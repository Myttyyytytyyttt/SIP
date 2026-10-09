// WHERE A WRITE STOPPED, AS THE PERSON SEES IT — and the one stop that is not a
// failure at all: cancelling in the wallet (owner, 09-25).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CONFIRMING_ELAPSED_MS, NO_STEP, TxProgress, markStep, stepKeyOf } from "@/components/wallets/TxProgress";
import type { WriteProgress } from "@/hooks/use-vault-actions";
import { FAILURE_COPY, PROGRESS_COPY, VAULT_COPY } from "@/lib/vault-copy";
import { DECLINED_CODE, type FlowResult } from "@/lib/vault-flows";

const finished = (result: FlowResult): WriteProgress => ({ phase: "finished", kind: "rule", result });
const render = (progress: WriteProgress, onDismiss?: () => void): string =>
  renderToStaticMarkup(createElement(TxProgress, { progress, successLabel: "Saving rule updated", ...(onDismiss === undefined ? {} : { onDismiss }) }));

describe("a write the person cancelled in their wallet", () => {
  const cancelled = finished({ ok: false, kind: "refused", message: FAILURE_COPY.phantomDeclined, code: DECLINED_CODE });

  it("is a neutral 'Cancelled' with the wallet's words — not the red 'Refused'", () => {
    const html = render(cancelled);
    expect(html).toContain(`>${PROGRESS_COPY.cancelled}<`);
    expect(html).toContain(FAILURE_COPY.phantomDeclined);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(PROGRESS_COPY.refused);
    expect(html).not.toContain("destructive");
  });

  it("offers Dismiss only when the card can dismiss it", () => {
    expect(render(cancelled, () => undefined)).toContain(`>${VAULT_COPY.dismiss}<`);
    expect(render(cancelled)).not.toContain(VAULT_COPY.dismiss);
  });

  it("leaves every other refusal in the red box, titled Refused", () => {
    const html = render(finished({ ok: false, kind: "refused", message: "The build refused it.", code: "policy_missing" }), () => undefined);
    expect(html).toContain('role="alert"');
    expect(html).toContain(`>${PROGRESS_COPY.refused}<`);
    expect(html).not.toContain(PROGRESS_COPY.cancelled);
  });
});

describe("the import's ladder", () => {
  const running = (kind: "import" | "importLink"): WriteProgress => ({ phase: "running", kind, step: "checking_permission", built: null });

  it("promises the link's steps, Phantom's included, only for an import a link follows", () => {
    const linking = render(running("importLink"));
    expect(linking).toContain(PROGRESS_COPY.importing_wallet);
    expect(linking).toContain(PROGRESS_COPY.approve_pension);
    const alone = render(running("import"));
    expect(alone).toContain(PROGRESS_COPY.importing_wallet);
    expect(alone).toContain(PROGRESS_COPY.checking_permission);
    expect(alone).not.toContain(PROGRESS_COPY.approve_pension);
    expect(alone).not.toContain(PROGRESS_COPY.consent);
  });
});

describe("the step in flight", () => {
  it("spins only for whoever has not asked for less motion; the bold current step says it either way (10-09)", () => {
    const html = render({ phase: "running", kind: "rule", step: "sending", built: null });
    expect(html).toMatch(/<svg[^>]*class="[^"]*motion-safe:animate-spin[^"]*"/);
    expect(html).not.toMatch(/class="[^"]*(?<!motion-safe:)animate-spin/);
    expect(html).toContain(`font-medium text-foreground">`);
  });
});

describe("how long Confirming has stood (10-09)", () => {
  const confirming: WriteProgress = { phase: "running", kind: "create", step: "confirming", built: null };
  const at = (progress: WriteProgress, startedAt?: number | null): string =>
    renderToStaticMarkup(createElement(TxProgress, { progress, successLabel: "Vault created", ...(startedAt === undefined ? {} : { startedAt }) }));
  /** The count, as drawn: its own aria-hidden leaf, never part of what the polite region reads out. */
  const COUNT = /<span aria-hidden="true" class="tabular-nums -ml-0\.5 font-normal text-muted-foreground">· (\d+) s<\/span>/;

  it("counts beside 'Confirming on Solana' once it has stood a while, hidden from the region it sits in", () => {
    const html = at(confirming, Date.now() - 8_000);
    expect(html).toContain('role="status" aria-live="polite"');
    expect(COUNT.exec(html)?.[1]).toBe("8");
    // In the current step's own row, right after its words.
    expect(html).toMatch(new RegExp(`${PROGRESS_COPY.confirming}<span aria-hidden="true"`));
  });

  it("shows nothing for its first seconds: a count that early is only noise", () => {
    expect(at(confirming, Date.now() - (CONFIRMING_ELAPSED_MS - 1_000))).not.toMatch(COUNT);
  });

  it("never counts another step, nor a write that has stopped", () => {
    const long = Date.now() - 60_000;
    for (const step of ["preparing", "approve_pension", "sending"] as const) {
      expect(at({ phase: "running", kind: "create", step, built: null }, long), step).not.toMatch(COUNT);
    }
    expect(at(finished({ ok: true, signature: "sig", explorerUrl: null, slot: 1, unitsConsumed: null }), long)).not.toMatch(COUNT);
  });

  it("a host that passes no start draws no count, the same ladder as with none", () => {
    for (const progress of [confirming, { phase: "running", kind: "link", step: "sending", built: null } as const]) {
      expect(at(progress)).toBe(at(progress, null));
      expect(at(progress)).not.toContain("tabular-nums");
    }
  });
});

describe("when a step began (useStepStartedAt's core)", () => {
  const running = (step: "sending" | "confirming" | "preparing", kind: "create" | "link" = "create"): WriteProgress => ({ phase: "running", kind, step, built: null });

  it("marks a step when it starts and keeps that moment while it runs", () => {
    const sending = markStep(NO_STEP, running("sending"), 1_000);
    expect(sending).toEqual({ key: "create:sending", at: 1_000 });
    expect(markStep(sending, running("sending"), 9_000)).toBe(sending);
  });

  it("starts again for the next step, a rebuild back to Preparing, or another write's step of the same name", () => {
    const confirming = markStep(markStep(NO_STEP, running("sending"), 1_000), running("confirming"), 2_000);
    expect(confirming.at).toBe(2_000);
    expect(markStep(confirming, running("preparing"), 3_000).at).toBe(3_000);
    expect(markStep(confirming, running("confirming", "link"), 4_000).at).toBe(4_000);
  });

  it("clears when the write stops, so the next write's Confirming counts from its own start", () => {
    const confirming = markStep(NO_STEP, running("confirming"), 1_000);
    const stopped = markStep(confirming, finished({ ok: false, kind: "expired", message: "x" }), 5_000);
    expect(stopped).toEqual(NO_STEP);
    expect(markStep(stopped, running("confirming"), 7_000).at).toBe(7_000);
    expect(stepKeyOf({ phase: "idle" })).toBeNull();
  });
});
