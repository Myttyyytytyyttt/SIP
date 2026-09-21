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

    // WHAT THE POSITION COSTS, with each number's owner named: the issuer sets
    // one and has moved it twice, the day's liquidity sets the other. SPYx is
    // beside it as the proof that this is these tokens, not Solana.
    expect(html).toContain("ANTHROPIC&#x27;s issuer charges 1 % of every transfer of it: once when your vault buys it, and once when it leaves.");
    // COMPOUNDED, NOT DOUBLED: 1 - 0.99^2 is 1.99 %, and "about 2 %" rounded
    // the owner's way past the only arithmetic on this card he could check.
    expect(html).toContain("gives up 1.99 % before the market is involved at all — not quite two, because the second 1 % is taken from what the first one left.");
    // A FEE, NOT SLIPPAGE. Nothing here may leave him thinking a smaller buy
    // escapes it: it is charged on every transfer, and again on every later one.
    expect(html).toContain("Buying in smaller pieces does not make it smaller");
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
    expect(html).toContain("it was 0.5 % for about two weeks, and it became 1 % when the current epoch began, hours before this was written on 20 September 2026.");
    expect(html).not.toContain("a few days ago");
    expect(html).not.toContain("it has been nothing, then 0.5 %");
    // THE CLOSED MEASUREMENT, and no tighter than it was read: simulated round
    // trips on mainnet, the sell chained on the credit the buy really returned
    // rather than on a quote. ANTHROPIC 2.4 % (2.24-2.63 %), of which 1.99 % is
    // the fee and 0.25-0.64 % the market; SPYx 1.1-1.8 basis points. The two
    // earlier readings -- the 0.60/0.57/1.26 % size curve, and the Jupiter
    // quotes that read this round trip at 0.41-0.44 % before the measurement
    // finished -- are gone from every sentence, not only from their own.
    expect(html).toContain("measured on 20 September 2026 on Solana itself — seven round trips, built and run but never signed, each sale priced on what its purchase actually delivered rather than on a quote.");
    expect(html).toContain("ANTHROPIC&#x27;s round trip cost 2.4 % all told, between 2.24 % and 2.63 %.");
    expect(html).toContain("the rest, between 0.25 % and 0.64 %, is the market, and it moved by 0.36 % within thirteen minutes that day.");
    expect(html).toContain("SPYx&#x27;s round trip, measured the same way, cost between 0.011 % and 0.018 %.");
    expect(html).not.toContain("1.3 % at $100");
    expect(html).not.toContain("because its pool is small");
    // THE OLD CLAIM IN ITS OLD SHAPE, not a bare number: 2.4 - 1.99 = 0.41 is
    // the market's own central share now, so banning the digits alone would go
    // red on a future editor writing something true. 0.44 % came only from the
    // dead reading, so it stays banned outright.
    expect(html).not.toMatch(/0\.41 %\s*(?:and|to|[-–—])\s*0\.44 %/);
    expect(html).not.toContain("half a percent");
    expect(html).toContain("cost 2.4 % on the day it was measured: 1.99 % of that is the issuer&#x27;s fee, charged whatever the market does");
    expect(html).toContain("SPYx cost under two hundredths of one percent the same day — more than a hundred times less.");

    // THE LIMIT THE NEXT RAISE CROSSES. Two sentences tell him the issuer moves
    // this fee and just did; none told him what the next move costs. ANTHROPIC
    // sits exactly on MAX_LEG_FEE_BPS, and the keeper's refusal is all-or-
    // nothing -- SPYx and the SOL conversion go down with it.
    expect(html).toContain("the keeper will not buy a stock that charges more than 1 % to transfer");
    expect(html).toContain("ANTHROPIC sits exactly on that limit today");
    expect(html).toContain("the vault stops buying the whole basket — SPYx along with it — and stops converting your SOL at all");
    expect(html).toContain("The difference is these two issuers and these two pools — not Solana, and not SaverFi.");

    // THE ISSUER RISK HE TICKS A BOX ABOUT. It named SPYx only, which is the
    // safer leg on every count — he was acknowledging the wrong token.
    expect(html).toContain("move it out of your vault through a permanent delegate");
    expect(html).toContain(
      "On ANTHROPIC a single key holds all of it at once — minting, freezing, pausing, the transfer fee, the transfer hook and the permanent delegate — and that key has already been used to raise the fee, from 0.5 % to 1 %, on the day this page was written.",
    );
    expect(html).toContain("On SPYx those powers sit with three separate keys and there is no fee to raise.");

    // THE SECOND SWITCH THE SAME KEY HOLDS, which the card never mentioned
    // while three of its sentences discussed the first. A filled-in transfer
    // hook is refused by the keeper outright, and the refusal is all-or-
    // nothing: SPYx and the SOL conversion stop with it.
    expect(html).toContain("The same key holds a second switch, and this one is not about money at all: it stops the buying.");
    expect(html).toContain("on both it is empty today, which is the issuer keeping the option rather than using it.");
    expect(html).toContain("SaverFi will not buy a stock whose field has been filled in");
    expect(html).toContain("the vault stops buying the whole basket — SPYx along with it — and stops converting your SOL, until the basket itself is changed.");
    expect(html).toContain("It applies from the moment it is written: the next buy is the one that stops.");
    // THE STOP SPEAKS FOR ITSELF. A bare "Nothing you have already saved is
    // lost or moved." sat two paragraphs under the permanent delegate IN THIS
    // SAME BOX, where alone it promises that nothing can ever be taken.
    expect(html).toContain("That stop takes nothing from you: what you have already saved is neither lost nor moved by it.");
    expect(html).toContain("The freeze, the pause and the permanent delegate described above are separate powers, and those can reach what your vault already holds.");
    expect(html).not.toContain("Nothing you have already saved is lost or moved.");
    // BOTH LEGS CARRY THE STOP; ONLY THE FEE IS ASYMMETRIC. SPYx has a live
    // hook authority of its own, so the old pairing of "a different key holds
    // it" with a close on "one stranger's key" read as ANTHROPIC's risk alone.
    expect(html).toContain("either issuer can fill its own field in and stop the whole basket the same way");
    expect(html).toContain("The asymmetry that can be proved is the fee, not the stop");
    expect(html).toContain("SPYx&#x27;s mint carries no fee setting at all and no key able to add one");
    expect(html).toContain("Nothing here measures which of them is likelier to.");
    expect(html).toContain("it is that either stranger&#x27;s key can stop your pension buying anything at all, on any day he chooses.");
    expect(html).not.toContain("SPYx carries the same empty field, a different key holds it");
    expect(html).not.toContain("one stranger&#x27;s key can stop your pension");

    expect(html).toContain(
      "I understand each issuer can freeze, pause or move its own stock out of my vault, that one key holds all of those powers over ANTHROPIC, and that the same key can stop my vault buying anything at all",
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
  });

  it("a SOL price under the signed floor says buying waits until signing again", () => {
    const fallen = { ...PRICES!, convertWad: "80000000000000000", usdcRawPerSol: "80000000" };
    const html = render(screen({ kind: "ready", state: stateWith({ policy: { status: "exists", address: account(), state: POLICY }, prices: fallen }) }));
    expect(html).toContain("The market moved past a floor: buying waits until you sign again with today&#x27;s prices.");
    expect(html).not.toContain("Floors below market");
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
