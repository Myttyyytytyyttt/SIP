// Will this wallet actually settle? — the Solana answer.
//
// SAME DOCTRINE AS THE EVM CHECKLIST, and it is the whole point of the file:
// only `pass` may look like a tick, and `unknown` always carries its reason, so
// a reader can never mistake "we could not check this" for "this is fine". A
// savings product whose keeper quietly does nothing is indistinguishable from
// one that is working, right up until someone asks where their money is — this
// is how a user finds out first.
//
// WHAT IT CANNOT SEE, IT SAYS IT CANNOT SEE. Two conditions decide whether a
// settlement succeeds and neither is on chain: whether the trading wallet
// granted the keeper's session signer (a Privy fact), and whether the keeper is
// running at all. The first is checked server-side where the credentials live;
// the second is honestly reported as unverifiable from here.

import type { Check, CheckStatus, Verdict } from "./diagnostics-types";
import type { SolanaInvestmentPolicyState, SolanaStock, SolanaTradingLinkState, SolanaVaultState } from "./solana";

export interface SolanaDiagnosticsInput {
  /** Null when the vault does not exist yet. */
  readonly vault: SolanaVaultState | null;
  /** Null when the vault read failed — different from absent. */
  readonly vaultReadFailed: boolean;
  /** This owner's vault PDA, to check the link actually points at it. */
  readonly vaultAddress: string;
  /** The link for the wallet being asked about, or null when unlinked. */
  readonly link: SolanaTradingLinkState | null;
  /**
   * True when the link account could not be READ — a different fact from
   * "there is no link", and the difference is a whole verdict: an unread link
   * announced as absent tells a settling user they are not linked and sends
   * them to re-run a step the chain must refuse.
   */
  readonly linkReadFailed: boolean;
  /** The trading wallet in question, if the caller named one. */
  readonly wallet: string | null;
  /**
   * Whether that wallet has granted the keeper's signer. Null = not checked
   * (no wallet named, or the Privy lookup itself failed) — never assumed.
   */
  readonly signerGranted: boolean | null;
  readonly signerDetail: string | null;
  readonly policy: SolanaInvestmentPolicyState | null;
  readonly policyReadFailed: boolean;
  /**
   * Mints the keeper has a pool for, or NULL when this surface cannot see the
   * keeper's registry at all.
   *
   * THE DISTINCTION IS THE WHOLE POINT. The pool registry lives in the
   * keeper's environment, not the website's, so an empty list here usually
   * means "not visible from here" rather than "the keeper has none" — and
   * rendering the second as a red cross tells a user their stock will never be
   * bought when it is being bought right now. Absent the list, the check
   * reports unknown, which is what it actually is.
   */
  readonly investablePools: readonly string[] | null;
  readonly stocks: readonly SolanaStock[];
}

const symbolFor = (mint: string, stocks: readonly SolanaStock[]): string =>
  stocks.find((stock) => stock.mint === mint)?.symbol ?? `${mint.slice(0, 8)}…`;

export function buildSolanaChecks(input: SolanaDiagnosticsInput): readonly Check[] {
  const checks: Check[] = [];
  const add = (
    id: string,
    label: string,
    severity: Check["severity"],
    status: CheckStatus,
    detail: string,
    meaning: string,
    source: string,
    scope: Check["scope"],
  ) => checks.push({ id, label, severity, status, detail, meaning, source, scope });

  // ── the vault ─────────────────────────────────────────────────────────────
  if (input.vaultReadFailed) {
    add(
      "vault-exists",
      "Your vault exists",
      "blocking",
      "unknown",
      "the vault account could not be read",
      "Nothing below could be checked either. This is a failed read, not a missing vault.",
      "PDA [\"vault\", owner]",
      "vault",
    );
    return checks;
  }
  if (input.vault === null) {
    add(
      "vault-exists",
      "Your vault exists",
      "blocking",
      "fail",
      "no vault account at this owner's address",
      "Create the vault first — everything else settles into it.",
      "create_vault",
      "vault",
    );
    return checks;
  }

  add(
    "vault-exists",
    "Your vault exists",
    "blocking",
    "pass",
    `created, saving ${input.vault.skimBps / 100}% of realised profit`,
    "Settlements have somewhere to land.",
    "PDA [\"vault\", owner]",
    "vault",
  );

  add(
    "vault-not-paused",
    "Saving is switched on",
    "blocking",
    input.vault.paused ? "fail" : "pass",
    input.vault.paused ? "the vault is paused" : "not paused",
    input.vault.paused
      ? "The keeper will not settle or invest while this is on. Withdrawing still works — pause never blocks the exit."
      : "The keeper may settle and invest.",
    "settle / invest require !vault.paused",
    "vault",
  );

  // ── the link ──────────────────────────────────────────────────────────────
  if (input.wallet === null) {
    // NOT `na`. "No wallet named" is an UNMET requirement, not an
    // inapplicable one — and the verdict only counts fail/unknown, so `na`
    // here made the checklist announce "This wallet will settle" in bold to a
    // user with nothing linked. That is precisely the belief this screen
    // exists to prevent.
    add(
      "wallet-linked",
      "A trading wallet is linked",
      "blocking",
      "fail",
      "no trading wallet yet",
      "Nothing is measured until you link the wallet you trade with.",
      "link_wallet",
      "account",
    );
  } else if (input.linkReadFailed) {
    add(
      "wallet-linked",
      "A trading wallet is linked",
      "blocking",
      "unknown",
      "the link account could not be read",
      "NOT verified. This is a failed read, not a missing link — refresh before changing anything.",
      'PDA ["link", wallet]',
      "account",
    );
  } else if (input.link === null) {
    add(
      "wallet-linked",
      "A trading wallet is linked",
      "blocking",
      "fail",
      `${input.wallet.slice(0, 8)}… has no link account`,
      "Until it is linked, the keeper does not know this wallet exists.",
      "PDA [\"link\", wallet]",
      "account",
    );
  } else {
    // The link existing is not the question — ["link", wallet] is GLOBAL, one
    // per wallet forever, so a wallet linked to someone else's vault has a
    // perfectly healthy link that will never feed THIS one.
    const mine = input.link.vault === input.vaultAddress;
    add(
      "wallet-linked",
      "A trading wallet is linked",
      "blocking",
      mine ? "pass" : "fail",
      mine
        ? `linked, ${input.link.settlementNonce} settlement(s) so far`
        : `linked to a different vault (${input.link.vault.slice(0, 8)}…)`,
      mine
        ? "The keeper discovers this wallet from the chain on every sweep."
        : "A wallet links to exactly one vault, ever. Unlink it there before it can feed this one.",
      'PDA ["link", wallet]',
      "account",
    );
    add(
      "link-frontier",
      "Settled up to",
      "info",
      "note",
      input.link.frontierSlot === "0"
        ? "nothing settled yet — the first sweep measures from the link's creation"
        : `slot ${input.link.frontierSlot}`,
      "Profit before this point is already accounted for and cannot be settled twice.",
      "TradingLink.frontier_slot",
      "account",
    );
  }

  // ── the keeper's signer: not on chain, and it decides everything ───────────
  if (input.wallet === null) {
    add(
      "keeper-signer",
      "The keeper can sign for that wallet",
      "blocking",
      "fail",
      "no trading wallet yet",
      "settle() is pushed BY the trading wallet, so there must be one before it can grant anything.",
      "Privy session signer",
      "account",
    );
  } else if (input.signerGranted === null) {
    add(
      "keeper-signer",
      "The keeper can sign for that wallet",
      "blocking",
      "unknown",
      input.signerDetail ?? "the check could not be run",
      "NOT verified. Without this the keeper discovers the wallet and Privy refuses every settlement.",
      "Privy session signer",
      "account",
    );
  } else {
    add(
      "keeper-signer",
      "The keeper can sign for that wallet",
      "blocking",
      input.signerGranted ? "pass" : "fail",
      input.signerDetail ?? (input.signerGranted ? "the keeper's signer is registered" : "no signer registered"),
      input.signerGranted
        ? "settle() is pushed BY the wallet; the keeper holds a signer bounded to this program."
        : "The keeper will find this wallet and be refused by Privy every sweep. Re-run the trading-wallet step to grant it.",
      "Privy session signer",
      "account",
    );
  }

  // ── investing: optional, and its absence is not a failure ─────────────────
  if (input.policyReadFailed) {
    add(
      "invest-policy",
      "A basket is chosen",
      "warning",
      "unknown",
      "the policy account could not be read",
      "Saving is unaffected; buying could not be checked.",
      "PDA [\"invest\", vault]",
      "vault",
    );
  } else if (input.policy === null) {
    add(
      "invest-policy",
      "A basket is chosen",
      "warning",
      "warn",
      "no investment policy",
      "Profit is saved as SOL and stays that way. Choose a stock to have it bought automatically.",
      "invest requires the policy account",
      "vault",
    );
  } else {
    add(
      "invest-policy",
      "A basket is chosen",
      "warning",
      input.policy.enabled ? "pass" : "warn",
      input.policy.enabled
        ? input.policy.legs.map((leg) => `${leg.weightBps / 100}% ${symbolFor(leg.mint, input.stocks)}`).join(" · ")
        : "a policy exists but investing is switched off",
      input.policy.enabled
        ? "Settled savings are converted and bought automatically."
        : "Savings accumulate as SOL until investing is switched back on.",
      "InvestmentPolicy.enabled",
      "vault",
    );

    // A leg the keeper has no pool for is refused BY NAME — the user should
    // learn that here rather than from a log line they will never read. But
    // only when the registry is actually visible from this surface.
    if (input.investablePools === null) {
      add(
        "invest-pool",
        "The keeper can route that stock",
        "warning",
        "unknown",
        "the keeper's pool registry is not visible to this deployment",
        "NOT verified. The keeper may well have a route; this surface simply cannot see its registry.",
        "NUVEM_SOLANA_POOLS (keeper environment)",
        "protocol",
      );
    } else {
      const orphan = input.policy.legs.find((leg) => !input.investablePools!.includes(leg.mint));
      if (orphan !== undefined) {
        add(
          "invest-pool",
          "The keeper can route that stock",
          "warning",
          "fail",
          `no pool configured for ${symbolFor(orphan.mint, input.stocks)}`,
          "The keeper refuses to guess a route, so this leg is never bought. Savings still accumulate as SOL.",
          "NUVEM_SOLANA_POOLS",
          "protocol",
        );
      }
    }
  }

  return checks;
}

export function buildSolanaVerdict(checks: readonly Check[]): Verdict {
  const blocking = checks.filter((check) => check.severity === "blocking");
  const failures = blocking.filter((check) => check.status === "fail").length;
  const unknowns = blocking.filter((check) => check.status === "unknown").length;
  // Counts the SEVERITY, not the status: a warning-severity check that FAILS
  // (a policy leg with no pool, say) is a warning that fired, and counting
  // only status "warn" silently dropped it from the summary line.
  const warnings = checks.filter(
    (check) => check.severity === "warning" && (check.status === "warn" || check.status === "fail"),
  ).length;

  if (failures > 0) {
    return {
      kind: "blocked",
      headline: "This wallet will not settle",
      detail:
        failures === 1
          ? "One requirement below fails. Until it changes, the keeper cannot move your profit into savings."
          : `${failures} requirements below fail. Until they change, the keeper cannot move your profit into savings.`,
      failures,
      unknowns,
      warnings,
    };
  }
  if (unknowns > 0) {
    return {
      kind: "unverified",
      headline: "Cannot say whether this wallet will settle",
      detail:
        "Something below could not be checked, and an unchecked requirement is not a satisfied one. " +
        "Refresh; if it persists, the reason is shown against the check.",
      failures,
      unknowns,
      warnings,
    };
  }
  return {
    kind: "settleable",
    headline: "This wallet will settle",
    detail:
      warnings > 0
        ? "Every requirement holds. The warnings below do not block saving, but they change what happens to it."
        : "Every requirement holds. The keeper measures realised profit each sweep and saves your share.",
    failures,
    unknowns,
    warnings,
  };
}
