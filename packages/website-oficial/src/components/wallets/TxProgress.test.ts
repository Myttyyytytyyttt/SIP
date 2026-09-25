// WHERE A WRITE STOPPED, AS THE PERSON SEES IT — and the one stop that is not a
// failure at all: cancelling in the wallet (owner, 09-25).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TxProgress } from "@/components/wallets/TxProgress";
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
