/**
 * CREATING A TRADING WALLET AND LINKING IT, as one pure flow.
 *
 * The owner's ask: one press. Privy mints the wallet, then the same press runs
 * the link (src/lib/vault-flows.ts's linkWalletFlow). Nothing about either
 * transaction changes here — this module only decides what happens BETWEEN them,
 * and what is said when the chain stops.
 *
 * THE CREATE COMES FIRST AND IS NEVER UNDONE. Once Privy answers, a real wallet
 * exists on the account, seated, whatever happens next. So every stop below
 * carries the address and says the wallet is there; a stop is never phrased as
 * "nothing happened", and the caller shows the wallet in the list with its own
 * Link to vault (src/components/wallets/LinkControl.tsx).
 *
 * NO VAULT IS EVER CREATED TO UNBLOCK THE CHAIN. Linking needs a vault, and a
 * vault costs rent that never comes back and carries a mode and limits the owner
 * chooses. With none, the flow stops after the create and says so.
 *
 * THE SEAT IS NOT WAITED FOR. A wallet is born seated (the keeper's signer with
 * its policy goes into createWallet itself), and Privy's record can read "unknown"
 * for seconds afterwards while the seat is perfectly real. Linking does not need
 * the seat, so nothing here reads it: the row's badge does, and says only what
 * Privy's record can prove.
 *
 * WHAT IS WAITED FOR is the one thing the link cannot do without: this session
 * being able to sign for the new wallet. Privy's useWallets lists it a moment
 * after the create, and the wait is bounded (READY_BACKOFF_MS); past that the
 * wallet is kept and the link is left to its row.
 *
 * Client-safe and pure, like vault-flows.ts: Privy's methods, the chain and the
 * link all arrive as arguments, so every state below is testable without a browser.
 */

import { rawFrom } from "@/lib/amounts";
import {
  createTradingWallet,
  failureText,
  importTradingWallet,
  keeperSigners,
  seatOf,
  seatProblem,
  tradingWalletsOf,
  type CreateWalletFn,
  type ImportWalletFn,
  type RefreshUserFn,
  type SeatConfig,
} from "@/lib/trading-wallets";
import type { VaultStateJson } from "@/lib/vault-api";
import { scrubKeyFrom } from "@/lib/import-key";
import { CREATE_LINK_COPY, IMPORT_LINK_COPY, LINK_COPY, VAULT_COPY, shortAddress } from "@/lib/vault-copy";
import type { FlowStep, LinkWalletResult } from "@/lib/vault-flows";

/** Why the chain cannot take a link right now. */
export type LinkGateCode = "needs_vault" | "vault_unreadable" | "needs_config" | "config_unreadable" | "paused";

export interface LinkGate {
  readonly code: LinkGateCode;
  readonly message: string;
}

/**
 * What the chain says about linking anything to this pension key's vault, in the
 * words the row already uses; null when it can be linked. One place, so the card's
 * chained flow and each row's own button never disagree.
 */
export function linkGate(state: VaultStateJson): LinkGate | null {
  if (state.vault.status === "missing") return { code: "needs_vault", message: LINK_COPY.needsVault };
  if (state.vault.status === "unreadable") return { code: "vault_unreadable", message: VAULT_COPY.unreadable };
  if (state.config.status === "missing") return { code: "needs_config", message: LINK_COPY.needsConfig };
  if (state.config.status === "unreadable") return { code: "config_unreadable", message: LINK_COPY.unreadable };
  if (state.config.paused === true) return { code: "paused", message: LINK_COPY.paused };
  return null;
}

/** The screen's view of the chain, as much of it as one press needs (src/hooks/use-vault-state.ts's VaultView). */
export type LinkChainView =
  | { readonly kind: "loading" }
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "ready"; readonly state: VaultStateJson };

/** What one press will do, and so what may be said before it is pressed. */
export type PressPlan =
  /** It will create the wallet and link it. `linkRent` is null when the rent has not been read: no amount may be invented. */
  | { readonly links: true; readonly linkRent: bigint | null }
  /** It will only create the wallet, for this reason, in the chain's own words. */
  | { readonly links: false; readonly reason: string };

/**
 * WHAT ONE PRESS WILL DO, from the screen's view of the chain.
 *
 * THREE CASES, NEVER TWO. A read still in flight is not a read that FAILED. While
 * it loads, the press may still link — the flow reads the chain again after the
 * create, and by then it usually has it — so the whole promise stands. A failed
 * read cannot take a link: the flow would stop at `chain_unknown` after minting a
 * wallet nobody asked for on its own, so the press promises the create alone,
 * with the read's own words. Folding the two into one "the chain says nothing
 * against it" announced Phantom and rent that never came.
 *
 * AN AMOUNT THAT WAS NOT READ IS NEVER WRITTEN. `linkRent` is the chain's, or null.
 */
export function pressPlan(view: LinkChainView | null): PressPlan {
  if (view === null || view.kind === "loading") return { links: true, linkRent: null };
  if (view.kind === "unreadable") return { links: false, reason: view.message };
  const gate = linkGate(view.state);
  return gate === null ? { links: true, linkRent: rawFrom(view.state.rents?.link) } : { links: false, reason: gate.message };
}

/** Where a chained press stopped before the link ran. */
export type CreateAndLinkStopKind =
  /** Refused before Privy was called: the keeper's seat is not configured. Nothing was created. */
  | "seat"
  /** Privy refused, or its dialog was closed. Nothing was created. */
  | "create"
  /** Privy created a wallet and did not name it. */
  | "no_address"
  /** Created; the chain cannot take a link (no vault, no config, paused…). */
  | "gate"
  /** Created; the screen's read of Solana is not usable, so nothing was attempted. */
  | "chain_unknown"
  /** Created; this session cannot sign for it yet. */
  | "not_ready";

export interface CreateAndLinkStop {
  readonly kind: CreateAndLinkStopKind;
  /** Words for the person; null ONLY when Privy's dialog was closed, which is a choice and not a failure, and nothing is shown. */
  readonly message: string | null;
  /** The chain's own reason, when `kind` is "gate". */
  readonly gate: LinkGateCode | null;
}

/**
 * Whether a stop is still true of the chain, and so still worth saying.
 *
 * A GATE STOP IS A STATEMENT ABOUT THE CHAIN RIGHT NOW — "a trading wallet can
 * only be linked to a vault, and this pension key has none yet" — so it stops
 * being true the moment the owner does the thing it asked for. The note that
 * carries it, and the way to the vault form inside it, go with it rather than
 * contradicting the screen around them. Every other stop records what happened
 * during the press, which stays true however the chain moves. A chain that cannot
 * be read proves nothing, so nothing is taken back on its word.
 */
export function stopStillHolds(stop: CreateAndLinkStop | ImportAndLinkStop | null, state: VaultStateJson | null): boolean {
  if (stop === null || stop.gate === null || state === null) return true;
  return linkGate(state)?.code === stop.gate;
}

export interface CreateAndLinkOutcome {
  /** The address Privy named, or null when nothing was created. A wallet may exist anyway: see `stop`. */
  readonly created: string | null;
  /** The link's own result, when the link ran; null when the chain stopped first. */
  readonly link: LinkWalletResult | null;
  /** Why it stopped before the link; null when the link ran. */
  readonly stop: CreateAndLinkStop | null;
}

export interface CreateAndLinkDeps {
  readonly createWallet: CreateWalletFn;
  readonly config: SeatConfig;
  readonly refreshUser: RefreshUserFn;
  /** The chain as the screen holds it, read after the create: "loading" while it is not known, null when the read failed. */
  readonly chain: () => VaultStateJson | "loading" | null;
  /** The addresses this session can sign for right now. Read again on every attempt: Privy lists a new wallet a moment late. */
  readonly signable: () => readonly string[];
  /** Runs the link transaction for the created address. */
  readonly link: (address: string) => Promise<LinkWalletResult>;
  readonly onStep?: (step: FlowStep) => void;
  /** Called the moment Privy names the wallet — before anything else can stop — so the list shows it at once. */
  readonly onCreated?: (address: string) => void;
  readonly wait?: (ms: number) => Promise<void>;
  readonly readyBackoffMs?: readonly number[];
}

/** The waits between readings of Privy's connected wallets while it lists a wallet just created. */
export const READY_BACKOFF_MS: readonly number[] = [250, 500, 1_000, 2_000, 3_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const stopped = (kind: CreateAndLinkStopKind, message: string | null, created: string | null, gate: LinkGateCode | null = null): CreateAndLinkOutcome => ({
  created,
  link: null,
  stop: { kind, message, gate },
});

/** Waits, bounded, for this session to be able to sign for `address`. */
async function signableSoon(deps: Pick<CreateAndLinkDeps, "signable" | "wait" | "readyBackoffMs">, address: string): Promise<boolean> {
  const backoff = deps.readyBackoffMs ?? READY_BACKOFF_MS;
  const wait = deps.wait ?? sleep;
  if (deps.signable().includes(address)) return true;
  for (const delay of backoff) {
    await wait(delay);
    if (deps.signable().includes(address)) return true;
  }
  return false;
}

/** Create a trading wallet, then link it to the pension key's vault, in one press. */
export async function createAndLinkFlow(deps: CreateAndLinkDeps): Promise<CreateAndLinkOutcome> {
  // Refuses before Privy, exactly as a plain create does: no wallet is minted for a seat that cannot be given.
  if (keeperSigners(deps.config) === null) {
    return stopped("seat", seatProblem(deps.config) ?? "The keeper's seat is not configured.", null);
  }

  deps.onStep?.("creating_wallet");
  let address: string | null;
  try {
    address = await createTradingWallet(deps.createWallet, deps.config);
  } catch (error) {
    // A wallet can exist even after a throw, so the record is read again either way; failureText is null for a closed dialog.
    await deps.refreshUser().catch(() => null);
    return stopped("create", failureText(error), null);
  }
  await deps.refreshUser().catch(() => null);
  if (address === null) return stopped("no_address", CREATE_LINK_COPY.noAddress, null);
  deps.onCreated?.(address);

  const chain = deps.chain();
  if (chain === "loading" || chain === null) return stopped("chain_unknown", CREATE_LINK_COPY.chainUnknown, address);
  const gate = linkGate(chain);
  if (gate !== null) return stopped("gate", gate.message, address, gate.code);

  if (!(await signableSoon(deps, address))) return stopped("not_ready", CREATE_LINK_COPY.notReady, address);

  return { created: address, link: await deps.link(address), stop: null };
}

/** Where an import-and-link stopped before its link ran. */
export type ImportAndLinkStopKind =
  /** Refused before Privy was called: the keeper's seat is not configured. Nothing was imported. */
  | "seat"
  /** The field no longer held a whole key. Nothing was sent. */
  | "no_key"
  /**
   * Privy refused — its record re-read on IMPORT_RECHECK_MS still did not list the wallet, and its words plus
   * importMaybe say to reload and look, since a throw is not proof — or its dialog was closed: the record is read
   * once, and nothing is shown.
   */
  | "import"
  /** Imported; Privy did not name it, and its record does not show it yet. */
  | "no_address"
  /** Imported, but not at the address this page checked. Not linked. */
  | "wrong_address"
  /** Imported; Privy's record shows no signer on it. Not linked: it could not save. */
  | "seat_missing"
  /** Imported; Privy's record does not list it yet, so its seat was not read. Not linked. */
  | "seat_unknown"
  /** Imported; the chain cannot take a link (no vault, no config, paused…). */
  | "gate"
  /** Imported; the screen's read of Solana is not usable. */
  | "chain_unknown"
  /** Imported; this session cannot sign for it yet. */
  | "not_ready"
  /** Imported; the press promised no link (the chain could not take one then), so none is made now: its row links it. */
  | "link_later";

export interface ImportAndLinkStop {
  readonly kind: ImportAndLinkStopKind;
  /** Words for the person; null ONLY when Privy's dialog was closed and nothing was imported. */
  readonly message: string | null;
  readonly gate: LinkGateCode | null;
}

export interface ImportAndLinkOutcome {
  /** The wallet now on the account, or null when it is not known to be on it. */
  readonly imported: string | null;
  readonly link: LinkWalletResult | null;
  readonly stop: ImportAndLinkStop | null;
  /** The wallet was already linked to this vault before the import: nothing was left to sign. */
  readonly alreadyLinked: boolean;
}

export interface ImportAndLinkDeps {
  readonly importWallet: ImportWalletFn;
  readonly config: SeatConfig;
  /**
   * The key, as Privy takes it, read ONCE and only after the seat is known to be
   * configurable; null when the field no longer holds a whole key opening
   * `expected`. The caller empties its field inside this call and judges the text
   * again there, so the key exists from here on only in the flow's own local,
   * which is dropped once Privy has it.
   */
  readonly takeKey: () => Promise<string | null>;
  /** The address the key's private half opens, which every preflight check ran on. Privy must name this one. */
  readonly expected: string;
  /** False when the wallet is already linked to this vault (the preflight read it): the import is all that is left. */
  readonly needsLink: boolean;
  /**
   * Whether the press PROMISED a link (needsLink, and the chain could take one when it was pressed). False: no link
   * is made whatever the chain says by then — Phantom never opens on a press that said it would not.
   */
  readonly links: boolean;
  readonly refreshUser: RefreshUserFn;
  readonly chain: () => VaultStateJson | "loading" | null;
  readonly signable: () => readonly string[];
  readonly link: (address: string) => Promise<LinkWalletResult>;
  readonly onStep?: (step: FlowStep) => void;
  /** Called the moment the wallet is known to be on the account, before anything else can stop. */
  readonly onImported?: (address: string) => void;
  readonly wait?: (ms: number) => Promise<void>;
  readonly readyBackoffMs?: readonly number[];
  readonly seatBackoffMs?: readonly number[];
  readonly importRecheckMs?: readonly number[];
}

/** The waits between readings of Privy's record while it lists a wallet just imported, with its signer. */
export const SEAT_BACKOFF_MS: readonly number[] = [500, 1_000, 2_000, 3_000, 5_000];

/** The waits between readings of Privy's record after its import threw, before saying it is not listed (yet). */
export const IMPORT_RECHECK_MS: readonly number[] = [500, 1_000, 2_000];

/**
 * Privy's error with every run of 8 or more characters of `key` taken out of its text (scrubKeyFrom), in every shape privyFailure reads:
 * a string, an Error, or any object with a string `message` — its code scrubbed and kept too. Anything else carries
 * no text to show.
 */
function withoutKey(error: unknown, key: string): unknown {
  if (typeof error === "string") return scrubKeyFrom(error, key);
  if (typeof error !== "object" || error === null) return error;
  const message: unknown = (error as { message?: unknown }).message;
  const code: unknown = (error as { privyErrorCode?: unknown }).privyErrorCode;
  return Object.assign(new Error(typeof message === "string" ? scrubKeyFrom(message, key) : ""), typeof code === "string" ? { privyErrorCode: scrubKeyFrom(code, key) } : {});
}

const importStopped = (kind: ImportAndLinkStopKind, message: string | null, imported: string | null, gate: LinkGateCode | null = null): ImportAndLinkOutcome => ({
  imported,
  link: null,
  stop: { kind, message, gate },
  alreadyLinked: false,
});

/** Whether Privy's record lists `address` as a trading wallet on this account. A record that could not be read says no. */
const listed = (record: Awaited<ReturnType<RefreshUserFn>>, address: string): boolean => tradingWalletsOf(record).some((wallet) => wallet.address === address);

/**
 * IMPORT A WALLET THE PERSON ALREADY USES, SEATED, THEN LINK IT — one press,
 * under the screen's write lock, like createAndLinkFlow.
 *
 * THE KEY IS TAKEN ONCE, after the seat is known to be configurable, and handed
 * to Privy in the same breath; the flow keeps the ADDRESS from then on, never the
 * key, so every way forward after a stop (the row's Link, Grant, Check again)
 * needs nothing pasted again.
 *
 * A THROW IS NOT PROOF NOTHING WAS IMPORTED. Privy's importWallet imports first
 * and re-reads the user after, failing with "Failed to import wallet" when that
 * read does not list it yet. So the record is read either way — on
 * IMPORT_RECHECK_MS after a throw, a read that fails counting as no answer — and
 * a wallet it lists at the expected address is carried on as imported. One it
 * still does not list stops with Privy's words and where to look, never with
 * "nothing happened". Privy's text loses every run of 8 or more characters of
 * the key first (scrubKeyFrom), while the flow still holds it to compare.
 *
 * THE ADDRESS MUST BE THE ONE CHECKED. Every preflight refusal — a vault this key
 * owns, a link elsewhere, the pension key — ran on `expected`. A wallet Privy
 * names otherwise is left unlinked, and the stop names both.
 *
 * THE SEAT IS READ BEFORE THE LINK, unlike a create's. It was asked for in the
 * same call as the import, but a link costs the owner rent and a wallet without
 * the seat would save nothing behind a "Linked" row. Privy's record must show a
 * signer (seatOf "has-signer") within SEAT_BACKOFF_MS; a record showing none, or
 * not listing the wallet, stops with the way forward on its row.
 */
export async function importAndLinkFlow(deps: ImportAndLinkDeps): Promise<ImportAndLinkOutcome> {
  if (keeperSigners(deps.config) === null) {
    return importStopped("seat", seatProblem(deps.config) ?? "The keeper's seat is not configured.", null);
  }

  deps.onStep?.("importing_wallet");
  const wait = deps.wait ?? sleep;
  let key = await deps.takeKey();
  if (key === null) return importStopped("no_key", IMPORT_LINK_COPY.noKey, null);
  let named: string | null = null;
  let failure: unknown = null;
  try {
    named = await importTradingWallet(deps.importWallet, deps.config, key);
  } catch (error) {
    failure = withoutKey(error, key);
  } finally {
    key = null;
  }
  let record = await deps.refreshUser().catch(() => null);
  // A closed dialog is a choice (failureText null): nothing to wait for.
  if (named === null && failure !== null && failureText(failure) !== null) {
    for (const delay of deps.importRecheckMs ?? IMPORT_RECHECK_MS) {
      if (listed(record, deps.expected)) break;
      await wait(delay);
      record = await deps.refreshUser().catch(() => null);
    }
  }
  let address: string;
  if (named !== null) {
    address = named;
  } else if (listed(record, deps.expected)) {
    address = deps.expected;
  } else if (failure !== null) {
    // failureText is null for a closed dialog, and redacts anything key-shaped from Privy's words.
    const said = failureText(failure);
    return importStopped("import", said === null ? null : `${said} ${IMPORT_LINK_COPY.importMaybe}`, null);
  } else {
    return importStopped("no_address", IMPORT_LINK_COPY.noAddress, null);
  }
  deps.onImported?.(address);
  if (address !== deps.expected) {
    return importStopped("wrong_address", IMPORT_LINK_COPY.wrongAddress(shortAddress(address), shortAddress(deps.expected)), address);
  }

  deps.onStep?.("checking_permission");
  let seat = seatOf(record, address);
  for (const delay of deps.seatBackoffMs ?? SEAT_BACKOFF_MS) {
    if (seat === "has-signer") break;
    await wait(delay);
    seat = seatOf(await deps.refreshUser().catch(() => null), address);
  }
  if (seat === "missing") return importStopped("seat_missing", IMPORT_LINK_COPY.seatMissing, address);
  if (seat !== "has-signer") return importStopped("seat_unknown", IMPORT_LINK_COPY.seatUnknown, address);

  if (!deps.needsLink) return { imported: address, link: null, stop: null, alreadyLinked: true };
  if (!deps.links) {
    // The press said it would not link: what the chain says now is reported, never acted on.
    const now = deps.chain();
    const gateNow = now === "loading" || now === null ? null : linkGate(now);
    if (gateNow !== null) return importStopped("gate", gateNow.message, address, gateNow.code);
    return importStopped("link_later", IMPORT_LINK_COPY.linkLater, address);
  }

  const chain = deps.chain();
  if (chain === "loading" || chain === null) return importStopped("chain_unknown", IMPORT_LINK_COPY.chainUnknown, address);
  const gate = linkGate(chain);
  if (gate !== null) return importStopped("gate", gate.message, address, gate.code);

  if (!(await signableSoon(deps, address))) return importStopped("not_ready", IMPORT_LINK_COPY.notReady, address);

  return { imported: address, link: await deps.link(address), stop: null, alreadyLinked: false };
}
