/**
 * WHAT THIS BROWSER REMEMBERS OF A KEY'S NEW-USER SETUP: the step it was left
 * at, and whether this tab closed it. Nothing else — and never the address.
 *
 * THE STEP LIVES IN localStorage, so a reload or a new visit reopens the setup
 * where it was left. THE CLOSE LIVES IN sessionStorage, so it lasts as long as
 * the tab: a reload keeps the sample the person chose, and a new visit offers
 * the setup again (owner, 09-23).
 *
 * BOTH ARE STORED UNDER A TAG OF THE KEY, an 8-hex FNV-1a hash, never the key
 * itself: this is a hint about a screen, and a public address has no business
 * sitting in storage for it. A tag that is not the connected key's reads as
 * nothing stored.
 *
 * STORAGE MAY BE BLOCKED (a private window, an embedded browser, a quota). Every
 * access is guarded, and an in-memory mirror answers for the life of the page,
 * so a blocked storage costs only the memory across reloads.
 *
 * Plain TS with a listener set, the pattern of src/lib/seat-activity.ts: the
 * frame reads the close through useSyncExternalStore.
 */

export type OnboardingStep = "welcome" | "vault";

const STEP_KEY = "saverfi.onboarding.step";
const CLOSED_KEY = "saverfi.onboarding.closed";
/**
 * Written once when a setup ends in a vault, so another tab of this browser
 * that is showing the sample reads the vault again rather than waiting for a
 * reload. Its value only has to change; nobody reads it.
 */
export const ONBOARDING_DONE_KEY = "saverfi.onboarding.done";

type Area = "local" | "session";

/** The key's tag: FNV-1a over its characters, as 8 hex digits. */
export function keyTag(pensionKey: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < pensionKey.length; index += 1) {
    hash ^= pensionKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const mirror = new Map<string, string | null>();
const listeners = new Set<() => void>();

function storageOf(area: Area): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return area === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function read(area: Area, name: string): string | null {
  const slot = `${area}:${name}`;
  if (mirror.has(slot)) return mirror.get(slot) ?? null;
  try {
    return storageOf(area)?.getItem(name) ?? null;
  } catch {
    return null;
  }
}

/** Writes, or removes with null. Says whether anything changed. */
function write(area: Area, name: string, value: string | null): boolean {
  if (read(area, name) === value) return false;
  mirror.set(`${area}:${name}`, value);
  try {
    const storage = storageOf(area);
    if (value === null) storage?.removeItem(name);
    else storage?.setItem(name, value);
  } catch {
    // The mirror has it for the life of the page.
  }
  return true;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Where this key's setup was left; "welcome" when nothing is stored for it. */
export function readOnboardingStep(pensionKey: string): OnboardingStep {
  const stored = read("local", STEP_KEY);
  const tag = keyTag(pensionKey);
  if (stored === `${tag}:vault`) return "vault";
  return "welcome";
}

export function saveOnboardingStep(pensionKey: string, step: OnboardingStep): void {
  if (write("local", STEP_KEY, `${keyTag(pensionKey)}:${step}`)) notify();
}

/** Whether this tab closed this key's setup. False for no key. */
export function readOnboardingClosed(pensionKey: string | null): boolean {
  if (pensionKey === null) return false;
  return read("session", CLOSED_KEY) === keyTag(pensionKey);
}

export function setOnboardingClosed(pensionKey: string, closed: boolean): void {
  const tag = keyTag(pensionKey);
  if (!closed && read("session", CLOSED_KEY) !== tag) return;
  if (write("session", CLOSED_KEY, closed ? tag : null)) notify();
}

/**
 * Drops what is remembered: for one key (its vault now exists), or for any key
 * (null: the session ended). `announce` also tells this browser's other tabs,
 * which is what a setup that ends in a vault does.
 */
export function forgetOnboarding(pensionKey: string | null, options: { readonly announce?: boolean } = {}): void {
  const tag = pensionKey === null ? null : keyTag(pensionKey);
  let changed = false;
  const step = read("local", STEP_KEY);
  if (step !== null && (tag === null || step.startsWith(`${tag}:`))) changed = write("local", STEP_KEY, null) || changed;
  const closed = read("session", CLOSED_KEY);
  if (closed !== null && (tag === null || closed === tag)) changed = write("session", CLOSED_KEY, null) || changed;
  if (options.announce === true) {
    try {
      storageOf("local")?.setItem(ONBOARDING_DONE_KEY, `${tag ?? "any"}:${Date.now()}`);
    } catch {
      // Another tab finds out on its next read instead.
    }
  }
  if (changed) notify();
}

// ── what the savings become ──────────────────────────────────────────────────

/**
 * What a key chose on the setup's vault step (owner, 09-24): its savings kept
 * as SOL, or bought as these stocks at an equal split. NOTHING IS SIGNED FOR
 * IT THERE — the vault's one approval is only the vault. The dashboard asks for
 * the buying approval once the first savings arrive, with that day's prices.
 *
 * IT OUTLIVES THE SETUP. forgetOnboarding clears the step and the close when
 * the vault lands; this stays, because the dashboard reads it after. Stored in
 * localStorage under the key's tag, so it is per browser: on another device,
 * or once a browser has cleared the site's storage, the dashboard does NOT ask —
 * it has no choice to ask about — and buying is set up from Manage wallets →
 * Investing, as for any vault.
 */
export type BasketChoice = { readonly kind: "sol" } | { readonly kind: "stocks"; readonly mints: readonly string[] };

const BASKET_KEY = "saverfi.basket";

/** The stored value when it is this key's, else null: a string, so a store snapshot of it is stable. */
export function readBasketStored(pensionKey: string): string | null {
  const stored = read("local", BASKET_KEY);
  return stored !== null && stored.startsWith(`${keyTag(pensionKey)}:`) ? stored : null;
}

export function readBasketChoice(pensionKey: string): BasketChoice | null {
  const stored = readBasketStored(pensionKey);
  if (stored === null) return null;
  const rest = stored.slice(keyTag(pensionKey).length + 1);
  if (rest === "sol") return { kind: "sol" };
  const mints = rest.split(",").filter((mint) => mint.length > 0);
  return mints.length === 0 ? null : { kind: "stocks", mints };
}

export function saveBasketChoice(pensionKey: string, choice: BasketChoice): void {
  const value = `${keyTag(pensionKey)}:${choice.kind === "sol" ? "sol" : choice.mints.join(",")}`;
  if (write("local", BASKET_KEY, value)) notify();
}

export function subscribeOnboarding(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: the mirror outlives a stubbed window otherwise. */
export function clearOnboardingMirror(): void {
  mirror.clear();
}
