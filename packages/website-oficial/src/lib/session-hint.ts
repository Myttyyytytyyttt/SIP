/**
 * A HINT THAT A SESSION EXISTS — and nothing else.
 *
 * THE PROBLEM IT SOLVES. Privy answers `ready` a few hundred milliseconds after
 * the page mounts. Until then this app knows nothing, and `/` showed the
 * landing: so a connected person coming back from another page watched the
 * front door flash past and then got dropped into their pension. The state was
 * never wrong, only unknowable that early.
 *
 * WHY A COOKIE and not localStorage. The server renders this page, and only a
 * cookie is readable BEFORE the first paint. Anything read in the browser is
 * read after React has already committed a tree, which is the flash again —
 * and reading it during render instead would be a hydration mismatch.
 *
 * WHAT IT IS NOT. It is not authentication, it carries no identity, and
 * nothing is granted on the strength of it: the one thing it changes is
 * whether an unknowable moment shows the front door or a skeleton. Forging it
 * gets you a skeleton, which resolves to the connect card the moment Privy
 * answers. It holds no address — this app keeps no copy of who you are, which
 * is why a disconnect is a disconnect.
 */

export const SESSION_HINT_COOKIE = "sip.session";

/** Thirty days: long enough to outlive a Privy session, short enough to expire. */
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** True when the cookie header carries the hint. Written for the server's own reader. */
export function hasSessionHint(value: string | undefined | null): boolean {
  return value === "1";
}

/**
 * Writes or clears the hint from the browser. `SameSite=Lax` because nothing
 * cross-site should ever set it, and no `Secure` on localhost, where there is
 * no https to be secure on.
 */
export function rememberSession(remember: boolean): void {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  const age = remember ? MAX_AGE_SECONDS : 0;
  document.cookie = `${SESSION_HINT_COOKIE}=${remember ? "1" : ""}; Path=/; Max-Age=${age}; SameSite=Lax${secure}`;
}
