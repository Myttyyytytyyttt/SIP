/**
 * WHICH WALLET SIGNS: Privy's connected Solana wallets, matched by address, and
 * the signers the vault flows call.
 *
 * THE PENSION KEY must be an external wallet (Phantom): the useWallets entry
 * with its address and NOT Privy's own standard wallet. A TRADING WALLET must be
 * Privy's: standardWallet.isPrivyWallet === true. An entry that is absent, or of
 * the other kind, is refused with words and no Privy call is made. After a
 * reload Phantom can be missing until it auto-connects, or connected as another
 * account; signing with the wrong entry is never the fallback.
 *
 * EXPLICIT OBJECTS ONLY. Each signer hands Privy exactly the fields named here,
 * never a click event (Privy reads an argument with a `target` as nothing).
 * Phantom signs with signTransaction on chain solana:mainnet, never
 * signAndSendTransaction: the send route verifies before anything is broadcast.
 *
 * Client-safe and pure: Privy's hooks come in as arguments.
 */

import { FAILURE_COPY, LINK_COPY, shortAddress } from "@/lib/vault-copy";

export interface SigningWallet {
  readonly address: string;
  readonly standardWallet: unknown;
}

export const SOLANA_MAINNET = "solana:mainnet" as const;

/** Whether `wallet` is one of Privy's embedded wallets (its standard wallet says so, through a getter). */
export function isPrivyWallet(wallet: SigningWallet): boolean {
  const standard = wallet.standardWallet;
  return typeof standard === "object" && standard !== null && (standard as { isPrivyWallet?: unknown }).isPrivyWallet === true;
}

/** The connected external wallet holding the pension key, or null. */
export const pensionWalletOf = <W extends SigningWallet>(wallets: readonly W[], pensionKey: string): W | null =>
  wallets.find((wallet) => wallet.address === pensionKey && !isPrivyWallet(wallet)) ?? null;

/** The connected Privy wallet at `address`, or null. */
export const tradingWalletOf = <W extends SigningWallet>(wallets: readonly W[], address: string): W | null =>
  wallets.find((wallet) => wallet.address === address && isPrivyWallet(wallet)) ?? null;

/** Privy's useSignTransaction().signTransaction, narrowed to the one call shape the flows make. */
export type SignTransactionFn<W extends SigningWallet> = (input: {
  transaction: Uint8Array;
  wallet: W;
  chain: typeof SOLANA_MAINNET;
  options?: { uiOptions?: { showWalletUIs?: boolean } };
}) => Promise<{ signedTransaction: Uint8Array }>;

/** Privy's useSignMessage().signMessage, narrowed likewise. */
export type SignMessageFn<W extends SigningWallet> = (input: {
  message: Uint8Array;
  wallet: W;
  options?: { uiOptions?: { showWalletUIs?: boolean; title?: string; description?: string; buttonText?: string } };
}) => Promise<{ signature: Uint8Array }>;

export interface SignerRefusal {
  readonly refusal: string;
}

export interface PensionSigner {
  /** Phantom's signature on these unsigned bytes; resolves to the bytes Phantom returned. */
  readonly signWithPension: (transaction: Uint8Array) => Promise<Uint8Array>;
}

export interface TradingSigners {
  /** The trading wallet's 64-byte signature over the consent bytes. */
  readonly signMessageWithTrading: (message: Uint8Array) => Promise<Uint8Array>;
  /** The trading wallet's answer for these (Phantom-signed) bytes: a transaction or a 64-byte signature. */
  readonly signWithTrading: (transaction: Uint8Array) => Promise<Uint8Array>;
}

export class SigningError extends Error {
  override readonly name = "SigningError";
}

function returnedBytes(output: { signedTransaction?: unknown } | undefined): Uint8Array {
  const bytes = output?.signedTransaction;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new SigningError(FAILURE_COPY.unreadableSigned);
  return bytes;
}

/** Phantom's signer for the pension key, or why there is none. */
export function pensionSigner<W extends SigningWallet>(input: { readonly wallets: readonly W[]; readonly pensionKey: string; readonly signTransaction: SignTransactionFn<W> }): PensionSigner | SignerRefusal {
  const wallet = pensionWalletOf(input.wallets, input.pensionKey);
  if (wallet === null) return { refusal: FAILURE_COPY.phantomNotConnected };
  return {
    signWithPension: async (transaction) => returnedBytes(await input.signTransaction({ transaction, wallet, chain: SOLANA_MAINNET })),
  };
}

/** The trading wallet's signers, or why there are none. The pension key is never a trading wallet. */
export function tradingSigners<W extends SigningWallet>(input: {
  readonly wallets: readonly W[];
  readonly pensionKey: string;
  readonly tradingAddress: string;
  readonly signTransaction: SignTransactionFn<W>;
  readonly signMessage: SignMessageFn<W>;
}): TradingSigners | SignerRefusal {
  if (input.tradingAddress === input.pensionKey) return { refusal: LINK_COPY.walletIsPension };
  const wallet = tradingWalletOf(input.wallets, input.tradingAddress);
  if (wallet === null) return { refusal: LINK_COPY.tradingNotReady };
  const uiOptions = {
    // The page has its own confirmation panel. These only show if the Privy dashboard enforces wallet screens.
    showWalletUIs: false,
    title: LINK_COPY.consentTitle,
    description: LINK_COPY.consentDescription(shortAddress(input.pensionKey)),
    buttonText: LINK_COPY.consentButton,
  };
  return {
    signMessageWithTrading: async (message) => {
      const output = await input.signMessage({ message, wallet, options: { uiOptions } });
      const signature: unknown = output?.signature;
      if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new SigningError(LINK_COPY.consentNotSignature);
      return signature;
    },
    // Headless, right after Phantom: a second approval screen spends the blockhash's lifetime, and Privy's own Retry recompiles with a new one.
    signWithTrading: async (transaction) =>
      returnedBytes(await input.signTransaction({ transaction, wallet, chain: SOLANA_MAINNET, options: { uiOptions: { showWalletUIs: false } } })),
  };
}

export const isSignerRefusal = (value: object): value is SignerRefusal => "refusal" in value;
