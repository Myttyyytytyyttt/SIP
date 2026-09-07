// A TradingSigner backed by Privy, so the keeper never holds a trading key.
//
// WHY THIS EXISTS. `submit.ts` needs a signer for the trading account, because
// `SettlementExecutor.settle` resolves the vault from `msg.sender`. Until now the
// only way to satisfy that was `TRADING_OWNER_PRIVATE_KEY` — total custody of the
// user's whole wallet, which is exactly why the README states multi-user is
// impossible. A service cannot ask a stranger for that key.
//
// Privy signers replace it. The user's wallet stays theirs; the service is added
// as a *signer* with a POLICY, and Privy's enclave refuses anything the policy
// does not allow. The credential this process holds is an authorization key that
// can only ask Privy to sign, and only within that policy — it cannot move a
// token, cannot trade on the user's behalf, and cannot be used anywhere else.
// It may also call `invest` on the user's own vault with zero value attached,
// which buys the assets that vault already holds a signed configuration for.
//
// WHAT THIS IS NOT. The containment is enforced by Privy's policy engine, not by
// a contract. That is a weaker guarantee than an on-chain module and it should be
// described that way: "we cannot take your money because Privy will not let us",
// not "check the chain yourself". The policy is therefore the security boundary,
// and `scripts/create-privy-policy.mjs` is where it is defined.
//
// `signTransaction` and not `sendTransaction`, matching the existing interface:
// the keeper must hold the serialized bytes, and therefore the hash, before the
// network sees them. Privy's `eth_signTransaction` returns exactly that.

import { PrivyClient } from "@privy-io/node";

import type { TradingSigner } from "./submit.js";

export interface PrivySignerConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** The authorization key registered as a signer on the wallet. */
  readonly authorizationKey: string;
  /** Privy's id for the wallet — NOT its address. Both are needed. */
  readonly walletId: string;
  /** The trading account address, which is what appears as msg.sender. */
  readonly address: `0x${string}`;
}

/** Privy takes quantities as hex strings; viem hands us bigints. */
const quantity = (value: bigint): string => `0x${value.toString(16)}`;

export function createPrivySigner(config: PrivySignerConfig): TradingSigner {
  const privy = new PrivyClient({ appId: config.appId, appSecret: config.appSecret });

  return {
    address: config.address,
    async signTransaction(transaction) {
      const response = await privy
        .wallets()
        .ethereum()
        .signTransaction(config.walletId, {
          params: {
            transaction: {
              to: transaction.to,
              value: quantity(transaction.value),
              data: transaction.data,
              nonce: transaction.nonce,
              chain_id: transaction.chainId,
              gas_limit: quantity(transaction.gas),
              max_fee_per_gas: quantity(transaction.maxFeePerGas),
              max_priority_fee_per_gas: quantity(transaction.maxPriorityFeePerGas),
              type: 2,
            },
          },
          authorization_context: {
            authorization_private_keys: [config.authorizationKey],
          },
        } as Parameters<ReturnType<ReturnType<typeof privy.wallets>["ethereum"]>["signTransaction"]>[1]);

      const signed = (response as { signed_transaction?: string }).signed_transaction;
      if (typeof signed !== "string" || !signed.startsWith("0x")) {
        // A policy refusal arrives as a rejected request, but a SHAPE change
        // arrives as a success with nothing usable in it. Refusing here keeps
        // that from being mistaken for a signature.
        throw new Error(
          "Privy returned no `signed_transaction`. Either the policy refused this call or the " +
            "API response shape changed; nothing was broadcast.",
        );
      }
      return signed as `0x${string}`;
    },
  };
}
