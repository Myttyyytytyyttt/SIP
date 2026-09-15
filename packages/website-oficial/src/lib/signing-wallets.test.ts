// Which connected wallet signs, and exactly what each signer hands Privy.

import { describe, expect, it, vi } from "vitest";

import { SigningError, isPrivyWallet, pensionSigner, pensionWalletOf, tradingSigners, tradingWalletOf, type SigningWallet } from "@/lib/signing-wallets";

/** Privy's standard wallet answers isPrivyWallet through a getter on its class. */
class PrivyStandardWalletLike {
  get isPrivyWallet(): boolean {
    return true;
  }
}

const PENSION = "PensionKeyP1aceho1der1111111111111111111111";
const TRADING = "TradingZeroP1aceho1der111111111111111111111";
const OTHER = "OtherP1aceho1der111111111111111111111111111";

const phantom: SigningWallet = { address: PENSION, standardWallet: { name: "Phantom" } };
const embedded: SigningWallet = { address: TRADING, standardWallet: new PrivyStandardWalletLike() };
const privyAtPension: SigningWallet = { address: PENSION, standardWallet: new PrivyStandardWalletLike() };
const phantomAtOther: SigningWallet = { address: OTHER, standardWallet: { name: "Phantom" } };

const SIGNED = Uint8Array.from([1, 2, 3]);

describe("picking the wallet", () => {
  it("the pension key is the external entry at its address; a Privy wallet there is not it; absent is null", () => {
    expect(pensionWalletOf([embedded, phantom], PENSION)).toBe(phantom);
    expect(pensionWalletOf([privyAtPension], PENSION)).toBeNull();
    expect(pensionWalletOf([embedded], PENSION)).toBeNull();
  });

  it("a trading wallet is Privy's entry at its address; an external wallet there is not it; absent is null", () => {
    expect(tradingWalletOf([phantom, embedded], TRADING)).toBe(embedded);
    expect(tradingWalletOf([phantomAtOther], OTHER)).toBeNull();
    expect(tradingWalletOf([phantom], TRADING)).toBeNull();
  });

  it("reads isPrivyWallet from a getter, and nothing else counts", () => {
    expect(isPrivyWallet(embedded)).toBe(true);
    expect(isPrivyWallet(phantom)).toBe(false);
    expect(isPrivyWallet({ address: OTHER, standardWallet: { isPrivyWallet: "true" } })).toBe(false);
    expect(isPrivyWallet({ address: OTHER, standardWallet: null })).toBe(false);
  });
});

describe("the pension signer", () => {
  it("hands Privy exactly {transaction, wallet, chain: solana:mainnet} and returns Phantom's bytes", async () => {
    const signTransaction = vi.fn(async () => ({ signedTransaction: SIGNED }));
    const signer = pensionSigner({ wallets: [embedded, phantom], pensionKey: PENSION, signTransaction });
    if ("refusal" in signer) throw new Error(signer.refusal);
    const transaction = Uint8Array.from([9, 9]);
    expect(await signer.signWithPension(transaction)).toBe(SIGNED);
    expect(signTransaction.mock.calls).toStrictEqual([[{ transaction, wallet: phantom, chain: "solana:mainnet" }]]);
  });

  it("without Phantom connected, refuses with words and never calls Privy", () => {
    const signTransaction = vi.fn();
    expect(pensionSigner({ wallets: [embedded, privyAtPension], pensionKey: PENSION, signTransaction })).toEqual({
      refusal: "Phantom is not connected to this page. Open Phantom, unlock it, and reload.",
    });
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("an empty answer is a SigningError, not bytes", async () => {
    const signer = pensionSigner({ wallets: [phantom], pensionKey: PENSION, signTransaction: async () => ({ signedTransaction: new Uint8Array(0) }) });
    if ("refusal" in signer) throw new Error(signer.refusal);
    await expect(signer.signWithPension(SIGNED)).rejects.toThrow(SigningError);
  });
});

describe("the trading wallet's signers", () => {
  it("refuses the pension key as a trading wallet, and a trading wallet this session does not hold", () => {
    const base = { wallets: [phantom, embedded], pensionKey: PENSION, signTransaction: vi.fn(), signMessage: vi.fn() };
    expect(tradingSigners({ ...base, tradingAddress: PENSION })).toEqual({ refusal: "A trading wallet cannot be your pension key." });
    expect(tradingSigners({ ...base, tradingAddress: OTHER })).toMatchObject({ refusal: expect.stringContaining("not ready") });
  });

  it("signs the consent with signMessage, the page's copy in uiOptions, and requires 64 bytes back", async () => {
    const signature = new Uint8Array(64).fill(7);
    const signMessage = vi.fn(async () => ({ signature }));
    const signers = tradingSigners({ wallets: [phantom, embedded], pensionKey: PENSION, tradingAddress: TRADING, signTransaction: vi.fn(), signMessage });
    if ("refusal" in signers) throw new Error(signers.refusal);
    const message = new Uint8Array(140).fill(0xff);
    expect(await signers.signMessageWithTrading(message)).toBe(signature);
    expect(signMessage.mock.calls).toStrictEqual([
      [
        {
          message,
          wallet: embedded,
          options: {
            uiOptions: {
              showWalletUIs: false,
              title: "Link to your SIP vault",
              description: "Consent for SIP to link this trading wallet to the vault of pension key Pens…1111. It moves no funds.",
              buttonText: "Sign consent",
            },
          },
        },
      ],
    ]);
    signMessage.mockResolvedValueOnce({ signature: new Uint8Array(63) });
    await expect(signers.signMessageWithTrading(message)).rejects.toThrow(SigningError);
  });

  it("co-signs with signTransaction on solana:mainnet, headless", async () => {
    const signTransaction = vi.fn(async () => ({ signedTransaction: SIGNED }));
    const signers = tradingSigners({ wallets: [embedded], pensionKey: PENSION, tradingAddress: TRADING, signTransaction, signMessage: vi.fn() });
    if ("refusal" in signers) throw new Error(signers.refusal);
    const transaction = Uint8Array.from([4, 4]);
    expect(await signers.signWithTrading(transaction)).toBe(SIGNED);
    expect(signTransaction.mock.calls).toStrictEqual([[{ transaction, wallet: embedded, chain: "solana:mainnet", options: { uiOptions: { showWalletUIs: false } } }]]);
  });
});
