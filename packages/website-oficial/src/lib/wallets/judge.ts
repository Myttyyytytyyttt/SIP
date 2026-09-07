/**
 * Two judges: the pasted key, BEFORE anything is done with it; and the thrown
 * thing, BEFORE it reaches a screen.
 *
 * `judgePastedKey` is ported verbatim from HEAD (fd927b0)
 * src/components/InviteTradingWallet.tsx, comments included. `describeError`
 * is HEAD's `describe()` from the same file, extended to name a revert reason
 * and to redact anything key- or URL-shaped.
 */

import { privateKeyToAccount } from "viem/accounts";

/**
 * The pasted text, judged BEFORE anything is done with it. Each wrong shape
 * gets its own explanation, because the two likeliest mistakes — a seed
 * phrase, or a base58 Solana key — look nothing like "wrong hex" to the
 * person holding them.
 *
 * PURE AND EXPORTED so scripts/check-import-judge.mts can drive the real
 * function with real-shaped keys instead of asserting against a copy.
 */
export function judgePastedKey(
  pasted: string,
): { problem: string } | { key: `0x${string}`; address: `0x${string}` } | null {
  const raw = pasted.trim();
  if (raw === "") return null;
  if (/\s/.test(raw)) {
    return { problem: "That looks like a seed phrase. Paste the wallet's PRIVATE KEY instead — one unbroken string, no spaces." };
  }
  // Only when the string CANNOT be hex: a real base58 key virtually always
  // carries characters outside [0-9a-f] (21 of base58's 58 characters are also
  // hex, so 88 chars all landing in the overlap is (21/58)^88 ≈ 10^-39), while
  // a hex-only string of the wrong length
  // is far likelier mangled hex — found by the check script, which fed this
  // judge 88 hex characters and was told to go find a Solana wallet.
  if (/^[1-9A-HJ-NP-Za-km-z]{80,96}$/.test(raw) && !/^[0-9a-fA-F]+$/.test(raw)) {
    return { problem: "That is a Solana private key (base58). This vault lives on Robinhood Chain, which needs the 64-hex-character key of an EVM wallet." };
  }
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? `0x${raw.slice(2)}` : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    return { problem: "A private key is 64 hex characters, with or without the 0x in front." };
  }
  try {
    return { key: hex as `0x${string}`, address: privateKeyToAccount(hex as `0x${string}`).address };
  } catch {
    return { problem: "Those 64 characters do not form a valid private key." };
  }
}

/**
 * The useful sentence inside a thrown thing.
 *
 * IT USED TO TAKE LINE ONE, and line one is exactly where viem and Privy put
 * their generic header. "An unknown RPC error occurred." is that header; the
 * cause — the revert reason, the RPC's own words, the missing permission — sits
 * below it or on a nested `cause`. So the one line kept was reliably the one
 * line worth nothing, and a user was told "unknown" about an error the library
 * had described perfectly.
 *
 * Walks the cause chain, prefers `shortMessage` and `details` (viem's own
 * fields for precisely this), and skips known-empty headers. A revert is named
 * FIRST: viem puts the decoded custom error on `data.errorName` (and the reason
 * string on the message's second line), and "InvalidState()" tells the reader
 * more than the header ever will.
 *
 * REDACTED. A rejected import echoes its input in some messages, and the input
 * there is a private key — so any long hex run is removed before the sentence
 * reaches a screen. 41+ rather than exactly 64, because a key clipped at a
 * truncation would otherwise slip past a whole-key pattern; 40-hex ADDRESSES
 * survive — those are diagnostic, not secret. URLs go the same way: a relay
 * error can quote an upstream endpoint, and an upstream endpoint carries a key.
 */
export function describeError(error: unknown): string {
  const EMPTY = /^(an unknown rpc error occurred|an unknown error occurred|error|internal json-rpc error)\.?$/i;
  const parts: string[] = [];
  let revert: string | null = null;
  let declined = false;

  const walk = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 5) return;
    if (typeof value === "string") {
      parts.push(value.trim());
      return;
    }
    if (typeof value !== "object") return;
    const it = value as {
      shortMessage?: unknown;
      details?: unknown;
      message?: unknown;
      cause?: unknown;
      code?: unknown;
      reason?: unknown;
      data?: unknown;
    };
    // 4001 is the EIP-1193 code every wallet uses for "the user said no".
    if (it.code === 4001 || it.code === "ACTION_REJECTED") declined = true;
    // viem's ContractFunctionRevertedError: the custom error's NAME is the reason.
    const data = it.data as { errorName?: unknown; args?: unknown } | undefined;
    if (revert === null && data !== undefined && data !== null && typeof data.errorName === "string") {
      const args = Array.isArray(data.args) ? data.args.map((arg) => String(arg)).join(", ") : "";
      revert = `${data.errorName}(${args})`;
    }
    if (revert === null && typeof it.reason === "string" && it.reason.trim() !== "") revert = it.reason.trim();
    for (const candidate of [it.shortMessage, it.details]) {
      if (typeof candidate === "string" && candidate.trim() !== "") parts.push(candidate.trim());
    }
    if (typeof it.message === "string") {
      const lines = it.message
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      const first = lines[0];
      if (first !== undefined) parts.push(first);
      // The RPC error's second line: "Error: InvalidState()" or the reason
      // string after "reverted with the following reason:".
      const second = lines[1];
      if (revert === null && second !== undefined && /reverted/i.test(first ?? "") && !/^(contract|function)/i.test(second)) {
        revert = second.replace(/^Error:\s*/, "");
      }
      if (/user rejected|user denied|rejected the request/i.test(it.message)) declined = true;
    }
    walk(it.cause, depth + 1);
  };
  walk(error, 0);

  if (declined) return "The signature was declined in the wallet. Nothing was sent.";

  const useful = [...new Set(parts.filter((part) => !EMPTY.test(part)))];
  // Two at most: the specific reason plus the context it came from. More than
  // that is a stack trace pretending to be a sentence.
  const context = useful.filter((part) => revert === null || !part.includes(revert)).slice(0, revert === null ? 2 : 1);
  const chosen = [revert === null ? null : `Reverted: ${revert}`, ...context].filter((part): part is string => part !== null);
  const sentence = chosen.length > 0 ? chosen.join(" — ") : (parts[0] ?? String(error));
  return redact(sentence).slice(0, 300);
}

/** Strip anything key- or URL-shaped from a sentence bound for a screen. */
export function redact(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, "[url]").replace(/(0x)?[0-9a-fA-F]{41,}/g, "[redacted]");
}
