"use client";

/**
 * "VAULT SETTINGS", BEHIND THE GEAR ON THE SAVINGS RULE CARD (owner, 09-25):
 * everything that changes the vault in one place — how it saves (mode, rate,
 * pause) and what it buys (assets by category, their shares, the threshold).
 *
 * PRESENTATION ONLY. Nothing here signs, builds a transaction or knows what a
 * policy is. The host hands the form a starting draft and a `judge` that says,
 * for any draft, what changed, what is wrong with it and what saving it costs;
 * Save hands the draft back. On live the host is LiveRulePanel (it signs through
 * the page's existing writers); on the sample it is the card itself (it moves
 * local state). The same form serves both, so nothing in it may say "sign":
 * the sample never asks for a signature (savings-rule-panel.test.ts).
 *
 * TWO EXPORTS, AND WHY. RuleSettingsDialog is the frame; RuleSettingsForm is
 * the body and its footer, exported on its own because an open Radix dialog
 * renders nothing on the server, and the tests render without a DOM.
 *
 * PRIVY'S DIALOG OPENS ON TOP OF THIS ONE while the wallet asks, and a stock
 * Radix modal fights it: it traps focus, and reads a press inside Privy's
 * dialog as a press outside itself. So this is WalletsModal's composition — an
 * UNTRAPPED FocusScope around the content, and no dismissal while Privy's
 * dialog is open — rather than ui/dialog's DialogContent. The two checks are
 * copied, not imported: WalletsModal's module carries the whole wallets screen,
 * and the sample's card (and its tests) must not load a wallet SDK to open a
 * settings dialog.
 *
 * IT DOES NOT CLOSE WHILE `holdClose` — while the wallet is asking, or a second
 * approval is queued behind the first. Closing then would unmount the progress
 * the owner is waiting on. The close button is disabled, and Escape, a press
 * outside and every other close request are ignored until it clears.
 *
 * WHILE `frozen` NOTHING CAN BE CHANGED (a write is running, another holds the
 * page's lock, or the vault has not been read again since the last one landed).
 * Each section is a disabled fieldset, and every control is ALSO disabled by
 * name: the Slider's thumbs are spans a fieldset does not reach, and Radix
 * styles its own disabled state only from its own prop.
 */

import { XIcon } from "lucide-react";
import Image from "next/image";
import { Dialog as DialogPrimitive } from "radix-ui";
import { FocusScope } from "radix-ui/internal";
import { useId, useMemo, useState, type ReactNode } from "react";

import { InfoTip } from "@/components/info-tip";
import { AssetMark } from "@/components/live/AssetMark";
import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { LABEL, MONO } from "@/lib/classes";
import { pct } from "@/lib/format";
import {
  BASE_THRESHOLD_USD,
  RATE_RANGES,
  evened,
  pickToggled,
  shareTotal,
  thresholdUsdOf,
  withShare,
  type RuleMode,
  type SettingsCategory,
  type SettingsDraft,
  type SettingsPick,
} from "@/lib/rule-settings";
import { SETTINGS_COPY } from "@/lib/settings-copy";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ THE FRAME */

/** Whether one of Privy's flows is on screen: its modal is a headless-ui dialog with this id, present only while open (WalletsModal.tsx). */
function privyDialogOpen(): boolean {
  return typeof document !== "undefined" && document.getElementById("privy-dialog") !== null;
}

/** ui/dialog.tsx's DialogContent classes, then WalletsModal's full-screen-below-sm shape at a settings dialog's width. */
const CONTENT = cn(
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
  "h-dvh max-h-dvh w-dvw max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-none p-0 sm:h-auto sm:max-h-[85vh] sm:w-full sm:max-w-lg sm:rounded-xl",
);

export function RuleSettingsDialog({
  open,
  onOpenChange,
  holdClose,
  description,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The wallet is asking, or a queued approval waits on the first: nothing closes the dialog. */
  readonly holdClose: boolean;
  /** SETTINGS_COPY.descriptionLive or descriptionSample. */
  readonly description: string;
  /** A RuleSettingsForm, or a RuleSettingsStatus while the vault is being read. */
  readonly children: ReactNode;
}) {
  const heldBack = (): boolean => holdClose || privyDialogOpen();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && heldBack()) return;
        onOpenChange(next);
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        <FocusScope.Root trapped={false}>
          <DialogPrimitive.Content
            data-slot="dialog-content"
            className={CONTENT}
            // A press or an Escape meant for Privy's dialog must not close this one underneath it, and nothing
            // closes it while the wallet is asking.
            onPointerDownOutside={(event) => {
              if (heldBack()) event.preventDefault();
            }}
            onEscapeKeyDown={(event) => {
              if (heldBack()) event.preventDefault();
            }}
          >
            {/* pr-12 keeps the title clear of the close button, which sits absolute in the corner. */}
            <DialogHeader className="border-b p-4 pr-12 text-left">
              <DialogTitle>{SETTINGS_COPY.title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>

            {/* The grid's second row: the form's own scrolling body and its footer, which stays in view. */}
            <div className="flex min-h-0 flex-col">{children}</div>

            <DialogPrimitive.Close data-slot="dialog-close" asChild>
              <Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" disabled={holdClose}>
                <XIcon aria-hidden />
                <span className="sr-only">{holdClose ? SETTINGS_COPY.closeHeld : SETTINGS_COPY.close}</span>
              </Button>
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </FocusScope.Root>
      </DialogPortal>
    </Dialog>
  );
}

/** What the dialog shows instead of the form: the vault still being read, or why it could not be (with the host's retry). */
export function RuleSettingsStatus({ children }: { readonly children: ReactNode }) {
  return (
    <div role="status" className="min-h-0 space-y-3 overflow-y-auto p-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------- THE FORM */

/** What the host says about a draft: the form renders it and gates Save on it, and never works any of it out itself. */
export interface SettingsJudgement {
  /** Which half would be saved: the rule (mode, rate, pause) and the buying (assets, shares, threshold). */
  readonly changes: { readonly rule: boolean; readonly buying: boolean };
  /** The first thing that stops Save, shown in the section it belongs to; null when nothing does. */
  readonly problem: { readonly section: "saving" | "buying"; readonly message: string } | null;
  /** What saving this draft also does, said before Save (a cap that moves, assets the stored choice lost…). */
  readonly notices: readonly string[];
  /** The sentence a tick must accept before Save (new assets and their issuers' powers), or null. */
  readonly acknowledge: string | null;
  /** How many approvals the wallet will ask for on Save; live only. */
  readonly approvals: number;
}

export interface RuleSettingsFormProps {
  readonly initial: SettingsDraft;
  /** Each mode's own rate, in basis points: switching mode starts the slider there. */
  readonly rates: { readonly profit: number; readonly volume: number };
  /** A real vault. The sample passes false, and then nothing about approvals or restarts is said. */
  readonly live: boolean;
  /** Whether Volume can be picked, and the muted line under the mode when it cannot (or when a legacy vault is on it). */
  readonly volume: { readonly selectable: boolean; readonly note: string | null };
  readonly categories: readonly SettingsCategory[];
  /** The most assets one basket holds; a full basket's unpicked tiles cannot be pressed. */
  readonly maxLegs: number;
  /** False is an even split only (a live vault that has not started buying): the shares are shown, not typed. */
  readonly weightsEditable: boolean;
  /** Whether the threshold can be typed. Absent means the same as weightsEditable: the no-policy path shows $10 read-only. */
  readonly thresholdEditable?: boolean;
  /** Why the Buying section cannot be changed from here, shown instead of it; null when it can. */
  readonly buyingLocked: string | null;
  /** A muted line under the threshold (e.g. SETTINGS_COPY.appliesWhenBuyingStarts), or null. */
  readonly thresholdNote: string | null;
  /** Nothing can be changed or saved (a write is running or has not been read back yet). */
  readonly frozen: boolean;
  readonly judge: (draft: SettingsDraft) => SettingsJudgement;
  readonly onSave: (draft: SettingsDraft) => void;
  readonly onCancel: () => void;
  /**
   * The host's "Refresh price limits" block, at the end of the Buying section; null on the sample and without a
   * policy. A function is handed whether the Buying half has unsaved edits: refreshing then would re-sign the
   * STORED basket under the owner's edits, so the host holds it until they are saved or cancelled.
   */
  readonly refresh: ReactNode | ((state: { readonly buyingChanged: boolean }) => ReactNode);
  /**
   * Put the refresh block FIRST, over everything else: the host says so when the
   * stored price limits no longer buy on every route — the one thing the owner
   * must do, and the reason the gear carries a dot.
   */
  readonly refreshFirst?: boolean;
  /** The host's progress of the approvals under way, under the buttons. */
  readonly progress: ReactNode;
}

/** A rate moved into its mode's range, whole basis points. */
function rateIn(mode: RuleMode, bps: number): number {
  const { min, max } = RATE_RANGES[mode];
  return Math.min(max, Math.max(min, Math.round(bps)));
}

/** A title and its "?", side by side — never the "?" inside a <label>. */
function Titled({ children, help, label }: { readonly children: ReactNode; readonly help: string; readonly label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {children}
      <InfoTip label={label}>{help}</InfoTip>
    </div>
  );
}

const TITLE = "text-sm leading-none font-medium";

export function RuleSettingsForm({
  initial,
  rates,
  live,
  volume,
  categories,
  maxLegs,
  weightsEditable,
  thresholdEditable = weightsEditable,
  buyingLocked,
  thresholdNote,
  frozen,
  judge,
  onSave,
  onCancel,
  refresh,
  refreshFirst = false,
  progress,
}: RuleSettingsFormProps) {
  const id = useId();
  const ids = {
    mode: `${id}-mode`,
    rate: `${id}-rate`,
    presets: `${id}-presets`,
    pause: `${id}-pause`,
    assets: `${id}-assets`,
    threshold: `${id}-threshold`,
    thresholdNote: `${id}-threshold-note`,
    buyingProblem: `${id}-buying-problem`,
  };

  // Lazy: the host keys this form on the chain's values, so a new seed is a new form, never a reset mid-edit.
  const [draft, setDraft] = useState<SettingsDraft>(() => initial);
  // The acknowledgement is of ONE sentence: a basket that changes its new assets asks again.
  const [acknowledgedText, setAcknowledgedText] = useState<string | null>(null);

  const update = (patch: Partial<SettingsDraft>): void => setDraft((current) => ({ ...current, ...patch }));
  const setPicked = (picked: readonly SettingsPick[]): void => update({ picked });

  const judgement = useMemo(() => judge(draft), [judge, draft]);
  const { changes, problem, acknowledge, approvals } = judgement;

  const range = RATE_RANGES[draft.mode];
  // Widened: the two modes' presets are different literal tuples, and a union of them has no callable .map.
  const presets: readonly number[] = range.presets;
  const preset = presets.includes(draft.rateBps) ? String(draft.rateBps) : "";
  const picked = draft.picked;
  const pickedShares = new Map(picked.map((row) => [row.id, row.percent]));
  const full = picked.length >= maxLegs;
  const total = shareTotal(picked);
  const thresholdUsd = thresholdUsdOf(draft.threshold);
  const buyingOpen = buyingLocked === null;

  // The form's own two gates, over and above the host's: a changed basket whose shares do not add up, or a
  // changed threshold that is not an amount, is never handed to Save, whatever the judge missed.
  const buyingUnreadable = changes.buying && buyingOpen && ((picked.length > 0 && total !== 100) || (thresholdEditable && thresholdUsd === null));
  const acknowledged = acknowledge === null || acknowledgedText === acknowledge;
  const changed = changes.rule || changes.buying;
  const canSave = changed && problem === null && !buyingUnreadable && acknowledged && !frozen;

  // What a changed basket costs on a vault that already buys, said once whether or not the host said it too.
  const notices =
    live && changes.buying && weightsEditable && !judgement.notices.includes(SETTINGS_COPY.buyingReapproved)
      ? [SETTINGS_COPY.buyingReapproved, ...judgement.notices]
      : judgement.notices;

  const refreshNode = typeof refresh === "function" ? refresh({ buyingChanged: changes.buying }) : refresh;

  function save(): void {
    if (!canSave) return; // aria-disabled does not stop Enter or Space
    onSave(draft);
  }

  function switchMode(mode: RuleMode): void {
    if (mode === draft.mode) return;
    update({ mode, rateBps: rateIn(mode, rates[mode]) });
  }

  const buyingDescribedBy = [thresholdNote === null ? null : ids.thresholdNote, problem?.section === "buying" ? ids.buyingProblem : null].filter(Boolean).join(" ");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        {refreshFirst ? refreshNode : null}
        {/* ------------------------------------------------------------ SAVING */}
        {/*
          NOT <fieldset disabled>: that would disable every "?" inside it too, and
          while a signature runs is exactly when the owner may want to read what
          he is changing. Each control is disabled by name instead.
        */}
        <fieldset className="min-w-0 space-y-5">
          <legend className={LABEL}>{SETTINGS_COPY.savingHeading}</legend>

          <div className="space-y-2">
            <Titled label={SETTINGS_COPY.mode} help={SETTINGS_COPY.help.mode}>
              <span id={ids.mode} className={TITLE}>
                {SETTINGS_COPY.mode}
              </span>
            </Titled>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={draft.mode}
              disabled={frozen}
              aria-labelledby={ids.mode}
              className="w-full"
              onValueChange={(value) => {
                if (value === "profit" || value === "volume") switchMode(value);
              }}
            >
              <ToggleGroupItem value="profit" className="flex-1">
                {SETTINGS_COPY.modeProfit}
              </ToggleGroupItem>
              <ToggleGroupItem value="volume" className="flex-1" disabled={!volume.selectable}>
                {SETTINGS_COPY.modeVolume}
                {volume.selectable ? null : <Badge variant="secondary">{SETTINGS_COPY.comingSoon}</Badge>}
              </ToggleGroupItem>
            </ToggleGroup>
            {volume.note === null ? null : <p className="text-xs text-muted-foreground">{volume.note}</p>}
          </div>

          <div role="group" aria-labelledby={ids.rate} className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <Titled label={SETTINGS_COPY.rate} help={draft.mode === "profit" ? SETTINGS_COPY.help.rateProfit : SETTINGS_COPY.help.rateVolume}>
                <Label id={ids.rate}>{SETTINGS_COPY.rate}</Label>
              </Titled>
              <Num className="text-sm">{pct(draft.rateBps)}</Num>
            </div>
            <Slider
              value={[draft.rateBps]}
              min={range.min}
              max={range.max}
              step={1}
              // Named: a fieldset does not reach the thumbs, which are spans.
              disabled={frozen}
              onValueChange={(values) => {
                const next = values[0];
                if (next !== undefined) update({ rateBps: next });
              }}
              // The thumb is what a screen reader lands on: name it, and speak the percent it shows rather than
              // the basis points it holds.
              thumbProps={{ "aria-labelledby": ids.rate, "aria-valuetext": pct(draft.rateBps) }}
            />
            <div className="space-y-1.5">
              <Titled label={SETTINGS_COPY.presets} help={SETTINGS_COPY.help.presets}>
                <span id={ids.presets} className="text-xs text-muted-foreground">
                  {SETTINGS_COPY.presets}
                </span>
              </Titled>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={preset}
                disabled={frozen}
                aria-labelledby={ids.presets}
                className="w-full"
                onValueChange={(value) => {
                  if (value) update({ rateBps: Number(value) });
                }}
              >
                {presets.map((value) => (
                  <ToggleGroupItem key={value} value={String(value)} className={cn("flex-1", MONO)}>
                    {pct(value)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <Titled label={SETTINGS_COPY.pause} help={SETTINGS_COPY.help.pause}>
              <Label htmlFor={ids.pause}>{SETTINGS_COPY.pause}</Label>
            </Titled>
            <Switch id={ids.pause} checked={draft.paused} disabled={frozen} onCheckedChange={(paused) => update({ paused })} />
          </div>

          {problem?.section === "saving" ? (
            <p role="alert" className="text-xs text-destructive">
              {problem.message}
            </p>
          ) : null}

          {/* WHAT A NEW RULE COSTS, said before Save and not discovered after it: live only, and only once it changed. */}
          {live && changes.rule ? <p className="rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-xs">{SETTINGS_COPY.nonceNotice}</p> : null}
        </fieldset>

        {/* ------------------------------------------------------------ BUYING */}
        <fieldset className="min-w-0 space-y-5">
          <legend className={LABEL}>{SETTINGS_COPY.buyingHeading}</legend>

          {buyingLocked !== null ? (
            <p className="text-sm text-muted-foreground">{buyingLocked}</p>
          ) : (
            <>
              <div role="group" aria-labelledby={ids.assets} className="space-y-3">
                <Titled label={SETTINGS_COPY.assets} help={SETTINGS_COPY.help.assets}>
                  <span id={ids.assets} className={TITLE}>
                    {SETTINGS_COPY.assets}
                  </span>
                </Titled>

                {categories.map((category) => {
                  const titleId = `${id}-category-${category.id}`;
                  return (
                    <div key={category.id} role="group" aria-labelledby={titleId} className="space-y-2">
                      <Titled label={category.title} help={category.help}>
                        <span id={titleId} className="text-xs font-medium text-muted-foreground">
                          {category.title}
                        </span>
                      </Titled>
                      {category.assets.length === 0 ? null : (
                        <ul className="grid gap-2 sm:grid-cols-2">
                          {category.assets.map((asset) => {
                            const percent = pickedShares.get(asset.id);
                            const isPicked = percent !== undefined;
                            const shareId = `${id}-share-${asset.id}`;
                            return (
                              <li
                                key={asset.id}
                                className={cn(
                                  "flex min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors",
                                  isPicked ? "border-primary bg-muted ring-1 ring-primary" : "hover:bg-muted/60",
                                )}
                              >
                                <button
                                  type="button"
                                  aria-pressed={isPicked}
                                  // A full basket does not grow: the limit is met where it is reached.
                                  disabled={frozen || (full && !isPicked)}
                                  onClick={() => setPicked(pickToggled(picked, asset.id, !isPicked, maxLegs))}
                                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-45"
                                >
                                  {asset.logo === undefined ? (
                                    <AssetMark symbol={asset.symbol} mint={asset.id} size={20} badge={false} className="shrink-0" />
                                  ) : (
                                    <Image src={asset.logo} alt="" width={20} height={20} className="max-w-none shrink-0 rounded-full" />
                                  )}
                                  <span className="min-w-0">
                                    <span className="block text-[0.8rem] leading-tight font-medium">{asset.symbol}</span>
                                    <span className="block truncate text-[0.7rem] leading-tight text-muted-foreground">{asset.name}</span>
                                  </span>
                                </button>
                                {!isPicked ? null : weightsEditable ? (
                                  <span className="flex shrink-0 items-center gap-1">
                                    <Label htmlFor={shareId} className="sr-only">
                                      {SETTINGS_COPY.shareOf(asset.symbol)}
                                    </Label>
                                    <Input
                                      id={shareId}
                                      inputMode="numeric"
                                      autoComplete="off"
                                      value={percent}
                                      disabled={frozen}
                                      aria-invalid={!/^\d+$/.test(percent.trim())}
                                      onChange={(event) => setPicked(withShare(picked, asset.id, event.target.value))}
                                      className={cn("h-7 w-14 text-right", MONO)}
                                    />
                                    <span className="text-xs text-muted-foreground">%</span>
                                  </span>
                                ) : (
                                  <Num className="shrink-0 text-xs">{percent} %</Num>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {category.unavailable.length === 0 ? null : (
                        <Titled label={SETTINGS_COPY.unavailable(category.unavailable.length)} help={`${category.unavailable.join(", ")}. ${SETTINGS_COPY.help.unavailable}`}>
                          <span className="text-xs text-muted-foreground">{SETTINGS_COPY.unavailable(category.unavailable.length)}</span>
                        </Titled>
                      )}
                    </div>
                  );
                })}

                {picked.length === 0 ? <p className="text-xs text-muted-foreground">{SETTINGS_COPY.nothingPicked}</p> : null}
                {full ? <p className="text-xs text-muted-foreground">{SETTINGS_COPY.full(maxLegs)}</p> : null}
              </div>

              {picked.length === 0 ? null : (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Titled label={SETTINGS_COPY.shares} help={SETTINGS_COPY.help.shares}>
                      <span className={TITLE}>{SETTINGS_COPY.shares}</span>
                    </Titled>
                    <Num className={cn("text-sm", total === 100 ? null : "text-destructive")}>{total} %</Num>
                  </div>
                  {/* THE FIX, AS A PRESS, never a silent repair: offered whenever the shares are not exactly 100. */}
                  {total === 100 ? (
                    <p className="text-xs text-muted-foreground">{SETTINGS_COPY.sharesExact}</p>
                  ) : (
                    <div aria-live="polite" className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-destructive">{SETTINGS_COPY.sharesTotal(total)}</span>
                      <Button type="button" size="xs" variant="outline" disabled={frozen} onClick={() => setPicked(evened(picked))}>
                        {SETTINGS_COPY.evenOut}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Titled label={SETTINGS_COPY.threshold} help={SETTINGS_COPY.help.threshold}>
                  <Label htmlFor={ids.threshold}>{SETTINGS_COPY.threshold}</Label>
                </Titled>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-sm text-muted-foreground">
                      $
                    </span>
                    <Input
                      id={ids.threshold}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={draft.threshold}
                      readOnly={!thresholdEditable}
                      disabled={frozen}
                      aria-invalid={thresholdEditable && thresholdUsd === null}
                      aria-describedby={buyingDescribedBy === "" ? undefined : buyingDescribedBy}
                      onChange={(event) => update({ threshold: event.target.value })}
                      className={cn("pl-7", MONO)}
                    />
                  </div>
                  {thresholdEditable && thresholdUsd !== BASE_THRESHOLD_USD ? (
                    <Button type="button" size="sm" variant="outline" disabled={frozen} onClick={() => update({ threshold: String(BASE_THRESHOLD_USD) })}>
                      {SETTINGS_COPY.useBase(`$${BASE_THRESHOLD_USD}`)}
                    </Button>
                  ) : null}
                </div>
                {thresholdNote === null ? null : (
                  <p id={ids.thresholdNote} className="text-xs text-muted-foreground">
                    {thresholdNote}
                  </p>
                )}
              </div>

              {problem?.section === "buying" ? (
                <p id={ids.buyingProblem} role="alert" className="text-xs text-destructive">
                  {problem.message}
                </p>
              ) : null}
            </>
          )}

          {/* The host's refresh: after the buying choices, and there even when they are locked — a stored basket can
              need new price limits whether or not this page can edit it. */}
          {refreshFirst ? null : refreshNode}
        </fieldset>
      </div>

      {/* ------------------------------------------------------------ FOOTER */}
      <div className="max-h-[50dvh] shrink-0 space-y-3 overflow-y-auto border-t bg-muted/50 p-4">
        {notices.length === 0 ? null : (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        )}

        {acknowledge === null ? null : (
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={frozen}
              onChange={(event) => setAcknowledgedText(event.target.checked ? acknowledge : null)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span>{acknowledge}</span>
          </label>
        )}

        {live && approvals > 0 ? <p className="text-xs text-muted-foreground">{SETTINGS_COPY.approvals(approvals)}</p> : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          {changed ? null : <span className="text-xs text-muted-foreground sm:mr-auto">{SETTINGS_COPY.noChanges}</span>}
          {changed && !acknowledged ? <span className="text-xs text-muted-foreground sm:mr-auto">{SETTINGS_COPY.acknowledgeRequired}</span> : null}
          <Button type="button" variant="outline" onClick={() => onCancel()}>
            {SETTINGS_COPY.cancel}
          </Button>
          {/*
            aria-disabled rather than disabled: a button that turns `disabled` under focus drops focus to <body>.
            ui/button only styles `disabled:`, hence the two classes; save() guards again.
          */}
          <Button
            type="button"
            variant={canSave ? "default" : "outline"}
            aria-disabled={!canSave}
            onClick={save}
            className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          >
            {SETTINGS_COPY.save}
          </Button>
        </div>

        {progress}
      </div>
    </div>
  );
}
