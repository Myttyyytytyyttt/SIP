"use client";

/**
 * THE ONE THING TO DO NEXT, and never a number.
 *
 * A pension that has not started yet has no figures worth showing, and the
 * failure this card exists to prevent is a screen full of honest zeroes that
 * reads as "it is broken". So each stage says what is missing, what it costs,
 * and which button fixes it — and the panels behind it stay hidden until there
 * is something real in them.
 *
 * IT NEVER OFFERS TO CREATE WHAT MAY ALREADY EXIST. `vault_unreadable` is not a
 * stage this card handles: a read that failed says nothing about whether a vault
 * is there, and a Create button on that state asks for a signature the chain
 * must refuse. The frame routes that to the unreadable card instead.
 *
 * THE COST IS NAMED BEFORE THE BUTTON IS PRESSED. Creating a vault spends rent
 * that does not come back, so the sentence carries the figure the chain just
 * quoted, and says plainly when it could not be read.
 *
 * THE SETUP STAYS IN VIEW THROUGH THE FIRST BUY (10-09). From the first wait
 * the card lists what is done and what comes next — vault created, a trading
 * wallet linked, the first saving, the first buy — and once the pension is
 * running it stays, ticked, until that first buy has happened. "First buy" is
 * listed only while one is on its way: a signed approval with buying on, or
 * stocks chosen on the setup and not approved yet. A pension kept as SOL, one
 * whose buying is off, or one the chain would refuse to buy for right now —
 * paused, an old price limit passed, caps no balance can clear (review,
 * 10-09) — is never promised a buy, and its card ends at the first saving as
 * it always did. While the first saving is still to come it says since when
 * it has been awaited — the link that started the wait, dated when not today
 * (waitingSinceOf) — and nothing when the loaded history cannot say.
 *
 * ONE CARD, NEVER TWO (10-09, G8). In the pension view's top column
 * (`animate`), the card grows in, swaps its height from one stage's card to the
 * next one's, and closes when there is nothing left to do (Reveal.tsx) — it
 * used to pop in and out at full height and push the page under it.
 *
 * WHAT WAS JUST SIGNED IS NOT OFFERED AGAIN (10-09, plan B4). The vault is
 * created in the wallets modal, a wallet linked there too; until the page
 * shows it, the stage — and its button — stayed as they were. Now, from the
 * landing until the page shows it, the button that would sign it again gives
 * way to "Vault created · reading it from Solana…" (a link: "Signed · updating
 * your pension…"), and past the cap to the still "Signed at 14:32 UTC · not
 * on this page yet" (last-write-context.ts stageWrite, SyncLine.tsx).
 */

import { Circle, CircleCheck } from "lucide-react";
import type { ReactNode } from "react";

import { HeightSwap, Reveal } from "@/components/live/Reveal";
import { SyncLine } from "@/components/live/SyncLine";
import { stageWrite, type WriteSync } from "@/components/live/last-write-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useBasketChoice } from "@/hooks/use-onboarding-closed";
import { formatSol } from "@/lib/amounts";
import { whenLabel } from "@/lib/format";
import { requestImport } from "@/lib/import-intent";
import { LIVE_COPY } from "@/lib/live-copy";
import type { LiveDashboard } from "@/lib/live-types";
import { basketOnShelf } from "@/lib/onboarding";
import type { BasketChoice } from "@/lib/onboarding-memory";
import { cn } from "@/lib/utils";
import { VAULT_COPY, ratePercent, shortAddress } from "@/lib/vault-copy";
import type { WalletsSection } from "@/lib/wallets-sections";

function Step({ label, done, note }: { readonly label: string; readonly done: boolean; readonly note?: string | null }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {done ? <CircleCheck className="size-4 text-emerald-700 dark:text-emerald-400" aria-hidden /> : <Circle className="size-4 text-muted-foreground" aria-hidden />}
      <span className={done ? "text-muted-foreground line-through" : undefined}>
        {label}
        {/* In the label's own run, so a narrow card wraps the sentence rather than squeezing the label. */}
        {note === undefined || note === null ? null : (
          <>
            {" "}
            <span className="text-muted-foreground">{note}</span>
          </>
        )}
      </span>
      <span className="sr-only">{done ? "done" : "not done yet"}</span>
    </li>
  );
}

/**
 * WHERE THE FIRST BUY STANDS: done (the policy has spent USDC), on its way (an
 * approval with buying on and nothing spent yet, or stocks chosen on the setup
 * and no approval signed), or "none" — nothing promised: a pension kept as SOL,
 * buying switched off, a policy that could not be read, or a buy the chain
 * would refuse until the owner changes something.
 *
 * "done" is decided before any stop on purpose: a first buy that happened
 * stays ticked even if the vault is paused later.
 */
export function firstBuyOf(data: Pick<LiveDashboard, "policy" | "vault" | "protocolPaused">, choice: BasketChoice | null): "none" | "ahead" | "done" {
  const { policy, vault, protocolPaused } = data;
  if (policy.status === "exists" && policy.lifetimeInvested !== null && policy.lifetimeInvested > 0n) return "done";
  // WHY (review, 10-09): invest.rs refuses while either pause switch is on, so
  // no buy is on its way and none is promised. A vault switch that could not be
  // read promises nothing either; the protocol's, unread, is claimed neither
  // way — as live-pending.ts turnRest reads them, in the same order.
  if (vault.paused !== false || protocolPaused === true) return "none";
  if (policy.status === "exists") {
    if (policy.lifetimeInvested === null || policy.enabled !== true) return "none";
    // A policy signed before 10-08 whose stock limit has passed refuses the
    // whole basket; caps that no balance can clear (one call's, or the 30-day
    // limit under what every leg needs) never buy. The SOL safety floor stops
    // only the conversion: USDC already held still buys, so it is no stop here.
    if (policy.oldLimitsStop === "basket" || policy.readiness?.state === "unreachable") return "none";
    if (policy.readiness !== null && policy.maxRolling30d !== null && policy.maxRolling30d < policy.readiness.investsAtRaw) return "none";
    return "ahead";
  }
  if (policy.status === "missing") return choice !== null && basketOnShelf(choice).kind === "stocks" ? "ahead" : "none";
  return "none";
}

/**
 * SINCE WHEN THE FIRST SAVING HAS BEEN AWAITED, in ms: when the wallets linked
 * to this vault were linked — each one's latest link, the earliest of those —
 * from the loaded history. Null unless that history holds a successful link
 * for EVERY wallet linked now: an older link it does not hold would make the
 * wait longer than said. Never guessed from when the vault was made, which can
 * be long before any wallet was linked.
 */
export function waitingSinceOf(data: Pick<LiveDashboard, "rows" | "wallets">): number | null {
  const linked = new Set(data.wallets.filter((wallet) => wallet.linkStatus === "this_vault").map((wallet) => wallet.address));
  if (linked.size === 0) return null;
  const latest = new Map<string, number>();
  for (const row of data.rows) {
    if (!row.ok || row.blockTime === null || row.event.kind !== "linked" || row.event.wallet === null || !linked.has(row.event.wallet)) continue;
    const at = row.blockTime * 1_000;
    if ((latest.get(row.event.wallet) ?? -Infinity) < at) latest.set(row.event.wallet, at);
  }
  return latest.size === linked.size ? Math.min(...latest.values()) : null;
}

/** What is done, from the chain, and what comes next. */
function SetupChecklist({ data, firstBuy }: { readonly data: LiveDashboard; readonly firstBuy: "none" | "ahead" | "done" }) {
  const copy = LIVE_COPY.setup;
  const saved = data.stage === "active";
  const since = saved ? null : waitingSinceOf(data);
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{copy.checklist}</p>
      <ul className="space-y-1.5">
        <Step label={copy.vault} done={data.vault.exists} />
        <Step label={copy.linked} done={data.wallets.some((wallet) => wallet.linkStatus === "this_vault")} />
        <Step label={copy.firstSaving} done={saved} note={since === null ? null : copy.waitingSince(whenLabel(since, data.nowMs))} />
        {firstBuy === "none" ? null : <Step label={copy.firstBuy} done={firstBuy === "done"} />}
      </ul>
    </div>
  );
}

/** The height of the button row a sync line stands in for: the card keeps its size when the line takes the buttons' place. */
const BUTTON_ROW = "min-h-8";

type NextStepProps = {
  readonly data: LiveDashboard;
  readonly pensionKey: string;
  /** Why no trading wallet can be created on this deployment, when that is so. */
  readonly seatProblem?: string | null;
  /**
   * Opens the Manage wallets modal on the section the stage needs. The type comes
   * from the leaf module: this card renders in the sample too, and must not pull
   * the wallets screen or Privy in with it.
   */
  readonly onOpenWallets: (section?: WalletsSection) => void;
  /** The page's verdict on the last signature (last-write-context.ts useWriteJudge). Absent or null: nothing to say. */
  readonly sync?: WriteSync | null;
  readonly className?: string;
};

export function LiveNextStep({
  animate = false,
  ...props
}: NextStepProps & {
  /** In a `gap-4` column on a page already drawn: grow in, swap stage cards by height, close (see the top of the file). */
  readonly animate?: boolean;
}) {
  const choice = useBasketChoice(props.pensionKey);
  const card = nextStepCard(props, choice);
  if (!animate) return card;
  return (
    <Reveal open={card !== null} inGap>
      <HeightSwap swapKey={props.data.stage}>{card}</HeightSwap>
    </Reveal>
  );
}

function nextStepCard({ data, pensionKey, seatProblem = null, onOpenWallets, sync = null, className }: NextStepProps, choice: BasketChoice | null): ReactNode {
  const { stage, vault, wallets, policy, rents, protocolPaused } = data;
  // `vault_unreadable` is the frame's to handle.
  if (stage === "vault_unreadable") return null;
  // The write that moves this stage on, landed and not on the page yet: said in place of the button that would sign it again.
  const signed = sync !== null && stageWrite(stage, sync.write) ? sync : null;
  const firstBuy = firstBuyOf(data, choice);
  // A running pension needs no card — until its first buy has happened, when one is on its way.
  if (stage === "active" && firstBuy !== "ahead") return null;

  const shell = (title: string, description: string, children?: ReactNode) => (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children === undefined ? null : <CardContent className="space-y-4">{children}</CardContent>}
    </Card>
  );

  if (stage === "no_vault") {
    const copy = LIVE_COPY.noVault;
    const short = shortAddress(pensionKey);
    const body = rents.vault === null ? `${copy.bodyNoRent(short)} ${VAULT_COPY.costUnknown}` : copy.body(short, formatSol(rents.vault));
    return shell(
      copy.title,
      body,
      <>
        {signed !== null ? (
          <SyncLine sync={signed} syncing={LIVE_COPY.syncing.vaultCreated} className={BUTTON_ROW} />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => onOpenWallets("vault")}>
              {copy.create}
            </Button>
            <Button type="button" variant="outline" asChild>
              <a href="/wallets?section=vault">{copy.openWallets}</a>
            </Button>
          </div>
        )}
        <div className="space-y-2">
          <p className="text-sm font-medium">{copy.checklist}</p>
          <ul className="space-y-1.5">
            <Step label={copy.steps[0]} done={vault.exists} />
            <Step label={copy.steps[1]} done={wallets.length > 0} />
            <Step label={copy.steps[2]} done={wallets.some((wallet) => wallet.linkStatus === "this_vault")} />
            <Step label={copy.steps[3]} done={policy.status === "exists"} />
          </ul>
        </div>
      </>,
    );
  }

  if (stage === "no_trading_wallet") {
    const copy = LIVE_COPY.noTradingWallet;
    // A deployment with no keeper seat cannot create one: say why, offer nothing.
    if (seatProblem !== null) return shell(copy.title, seatProblem);
    if (signed !== null) return shell(copy.title, copy.body, <SyncLine sync={signed} syncing={LIVE_COPY.syncing.signed} className={BUTTON_ROW} />);
    return shell(
      copy.title,
      copy.body,
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => onOpenWallets("trading")}>
          {copy.create}
        </Button>
        {/* The same tab, with its import panel already open (import-intent.ts). */}
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            requestImport();
            onOpenWallets("trading");
          }}
        >
          {copy.import}
        </Button>
      </div>,
    );
  }

  if (stage === "not_linked") {
    const copy = LIVE_COPY.notLinked;
    // The protocol's own state comes first: linking cannot work either way.
    if (protocolPaused === null) return shell(copy.title, copy.needsConfig);
    if (protocolPaused) return shell(copy.title, copy.paused);
    return shell(
      copy.title,
      // The link's rent is not in this snapshot, so the figure is left out
      // rather than guessed; the modal quotes it before anything is signed.
      copy.bodyNoRent(String(wallets.length)),
      // Each wallet's own row carries its Link to vault, in the trading wallets tab.
      signed !== null ? (
        <SyncLine sync={signed} syncing={LIVE_COPY.syncing.signed} className={BUTTON_ROW} />
      ) : (
        <Button type="button" onClick={() => onOpenWallets("trading")}>
          {copy.link}
        </Button>
      ),
    );
  }

  // Saving, and the first buy still ahead: the list, ticked, says what is left.
  if (stage === "active") {
    return shell(
      LIVE_COPY.firstBuy.title,
      policy.status === "exists" ? LIVE_COPY.firstBuy.body : LIVE_COPY.firstBuy.approve,
      <SetupChecklist data={data} firstBuy={firstBuy} />,
    );
  }

  // waiting_first_settlement
  const rate = vault.rateBps === null ? null : ratePercent(vault.rateBps);
  const short = wallets.filter((wallet) => wallet.canSettle === false && wallet.linkStatus === "this_vault");
  return shell(
    LIVE_COPY.waiting.title,
    rate === null ? LIVE_COPY.waiting.body("its rate") : LIVE_COPY.waiting.body(rate),
    <>
      {short.length === 0 ? null : (
        <ul className="space-y-1.5">
          {short.map((wallet) => (
            <li key={wallet.address} className={cn("text-sm text-amber-700 dark:text-amber-400")}>
              {wallet.label}: {vault.walletReserve === null ? "" : LIVE_COPY.reserveNote(formatSol(vault.walletReserve))}
            </li>
          ))}
        </ul>
      )}
      <SetupChecklist data={data} firstBuy={firstBuy} />
    </>,
  );
}
