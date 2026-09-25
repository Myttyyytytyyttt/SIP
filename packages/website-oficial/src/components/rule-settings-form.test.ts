// The vault settings form behind the gear, rendered on its own: an open Radix dialog draws nothing on the server,
// and neither does an open popover, so every "?" keeps its sentence in a screen-reader span that these tests read.
// The form decides nothing — a `judge` says what a draft changes and costs — so each case here hands it one.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InfoTip } from "@/components/info-tip";
import { RuleSettingsForm, type RuleSettingsFormProps, type SettingsJudgement } from "@/components/rule-settings-dialog";
import type { SettingsCategory, SettingsDraft } from "@/lib/rule-settings";
import { SETTINGS_COPY } from "@/lib/settings-copy";

const UNCHANGED: SettingsJudgement = { changes: { rule: false, buying: false }, problem: null, notices: [], acknowledge: null, approvals: 0 };
const judging =
  (overrides: Partial<SettingsJudgement> = {}) =>
  (): SettingsJudgement => ({ ...UNCHANGED, ...overrides });

/** The sample's vault (/?mode=mock): volume at 2 %, three sample tickers. */
const SAMPLE_DRAFT: SettingsDraft = {
  mode: "volume",
  rateBps: 200,
  paused: false,
  picked: [
    { id: "INDEX", percent: "60" },
    { id: "SPYx", percent: "25" },
    { id: "GLDx", percent: "15" },
  ],
  threshold: "5",
};
const SAMPLE_CATEGORIES: readonly SettingsCategory[] = [
  { id: "index", title: SETTINGS_COPY.categories.index, help: SETTINGS_COPY.help.index, assets: [{ id: "INDEX", symbol: "INDEX", name: "Index fund" }], unavailable: [] },
  {
    id: "xstock",
    title: SETTINGS_COPY.categories.xstock,
    help: SETTINGS_COPY.help.xstock,
    assets: [
      { id: "SPYx", symbol: "SPYx", name: "S&P 500" },
      { id: "GLDx", symbol: "GLDx", name: "Gold" },
    ],
    unavailable: [],
  },
];

const SPYX = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const ANTHROPIC = "Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP";
const UNAVAILABLE = ["FIGUREAI", "OPENAI", "NEURALINK", "SPACEX", "POLYMARKET", "KALSHI", "ANDURIL"];

/** The owner's vault: profit at 20 %, SPYx and ANTHROPIC at 50/50, the $10 base. */
const LIVE_DRAFT: SettingsDraft = {
  mode: "profit",
  rateBps: 2_000,
  paused: false,
  picked: [
    { id: SPYX, percent: "50" },
    { id: ANTHROPIC, percent: "50" },
  ],
  threshold: "10",
};
const LIVE_CATEGORIES: readonly SettingsCategory[] = [
  { id: "xstock", title: SETTINGS_COPY.categories.xstock, help: SETTINGS_COPY.help.xstock, assets: [{ id: SPYX, symbol: "SPYx", name: "SP500 xStock" }], unavailable: [] },
  { id: "prestock", title: SETTINGS_COPY.categories.prestock, help: SETTINGS_COPY.help.prestock, assets: [{ id: ANTHROPIC, symbol: "ANTHROPIC", name: "Anthropic" }], unavailable: UNAVAILABLE },
];

const sampleProps = (overrides: Partial<RuleSettingsFormProps> = {}): RuleSettingsFormProps => ({
  initial: SAMPLE_DRAFT,
  rates: { profit: 2_000, volume: 200 },
  live: false,
  volume: { selectable: true, note: null },
  categories: SAMPLE_CATEGORIES,
  maxLegs: 5,
  weightsEditable: true,
  buyingLocked: null,
  thresholdNote: null,
  frozen: false,
  judge: judging(),
  onSave: () => undefined,
  onCancel: () => undefined,
  refresh: null,
  progress: null,
  ...overrides,
});

const liveProps = (overrides: Partial<RuleSettingsFormProps> = {}): RuleSettingsFormProps =>
  sampleProps({
    initial: LIVE_DRAFT,
    rates: { profit: 2_000, volume: 100 },
    live: true,
    volume: { selectable: false, note: "Volume is not offered yet." },
    categories: LIVE_CATEGORIES,
    ...overrides,
  });

const render = (props: RuleSettingsFormProps): string => renderToStaticMarkup(createElement(RuleSettingsForm, props));

/** Text as React writes it into markup. */
const escaped = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** The "?" beside `label`, as a screen reader (and this test) reads it. */
const tip = (label: string, help: string): string => `<span class="sr-only">${escaped(label)}: ${escaped(help)}</span>`;

/** The opening tag of the first element whose attributes match `attribute`. */
function tagWith(html: string, attribute: RegExp): string {
  const tag = html.match(new RegExp(`<[a-z]+[^>]*${attribute.source}[^>]*>`));
  if (tag === null) throw new Error(`no element with ${attribute.source}`);
  return tag[0];
}

/** The opening tag of the button whose text starts with `text` (a toggle item carries no value attribute). */
function buttonStarting(html: string, text: string): string {
  const tag = html.match(new RegExp(`<button[^>]*>(?=${text}(<|$))`));
  if (tag === null) throw new Error(`no button starting ${text}`);
  return tag[0];
}

const SAVE_DISABLED = new RegExp(`aria-disabled="true"[^>]*>${SETTINGS_COPY.save}<`);
const SAVE_ENABLED = new RegExp(`aria-disabled="false"[^>]*>${SETTINGS_COPY.save}<`);

describe("the sample's settings", () => {
  it("offers the volume presets and the volume rate's own explanation", () => {
    const html = render(sampleProps());
    for (const preset of ["0.5%", "1%", "2%"]) expect(html).toContain(`>${preset}<`);
    expect(html).not.toContain(">20%<");
    expect(html).toContain(tip(SETTINGS_COPY.rate, SETTINGS_COPY.help.rateVolume));
    expect(html).not.toContain(escaped(SETTINGS_COPY.help.rateProfit));
  });

  it("never says sign, even with both sections changed and something to accept", () => {
    const html = render(sampleProps({ judge: judging({ changes: { rule: true, buying: true }, approvals: 2, acknowledge: "I accept the risks." }) }));
    expect(html).not.toMatch(/sign/i);
    // Restarts and wallet approvals are a real vault's costs; the sample has neither.
    expect(html).not.toContain(escaped(SETTINGS_COPY.nonceNotice));
    expect(html).not.toContain(escaped(SETTINGS_COPY.buyingReapproved));
    expect(html).not.toContain(escaped(SETTINGS_COPY.approvals(2)));
  });

  it("lets Volume be picked: it is the sample's own mode", () => {
    const html = render(sampleProps());
    expect(buttonStarting(html, SETTINGS_COPY.modeVolume)).not.toContain('disabled=""');
    expect(html).not.toContain(SETTINGS_COPY.comingSoon);
  });
});

describe("a live vault's settings", () => {
  it("offers the profit presets, and shows Volume disabled and coming soon", () => {
    const html = render(liveProps());
    for (const preset of ["10%", "20%", "50%"]) expect(html).toContain(`>${preset}<`);
    expect(html).not.toContain(">0.5%<");
    expect(buttonStarting(html, SETTINGS_COPY.modeVolume)).toContain('disabled=""');
    // Only Volume: Profit stays pickable, so a legacy volume vault can still move back to it.
    expect(buttonStarting(html, SETTINGS_COPY.modeProfit)).not.toContain('disabled=""');
    expect(html).toMatch(new RegExp(`${SETTINGS_COPY.modeVolume}<span[^>]*>${SETTINGS_COPY.comingSoon}</span>`));
    expect(html).toContain("Volume is not offered yet.");
  });

  it("puts a sentence behind every title, where a screen reader finds it", () => {
    const html = render(liveProps());
    const expected: readonly (readonly [string, string])[] = [
      [SETTINGS_COPY.mode, SETTINGS_COPY.help.mode],
      [SETTINGS_COPY.rate, SETTINGS_COPY.help.rateProfit],
      [SETTINGS_COPY.presets, SETTINGS_COPY.help.presets],
      [SETTINGS_COPY.pause, SETTINGS_COPY.help.pause],
      [SETTINGS_COPY.assets, SETTINGS_COPY.help.assets],
      [SETTINGS_COPY.categories.xstock, SETTINGS_COPY.help.xstock],
      [SETTINGS_COPY.categories.prestock, SETTINGS_COPY.help.prestock],
      [SETTINGS_COPY.shares, SETTINGS_COPY.help.shares],
      [SETTINGS_COPY.threshold, SETTINGS_COPY.help.threshold],
    ];
    for (const [label, help] of expected) expect(html).toContain(tip(label, help));
    expect(html).toContain(escaped(SETTINGS_COPY.help.unavailable));
    // The sample's own categories carry theirs the same way.
    expect(render(sampleProps())).toContain(tip(SETTINGS_COPY.categories.index, SETTINGS_COPY.help.index));
  });

  it("says what a new rule costs, and how many approvals, only once something changed", () => {
    const quiet = render(liveProps());
    expect(quiet).not.toContain(escaped(SETTINGS_COPY.nonceNotice));
    expect(quiet).toContain(SETTINGS_COPY.noChanges);

    const html = render(liveProps({ judge: judging({ changes: { rule: true, buying: true }, approvals: 2, notices: ["The most one buy can spend moves."] }) }));
    expect(html).toContain(escaped(SETTINGS_COPY.nonceNotice));
    expect(html).toContain(escaped(SETTINGS_COPY.buyingReapproved));
    expect(html).toContain("The most one buy can spend moves.");
    expect(html).toContain(escaped(SETTINGS_COPY.approvals(2)));
    expect(html).toMatch(SAVE_ENABLED);
  });

  it("says the re-approval once when the host already said it", () => {
    const html = render(liveProps({ judge: judging({ changes: { rule: false, buying: true }, approvals: 1, notices: [SETTINGS_COPY.buyingReapproved] }) }));
    expect(html.split(escaped(SETTINGS_COPY.buyingReapproved))).toHaveLength(2);
  });
});

describe("while frozen", () => {
  it("disables every control, the slider's thumbs by name", () => {
    const html = render(liveProps({ frozen: true, judge: judging({ changes: { rule: true, buying: false } }) }));
    expect(tagWith(html, /id="[^"]*-threshold"/)).toContain('disabled=""');
    expect(tagWith(html, /data-slot="slider"/)).toContain('data-disabled=""');
    expect(tagWith(html, /role="slider"/)).toContain('data-disabled=""');
    expect(buttonStarting(html, SETTINGS_COPY.modeProfit)).toContain('disabled=""');
    expect(tagWith(html, /role="switch"/)).toContain('disabled=""');
    expect(tagWith(html, /aria-pressed="true"/)).toContain('disabled=""');
    expect(tagWith(html, /id="[^"]*-share-/)).toContain('disabled=""');
    // …but never the "?" tips: the sections are not disabled wholesale, so help stays readable during a signature.
    expect(html).not.toMatch(/<fieldset[^>]*disabled=""/);
    const tips = html.match(/<button[^>]*aria-haspopup="dialog"[^>]*>/g) ?? [];
    expect(tips.length).toBeGreaterThan(5);
    for (const tip of tips) expect(tip).not.toContain('disabled=""');
    // A change is there, and still nothing can be saved.
    expect(html).toMatch(SAVE_DISABLED);
  });

  it("leaves the controls live when not frozen", () => {
    const html = render(liveProps());
    expect(tagWith(html, /id="[^"]*-threshold"/)).not.toContain('disabled=""');
    expect(tagWith(html, /data-slot="slider"/)).not.toContain('data-disabled=""');
    expect(html).not.toMatch(/<fieldset[^>]*disabled=""/);
  });
});

describe("the Save button", () => {
  it("is not offered when nothing changed", () => {
    expect(render(liveProps())).toMatch(SAVE_DISABLED);
    expect(render(sampleProps())).toMatch(SAVE_DISABLED);
  });

  it("is not offered while the judge names a problem, and the problem is shown in its section", () => {
    const html = render(liveProps({ judge: judging({ changes: { rule: false, buying: true }, problem: { section: "buying", message: "The threshold is too high for this basket." } }) }));
    expect(html).toMatch(SAVE_DISABLED);
    expect(html).toMatch(/role="alert"[^>]*>The threshold is too high for this basket\.</);
  });

  it("waits for the tick when something must be accepted", () => {
    const html = render(liveProps({ judge: judging({ changes: { rule: false, buying: true }, acknowledge: "I accept the issuer's powers." }) }));
    expect(html).toMatch(SAVE_DISABLED);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain(escaped("I accept the issuer's powers."));
    expect(html).toContain(SETTINGS_COPY.acknowledgeRequired);
  });

  it("is offered for a clean change", () => {
    expect(render(sampleProps({ judge: judging({ changes: { rule: true, buying: false } }) }))).toMatch(SAVE_ENABLED);
  });

  it("is not offered for a changed basket whose shares do not add up, whatever the judge says", () => {
    const initial: SettingsDraft = { ...LIVE_DRAFT, picked: [{ id: SPYX, percent: "60" }, { id: ANTHROPIC, percent: "30" }] };
    const html = render(liveProps({ initial, judge: judging({ changes: { rule: false, buying: true } }) }));
    expect(html).toMatch(SAVE_DISABLED);
    expect(html).toContain(escaped(SETTINGS_COPY.sharesTotal(90)));
    expect(html).toContain(`>${SETTINGS_COPY.evenOut}<`);
  });
});

describe("what the savings buy", () => {
  it("lists each category's assets as pressable tiles, the picked ones with their shares", () => {
    const html = render(liveProps());
    expect(html).toContain(">SPYx<");
    expect(html).toContain(">ANTHROPIC<");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(tagWith(html, new RegExp(`id="[^"]*-share-${SPYX}"`))).toContain('value="50"');
    expect(html).toContain(escaped(SETTINGS_COPY.sharesExact));
    expect(html).not.toContain(`>${SETTINGS_COPY.evenOut}<`);
  });

  it("collapses the assets that cannot be bought into one line, naming them behind its ?", () => {
    const html = render(liveProps());
    const line = SETTINGS_COPY.unavailable(UNAVAILABLE.length);
    expect(html).toContain(`>${line}<`);
    expect(html).toContain(tip(line, `${UNAVAILABLE.join(", ")}. ${SETTINGS_COPY.help.unavailable}`));
    // Never a tile: only the two offered assets can be pressed.
    expect(html.match(/aria-pressed=/g)).toHaveLength(2);
    expect(html).not.toContain(">FIGUREAI<");
  });

  it("shows the tiles unpressed and says where the savings stay when nothing is picked", () => {
    const html = render(sampleProps({ initial: { ...SAMPLE_DRAFT, picked: [] } }));
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(3);
    expect(html).toContain(escaped(SETTINGS_COPY.nothingPicked));
    expect(html).not.toContain(tip(SETTINGS_COPY.shares, SETTINGS_COPY.help.shares));
  });

  it("does not let a full basket grow", () => {
    const html = render(sampleProps({ maxLegs: 3 }));
    expect(html).toContain(SETTINGS_COPY.full(3));
    const html2 = render(sampleProps({ maxLegs: 2, initial: { ...SAMPLE_DRAFT, picked: SAMPLE_DRAFT.picked.slice(0, 2) } }));
    expect(tagWith(html2, /aria-pressed="false"/)).toContain('disabled=""');
  });

  it("shows an even split it does not let be typed, and the $10 it does not let be changed, before buying starts", () => {
    const html = render(liveProps({ weightsEditable: false, initial: { ...LIVE_DRAFT, threshold: "10" }, thresholdNote: SETTINGS_COPY.appliesWhenBuyingStarts }));
    expect(html).not.toMatch(/id="[^"]*-share-/);
    expect(html).toContain(">50 %<");
    expect(tagWith(html, /id="[^"]*-threshold"/)).toContain("readOnly");
    expect(html).toContain(escaped(SETTINGS_COPY.appliesWhenBuyingStarts));
    expect(html).not.toContain(SETTINGS_COPY.useBase("$10"));
  });

  it("offers the $10 base when the threshold is anything else", () => {
    expect(render(sampleProps())).toContain(`>${SETTINGS_COPY.useBase("$10")}<`);
    expect(render(liveProps())).not.toContain(SETTINGS_COPY.useBase("$10"));
  });

  it("shows only the reason when the buying cannot be changed here, and still the host's refresh", () => {
    const html = render(liveProps({ buyingLocked: "Your buying choices could not be read.", refresh: createElement("p", null, "REFRESH-BLOCK") }));
    expect(html).toContain("Your buying choices could not be read.");
    expect(html).not.toMatch(/aria-pressed=/);
    expect(html).not.toMatch(/id="[^"]*-threshold"/);
    expect(html).toContain("REFRESH-BLOCK");
  });
});

describe("the judge", () => {
  it("is asked about the draft the host started it on", () => {
    const seen: SettingsDraft[] = [];
    render(
      liveProps({
        judge: (draft) => {
          seen.push(draft);
          return UNCHANGED;
        },
      }),
    );
    expect(seen).toEqual([LIVE_DRAFT]);
  });
});

describe("the ?", () => {
  it("is a button that carries its sentence, and draws no bubble until opened", () => {
    const html = renderToStaticMarkup(createElement(InfoTip, { label: "Rate", children: "How much is put aside." }));
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('<span class="sr-only">Rate: How much is put aside.</span>');
    expect(html).not.toContain('role="dialog"');
  });
});
