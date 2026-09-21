// The investing card rendered to HTML in each state, with Privy mocked, and its buttons pressed: the
// pattern VaultCard.test.ts uses. Pressing a button runs the real flow against a stub client.

import { ANDURIL_MINT, ANTHROPIC_MINT, CATALOGUE, OFFERED_LEGS, RAYDIUM_CLMM, SIP_PROGRAM_ID, SPYX_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT, isOfferable, offerProblems } from "@sip/solana-core/client";
import { Keypair } from "@solana/web3.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  function textOf(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (typeof node === "object" && node !== null && "props" in node) return textOf((node as { props: { children?: unknown } }).props.children);
    return "";
  }
  return {
    textOf,
    buttons: [] as { label: string; disabled: boolean; onClick: ((event: unknown) => void) | undefined }[],
    wallets: [] as { address: string; standardWallet: unknown }[],
    signTransaction: vi.fn(),
  };
});

vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => ({ ready: true, wallets: mocked.wallets }),
  useSignTransaction: () => ({ signTransaction: mocked.signTransaction }),
  useSignMessage: () => ({ signMessage: vi.fn() }),
}));

vi.mock("@/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/button")>();
  return {
    ...actual,
    Button: (props: Parameters<typeof actual.Button>[0]) => {
      mocked.buttons.push({ label: mocked.textOf(props.children).trim(), disabled: props.disabled === true, onClick: props.onClick as unknown as ((event: unknown) => void) | undefined });
      return actual.Button(props);
    },
  };
});

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  DEFAULT_PICKED,
  DEPTH_CEILING_PER_BUY_RAW,
  InvestingCard,
  REACHABLE_PER_BUY_RAW,
  SUGGESTED_PER_BUY_RAW,
  SigningDetail,
  canSignPolicy,
  readCaps,
  readMinimum,
  readWeights,
  setupRent,
  usedInLast30Days,
} from "@/components/wallets/InvestingCard";
import { VaultWriteLock, type WriteProgress } from "@/hooks/use-vault-actions";
import { VaultScreenContext, type VaultScreenValue, type VaultView } from "@/hooks/use-vault-state";
import { USDC_DECIMALS, formatUnits } from "@/lib/amounts";
import { PICKER_MAX_LEGS } from "@/lib/basket-picker";
import { INVEST_COPY } from "@/lib/vault-copy";
import type { InvestmentPolicyJson, VaultApi, VaultStateJson } from "@/lib/vault-api";

const CLICK = { type: "click", target: {} };
const PENSION = Keypair.generate().publicKey.toBase58();
const VAULT = Keypair.generate().publicKey.toBase58();
const account = (): string => Keypair.generate().publicKey.toBase58();

/**
 * The pools: SOL and SPYx at mainnet slot 447313239, ANTHROPIC at the $180-a-token
 * pool solana-core's fixture pins. ONE PRICE PER OFFERED LEG, because todaysLimits
 * reads every leg and answers nothing at all when one of them has no price.
 */
const PRICES: VaultStateJson["prices"] = {
  slot: 1,
  convertWad: "100038711555492562",
  usdcRawPerSol: "100038711",
  legs: [
    { symbol: "SPYx", mint: SPYX_MINT, wad: "131283650130637569", usdcRawPer1e8: "761709474" },
    { symbol: "ANTHROPIC", mint: ANTHROPIC_MINT, wad: "5555555555555555556", usdcRawPer1e8: "18000000" },
  ],
};

const POLICY: InvestmentPolicyJson = {
  vault: VAULT,
  enabled: true,
  venueProgram: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  inMint: USDC_MINT,
  legs: [
    { mint: SPYX_MINT, weightBps: 5_000, minOutRateWad: "124719467624105690" },
    { mint: ANTHROPIC_MINT, weightBps: 5_000, minOutRateWad: "5277777777777777778" },
  ],
  minConvertRateWad: "90034840399943305",
  // defaultInvestPolicy(2): the $5 purchase split across the legs, enforced per leg.
  minInvestment: "2500000",
  maxPerCall: "10000000",
  maxRolling30d: "50000000",
  bucketDays: new Array<number>(31).fill(0),
  bucketAmounts: new Array<string>(31).fill("0"),
  lifetimeInvested: "25000000",
  policyNonce: "1",
};

function stateWith(overrides: Partial<VaultStateJson> = {}): VaultStateJson {
  return {
    owner: PENSION,
    programId: SIP_PROGRAM_ID,
    vault: { status: "exists", address: VAULT, lamports: "1285240", rentFloor: "1285240", withdrawableLamports: "0" },
    policy: { status: "missing", address: account() },
    config: { address: account(), status: "missing", exists: false, paused: null },
    walletLinks: [],
    holdings: { status: "exists", items: [] },
    vaultTokenAccounts: {
      status: "exists",
      items: [
        { mint: WSOL_MINT, address: account(), tokenProgram: TOKEN_PROGRAM, status: "missing" },
        { mint: USDC_MINT, address: account(), tokenProgram: TOKEN_PROGRAM, status: "missing" },
        { mint: SPYX_MINT, address: account(), tokenProgram: TOKEN_2022_PROGRAM, status: "missing" },
        { mint: ANTHROPIC_MINT, address: account(), tokenProgram: TOKEN_2022_PROGRAM, status: "missing" },
      ],
    },
    // ANTHROPIC's Token-2022 account is 191 bytes to SPYx's 179, so it carries its own rent.
    rents: { vault: "1285240", link: "1305560", policy: "5577840", tokenAccount: "1488440", legTokenAccounts: { [SPYX_MINT]: "1559560", [ANTHROPIC_MINT]: "1620520" } },
    prices: PRICES,
    ...overrides,
  };
}

function screen(view: VaultView, api: Partial<VaultApi> = {}) {
  return { pensionKey: PENSION, view, refresh: vi.fn(), api: api as VaultApi } satisfies VaultScreenValue;
}

function render(value: VaultScreenValue): string {
  mocked.buttons.length = 0;
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(VaultScreenContext.Provider, { value }, createElement(VaultWriteLock, null, createElement(InvestingCard)))));
}

const buttons = (label: string) => mocked.buttons.filter((button) => button.label === label);

beforeEach(() => {
  // Phantom connected at the pension key, so a pressed button reaches the build route.
  mocked.wallets = [{ address: PENSION, standardWallet: { name: "Phantom" } }];
  mocked.signTransaction.mockReset();
});

describe("InvestingCard", () => {
  it("no vault: says to create it first, and offers nothing to sign", () => {
    const html = render(screen({ kind: "ready", state: stateWith({ vault: { status: "missing", address: VAULT } }) }));
    expect(html).toContain("Create your vault first.");
    expect(mocked.buttons).toHaveLength(0);
  });

  it("an unreadable vault or policy is never offered a form", () => {
    for (const state of [stateWith({ vault: { status: "unreadable", address: VAULT } }), stateWith({ policy: { status: "unreadable", address: account() } })]) {
      render(screen({ kind: "ready", state }));
      expect(buttons("Sign investment policy")).toHaveLength(0);
    }
    expect(render(screen({ kind: "ready", state: stateWith({ policy: { status: "unreadable", address: account() } }) }))).toContain("SaverFi could not read your investment policy just now.");
  });

  it("no policy: the whole basket in the prose, what the position costs and who sets it, that today's caps may buy nothing, what the SOL floor is for, and the issuer's powers over BOTH stocks; Sign waits for the box", () => {
    const html = render(screen({ kind: "ready", state: stateWith() }));
    // basketWeightsBps(2): equal halves, one line per offered leg.
    expect(html).toContain("SPYx · 50 %, ANTHROPIC · 50 %");
    expect(html).toContain("Buys each time $5.00 of USDC is ready");
    // THE BOX DOES NOT START ON A CAP THIS CARD CALLS DEAD. It used to open at
    // DEFAULT_INVEST_CAPS.maxPerCall ($1,000), which the thin-pool notice three
    // boxes below describes as "nothing bought, no SOL converted, at any
    // balance" -- with Sign lit and 0.0117348 SOL of unrecoverable rent behind
    // it. $149 is half the ceiling the default basket's counted routes admit,
    // so it keeps about 2x cover. It was $190 while the ceiling was a literal
    // read off ANTHROPIC's pinned Raydium pool; the ceiling is computed from
    // the chosen legs now, so this number moves when the basket does.
    expect(html).toContain('value="149"');
    expect(html).not.toContain('value="1000"');
    expect(html).toContain('value="31000"');
    // And the notice names the figure the box actually starts at, the leg whose
    // market set the ceiling, and the day that market was counted — so the
    // sentence and the box cannot drift apart the way a literal let them.
    expect(html).toContain("Most per buy starts at $149.00, which is half the ceiling");
    expect(html).toContain("the leg that sets it is ANTHROPIC");
    expect(html).toContain("the whole buy can be at most $298.00");
    expect(html).toContain("SOL is never sold below $90.03 (90 % of today&#x27;s $100.04)");
    expect(html).toContain("SPYx is never bought above $801.80 per 100,000,000 raw units (5.3 % over today&#x27;s pool price)");
    expect(html).toContain("ANTHROPIC is never bought above $18.95 per 100,000,000 raw units (5.3 % over today&#x27;s pool price)");
    // THE PROSE NAMES THE WHOLE BASKET, from the offered legs and their weights.
    // It used to open "Your vault invests in SPYx (SP500 xStock) through Raydium"
    // while the Basket field directly below already read two legs — the card
    // contradicted itself on screen.
    expect(html).toContain(
      "Your vault invests in SPYx at 50 % and ANTHROPIC at 50 %, each through its own Raydium pool, and a buy takes all of them or none.",
    );
    expect(html).not.toContain("invests in SPYx (SP500 xStock)");
    expect(html).toContain("the keeper converts it to USDC, never below $90.03 per SOL, then buys once $5.00 of USDC is ready");
    expect(html).toContain("At most $149.00 per buy and $31,000.00 per 30 days until you change them.");
    // The per-stock ceilings left the prose: at two legs they were joined by a
    // slash into "$801.80 / $18.95", a figure of no meaning. One line per stock
    // in the limits box above is the whole of it now.
    expect(html).not.toContain("$801.80 / $18.95");
    expect(html).toContain("or one of the pools is too small for the buy, nothing is bought and no SOL is converted until you sign again.");
    // Policy 5,577,840 + wSOL and USDC 1,488,440 each + SPYx 1,559,560 + ANTHROPIC 1,620,520 lamports, then 5,000 + 30,000 of fees.
    expect(html).toContain("Setting this up costs 0.0117348 SOL of rent for the policy and the vault&#x27;s token accounts, and none of it comes back.");
    expect(html).toContain("Cost: 0.0117348 SOL of rent that does not come back, plus 0.000035 SOL of network fees.");

    // WHAT THE SOL FLOOR IS FOR, beside the live price it came from: the program
    // does not validate min_convert_rate_wad, and zero there silently switches
    // converting off, so the effect and the zero are both said out loud.
    expect(html).toContain("That floor is what keeps converting switched on: the keeper sells your vault&#x27;s SOL for USDC only at or above it, and it is set 10 % under the price just read above.");
    expect(html).toContain("it would mean your SOL sold at any price at all.");

    // WHETHER IT CAN BUY AT ALL TODAY. The keeper's depth gate is all-or-nothing
    // and tests a converting turn at max_per_call itself, so the shipped $1,000
    // default is refused against ANTHROPIC's pool and takes SPYx and the SOL
    // conversion down with it.
    expect(html).toContain("Today, this basket may buy nothing at all");
    // THE VENUE, NOT "THE POOL", since 2026-09-21: the keeper counts what the
    // venue can hand over rather than a pool's in-side reserve, because the
    // assets this basket must hold trade where there is no pool to read. The
    // ratio and the 50 are unchanged, which is precisely why the WORDS needed
    // changing in the same commit and no test would have said so.
    expect(html).toContain("The keeper refuses a buy unless the venue it buys from holds at least 50 times that buy");
    expect(html).toContain("a Most per buy above it stops the buying altogether whenever the vault has SOL to convert: nothing bought, no SOL converted, at any balance.");
    // THE CEILING IS DATED WHERE THE INSTRUCTION IS, and it is now COMPUTED
    // FROM THE BASKET rather than quoted from one night. It names the leg that
    // set it, that leg's own reading day, the ceiling and the starting value —
    // all four from the shares on screen, so re-weighting the basket moves the
    // sentence with it.
    expect(html).toContain("the leg that sets it is ANTHROPIC");
    expect(html).toContain("when it was last read, on 2026-09-21");
    expect(html).toContain("the whole buy can be at most $298.00, and that is the ceiling itself, not a target");
    expect(html).toContain("Most per buy starts at $149.00, which is half the ceiling");
    expect(html).toContain("The keeper measures whichever venue it is actually buying through, in the turn itself");
    // AND THE OLD LITERAL'S FIGURES ARE GONE FROM THE PAGE. They described
    // ANTHROPIC's pinned Raydium pool, which the keeper no longer routes
    // through at all; a stale number with a confident sentence around it is
    // exactly what this change removes.
    expect(html).not.toContain("held about $9,500 when it was read on 20 September 2026");
    expect(html).not.toContain("about $380 for the whole buy");
    expect(html).not.toContain("Set it to about $380 or less");

    // ── WHAT THE POSITION COSTS, GENERATED FROM THE TICKED LEGS ──────────────
    //
    // EVERY SENTENCE BELOW IS NOW BUILT FROM THE BASKET, not written for one.
    // The card opens on SPYx and ANTHROPIC, so these are the words THAT basket
    // produces; vault-copy.test.ts holds the same builders against four other
    // baskets and asserts the property this file cannot: that no paragraph ever
    // names a stock the owner did not choose.
    expect(html).toContain("ANTHROPIC&#x27;s issuer charges 1 % of every transfer of it: once when your vault buys it, and once when it leaves.");
    // COMPOUNDED, NOT DOUBLED: 1 - 0.99^2 is 1.99 %, and "about 2 %" rounded
    // the owner's way past the only arithmetic on this card he could check. It
    // is computed from the leg's own fee now, so a different fee reads right.
    expect(html).toContain("Going in and back out therefore gives up 1.99 % before the market is involved at all — not quite twice the fee, because the second charge is taken from what the first one left.");
    // A FEE, NOT SLIPPAGE. Nothing here may leave him thinking a smaller buy
    // escapes it: it is charged on every transfer, and again on every later one.
    expect(html).toContain("Buying in smaller pieces does not make that smaller");
    expect(html).toContain("every later buy pays it again");
    expect(html).toContain("no fee setting at all, and no key with the power to add one");
    // ONE RAISE, NOT TWO: the mint's TransferFeeConfig carries only older{1032,
    // 50 bps} and newer{1039, 100 bps}, so 50 -> 100 is all that can be read off
    // it and all the copy may claim.
    // WHEN, NOT ROUGHLY WHEN. newer{epoch 1039} and a read at slot 448864409
    // put the rise about 1.8 hours before the reading (1039 x 432,000 =
    // 448,848,000), and product.ts read the same calendar day in epoch 1038 with
    // the rise still scheduled. "A few days ago" understated the one thing the
    // sentence exists to prove: that this key is in use now.
    expect(html).toContain("ANTHROPIC&#x27;s was 0.5 % for about two weeks and became 1 % when the current epoch began, hours before this was written on 20 September 2026.");
    expect(html).not.toContain("a few days ago");
    expect(html).not.toContain("it has been nothing, then 0.5 %");
    // THE CLOSED MEASUREMENT, and no tighter than it was read: simulated round
    // trips on mainnet, the sell chained on the credit the buy really returned
    // rather than on a quote. The two earlier readings -- the 0.60/0.57/1.26 %
    // size curve, and the Jupiter quotes that read this round trip at
    // 0.41-0.44 % before the measurement finished -- are gone from every
    // sentence, not only from their own.
    expect(html).toContain("measured on 20 September 2026 on Solana itself — seven round trips, built and run but never signed, each sale priced on what its purchase actually delivered rather than on a quote.");
    expect(html).toContain("ANTHROPIC&#x27;s round trip cost 2.4 % all told, between 2.24 % and 2.63 %.");
    expect(html).toContain("the rest, between 0.25 % and 0.64 %, is the market, and it moved by 0.36 % within thirteen minutes that day.");
    expect(html).toContain("SPYx&#x27;s round trip cost between 0.011 % and 0.018 %.");
    expect(html).not.toContain("1.3 % at $100");
    expect(html).not.toContain("because its pool is small");
    expect(html).not.toMatch(/0\.41 %\s*(?:and|to|[-–—])\s*0\.44 %/);
    expect(html).not.toContain("half a percent");
    expect(html).toContain("Another day reads differently, and where two of these cost differently it is their issuers and their markets that differ — not Solana, and not SaverFi.");

    // THE LIMIT THE NEXT RAISE CROSSES, and it names the whole basket that goes
    // down with it. "SPYx along with it" was true of exactly one basket; this
    // is the same doctrine said of the legs on screen.
    expect(html).toContain("the keeper will not buy a stock that charges more than 1 % to transfer");
    expect(html).toContain("ANTHROPIC sits exactly on that limit today, with no margin whatsoever");
    expect(html).toContain("the vault stops buying the whole basket — SPYx and ANTHROPIC, every one of them — and stops converting your SOL at all");

    // WHAT SAVERFI DOES NOT DO, which nothing on this card said while three
    // paragraphs described what it does. The depth gate is a size check; Pyth
    // covers the SOL hop only; the stock legs' one price bound is a floor the
    // owner signs once and which decays from the moment he signs it.
    expect(html).toContain("THAT IS A CHECK ON SIZE, NOT ON PRICE");
    expect(html).toContain("the SOL price Pyth publishes, which is the only number in a buy that does not come from the venue being traded against");
    expect(html).toContain("SPYx and ANTHROPIC have no such anchor today");
    expect(html).toContain("it is taken from one pool&#x27;s price at the moment you sign, 5 % under it, and it does not follow the market afterwards");
    expect(html).not.toMatch(/fair price|best price|guarantee/i);

    // THE ISSUER RISK HE TICKS A BOX ABOUT, enumerated per issuer of per leg.
    expect(html).toContain("move it out of your vault through a permanent delegate");
    expect(html).toContain("ANTHROPIC is a PreStock, and one key — WV9P…i5Wc — is the mint authority, the freeze authority, the transfer-fee authority and the permanent delegate of it.");
    expect(html).toContain("SPYx is an xStock: its mint carries no transfer-fee setting at all, and no key anywhere can add one");
    expect(html).toContain("That is about the fee and nothing else");

    // THE SECOND SWITCH THE SAME KEY HOLDS. A filled-in transfer hook is
    // refused by the keeper outright, and the refusal is all-or-nothing: every
    // other leg and the SOL conversion stop with it.
    expect(html).toContain("There is a second switch, and it is not about money at all: it stops the buying.");
    expect(html).toContain("On ANTHROPIC and SPYx that field was empty when SaverFi read it (ANTHROPIC on 2026-09-21 and SPYx on 2026-09-20)");
    expect(html).toContain("SaverFi will not buy a stock whose field has been filled in");
    expect(html).toContain("the vault stops buying the whole basket — SPYx and ANTHROPIC, every one of them — and stops converting your SOL, until the basket itself is changed.");
    expect(html).toContain("It applies from the moment it is written: the next buy is the one that stops.");
    // THE STOP SPEAKS FOR ITSELF. A bare "Nothing you have already saved is
    // lost or moved." sat two paragraphs under the permanent delegate IN THIS
    // SAME BOX, where alone it promises that nothing can ever be taken.
    expect(html).toContain("That stop takes nothing from you: what you have already saved is neither lost nor moved by it.");
    expect(html).toContain("The freeze, the pause and the permanent delegate described above are separate powers, and those can reach what your vault already holds.");
    expect(html).not.toContain("Nothing you have already saved is lost or moved.");
    // BOTH LEGS CARRY THE STOP; ONLY THE FEE IS ASYMMETRIC, and neither side is
    // weighed, because nothing anybody read measures which key is likelier.
    expect(html).toContain("either issuer can fill its own field in and stop the whole basket the same way");
    expect(html).toContain("The asymmetry that can be proved is the fee, not the stop");
    expect(html).toContain("SPYx carries no fee setting at all and no key able to add one, while ANTHROPIC has one its issuer can raise");
    expect(html).toContain("Nothing here measures which of them is likelier to.");
    expect(html).toContain("it is that a stranger&#x27;s key can stop your pension buying anything at all, on any day he chooses.");
    expect(html).not.toContain("SPYx carries the same empty field, a different key holds it");

    expect(html).toContain(
      "I understand each issuer can freeze, pause or move its own stock out of my vault, that one key holds all of those powers over ANTHROPIC, and that any of these issuers can stop my vault buying anything at all",
    );
    expect(html).not.toContain("I understand the issuer can freeze, pause or move SPYx");

    const box = html.match(/<input[^>]*name="invest-acknowledge"[^>]*>/)?.[0] ?? "";
    expect(box).toContain('type="checkbox"');
    expect(box).not.toContain("checked");
    expect(buttons("Sign investment policy").map((button) => button.disabled)).toEqual([true]);
  });

  /**
   * THE HIGH END OF THE CAP, which readCaps never guarded. It enforces a lower
   * bound (REACHABLE_PER_BUY_RAW) and an ordering and no upper bound at all, so
   * the shipped $1,000 default sat above the depth ceiling with Sign lit --
   * exactly the failure REACHABLE_PER_BUY_RAW closes at the other end.
   */
  it("derives the per-buy ceiling from the chosen legs instead of a literal, and refuses to sign above it", () => {
    // NOT A LITERAL ANY MORE. It was 380_000_000n, a fiftieth of ANTHROPIC's
    // PINNED RAYDIUM pool read on 2026-09-20, doubled for two equal legs. The
    // keeper now routes Jupiter, so that pool is not where a buy lands.
    expect(DEPTH_CEILING_PER_BUY_RAW).not.toBe(380_000_000n);

    // THE ARITHMETIC, HAND-DERIVED, so this pins the computation rather than
    // restating it. The default basket is SPYx and ANTHROPIC at 50 % each.
    // ANTHROPIC's route was counted at 7,450,000,000 raw, so one leg may take
    // ⌊7,450,000,000 / 50⌋ = 149,000,000, and the largest cap whose half still
    // floors to that is ⌈(149,000,000 + 1) × 10,000 / 5,000⌉ − 1 = 298,000,001.
    // SPYx's count is a thousand times deeper and does not bind.
    expect(DEPTH_CEILING_PER_BUY_RAW).toBe(298_000_001n);
    // Which is the $298 the 50 %-share measurement recorded on 2026-09-21 — the
    // number the brief reports, reproduced from the census rather than copied.
    expect(DEPTH_CEILING_PER_BUY_RAW! / 1_000_000n).toBe(298n);

    // The starting value is buyable at BOTH ends: over the per-leg minimum, and
    // under the ceiling the thin-pool notice quotes.
    expect(readCaps(formatUnits(SUGGESTED_PER_BUY_RAW, USDC_DECIMALS), "31000")).toMatchObject({ ok: true, maxPerCall: SUGGESTED_PER_BUY_RAW });
    expect(SUGGESTED_PER_BUY_RAW).toBeLessThanOrEqual(DEPTH_CEILING_PER_BUY_RAW!);
    expect(SUGGESTED_PER_BUY_RAW).toBeGreaterThanOrEqual(REACHABLE_PER_BUY_RAW);
    // HALF THE CEILING, so an ordinary day's drift in that market does not turn
    // the starting value into a cap that buys nothing.
    expect(SUGGESTED_PER_BUY_RAW).toBe(149_000_000n);
    expect(SUGGESTED_PER_BUY_RAW * 2n).toBeLessThanOrEqual(DEPTH_CEILING_PER_BUY_RAW!);

    // readCaps IS STILL THE PROGRAM'S RULE ALONE — a lower bound and an
    // ordering — because the depth ceiling is not a fact about the two fields
    // it reads. $1,000 parses.
    expect(readCaps("1000", "31000")).toMatchObject({ ok: true, maxPerCall: 1_000_000_000n });
    // BUT IT NO LONGER REACHES PHANTOM. The ceiling used to be a literal the
    // page could not re-derive, so refusing on it would have been refusing on a
    // number it could not defend; the page computes it now, from the basket on
    // screen, so a cap above it is an arithmetic certainty that the policy buys
    // NOTHING at any balance — and the rent is spent either way.
    expect(canSignPolicy({ acknowledged: true, capsOk: true, minimumOk: true, weightsOk: true, depthOk: false, blocked: false })).toBe(false);
    // And the gate defaults OPEN for the callers that predate it, so a basket
    // whose ceiling nobody could compute is never refused on a missing number.
    expect(canSignPolicy({ acknowledged: true, capsOk: true, minimumOk: true, weightsOk: true, blocked: false })).toBe(true);

    // At the value the box starts on, no refusal is shown.
    const html = render(screen({ kind: "ready", state: stateWith() }));
    expect(html).not.toContain("is the most this basket can buy with");
    expect(html).not.toContain("one conversion can sell more than 1 SOL");

    // A REFUSAL THAT DOES NOT SAY WHAT TO DO INSTEAD IS HALF A REFUSAL: the
    // words name the leg responsible, the day it was counted, and all three
    // ways out — the cap, that leg's share, or that leg.
    const refusal = INVEST_COPY.depthWarning("$298.00", "ANTHROPIC", "2026-09-21", "20 %");
    expect(refusal).toContain("$298.00 is the most this basket can buy with, and ANTHROPIC is what sets it");
    expect(refusal).toContain("counted on 2026-09-21");
    expect(refusal).toContain("the vault buys nothing and converts no SOL, at any balance");
    expect(refusal).toContain("lower Most per buy to $298.00 or less");
    expect(refusal).toContain("give ANTHROPIC a smaller share — 20 % or under");
    expect(refusal).toContain("take ANTHROPIC out of the basket");
    expect(refusal).toContain("Three ways out");
    // When no lighter share would save it — a one-stock basket, where the
    // share is 100 % by arithmetic — that way out is not offered, and the
    // sentence COUNTS the ones it does offer rather than promising three and
    // listing two.
    const two = INVEST_COPY.depthWarning("$149.00", "ANTHROPIC", "2026-09-21", null);
    expect(two).not.toContain("a smaller share");
    expect(two).toContain("Two ways out: lower Most per buy to $149.00 or less, or take ANTHROPIC out of the basket.");
    expect(two).not.toContain("Three ways out");
  });

  /**
   * THE THREE FIELDS THE SERVER OPENED AND THE PANEL NOW OFFERS. route.test.ts
   * pins the shapes the route takes and vault-flows.test.ts pins what is sent;
   * this pins that the owner can actually reach them, and that the ones the
   * server refuses outright can never leave the form.
   */
  it("offers the minimum per stock, the basket shares and the venue, and refuses a basket that does not add up rather than adjusting it", () => {
    const html = render(screen({ kind: "ready", state: stateWith() }));
    // The minimum starts at defaultInvestPolicy(2).minInvestment, $2.50 a leg.
    expect(html).toContain('id="invest-min-investment"');
    expect(html).toContain('value="2.5"');
    // One share box per offered leg, keyed by MINT and never by position.
    expect(html).toContain(`id="invest-weight-${SPYX_MINT}"`);
    expect(html).toContain(`id="invest-weight-${ANTHROPIC_MINT}"`);
    expect(html).toContain("Whole percentages that add up to 100.");

    // THE SUM IS EXACT, AND NOTHING IS REPAIRED -- the same rule the server
    // applies, said here so the owner learns it before he spends a build on it.
    expect(readWeights(["50", "50"])).toEqual({
      ok: true,
      byMint: new Map([
        [SPYX_MINT, 5_000],
        [ANTHROPIC_MINT, 5_000],
      ]),
    });
    expect(readWeights(["70", "30"])).toMatchObject({ ok: true });
    expect(readWeights(["50", "49"])).toMatchObject({ ok: false, message: "The shares must add up to exactly 100 %. These add up to 99 %." });
    expect(readWeights(["50", "51"])).toMatchObject({ ok: false });
    expect(readWeights(["100", "0"])).toMatchObject({ ok: false });
    expect(readWeights(["50.5", "49.5"])).toMatchObject({ ok: false });
    expect(readWeights(["50"])).toMatchObject({ ok: false });

    // THE MINIMUM IS CHECKED PER LEG against the cap beside it: the program's
    // own rule (0 < min <= max_per_call) would accept a pair that never buys.
    expect(readMinimum("2.5", 10_000_000n)).toEqual({ ok: true, raw: 2_500_000n });
    expect(readMinimum("0", 10_000_000n)).toMatchObject({ ok: false, message: "Least per stock must be more than zero." });
    // $10 a buy, two equal legs, $5 a leg: a $6 minimum can never be reached.
    expect(readMinimum("6", 10_000_000n)).toMatchObject({ ok: false, message: "At these settings no buy ever reaches $6.00 for every stock, so nothing would be bought. Lower this, or raise Most per buy." });
    expect(readMinimum("5", 10_000_000n)).toMatchObject({ ok: true });

    // SIGN IS GATED ON ALL OF IT, not only the caps and the box.
    expect(canSignPolicy({ acknowledged: true, capsOk: true, minimumOk: true, weightsOk: true, blocked: false })).toBe(true);
    expect(canSignPolicy({ acknowledged: true, capsOk: true, minimumOk: true, weightsOk: false, blocked: false })).toBe(false);
    expect(canSignPolicy({ acknowledged: true, capsOk: true, minimumOk: false, weightsOk: true, blocked: false })).toBe(false);
  });

  /**
   * THE PICKER IS IN THE CARD, AND THE CARD'S OWN BARS MOVE WITH IT.
   *
   * BasketPicker.test.ts pins the list and basket-picker.test.ts pins the
   * arithmetic. What is pinned here is the seam: that the card renders the
   * catalogue rather than the two fixed boxes it used to, and that the floor
   * under Most per buy is computed from the basket on screen rather than from
   * a constant that was only ever right for the shelf being the whole basket.
   */
  it("puts the whole catalogue in the card, and moves the cap's floor with the basket instead of holding a constant", () => {
    const html = render(screen({ kind: "ready", state: stateWith() }));
    // Every stock the catalogue knows, offered or refused, is tickable-or-not
    // HERE — the card no longer shows one box per offered leg and nothing else.
    for (const asset of CATALOGUE) expect(html).toContain(`id="invest-pick-${asset.mint}"`);
    expect(html).toContain("A buy takes the whole basket or none of it.");
    // And a refused stock arrives with its reason, inside the card.
    expect(html).toContain(offerProblems(CATALOGUE.find((asset) => asset.mint === ANDURIL_MINT)!)[0]!.why.replaceAll("'", "&#x27;"));

    // THE ORDER IS PART OF THE ANSWER. The basket sets BOTH ends of the window
    // the cap has to sit in, so it is chosen first; the window is stated next,
    // before the box rather than as an explanation of a refusal after it.
    expect(html.indexOf(`id="invest-pick-${SPYX_MINT}"`)).toBeLessThan(html.indexOf('id="invest-max-per-call"'));
    expect(html).toContain("At these shares, Most per buy can be between $5.00 and $298.00.");
    expect(html.indexOf("At these shares, Most per buy can be between")).toBeLessThan(html.indexOf('id="invest-max-per-call"'));
    // Its top is dated and attributed on the same line, so a stale ceiling is
    // visible as a stale one rather than reading as today's.
    expect(html).toContain("the top is ANTHROPIC&#x27;s market as it was counted on 2026-09-21");

    // THE FORM OPENS ON THE SHELF, at whole percents that add up exactly.
    expect(DEFAULT_PICKED.map((row) => row.mint)).toEqual(OFFERED_LEGS.map((leg) => leg.mint));
    expect(DEFAULT_PICKED.reduce((total, row) => total + Number(row.percent), 0)).toBe(100);
    expect(DEFAULT_PICKED.every((row) => isOfferable(CATALOGUE.find((asset) => asset.mint === row.mint)!))).toBe(true);
    expect(DEFAULT_PICKED.length).toBeLessThanOrEqual(PICKER_MAX_LEGS);

    // THE BASKET'S SIZE IS A RULE AT BOTH ENDS, refused on the form rather
    // than by the build route after the owner has already pressed Sign.
    const leg = (index: number) => ({ mint: `Mint${index}`, symbol: `S${index}` });
    expect(readWeights([], [])).toMatchObject({ ok: false, message: "Choose at least one stock for your vault to buy." });
    const six = Array.from({ length: 6 }, (_, index) => leg(index));
    expect(readWeights(["20", "20", "20", "20", "10", "10"], six)).toMatchObject({
      ok: false,
      message: `A basket holds at most ${PICKER_MAX_LEGS} stocks. This one has 6: untick one before adding another.`,
    });
    // Five is fine, and five equal shares add up exactly.
    expect(readWeights(["20", "20", "20", "20", "20"], six.slice(0, 5))).toMatchObject({ ok: true });
    // The same mint twice is a basket the program refuses outright, and the sum
    // would still have been 100.
    expect(readWeights(["50", "50"], [leg(0), leg(0)])).toMatchObject({ ok: false });

    // THE FLOOR UNDER "Most per buy" IS THE LIGHTEST SHARE'S, NOT A CONSTANT.
    // Five equal legs at a $1 minimum need $5 a buy; one leg at 5 % needs $20.
    // readCaps holds the cap to whichever floor the basket on screen produced.
    expect(readCaps("5", "31000", 5_000_000n)).toMatchObject({ ok: true });
    expect(readCaps("19.99", "31000", 20_000_000n)).toMatchObject({ ok: false });
    expect(readCaps("20", "31000", 20_000_000n)).toMatchObject({ ok: true, maxPerCall: 20_000_000n });
    // And with no floor passed it is still the default basket's, so every
    // caller that predates the picker keeps the bar it had.
    expect(readCaps(formatUnits(REACHABLE_PER_BUY_RAW - 1n, USDC_DECIMALS), "31000")).toMatchObject({ ok: false });
    expect(readCaps(formatUnits(REACHABLE_PER_BUY_RAW, USDC_DECIMALS), "31000")).toMatchObject({ ok: true });
  });

  /**
   * THE VENUE IS A NAME FROM A CLOSED SET, AND THE PANEL FAILS CLOSED.
   * The server serves the names it enforces; the web can only SIGN a name whose
   * program it can check the built bytes against. So the box offers the
   * intersection, and a server that learns a new venue does not make the panel
   * offer something it cannot verify.
   */
  it("offers only venue names the server serves AND this app can check the bytes of, and never puts a program id in the form", () => {
    const offered = render(screen({ kind: "ready", state: { ...stateWith(), offeredVenues: ["raydium-clmm"] } }));
    expect(offered).toContain('id="invest-venue"');
    expect(offered).toContain('value="raydium-clmm"');
    // NAMES ONLY: the program id never reaches the browser's form.
    expect(offered).not.toContain(RAYDIUM_CLMM);

    // A name this app cannot verify is not offered, even when the server does.
    const unknown = render(screen({ kind: "ready", state: { ...stateWith(), offeredVenues: ["orca-whirlpool"] } }));
    expect(unknown).not.toContain("orca-whirlpool");
    expect(unknown).not.toContain('id="invest-venue"');

    // An older server that serves no list at all offers no choice and leaves
    // the default alone, rather than guessing at one.
    expect(render(screen({ kind: "ready", state: stateWith() }))).not.toContain('id="invest-venue"');
  });

  it("Sign is possible only with the box ticked, valid caps and no other write running", () => {
    expect(canSignPolicy({ acknowledged: true, capsOk: true, blocked: false })).toBe(true);
    expect(canSignPolicy({ acknowledged: false, capsOk: true, blocked: false })).toBe(false);
    expect(canSignPolicy({ acknowledged: true, capsOk: false, blocked: false })).toBe(false);
    expect(canSignPolicy({ acknowledged: true, capsOk: true, blocked: true })).toBe(false);
  });

  // The bar is the cap at which the LIGHTEST leg's slice clears min_investment,
  // not min_investment itself: at two equal legs min_investment is $2.50 and a
  // $2.50 cap gives each leg $1.25, a policy that can never buy.
  it("reads the caps as dollars into USDC raw units, and refuses a per-buy cap under $5 or a month under one buy", () => {
    expect(readCaps("10", "50")).toEqual({ ok: true, maxPerCall: 10_000_000n, maxRolling30d: 50_000_000n });
    expect(readCaps("1000", "31000")).toEqual({ ok: true, maxPerCall: 1_000_000_000n, maxRolling30d: 31_000_000_000n });
    expect(readCaps("4.99", "50")).toMatchObject({ ok: false });
    expect(readCaps("2.50", "50")).toMatchObject({ ok: false, message: "Most per buy must be at least $5.00, and Most per 30 days at least Most per buy." });
    expect(readCaps("5", "50")).toEqual({ ok: true, maxPerCall: 5_000_000n, maxRolling30d: 50_000_000n });
    expect(readCaps("10", "9")).toMatchObject({ ok: false, message: "Most per buy must be at least $5.00, and Most per 30 days at least Most per buy." });
    expect(readCaps("", "50")).toMatchObject({ ok: false });
    expect(readCaps("10.0000001", "50")).toMatchObject({ ok: false });
  });

  it("the rent quoted counts the policy and only the vault accounts missing, and says nothing when a part is unknown", () => {
    const partly = stateWith();
    const items = partly.vaultTokenAccounts.items.map((item) => (item.mint === USDC_MINT ? { ...item, status: "exists" as const } : item));
    expect(setupRent({ ...partly, vaultTokenAccounts: { status: "exists", items } })).toBe(5_577_840n + 1_488_440n + 1_559_560n + 1_620_520n);
    expect(setupRent({ ...partly, rents: null })).toBeNull();
    expect(setupRent({ ...partly, vaultTokenAccounts: { status: "unreadable", items: [] } })).toBeNull();
  });

  it("a policy: on, the basket, its floors against today's prices below market, the caps, what it used and invested, and whether it can buy", () => {
    const holdings: VaultStateJson["holdings"] = { status: "exists", items: [{ tokenAccount: account(), mint: USDC_MINT, amountRaw: "3000000", decimals: 6, uiAmount: "3", tokenProgram: TOKEN_PROGRAM }] };
    const html = render(screen({ kind: "ready", state: stateWith({ policy: { status: "exists", address: account(), state: POLICY }, holdings }) }));
    expect(html).toContain("Investing is on.");
    expect(html).toContain("Floors below market");
    expect(html).toContain("SPYx · 50 %, ANTHROPIC · 50 %");
    expect(html).toContain("$10.00");
    expect(html).toContain("$50.00");
    expect(html).toContain("$25.00");
    expect(html).toContain("SOL floor $90.03, today $100.04");
    expect(html).toContain("SPYx ceiling $801.80 per 100,000,000 raw units, today $761.71");
    expect(html).toContain("ANTHROPIC ceiling $18.95 per 100,000,000 raw units, today $18.00");
    expect(html).toContain("Waiting: it buys once the vault holds $5.00 of USDC.");
    expect(html).toContain("Signing again does not refill this month&#x27;s cap.");
    expect(buttons("Sign again with today's prices")).toHaveLength(1);
    expect(buttons("Pause investing")).toHaveLength(1);
    expect(buttons("Sign investment policy")).toHaveLength(0);
    // AND NOTHING ABOUT DRIFT, because these floors are exactly where they were
    // signed: 90.03 against 100.04 is the 10 % convert margin, and both legs sit
    // 5 % under today. A notice that fired here would fire on every policy the
    // moment it was signed, which is a notice nobody would read.
    expect(html).not.toContain("The limits you signed do not follow the market");
  });

  it("a SOL price under the signed floor says buying waits until signing again", () => {
    const fallen = { ...PRICES!, convertWad: "80000000000000000", usdcRawPerSol: "80000000" };
    const html = render(screen({ kind: "ready", state: stateWith({ policy: { status: "exists", address: account(), state: POLICY }, prices: fallen }) }));
    expect(html).toContain("The market moved past a floor: buying waits until you sign again with today&#x27;s prices.");
    expect(html).not.toContain("Floors below market");
    // AND WHICH FLOOR, AND WHAT IT STOPS. The badge says a floor has been
    // passed; this says it was the SOL one, at what price, and that the
    // conversion stopping stops the buying too.
    expect(html).toContain("The limits you signed do not follow the market");
    expect(html).toContain("Your SOL floor is $90.03 per SOL and SOL is at $80.00, under it: no SOL is converted, so nothing is bought, until you sign again with today&#x27;s prices.");
  });

  /**
   * THE HALF THAT WAS INVISIBLE. A floor the market has PASSED is loud: the
   * badge flips and buying stops. A floor the market has walked away FROM is
   * silent — still signed, still enforced, and now permitting a fill at a price
   * nobody would take today. The keeper's own comment on min_out_rate_wad says
   * both halves ("it clears itself as the market rises ... and blocks every
   * honest buy as the market falls"), and only one of them was on the screen.
   */
  it("says how far a signed floor has drifted from the market, and that the day it was signed is not knowable", () => {
    // SPYx's price fell to a third since signing — min_out_rate_wad is units
    // per USDC, so a bigger wad is a cheaper stock — and the stored floor still
    // lets the vault pay $801.80 per 100,000,000 raw units for something the
    // market is selling at $253.90.
    const walked = { ...PRICES!, legs: PRICES!.legs.map((leg) => (leg.mint === SPYX_MINT ? { ...leg, wad: "393850950391912707" } : leg)) };
    const html = render(screen({ kind: "ready", state: stateWith({ policy: { status: "exists", address: account(), state: POLICY }, prices: walked }) }));
    expect(html).toContain("The limits you signed do not follow the market");
    // THE DRIFT IS ARITHMETIC OVER TWO NUMBERS ON THE PAGE — the wad the policy
    // carries and the wad just read — and it is quoted against the floor, which
    // is what the sentence names.
    expect(html).toContain("SPYx may still be bought at up to $801.80, while the market is at $253.90 — 215.78 % above today&#x27;s price");
    expect(html).toContain("it is no longer stopping much");
    expect(html).toContain("Sign again to set it from today&#x27;s prices.");
    // THE DATE IS NOT INVENTED. InvestmentPolicy carries no timestamp, so the
    // page says it cannot date the signature rather than implying freshness.
    expect(html).toContain("SaverFi cannot tell you which day that was — the policy on Solana does not record one");
    // AND THE LEG THAT HAS NOT DRIFTED IS NOT LISTED: ANTHROPIC still sits 5 %
    // under its own market, which is where it was signed.
    expect(html).not.toContain("ANTHROPIC may still be bought");
  });

  it("Pause asks for the policy on screen to be signed again with investing off, and is offered with no prices on screen; it never hands the flow the click event", async () => {
    const build = vi.fn(async () => ({ ok: false as const, status: 409, code: "vault_missing", message: "Create your vault first.", retryAfterSeconds: null, body: {} }));
    const value = screen({ kind: "ready", state: stateWith({ policy: { status: "exists", address: account(), state: POLICY }, prices: null }) }, { build: build as unknown as VaultApi["build"] });
    const html = render(value);
    expect(html).toContain("Pausing signs this policy again as it is, with investing off, so it needs no prices.");
    expect(buttons("Pause investing").map((button) => button.disabled)).toEqual([false]);
    buttons("Pause investing")[0]?.onClick?.(CLICK);
    await vi.waitFor(() => expect(value.refresh).toHaveBeenCalledTimes(1));
    expect(build.mock.calls).toStrictEqual([[{ action: "pauseInvesting", owner: PENSION }]]);
    expect(mocked.signTransaction).not.toHaveBeenCalled();
  });

  it("Resume hands the flow the stored caps with investing on, which reads today's prices", async () => {
    const build = vi.fn(async () => ({ ok: false as const, status: 409, code: "vault_missing", message: "Create your vault first.", retryAfterSeconds: null, body: {} }));
    const value = screen({ kind: "ready", state: stateWith({ policy: { status: "exists", address: account(), state: { ...POLICY, enabled: false } } }) }, { build: build as unknown as VaultApi["build"] });
    const html = render(value);
    expect(html).toContain("Investing is paused.");
    buttons("Resume investing")[0]?.onClick?.(CLICK);
    await vi.waitFor(() => expect(value.refresh).toHaveBeenCalledTimes(1));
    expect(build.mock.calls).toStrictEqual([[{ action: "investPolicy", owner: PENSION, maxPerCall: "10000000", maxRolling30d: "50000000", enabled: true }]]);
  });

  /**
   * A build answer whose dollar fields and whose wads disagree. Nothing holds
   * the two to each other: the flow checks the WADS (they are what the
   * transaction carries), while floorUsdcRawPerSol, maxUsdcRawPer1e8 and
   * symbol ride along unchecked.
   */
  const FORGED_BUILD = {
    txBase64: "",
    lastValidBlockHeight: 1,
    floors: {
      slot: 1,
      marginBps: { convert: 1_000, leg: 500 },
      liveConvertWad: "2",
      convertWad: "1",
      usdcRawPerSol: "100038711",
      floorUsdcRawPerSol: "90034840",
      legs: [
        { symbol: "NOTSPYX", mint: SPYX_MINT, liveWad: "2", wad: "1", usdcRawPer1e8: "761709474", maxUsdcRawPer1e8: "801799446" },
        { symbol: "NOTANTHROPIC", mint: ANTHROPIC_MINT, liveWad: "2", wad: "1", usdcRawPer1e8: "18000000", maxUsdcRawPer1e8: "18947369" },
      ],
    },
  };

  const signingDetail = (built: unknown): string =>
    renderToStaticMarkup(
      createElement(SigningDetail, {
        progress: { phase: "running", kind: "policy", step: "approve_pension", built } as WriteProgress,
        request: { maxPerCall: 10_000_000n, maxRolling30d: 50_000_000n, enabled: true },
      }),
    );

  it("what Phantom is asked to sign is read from the floors the BYTES carry, never from the answer's own dollar fields", () => {
    const html = signingDetail(FORGED_BUILD);
    // The unchecked display fields, over bytes that signed neither of them.
    expect(html).not.toContain("$90.03");
    expect(html).not.toContain("$801.80");
    expect(html).not.toContain("$18.95");
    expect(html).not.toContain("NOTSPYX");
    expect(html).not.toContain("NOTANTHROPIC");
    // What min_convert_rate_wad = 1 actually means, and SaverFi's own basket names.
    expect(html).toContain("SOL never sold below $0.00");
    expect(html).toContain("SPYx never bought above");
    expect(html).toContain("ANTHROPIC never bought above");
    // The caps are this card's own, not the answer's.
    expect(html).toContain("$10.00");
    expect(html).toContain("$50.00");
  });

  it("an honest build is described by its own floors", () => {
    const honest = {
      ...FORGED_BUILD,
      floors: {
        ...FORGED_BUILD.floors,
        convertWad: "90034840399943305",
        legs: [
          { ...FORGED_BUILD.floors.legs[0]!, wad: "124719467624105690" },
          { ...FORGED_BUILD.floors.legs[1]!, wad: "5277777777777777778" },
        ],
      },
    };
    const html = signingDetail(honest);
    expect(html).toContain("SOL never sold below $90.03");
    expect(html).toContain("SPYx never bought above $801.80");
    expect(html).toContain("ANTHROPIC never bought above $18.95");
  });

  it("says nothing rather than a figure when a checked floor cannot be read", () => {
    expect(signingDetail({ ...FORGED_BUILD, floors: { ...FORGED_BUILD.floors, convertWad: "0" } })).toBe("");
    expect(signingDetail({ ...FORGED_BUILD, floors: { ...FORGED_BUILD.floors, legs: [] } })).toBe("");
    // A build that carries only the first leg is one floor short of the basket, and says nothing either.
    expect(signingDetail({ ...FORGED_BUILD, floors: { ...FORGED_BUILD.floors, legs: [FORGED_BUILD.floors.legs[0]!] } })).toBe("");
    expect(signingDetail({ txBase64: "", lastValidBlockHeight: 1 })).toBe("");
  });

  it("sums the day-buckets of the trailing 31 days as the program does", () => {
    const now = 20_000 * 86_400 + 5;
    const days = new Array<number>(31).fill(0);
    const amounts = new Array<string>(31).fill("0");
    [days[0], amounts[0]] = [20_000, "1000000"];
    [days[1], amounts[1]] = [19_970, "2000000"];
    [days[2], amounts[2]] = [19_969, "4000000"];
    expect(usedInLast30Days(days, amounts, now)).toBe(3_000_000n);
  });
});
