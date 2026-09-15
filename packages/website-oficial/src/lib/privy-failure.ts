/**
 * WHAT PRIVY SAID, IN WORDS SOMEONE CAN ACT ON.
 *
 * Privy fails in two shapes. Login hands a PrivyErrorCode string to its onError
 * callback; every wallet method (createWallet, addSigners, exportWallet) rejects
 * with an Error whose message is the only thing that says why. The messages
 * matched below were read from @privy-io/react-auth 3.36.0's own bundle
 * (usePrivy-*.mjs, index-*.mjs, use-export-wallet-*.mjs). A failure that matches
 * none of them is shown as Privy wrote it — never swallowed, never a blank.
 *
 * Client-safe and pure: no React, and nothing imported from Privy at runtime.
 */

export type PrivyFailureKind =
  /** The person closed Privy's dialog. Not a failure, and nothing is shown. */
  | "exited"
  /** The Privy app runs wallets on the device, and signers exist only in TEE execution. */
  | "tee"
  /** A new wallet has not reached Privy's record of the user yet; asking again shortly works. */
  | "propagating"
  /** Privy's wallet frame on auth.privy.io is not loaded, so no wallet call can run. */
  | "frame"
  | "rate"
  | "session"
  /** This site's address is not an allowed origin of the Privy app. */
  | "origin"
  /** Privy refused the keeper's signer or its policy. */
  | "refused"
  | "other";

export interface PrivyFailure {
  readonly kind: PrivyFailureKind;
  /** What to show. Empty only for "exited". */
  readonly message: string;
}

/** The variables a refused seat points at, named so the fix needs no guessing. */
const SEAT_VARIABLES = "SIP_SOLANA_PRIVY_SIGNER_ID and SIP_SOLANA_PRIVY_POLICY_ID";

/** Privy's text for a failure: the code a login reports, or an Error's message plus the code it carries. */
function rawText(error: unknown): string {
  if (typeof error === "string") return error.trim();
  if (error instanceof Error) {
    const code = (error as { privyErrorCode?: unknown }).privyErrorCode;
    return [error.message, typeof code === "string" ? code : ""].filter((part) => part !== "").join(" ").trim();
  }
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message.trim();
  }
  return "";
}

/**
 * The failure, classified. ORDER MATTERS: "must be authenticated and have an
 * embedded wallet to add a session signer" mentions a signer but is the
 * propagation race, and the TEE refusal mentions signers too — both are matched
 * before the signer-or-policy refusal is.
 */
export function privyFailure(error: unknown): PrivyFailure {
  const raw = rawText(error);

  if (/exited_|_exited|exited the|user exited/i.test(raw)) return { kind: "exited", message: "" };

  if (/only supported for TEE execution/i.test(raw)) {
    return {
      kind: "tee",
      message:
        "This Privy app creates wallets on the device, and the keeper's seat needs Privy's TEE execution. Nothing was " +
        "seated. Turn on TEE execution for the app in the Privy dashboard, then try again.",
    };
  }

  if (/not associated with current user|have an embedded wallet to add a session signer/i.test(raw)) {
    return {
      kind: "propagating",
      message: "Privy has not finished recording this wallet on your account. Try again in a moment.",
    };
  }

  if (/wallet proxy not initialized|failed to connect to wallet proxy/i.test(raw)) {
    return {
      kind: "frame",
      message:
        "Privy's wallet frame (auth.privy.io) has not loaded, so nothing was sent. Reload the page. If it keeps " +
        "happening, check that this site's address is an allowed origin of the Privy app.",
    };
  }

  if (/too_many_requests|too many requests|\b429\b/i.test(raw)) {
    return { kind: "rate", message: "Privy is limiting requests from this session. Wait a minute, then try again." };
  }

  if (/must_be_authenticated|must be authenticated/i.test(raw)) {
    return { kind: "session", message: "Your session has ended. Connect your pension key again." };
  }

  if (/invalid_origin|origin not allowed|not an allowed origin/i.test(raw)) {
    return {
      kind: "origin",
      message: "Privy does not allow this site's address yet. Add it to the app's allowed origins in the Privy dashboard.",
    };
  }

  if (/signer|key quorum|polic(y|ies)/i.test(raw)) {
    return {
      kind: "refused",
      message: `Privy refused the keeper's signer or its policy: “${raw}”. Check ${SEAT_VARIABLES} against the Privy dashboard.`,
    };
  }

  return { kind: "other", message: raw === "" ? "Privy did not say why." : `Privy said: “${raw}”.` };
}
