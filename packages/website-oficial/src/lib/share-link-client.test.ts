// THE DIALOG'S SIDE OF THE SIGNED LINK (owner, 10-22): asked once per figures —
// what the PAGE showed, never the card the server answered, or adopting it
// would ask again forever — a refusal asked again, "off" not, and the picture
// warmed once.

import { afterEach, describe, expect, it, vi } from "vitest";

import { toDashboardMock } from "@/lib/live-mock";
import { shareCardOf, type ShareCardData } from "@/lib/live-share";
import { SHARE_LINK_KEEP_MS, askShareLink, forgetShareLinks, keptShareLink, shareLinkUrl, warmShareImage } from "@/lib/share-link-client";

import { OWNER, liveDashboard } from "../../test/fixtures/live-dashboard";

const page = toDashboardMock(liveDashboard(), { complete: false });
const card: ShareCardData = shareCardOf({ lifetimeSaved: 60_000_000n, stats: page.stats, rule: page.rule, now: page.now });
const source = { kind: "live" as const, owner: OWNER, proof: [] as readonly string[] };
const answer = (over: Partial<ShareCardData> = {}) => ({ card: { ...card, ...over }, links: { grid: { usd: "/c/a.b" }, streaks: {}, vault: {} }, streak: { claimed: 0, proven: null } });
const replying = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => {
  forgetShareLinks();
  vi.unstubAllGlobals();
});

describe("asking for a card's link", () => {
  it("posts the pension key and the streak's proof, once for the same figures", async () => {
    const fetch = replying(200, answer({ usdText: "$6.01" }));
    const first = await askShareLink({ ...source, proof: ["sig"] }, card, { fetch });
    expect(first?.card.usdText).toBe("$6.01");
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ action: "link", owner: OWNER, streak: ["sig"] });
    await askShareLink({ ...source, proof: ["sig"] }, { ...card }, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(keptShareLink({ ...source, proof: ["sig"] }, card)?.card.usdText).toBe("$6.01");
  });

  it("is keyed by what the page showed: the adopted card never asks again, new figures do", async () => {
    const fetch = replying(200, answer({ usdText: "$6.01" }));
    const adopted = (await askShareLink(source, card, { fetch }))!.card;
    // The dialog shows the server's card now, but asks with the page's: no second POST.
    await askShareLink(source, card, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(keptShareLink(source, adopted)).toBeUndefined();
    await askShareLink(source, { ...card, usdText: "$7.00" }, { fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("asks again after five minutes", async () => {
    const fetch = replying(200, answer());
    await askShareLink(source, card, { fetch, now: 0 });
    await askShareLink(source, card, { fetch, now: SHARE_LINK_KEEP_MS + 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a refusal is asked again next time; links that are off stay off for the while", async () => {
    const limited = replying(429, { error: { code: "rate_limited", retryAfterSeconds: 3 } });
    expect(await askShareLink(source, card, { fetch: limited })).toBeNull();
    expect(keptShareLink(source, card)).toBeUndefined();
    const off = replying(404, { error: { code: "share_links_off" } });
    expect(await askShareLink(source, card, { fetch: off })).toBeNull();
    expect(keptShareLink(source, card)).toBeNull();
    await askShareLink(source, card, { fetch: off });
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("a body that is not an answer is no link", async () => {
    expect(await askShareLink(source, card, { fetch: replying(200, { links: "nope" }) })).toBeNull();
  });
});

describe("what leaves the dialog", () => {
  it("the post carries the production site's address, whatever host the dialog runs on", () => {
    expect(shareLinkUrl("/c/a.b")).toBe("https://saverfi.cash/c/a.b");
  });

  it("the picture is asked for once, so X's crawler finds it drawn", () => {
    const fetch = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", fetch);
    warmShareImage("/c/a.b/card.png?v=1");
    warmShareImage("/c/a.b/card.png?v=1");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/c/a.b/card.png?v=1");
  });
});
