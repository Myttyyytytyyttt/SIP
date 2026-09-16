// What `ready` can decide without asking anybody: the arming checks that were
// arithmetic and literals inline in bin/ready.mts, where no test could reach
// them.
//
// A CHECKLIST THAT PASSES A KEEPER THAT CANNOT WORK IS WORSE THAN NO CHECKLIST,
// because it is read once, before arming, and believed. Each rule here exists
// because a green `ready` once meant less than it looked: a crank funded just
// over the old fee line that wraps exactly zero for ever, an armed keeper whose
// critical pages reach nobody, an id pasted into the wrong variable and then
// served from /status as if it were right. None of them is visible afterwards —
// they look like a keeper that is simply quiet.
//
// NOTHING HERE PRINTS, AND NOTHING HERE ECHOES A VALUE. bin/ready.mts owns the
// words and the language; these functions answer with verdicts and numbers. A
// wrong id is described by shape() alone (src/config.ts), because the commonest
// way to hold a wrong id is to have pasted a secret into the variable.

import { shape } from "./config.js";
import { CRANK_WRAP_RESERVE_LAMPORTS, WRAP_DUST_LAMPORTS, wrapPlan } from "./invest-decision.js";

/**
 * A Privy id, as every id in this repository is written: the policy CLI's own
 * ID_SHAPE (src/privy-policy-cli.ts). Privy's ids are cuid-like — 24 or 25
 * lowercase alphanumeric characters for the app, the key quorum and the policy.
 */
export const PRIVY_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Under this, nothing is a Privy id.
 *
 * DELIBERATELY FAR BELOW the 24 characters every id SIP has ever held. The cost
 * of failing a real id here is an operator blocked in front of an arming
 * checklist that is wrong, which is worse than missing a wrong one — so this
 * catches only the values that cannot be an id at all, never a longer one it
 * merely disapproves of.
 */
export const PRIVY_ID_MIN_LENGTH = 8;

/**
 * Why `value` cannot be the Privy id `name` names, or null when it can be.
 *
 * WHAT IT ACTUALLY CATCHES, none of it hypothetical: a URL or a `did:privy:…`
 * user id pasted in (both carry characters an id never has), a quoted or
 * whitespace-padded value copied out of a dashboard, and the catastrophic one —
 * a signing key pasted into a public variable, which shape() names for what it
 * is and tells the operator to rotate.
 *
 * ITS VALUE NEVER APPEARS IN THE ANSWER, even though app ids and signer ids are
 * public: at the moment this fails, the one thing known about the value is that
 * it is not the public id it was supposed to be.
 */
export function privyIdProblem(name: string, value: string): string | null {
  if (value.trim() !== value) {
    return `${name} has whitespace around it: it holds ${shape(value)}. Copy the id alone.`;
  }
  if (value.length < PRIVY_ID_MIN_LENGTH || !PRIVY_ID_SHAPE.test(value)) {
    return `${name} is not a Privy id: it holds ${shape(value)}.`;
  }
  return null;
}

/**
 * The first pair of Privy variables holding the SAME id, or null when they all
 * differ.
 *
 * NO ID IS TWO THINGS. An app id is not a key quorum id and a key quorum id is
 * not a policy id, so one value in two of these variables is always a paste into
 * the wrong box — and the pair that matters most, the signer and its policy, is
 * the one the web already refuses (seatProblem, packages/website-oficial): a
 * signer "bounded" by itself is a signer bounded by nothing.
 */
export function privyIdCollision(entries: readonly (readonly [string, string | undefined])[]): string | null {
  const present = entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined);
  for (let i = 0; i < present.length; i += 1) {
    for (let j = i + 1; j < present.length; j += 1) {
      if (present[i]![1] === present[j]![1]) {
        return `${present[i]![0]} and ${present[j]![0]} hold the same id, and no id is both.`;
      }
    }
  }
  return null;
}

/** The balance at which a wrap stops being zero: the crank's reserve plus the dust floor. */
export const READY_CRANK_MINIMUM_LAMPORTS = CRANK_WRAP_RESERVE_LAMPORTS + WRAP_DUST_LAMPORTS;

/**
 * Below this the crank works, but fronts so little per sweep that a settled
 * vault is wrapped in slices for a long time and wrap-short warns about it.
 *
 * 0.1 SOL: not a rule the keeper enforces anywhere — it is this checklist's own
 * line, chosen so that one sweep can front about 0.08 SOL, well above the dust
 * floor. Only the minimum above is derived from the tick's own constants.
 */
export const READY_CRANK_COMFORTABLE_LAMPORTS = 100_000_000n;

export interface CrankHeadroom {
  /**
   * CANNOT_WRAP: every wrap this crank fronts would be zero, so settled SOL is
   * never wrapped, converted or invested. THIN: it works, in small slices.
   */
  readonly verdict: "CANNOT_WRAP" | "THIN" | "OK";
  /** What one wrap may front: the balance less the reserve, never below zero. */
  readonly allowance: bigint;
  readonly minimum: bigint;
}

/**
 * Whether the crank can front more than dust once its reserve is set aside.
 *
 * THE OLD CHECK DREW THE LINE IN THE WRONG PLACE. It passed any balance over
 * 0.02 SOL, which is exactly CRANK_WRAP_RESERVE_LAMPORTS — the amount wrapPlan
 * keeps back. A crank holding 0.021 SOL therefore printed a tick and an
 * allowance of 0.001 SOL, under WRAP_DUST_LAMPORTS, so every wrap resolved to
 * zero and nothing was ever invested. crank-low stayed silent above 0.02 SOL
 * too, so the only signal was a wrap-short warning three turns later.
 *
 * The allowance comes from wrapPlan itself, so this checklist and the turn that
 * moves the money cannot disagree about what a crank can front.
 */
export function crankHeadroom(lamports: bigint): CrankHeadroom {
  // `free` does not enter the allowance: wrapPlan derives it from the crank alone.
  const { allowance } = wrapPlan({ free: 0n, crankLamports: lamports });
  const verdict = allowance < WRAP_DUST_LAMPORTS ? "CANNOT_WRAP" : lamports < READY_CRANK_COMFORTABLE_LAMPORTS ? "THIN" : "OK";
  return { verdict, allowance, minimum: READY_CRANK_MINIMUM_LAMPORTS };
}

export type WebhookVerdict =
  /** Set to an http(s) URL: alerts have somewhere to go. */
  | "OK"
  /** Set to something that is not an http(s) URL — and loadConfig refuses to start with it. */
  | "NOT_HTTP"
  /** Unset while armed: every critical page would be a log line in Railway and nothing else. */
  | "MISSING_ARMED"
  /** Unset in a dry run, which the runbook allows. */
  | "MISSING_DRY";

/**
 * Whether the alert webhook is in a state worth arming with.
 *
 * ARMED WITHOUT IT, NOTHING WAKES ANYONE. Every escalation this keeper has —
 * settle-failed, invest-failed, wrap-short, crank-low, claim-lost, a seat
 * bounded by nothing — reaches a person only through this webhook; without it
 * they are log lines in Railway that nobody is watching at 3 a.m., and the
 * keeper's characteristic failure is an ABSENCE that looks like quiet. The
 * runbook marks it optional for the dry run, and it stays optional there.
 */
export function alertWebhookVerdict(raw: string | undefined, armed: boolean): WebhookVerdict {
  const value = raw?.trim() ?? "";
  if (value === "") return armed ? "MISSING_ARMED" : "MISSING_DRY";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "NOT_HTTP";
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? "OK" : "NOT_HTTP";
}
