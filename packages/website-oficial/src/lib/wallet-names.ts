/**
 * A TRADING WALLET'S OWN NAME, AS ITS OWNER TYPED IT (owner, 10-23: "que el
 * nombre de la trading wallet se pueda editar").
 *
 * The rules the browser and /api/wallet-names both apply, so a name the input
 * accepts is a name the server keeps, and the other way round. Saved TO THE
 * ACCOUNT, on every device (owner, 10-23): one document per Privy login, kept
 * by the server (lib/wallet-names-server.ts). A name is a label and nothing
 * else — it moves no money and no screen trusts it for anything but display.
 *
 * A LEAF, with no imports, like wallet-labels.ts: the input and the route both
 * read it, and neither may pull the other's world in.
 */

/** The longest name, in characters (code points): what fits beside the status badge in the wallet column. */
export const WALLET_NAME_MAX_CHARS = 32;

/** The most names one account keeps. Far over the trading wallets an account can hold; a bound on the document, not a product limit. */
export const WALLET_NAMES_MAX = 50;

/**
 * WHAT A NAME MAY NOT CARRY: control characters and line breaks, which would
 * break the one-line rows it is drawn in, and the invisible characters that
 * turn text around or hide in it (bidi overrides and isolates, zero-width
 * space, BOM) — a name that reads differently from what it holds. The joiners
 * (U+200C, U+200D) stay: emoji sequences and several scripts need them.
 */
const FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;

/** The words the input says when it refuses a name. */
export const WALLET_NAME_COPY = {
  tooLong: `A name has at most ${WALLET_NAME_MAX_CHARS} characters.`,
  forbidden: "A name can't hold line breaks or invisible characters.",
} as const;

export type CleanedWalletName =
  /** `name` null: the input was empty, which means "back to the default name". */
  | { readonly ok: true; readonly name: string | null }
  | { readonly ok: false; readonly message: string };

/** A typed name, as it is kept: normalized (NFC), trimmed, checked. */
export function cleanWalletName(raw: string): CleanedWalletName {
  const name = raw.normalize("NFC").trim();
  if (name === "") return { ok: true, name: null };
  if (FORBIDDEN.test(name)) return { ok: false, message: WALLET_NAME_COPY.forbidden };
  if ([...name].length > WALLET_NAME_MAX_CHARS) return { ok: false, message: WALLET_NAME_COPY.tooLong };
  return { ok: true, name };
}

/** What finishing an edit does: nothing, save a name (null: back to the default), or refuse what was typed. */
export type RenameOutcome =
  | { readonly kind: "unchanged" }
  | { readonly kind: "save"; readonly name: string | null }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * THE EDIT'S ONE DECISION, kept out of the component so it can be tested
 * without a DOM. `typed` is the input's text; `shown` the name on screen when
 * the edit began; `custom` the name saved for this wallet, or null when it
 * shows its default ("Trading wallet 1").
 *
 * EMPTY GOES BACK TO THE DEFAULT, and only when there is a name to clear.
 * IDENTICAL CHANGES NOTHING: Enter on the untouched text, or a blur after a
 * look, saves nothing and spends nothing.
 */
export function renameOutcome(typed: string, shown: string, custom: string | null): RenameOutcome {
  const cleaned = cleanWalletName(typed);
  if (!cleaned.ok) return { kind: "invalid", message: cleaned.message };
  if (cleaned.name === custom) return { kind: "unchanged" };
  if (cleaned.name !== null && cleaned.name === shown) return { kind: "unchanged" };
  return { kind: "save", name: cleaned.name };
}

/** Shaped like a Solana address: base58, 32 to 44 characters. The route checks the bytes too (isPubkey); this only keeps junk keys out of a map. */
const ADDRESS_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A names map read from anywhere (the server's answer, a stored document): only address → valid-name entries survive. */
export function namesFrom(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [address, name] of Object.entries(value as Record<string, unknown>)) {
    if (typeof name !== "string" || !ADDRESS_SHAPE.test(address)) continue;
    const cleaned = cleanWalletName(name);
    if (cleaned.ok && cleaned.name !== null) out[address] = cleaned.name;
  }
  return out;
}
