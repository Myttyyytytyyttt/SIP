// The real PrivyPolicyClient and ProbeChain: @privy-io/node and @solana/web3.js
// behind the interfaces src/privy-policy-cli.ts decides against.
//
// TRANSLATION ONLY. Nothing here chooses or interprets; an SDK error propagates
// untouched so classifyPrivyError sees its real shape (status, and Privy's
// `code` in the parsed body). Secrets are revealed inside the call that needs
// them and nowhere else, as in privy-signer.ts.
//
// THE TRANSPORT IS PINNED, NOT INHERITED. The client comes from
// pinnedPrivyClient (privy-signer.ts), the one place the keeper builds one:
//   * apiUrl and logLevel are set there. Left out, the SDK takes
//     PRIVY_API_BASE_URL and PRIVY_API_LOG from the environment, and the first
//     sends the app secret to whatever host it names. The third variable the
//     SDK reads, PRIVY_API_CUSTOM_HEADERS, has no option that overrides it, so
//     the CLI refuses all three by name before a client is built.
//   * maxRetries is 0: ONE ATTEMPT PER REQUEST. The SDK otherwise re-sends on
//     408, 409, 429, 5xx and dropped connections, POSTs included, with no
//     idempotency key of its own. A key quorum that landed behind a 504 would be
//     created again, and `create` could no longer say which objects exist.

import { randomUUID } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Secret } from "@sip/solana-log";
import type { PrivyPolicyClient, ProbeChain } from "./privy-policy-cli.js";
import { SOLANA_MAINNET_CAIP2, pinnedPrivyClient } from "./privy-signer.js";
import { poolFetch } from "./rpc-pool.js";

export interface PrivyPolicyClientOptions {
  /** Tests only: a fetch that answers in-process, so the transport settings above are checked with no network. */
  readonly fetch?: typeof globalThis.fetch;
}

export function createPrivyPolicyClient(
  credentials: { readonly appId: string; readonly appSecret: Secret },
  options: PrivyPolicyClientOptions = {},
): PrivyPolicyClient {
  const privy = pinnedPrivyClient({ appId: credentials.appId, appSecret: credentials.appSecret.reveal(), fetch: options.fetch });
  const authorization = (key: Secret): { authorization_private_keys: string[] } => ({ authorization_private_keys: [key.reveal()] });
  return {
    async createKeyQuorum({ publicKey, displayName }) {
      const quorum = await privy.keyQuorums().create({ public_keys: [publicKey], authorization_threshold: 1, display_name: displayName });
      return { id: quorum.id };
    },

    async getKeyQuorum(keyQuorumId) {
      // A GET takes no authorization signature — only the app id and secret
      // (the SDK threads prepareRequest through update and delete alone). That
      // is what makes `key` possible: the credentials already proven good read
      // the ground truth the questionable credential is measured against.
      const quorum = await privy.keyQuorums().get(keyQuorumId);
      return {
        id: quorum.id,
        authorizationKeys: (quorum.authorization_keys ?? []).map((entry) => ({
          publicKey: entry.public_key,
          displayName: entry.display_name,
        })),
      };
    },

    async createPolicy(policy, ownerId) {
      return privy.policies().create({
        // Already one attempt; the key keeps it one policy if anything between here and Privy re-sends it.
        idempotency_key: randomUUID(),
        version: policy.version,
        name: policy.name,
        chain_type: policy.chain_type,
        rules: policy.rules.map((rule) => ({
          name: rule.name,
          method: rule.method,
          action: rule.action,
          conditions: rule.conditions.map((condition) => ({
            field_source: condition.field_source,
            field: condition.field,
            operator: condition.operator,
            value: [...condition.value],
          })),
        })),
        owner_id: ownerId,
      });
    },

    async getPolicy(policyId) {
      return privy.policies().get(policyId);
    },

    async getWallet(walletId) {
      return privy.wallets().get(walletId);
    },

    async signMessage(walletId, message, authorizationKey) {
      // BYTES, NOT A STRING: the SDK assumes a string message is already base64
      // (public-api/services/solana.js) and would sign the decoding of it.
      const response = await privy.wallets().solana().signMessage(walletId, { message, authorization_context: authorization(authorizationKey) });
      return { signature: response.signature };
    },

    async signAndSendTransaction(walletId, transaction, authorizationKey) {
      const response = await privy
        .wallets()
        .solana()
        .signAndSendTransaction(walletId, {
          caip2: SOLANA_MAINNET_CAIP2 as `${string}:${string}`,
          transaction: Buffer.from(transaction).toString("base64"),
          authorization_context: authorization(authorizationKey),
        });
      return { hash: response.hash };
    },
  };
}

/** Failover under the transport, as in the keeper: the endpoints are Secrets because they carry API keys. */
export function createProbeChain(rpcUrls: readonly Secret[]): ProbeChain {
  const connection = new Connection(rpcUrls[0]!.reveal(), { commitment: "confirmed", fetch: poolFetch(rpcUrls) });
  return {
    genesisHash: () => connection.getGenesisHash(),
    latestBlockhash: async () => (await connection.getLatestBlockhash("confirmed")).blockhash,
    balanceLamports: (address) => connection.getBalance(new PublicKey(address), "confirmed"),
  };
}
