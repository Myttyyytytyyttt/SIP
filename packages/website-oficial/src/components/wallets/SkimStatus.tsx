"use client";

import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { formatEther, type Address, type Hex } from "viem";

import { Num } from "@/components/num";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MONO, SAVED } from "@/lib/classes";
import { shortHex, timeAgo } from "@/lib/format";
import { parseTagged } from "@/lib/serialize";
import type { SkimPull, SkimWallet, SkimsResponse } from "@/lib/skims";
import { cn } from "@/lib/utils";

/**
 * What the rule has put aside per trading wallet, read from the worker's
 * ledger through /api/skims. Read-only: the numbers are the worker's, the
 * page only shows them.
 *
 * BEST EFFORT IS THE PRODUCT, NOT A BUG. The worker collects
 * min(owed, balance − reserve) and carries the rest forward, so a wallet full
 * of tokens after a buy shows "put aside 0.002 · collected 0 · pending 0.002"
 * until it sells. The description says so, in one line, so the column of
 * zeros reads as "waiting", not "broken".
 *
 * ABSENT IS NOT EMPTY. The route answers `unavailable` when there is no
 * database, no tables, or the query failed; that renders as a muted "Status
 * unavailable" — never as a row of zeros over money that really moved.
 *
 * HYDRATION. This client component renders a skeleton until the first answer
 * arrives (after mount), and `now` for the "ago" labels is taken inside the
 * effect, never during render — the server and the browser paint the same
 * skeleton.
 */

/** The worker runs every five minutes; a minute is plenty and keeps the read path quiet. */
const REFRESH_MS = 60_000;

type Answer =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "ledger";
      readonly wallets: readonly SkimWallet[];
      readonly explorerUrl: string | null;
      /** ISO, taken when the answer arrived; the reference for every "ago" below. */
      readonly now: string;
    };

const LOADING: Answer = { kind: "loading" };

async function fetchSkims(vault: Address, signal: AbortSignal): Promise<Answer> {
  try {
    const response = await fetch(`/api/skims?vault=${vault}`, { signal, cache: "no-store" });
    if (!response.ok) {
      return { kind: "unavailable", reason: `the status route answered ${response.status}` };
    }
    const body = parseTagged<SkimsResponse>(await response.text());
    if (body.source === "unavailable") return { kind: "unavailable", reason: body.reason };
    if (body.source !== "ledger" || !Array.isArray(body.wallets)) {
      return { kind: "unavailable", reason: "the status route answered something unexpected" };
    }
    return {
      kind: "ledger",
      wallets: body.wallets,
      explorerUrl: body.explorerUrl ?? null,
      now: new Date().toISOString(),
    };
  } catch (error) {
    if (signal.aborted) return LOADING; // the caller drops it
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Wei -> a short ETH string. Ported from HEAD's src/lib/format.ts `eth`
 * (fd927b0); trailing zeros dropped because these are amounts, not a column of
 * fixed width.
 */
function eth(value: bigint, maxDecimals = 9): string {
  const raw = formatEther(value);
  const dot = raw.indexOf(".");
  if (dot === -1) return `${raw} ETH`;
  const whole = raw.slice(0, dot);
  const trimmed = raw.slice(dot + 1, dot + 1 + maxDecimals).replace(/0+$/, "");
  if (trimmed !== "") return `${whole}.${trimmed} ETH`;
  // Rounding a non-zero amount down to "0 ETH" would be a lie in exactly the
  // place it matters most: a debt of a few wei is still a debt the next pull
  // carries forward, so it must not print as zero.
  if (value !== 0n) return `${value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} wei`;
  return `${whole} ETH`;
}

/** The worker's window states in the page's words; an unknown state is shown as it came. */
const WINDOW_LABEL: Readonly<Record<string, string>> = {
  OPEN: "window open",
  SIGNED: "pull signed",
  SUBMITTED: "pull sent",
  CONFIRMED: "pull confirmed",
  FAILED: "pull failed",
};

function windowLabel(status: string): string {
  return WINDOW_LABEL[status] ?? status.toLowerCase();
}

function txUrl(explorerUrl: string | null, hash: Hex): string | null {
  if (explorerUrl === null || explorerUrl === "") return null;
  return `${explorerUrl.replace(/\/+$/, "")}/tx/${hash}`;
}

interface Row {
  readonly address: Address;
  /** null: the worker has not seen this wallet yet — unknown, not zero. */
  readonly ledger: SkimWallet | null;
}

/**
 * One row per address: the page's wallets in the order given, then anything
 * the ledger knows that the page does not, so nothing the worker put aside is
 * ever hidden.
 */
function mergeRows(wallets: readonly Address[], ledger: readonly SkimWallet[]): readonly Row[] {
  const byAddress = new Map<string, SkimWallet>();
  for (const entry of ledger) byAddress.set(entry.address.toLowerCase(), entry);
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const address of wallets) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ address, ledger: byAddress.get(key) ?? null });
  }
  for (const entry of ledger) {
    const key = entry.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ address: entry.address, ledger: entry });
  }
  return rows;
}

/** The most recent sent pull across the vault: by timestamp when the ledger has one, else the first found. */
function latestPull(rows: readonly Row[]): { readonly wallet: Address; readonly pull: SkimPull } | null {
  let best: { readonly wallet: Address; readonly pull: SkimPull } | null = null;
  for (const row of rows) {
    const pull = row.ledger?.lastPull ?? null;
    if (pull === null) continue;
    if (best === null) {
      best = { wallet: row.address, pull };
      continue;
    }
    if (pull.at !== null && (best.pull.at === null || pull.at > best.pull.at)) {
      best = { wallet: row.address, pull };
    }
  }
  return best;
}

function TxLink({ hash, explorerUrl }: { hash: Hex; explorerUrl: string | null }) {
  const href = txUrl(explorerUrl, hash);
  const label = <Num>{shortHex(hash)}</Num>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {href === null ? (
          <span tabIndex={0} className="cursor-default">
            {label}
          </span>
        ) : (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
          >
            {label}
            <ExternalLink aria-hidden className="size-3" />
            <span className="sr-only">View transaction on the explorer</span>
          </a>
        )}
      </TooltipTrigger>
      <TooltipContent className={MONO}>{hash}</TooltipContent>
    </Tooltip>
  );
}

function Amount({ value, accent = false }: { value: bigint; accent?: boolean }) {
  return (
    <span className={cn(MONO, value === 0n ? "text-muted-foreground" : accent ? SAVED : undefined)}>
      {eth(value)}
    </span>
  );
}

export function SkimStatus({
  vault,
  wallets,
  explorerUrl,
  className,
}: {
  vault: Address;
  wallets: readonly Address[];
  /** Overrides the route's explorer when the page already has one from PublicConfig. */
  explorerUrl?: string | null;
  className?: string;
}) {
  const [answer, setAnswer] = useState<Answer>(LOADING);

  useEffect(() => {
    // A table left over from another vault is a claim about the wrong account.
    setAnswer(LOADING);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function ask(): Promise<void> {
      // A hidden tab keeps its place in the queue but does not query for it.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        timer = setTimeout(() => void ask(), REFRESH_MS);
        return;
      }
      const next = await fetchSkims(vault, controller.signal);
      if (controller.signal.aborted) return;
      setAnswer(next);
      timer = setTimeout(() => void ask(), REFRESH_MS);
    }

    void ask();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [vault]);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Put aside</CardTitle>
        <CardDescription>Collected when the wallet holds ETH; the rest carries forward.</CardDescription>
      </CardHeader>
      <CardContent>
        {answer.kind === "loading" ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading skim status">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : answer.kind === "unavailable" ? (
          <div className="space-y-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="w-fit cursor-default text-sm text-muted-foreground">
                  Status unavailable
                </span>
              </TooltipTrigger>
              <TooltipContent>{answer.reason}</TooltipContent>
            </Tooltip>
            <p className="text-xs text-muted-foreground">
              The ledger could not be read; nothing put aside is lost.
            </p>
          </div>
        ) : (
          <LedgerTable
            rows={mergeRows(wallets, answer.wallets)}
            explorerUrl={explorerUrl ?? answer.explorerUrl}
            now={answer.now}
          />
        )}
      </CardContent>
    </Card>
  );
}

function LedgerTable({
  rows,
  explorerUrl,
  now,
}: {
  rows: readonly Row[];
  explorerUrl: string | null;
  now: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No trading wallets yet.</p>;
  }
  const latest = latestPull(rows);

  return (
    <div className="space-y-3">
      <Table aria-label="Put aside, collected and pending per trading wallet">
        <TableHeader>
          <TableRow>
            <TableHead>Trading wallet</TableHead>
            <TableHead className="text-right">Put aside</TableHead>
            <TableHead className="text-right">Collected</TableHead>
            <TableHead className="text-right">Pending</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ address, ledger }) => (
            <TableRow key={address.toLowerCase()}>
              <TableCell>
                <span className="block">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={0} className={cn(MONO, "cursor-default")}>
                        {shortHex(address)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className={MONO}>{address}</TooltipContent>
                  </Tooltip>
                </span>
                <span className="block text-xs text-muted-foreground">
                  {ledger === null ? (
                    "not observed yet"
                  ) : ledger.lastWindow === null ? (
                    "no fills yet"
                  ) : (
                    <>
                      <Num>{eth(ledger.lastWindow.sumNotionalWei)}</Num> notional ·{" "}
                      {windowLabel(ledger.lastWindow.status)}
                    </>
                  )}
                </span>
              </TableCell>
              {ledger === null ? (
                <>
                  <TableCell className={cn(MONO, "text-right text-muted-foreground")}>—</TableCell>
                  <TableCell className={cn(MONO, "text-right text-muted-foreground")}>—</TableCell>
                  <TableCell className={cn(MONO, "text-right text-muted-foreground")}>—</TableCell>
                </>
              ) : (
                <>
                  <TableCell className="text-right">
                    <Amount value={ledger.owedTotalWei} accent />
                  </TableCell>
                  <TableCell className="text-right">
                    <Amount value={ledger.collectedTotalWei} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Amount value={ledger.pendingWei} />
                  </TableCell>
                </>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <p className="text-xs text-muted-foreground">
        {latest === null ? (
          "No pulls yet."
        ) : (
          <>
            Last pull <Num className="text-foreground">{eth(latest.pull.contributionWei)}</Num> from{" "}
            <Num>{shortHex(latest.wallet)}</Num> · <TxLink hash={latest.pull.txHash} explorerUrl={explorerUrl} />
            {latest.pull.at === null ? null : <> · {timeAgo(latest.pull.at, now)}</>}
          </>
        )}
      </p>
    </div>
  );
}
