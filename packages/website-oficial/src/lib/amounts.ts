/**
 * AMOUNTS: decimal text and raw on-chain units, in bigint only.
 *
 * A float cannot hold 0.06 SOL exactly, and a lamport lost to rounding is a
 * transaction that differs from what the person typed. So text is parsed digit
 * by digit into raw units (lamports, USDC's six decimals), and raw units are
 * written back as text the same way. Client-safe and pure.
 */

export class AmountError extends Error {
  override readonly name = "AmountError";
}

export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;
const U64_MAX = (1n << 64n) - 1n;

/** Digits, optionally a point and more digits: 0.05, 10, 007.5. No sign, exponent, separator or bare point. */
const PLAIN_DECIMAL = /^([0-9]+)(?:\.([0-9]+))?$/;

/** `text` in raw units of a token with `decimals` decimals. Throws AmountError with words `what` starts. */
export function parseUnits(text: string, decimals: number, what = "The amount"): bigint {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed === "") throw new AmountError(`${what} is empty.`);
  const match = PLAIN_DECIMAL.exec(trimmed);
  if (match === null) throw new AmountError(`${what} must be a plain number, like 0.05.`);
  const whole = match[1]!;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) throw new AmountError(`${what} has more than ${decimals} decimal places.`);
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (value > U64_MAX) throw new AmountError(`${what} is too large.`);
  return value;
}

export const solToLamports = (text: string): bigint => parseUnits(text, SOL_DECIMALS, "The SOL amount");
export const usdcToRaw = (text: string): bigint => parseUnits(text, USDC_DECIMALS, "The USD amount");

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Raw units as decimal text, trailing zeros dropped: 60,000,000 lamports is "0.06". Never rounds. */
export function formatUnits(raw: bigint, decimals: number, options: { readonly grouped?: boolean } = {}): string {
  if (raw < 0n) return `-${formatUnits(-raw, decimals, options)}`;
  const scale = 10n ** BigInt(decimals);
  const whole = (raw / scale).toString();
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const wholeText = options.grouped === true ? group(whole) : whole;
  return fraction === "" ? wholeText : `${wholeText}.${fraction}`;
}

/** Lamports as SOL text: "0.00128524". */
export const formatSol = (lamports: bigint): string => formatUnits(lamports, SOL_DECIMALS, { grouped: true });

/** USDC raw units as dollars to the nearest cent: "$1,000.00". */
export function formatUsd(usdcRaw: bigint): string {
  const negative = usdcRaw < 0n;
  const cents = ((negative ? -usdcRaw : usdcRaw) + 5_000n) / 10_000n;
  const text = `$${group((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/** What `lamports` of SOL come to in USDC raw units at `usdcRawPerSol`, rounded down. */
export const usdcRawForLamports = (lamports: bigint, usdcRawPerSol: bigint): bigint => (lamports * usdcRawPerSol) / 1_000_000_000n;

/**
 * `percent` of `raw`, rounded down; 100 is `raw` itself. Token shares are taken
 * from raw units, never from the display amount: SPYx's display amount is scaled.
 */
export function shareOfRaw(raw: bigint, percent: number): bigint {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new AmountError("A share is 1 to 100 percent.");
  return percent === 100 ? raw : (raw * BigInt(percent)) / 100n;
}

/** A decimal string from the server (bigints travel as strings), or null when it is not one. */
export function rawFrom(text: unknown): bigint | null {
  return typeof text === "string" && /^[0-9]{1,39}$/.test(text) ? BigInt(text) : null;
}
