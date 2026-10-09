"use client";

/**
 * "IMPORT A WALLET I ALREADY USE": paste, check, then one press that imports the
 * wallet seated and links it (src/lib/create-and-link.ts, importAndLinkFlow).
 *
 * A PANEL INSIDE THE TRADING WALLETS CARD, NOT A DIALOG. The card already lives
 * in the Manage wallets dialog, and a second Radix dialog on top of it fights it
 * for focus (WalletsModal.tsx says why); the panel takes the card's body instead.
 *
 * THE KEY NEVER ENTERS REACT. The field is uncontrolled: its value is read from
 * the element when it changes, judged (src/lib/import-key.ts), and only the
 * verdict — an address, or why not — goes into state. Nothing a DevTools panel
 * or an error boundary could serialise holds it. The field is emptied by every
 * refusal after Check, Use another key, Never mind, the press itself and
 * unmount, and the moment it is recognised as a recovery phrase or a whole EVM
 * key; a text the judge refuses otherwise stays, so a key being typed is not
 * wiped under the person's fingers.
 *
 * NOT A PASSWORD FIELD. A browser's own password manager can offer to save what
 * a password field held once it disappears after a request — exactly what the
 * press does — and "new-password" invites that. So it is a text field, masked
 * with -webkit-text-security, autocomplete "off", and the ignore attributes of
 * three password managers and of Grammarly. The browser is not invited to save
 * it. What a text field gives up: a phone keyboard may learn what is TYPED into
 * it (pasting is the way in), and where the masking is not supported the key
 * shows as typed.
 *
 * EVERY CHECK BEFORE THE PRESS (src/lib/import-preflight.ts): the seat, the
 * pension key, a wallet already here, the cap, then the chain — a vault the key
 * owns, a link elsewhere — read from the ADDRESS (/api/solana-vault importCheck).
 * Holdings besides SOL are listed and must be acknowledged (owner, 10-08).
 *
 * THE PRESS JUDGES THE KEY AGAIN. The text is taken from the field once, the
 * field emptied, and the flow's takeKey hands Privy the key only if it still
 * opens the address every check ran on.
 */

import { usePrivy } from "@privy-io/react-auth";
import { LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useSolanaConfig } from "@/app/providers";
import { Button } from "@/components/ui/button";
import { AddressLine } from "@/components/wallets/AddressLine";
import { useVaultScreen } from "@/hooks/use-vault-state";
import { formatSol } from "@/lib/amounts";
import { pressPlan } from "@/lib/create-and-link";
import { isForeignSecret, judgePastedKey, privateKeyForImport, type PastedKey } from "@/lib/import-key";
import { HOLDINGS_COPY, importPreflight, startingPointLine, type HoldingsNotice, type Preflight } from "@/lib/import-preflight";
import { symbolOfMint } from "@/lib/live-symbols";
import type { ImportAndLinkOutcome } from "@/lib/create-and-link";
import { createRefusal, hasCreateRoot } from "@/lib/trading-wallets";
import { CREATE_LINK_COPY, IMPORT_LINK_COPY, IMPORT_PANEL_COPY, VAULT_COPY, shortAddress } from "@/lib/vault-copy";

/** Holdings listed by name before the rest are counted: a wallet can hold hundreds. */
const LISTED_HOLDINGS = 8;

type Review = { readonly address: string; readonly verdict: Extract<Preflight, { kind: "go" }> };

export interface ImportRequest {
  readonly takeKey: () => Promise<string | null>;
  readonly expected: string;
  readonly needsLink: boolean;
  /** Whether the press goes on to a link (needsLink and the chain can take one): the progress ladder shows its steps only then. */
  readonly links: boolean;
}

export function ImportWalletPanel({
  disabled,
  onImport,
  onClose,
}: {
  /** Another write holds the screen, or one is waiting for confirmation: nothing may start. */
  readonly disabled: boolean;
  readonly onImport: (request: ImportRequest) => void;
  readonly onClose: () => void;
}) {
  const config = useSolanaConfig();
  const { user } = usePrivy();
  const screen = useVaultScreen();
  const fieldId = useId();
  const field = useRef<HTMLInputElement>(null);
  const judged = useRef(0);
  const [verdict, setVerdict] = useState<PastedKey>({ kind: "empty" });
  /** A text is being judged: Check waits for its verdict, and a refusal stays on screen meanwhile (a key's address does not). */
  const [judging, setJudging] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  /** Empties the field and forgets every verdict about what it held. */
  const clearKey = () => {
    judged.current += 1;
    if (field.current !== null) field.current.value = "";
    setVerdict({ kind: "empty" });
    setJudging(false);
  };

  // Whatever way the panel goes, the key goes with it.
  useEffect(() => {
    const element = field.current;
    return () => {
      if (element !== null) element.value = "";
    };
  }, []);

  const onInput = () => {
    const text = field.current?.value ?? "";
    const turn = (judged.current += 1);
    setRefusal(null);
    // At once, before the judge answers: Check must not act on the previous text's verdict. A refusal stays on screen
    // until the new verdict replaces it, so it is not withdrawn and re-announced on every keystroke.
    setJudging(true);
    void judgePastedKey(text).then((next) => {
      // A later keystroke has already been judged: this verdict is about a text that is gone.
      if (judged.current !== turn) return;
      setVerdict(next);
      setJudging(false);
      // A recovery phrase, or a whole EVM key, is a secret of its own and no step towards a Solana key: it goes now.
      if (isForeignSecret(text, next) && field.current !== null) field.current.value = "";
    });
  };

  const check = async () => {
    if (verdict.kind !== "key" || screen === null) return;
    const address = verdict.address;
    const local = importPreflight({ address, pensionKey: screen.pensionKey, user, config, check: null });
    if (local.kind === "refused") {
      clearKey();
      setRefusal(local.message);
      return;
    }
    setChecking(true);
    const turn = judged.current;
    const answer = await screen.api.importCheck({ owner: screen.pensionKey, wallet: address });
    setChecking(false);
    // The field was emptied or closed meanwhile: this answer is about a key that is gone.
    if (judged.current !== turn) return;
    const decided = importPreflight({ address, pensionKey: screen.pensionKey, user, config, check: answer.ok ? answer.body : "unreadable" });
    if (decided.kind === "go") {
      setReview({ address, verdict: decided });
      setAcknowledged(false);
      return;
    }
    clearKey();
    setRefusal(decided.kind === "refused" ? decided.message : null);
  };

  // The field is disabled during review: focus waits for the render that enables it.
  const refocus = useRef(false);
  useEffect(() => {
    if (review !== null || !refocus.current) return;
    refocus.current = false;
    field.current?.focus();
  }, [review]);

  const otherKey = () => {
    clearKey();
    setReview(null);
    setRefusal(null);
    refocus.current = true;
  };

  const close = () => {
    clearKey();
    onClose();
  };

  const press = () => {
    if (review === null) return;
    // The text leaves the field here, once; `held` lets takeKey drop it the moment Privy has it.
    let held: string | null = field.current?.value ?? "";
    clearKey();
    const expected = review.address;
    onImport({
      expected,
      needsLink: review.verdict.needsLink,
      links: review.verdict.needsLink && pressPlan(screen?.view ?? null).links,
      takeKey: async () => {
        const text = held ?? "";
        held = null;
        const again = await judgePastedKey(text);
        return again.kind === "key" && again.address === expected ? privateKeyForImport(text) : null;
      },
    });
    onClose();
  };

  const view = screen?.view ?? null;
  const plan = pressPlan(view);
  const go = review?.verdict ?? null;
  const ahead =
    go === null ? null : !go.needsLink ? IMPORT_PANEL_COPY.aheadLinked : plan.links ? IMPORT_PANEL_COPY.ahead(plan.linkRent === null ? null : formatSol(plan.linkRent)) : IMPORT_PANEL_COPY.aheadImportOnly(plan.reason);
  const mustAcknowledge = go?.holdings != null;
  const pressLabel = go !== null && go.needsLink && plan.links ? IMPORT_PANEL_COPY.importAndLink : IMPORT_PANEL_COPY.importOnly;

  return (
    <section aria-labelledby={`${fieldId}-title`} data-import-panel={review === null ? "paste" : "review"} className="space-y-3 rounded-md border px-3 py-3 text-sm">
      <h3 id={`${fieldId}-title`} className="font-medium">
        {IMPORT_PANEL_COPY.title}
      </h3>
      <div className="space-y-1.5 text-xs text-muted-foreground">
        <p>{IMPORT_PANEL_COPY.intro}</p>
        <p>{IMPORT_PANEL_COPY.copy}</p>
        <p>{IMPORT_PANEL_COPY.travel}</p>
        <p>{IMPORT_PANEL_COPY.login}</p>
        <p>{IMPORT_PANEL_COPY.permission}</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor={fieldId} className="text-xs font-medium">
          {IMPORT_PANEL_COPY.field}
        </label>
        {/* Not inside a <form>: a browser must not read this as a login to remember. */}
        <input
          ref={field}
          id={fieldId}
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore=""
          data-bwignore=""
          data-lpignore="true"
          data-gramm="false"
          data-gramm_editor="false"
          data-enable-grammarly="false"
          data-form-type="other"
          placeholder={IMPORT_PANEL_COPY.placeholder}
          disabled={review !== null || checking}
          onInput={onInput}
          className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 font-mono text-sm shadow-xs outline-none [-webkit-text-security:disc] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
        />
        {verdict.kind === "refused" ? (
          <p role="alert" data-key-verdict={verdict.reason} className="text-xs text-destructive">
            {verdict.message}
          </p>
        ) : null}
        {verdict.kind === "key" && review === null && !judging ? (
          <div data-key-verdict="key" className="space-y-1 text-xs">
            <p className="text-muted-foreground">{IMPORT_PANEL_COPY.opens}</p>
            <AddressLine address={verdict.address} />
            <p className="text-muted-foreground">{IMPORT_PANEL_COPY.expect}</p>
          </div>
        ) : null}
      </div>

      {refusal !== null ? (
        <p role="alert" data-import-refusal="" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {refusal}
        </p>
      ) : null}

      {review !== null && go !== null ? (
        <ImportReview
          address={review.address}
          verdict={go}
          // Only on an account with no Privy wallet yet: where Create is already refused, the card says so.
          noCreatedYet={!hasCreateRoot(user) && createRefusal(user) === null}
          ahead={ahead}
          acknowledged={acknowledged}
          onAcknowledge={setAcknowledged}
        />
      ) : null}

      <div className="flex flex-wrap gap-2">
        {review === null ? (
          <Button type="button" size="sm" disabled={verdict.kind !== "key" || judging || checking || screen === null} aria-busy={checking} onClick={() => void check()}>
            {checking ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : null}
            {checking ? IMPORT_PANEL_COPY.checking : IMPORT_PANEL_COPY.check}
          </Button>
        ) : (
          <>
            <Button type="button" size="sm" disabled={disabled || (mustAcknowledge && !acknowledged)} onClick={() => press()}>
              {pressLabel}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => otherKey()}>
              {IMPORT_PANEL_COPY.otherKey}
            </Button>
          </>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={() => close()}>
          {IMPORT_PANEL_COPY.cancel}
        </Button>
      </div>
      {checking ? <p className="text-xs text-muted-foreground">{IMPORT_PANEL_COPY.reading}</p> : null}
    </section>
  );
}

/**
 * The review before the press, from the preflight's verdict alone — pure, so its every shape is tested
 * (ImportWalletPanel.test.ts). The SOL starting point is said only for a new link: one already in place measures
 * from its own start or last saving. The line on SOL coming back from other apps is said on every import, in the
 * words that fit it.
 */
export function ImportReview({
  address,
  verdict,
  noCreatedYet,
  ahead,
  acknowledged,
  onAcknowledge,
}: {
  readonly address: string;
  readonly verdict: Extract<Preflight, { kind: "go" }>;
  readonly noCreatedYet: boolean;
  readonly ahead: string | null;
  readonly acknowledged: boolean;
  readonly onAcknowledge: (value: boolean) => void;
}) {
  const startingPoint = verdict.needsLink ? startingPointLine(verdict.lamports) : null;
  return (
    <div className="space-y-3">
      <div className="space-y-1 text-xs">
        <p className="text-muted-foreground">{IMPORT_PANEL_COPY.opens}</p>
        <AddressLine address={address} />
        {startingPoint !== null ? <p className="text-muted-foreground">{startingPoint}</p> : null}
        <p data-elsewhere="" className="text-muted-foreground">
          {verdict.needsLink ? HOLDINGS_COPY.elsewhere : HOLDINGS_COPY.elsewhereLinked}
        </p>
      </div>
      {verdict.holdings !== null ? <HoldingsList notice={verdict.holdings} linked={!verdict.needsLink} acknowledged={acknowledged} onAcknowledge={onAcknowledge} /> : null}
      {noCreatedYet ? (
        <p data-no-created-yet="" className="text-xs text-muted-foreground">
          {IMPORT_PANEL_COPY.noCreatedYet}
        </p>
      ) : null}
      {ahead !== null ? <p className="text-xs text-muted-foreground">{ahead}</p> : null}
    </div>
  );
}

/**
 * What the wallet holds besides SOL, and the acknowledgement the press waits for, in three shapes with their own
 * words: tokens (a few named, the rest counted), a listing too large to read (closing accounts said outright: there
 * are thousands), and empty token accounts alone.
 */
export function HoldingsList({
  notice,
  linked = false,
  acknowledged,
  onAcknowledge,
}: {
  readonly notice: HoldingsNotice;
  /** Already linked to this vault: nothing done before the import keeps a sale out of the measure, so no "before you import" advice. */
  readonly linked?: boolean;
  readonly acknowledged: boolean;
  readonly onAcknowledge: (value: boolean) => void;
}) {
  const checkboxId = useId();
  const shape = notice.count === null ? "too-many" : notice.count === 0 ? "empty-only" : "tokens";
  const shown = notice.holdings.slice(0, LISTED_HOLDINGS);
  const rest = (notice.count ?? 0) - shown.length;
  const title = shape === "too-many" ? HOLDINGS_COPY.titleTooMany : shape === "empty-only" ? HOLDINGS_COPY.titleEmptyOnly : HOLDINGS_COPY.title;
  const avoid = linked
    ? shape === "empty-only"
      ? HOLDINGS_COPY.avoidLinkedEmptyOnly
      : HOLDINGS_COPY.avoidLinked
    : shape === "too-many" ? HOLDINGS_COPY.avoidTooMany : shape === "empty-only" ? HOLDINGS_COPY.avoidEmptyOnly : HOLDINGS_COPY.avoid;
  const acknowledge = shape === "too-many" ? HOLDINGS_COPY.acknowledgeTooMany : shape === "empty-only" ? HOLDINGS_COPY.acknowledgeEmptyOnly : HOLDINGS_COPY.acknowledge;
  return (
    <div role="group" aria-labelledby={`${checkboxId}-title`} data-holdings={shape} className="space-y-2 rounded-md border border-amber-600/30 bg-amber-500/5 px-3 py-2 text-xs">
      <p id={`${checkboxId}-title`} className="font-medium">
        {title}
      </p>
      {shown.length > 0 ? (
        <ul className="space-y-0.5">
          {shown.map((holding) => (
            <li key={holding.tokenAccount} className="flex flex-wrap gap-x-1.5">
              <span className="font-mono">{holding.uiAmount === "" ? holding.amountRaw : holding.uiAmount}</span>
              <span>{symbolOfMint(holding.mint) ?? shortAddress(holding.mint)}</span>
            </li>
          ))}
          {rest > 0 ? <li className="text-muted-foreground">{IMPORT_PANEL_COPY.moreHoldings(rest)}</li> : null}
        </ul>
      ) : null}
      {shape === "empty-only" && notice.emptyAccounts !== null ? (
        <p className="text-muted-foreground">{HOLDINGS_COPY.emptyOnly(notice.emptyAccounts)}</p>
      ) : (
        <p className="text-muted-foreground">{HOLDINGS_COPY.body}</p>
      )}
      {shape === "too-many" ? <p className="text-muted-foreground">{HOLDINGS_COPY.tooManyClosing}</p> : null}
      {shape === "tokens" && notice.emptyAccounts !== null && notice.emptyAccounts > 0 ? <p className="text-muted-foreground">{HOLDINGS_COPY.emptyAccounts(notice.emptyAccounts)}</p> : null}
      <p className="text-muted-foreground">{avoid}</p>
      <label htmlFor={checkboxId} className="flex items-start gap-2">
        <input id={checkboxId} type="checkbox" checked={acknowledged} onChange={(event) => onAcknowledge(event.currentTarget.checked)} className="mt-0.5" />
        <span>{acknowledge}</span>
      </label>
    </div>
  );
}

/**
 * What the press ended in, in the card's words, like CreateAndLinkNote: nothing
 * when Privy's dialog was only closed; whenever a wallet was imported, that
 * first — it is on the account and in the list — then why it stopped. A link
 * that ran and stopped has its words in TxProgress already.
 */
export function ImportAndLinkNote({
  outcome,
  vaultRent,
  onGoToVault,
  onDismiss,
}: {
  readonly outcome: ImportAndLinkOutcome;
  readonly vaultRent: bigint | null;
  /** The way to the vault form, when the stop is "create your vault first"; null where there is none. */
  readonly onGoToVault: (() => void) | null;
  readonly onDismiss: () => void;
}) {
  const { stop, imported, link, alreadyLinked } = outcome;
  // The outcome the press announced, not a failure: said once, as a status.
  if (stop?.kind === "link_later") {
    return (
      <p role="status" data-outcome="link_later" className="text-xs text-muted-foreground">
        {stop.message}
      </p>
    );
  }
  if (stop === null) {
    if (alreadyLinked) {
      return (
        <p role="status" data-outcome="imported-already-linked" className="text-xs text-muted-foreground">
          {IMPORT_LINK_COPY.doneAlreadyLinked}
        </p>
      );
    }
    if (link === null || link.ok) return null;
    return (
      <p role="status" data-outcome="link-stopped" className="text-xs text-muted-foreground">
        {IMPORT_LINK_COPY.imported} {IMPORT_LINK_COPY.inTheList}
      </p>
    );
  }
  if (stop.message === null) return null;
  const needsVault = stop.gate === "needs_vault";
  return (
    <div role="alert" data-outcome={stop.kind} className="space-y-2 rounded-md border px-3 py-2 text-xs">
      {imported !== null ? (
        <p>
          {IMPORT_LINK_COPY.imported} {IMPORT_LINK_COPY.inTheList}
        </p>
      ) : null}
      {needsVault ? <p className="font-medium">{CREATE_LINK_COPY.needsVaultTitle}</p> : null}
      <p className="text-muted-foreground">{needsVault ? CREATE_LINK_COPY.needsVault(vaultRent === null ? null : formatSol(vaultRent)) : stop.message}</p>
      <div className="flex flex-wrap gap-2">
        {needsVault && onGoToVault !== null ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onGoToVault()}>
            {CREATE_LINK_COPY.goToVault}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" onClick={() => onDismiss()}>
          {VAULT_COPY.dismiss}
        </Button>
      </div>
    </div>
  );
}

