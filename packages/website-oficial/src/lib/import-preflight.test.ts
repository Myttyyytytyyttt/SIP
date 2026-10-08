// Every reason not to import a key, read before the key goes anywhere. A check
// that could not be made refuses: an import is not undone.

import { USDC_MINT } from "@sip/solana-core/client";
import { describe, expect, it } from "vitest";

import { HOLDINGS_COPY, PREFLIGHT_COPY, importPreflight, startingPointLine, type Preflight } from "@/lib/import-preflight";
import { MAX_TRADING_WALLETS, type SeatConfig } from "@/lib/trading-wallets";
import type { ImportCheckJson } from "@/lib/vault-api";

import { PENSION_KEY, POLICY, SIGNER, TRADING_0, embedded, phantom, teeWallet, userWith } from "../../test/fixtures/privy-user";

const CANDIDATE = "CandidateP1aceho1der111111111111111111111";
const OTHER_VAULT = "OtherVau1tP1aceho1der11111111111111111111";
const SEAT: SeatConfig = { privySignerId: SIGNER, privyPolicyId: POLICY };
const USER = userWith([phantom(), teeWallet(TRADING_0, 0, true)]);

function check(overrides: Partial<ImportCheckJson> = {}): ImportCheckJson {
  return {
    owner: PENSION_KEY,
    wallet: CANDIDATE,
    programId: "program",
    ownVault: { address: "vault-of-candidate", status: "missing" },
    protocolRole: "none",
    link: { address: "link-of-candidate", status: "missing", vault: null },
    lamports: "50000000",
    tokens: { status: "exists", items: [], count: 0, emptyAccounts: 0 },
    ...overrides,
  };
}

const run = (overrides: Partial<Parameters<typeof importPreflight>[0]> = {}): Preflight =>
  importPreflight({ address: CANDIDATE, pensionKey: PENSION_KEY, user: USER, config: SEAT, check: check(), ...overrides });

const reason = (verdict: Preflight): string | null => (verdict.kind === "refused" ? verdict.reason : null);

const HOLDING = { tokenAccount: "ata", mint: USDC_MINT, amountRaw: "1000000000", decimals: 6, uiAmount: "1000", tokenProgram: "token" };

describe("importPreflight: the local checks, before the chain is asked", () => {
  it("asks for the chain once every local check passes, and not before", () => {
    expect(run({ check: null })).toEqual({ kind: "read_chain" });
  });

  const LOCAL: ReadonlyArray<readonly [string, Partial<Parameters<typeof importPreflight>[0]>, string]> = [
    ["a seat with no policy", { config: { privySignerId: SIGNER, privyPolicyId: null } }, "seat"],
    ["no seat at all", { config: { privySignerId: null, privyPolicyId: null } }, "seat"],
    ["the pension key itself", { address: PENSION_KEY }, "pension_key"],
    ["a wallet already on the account", { address: TRADING_0 }, "already_yours"],
    ["a wallet already on the account, imported", { user: userWith([phantom(), embedded(CANDIDATE, null, true, { imported: true })]) }, "already_yours"],
    ["a wallet the account connects from its own app", { user: userWith([phantom(), phantom(CANDIDATE)]) }, "connected_wallet"],
    [
      `an account with ${MAX_TRADING_WALLETS} trading wallets, any mix of created and imported`,
      {
        user: userWith([
          phantom(),
          ...Array.from({ length: MAX_TRADING_WALLETS - 1 }, (_, index) => teeWallet(`Created${index}P1aceho1der1111111111111111111`.slice(0, 43), index, true)),
          embedded("Imported9P1aceho1der11111111111111111111111", null, true, { imported: true }),
        ]),
      },
      "full",
    ],
  ];

  it.each(LOCAL)("refuses %s, without asking the chain", (_, overrides, expected) => {
    expect(reason(run({ ...overrides, check: null }))).toBe(expected);
  });

  it("takes the seat first: no other reason matters when nothing could be seated", () => {
    expect(reason(run({ config: { privySignerId: null, privyPolicyId: null }, address: PENSION_KEY }))).toBe("seat");
  });

  it("leaves room for one more below the cap", () => {
    const user = userWith([phantom(), ...Array.from({ length: MAX_TRADING_WALLETS - 1 }, (_, index) => teeWallet(`Created${index}P1aceho1der1111111111111111111`.slice(0, 43), index, true))]);
    expect(run({ user, check: null })).toEqual({ kind: "read_chain" });
  });
});

describe("importPreflight: what the chain says", () => {
  it("goes, with a link to make and nothing to acknowledge, for a fresh SOL-only wallet", () => {
    expect(run()).toEqual({ kind: "go", needsLink: true, lamports: 50_000_000n, holdings: null });
  });

  it("goes WITHOUT a link for a wallet already linked to this vault", () => {
    expect(run({ check: check({ link: { address: "link", status: "this_vault", vault: "this" } }) })).toMatchObject({ kind: "go", needsLink: false });
  });

  const CHAIN: ReadonlyArray<readonly [string, ImportCheckJson | "unreadable", string]> = [
    ["a key that owns a vault", check({ ownVault: { address: "v", status: "exists" } }), "owns_vault"],
    ["a key that owns a vault, linked elsewhere too", check({ ownVault: { address: "v", status: "exists" }, link: { address: "l", status: "other_vault", vault: OTHER_VAULT } }), "owns_vault"],
    ["a wallet linked to another vault", check({ link: { address: "l", status: "other_vault", vault: OTHER_VAULT } }), "linked_elsewhere"],
    ["the protocol's authority", check({ protocolRole: "authority" }), "protocol_key"],
    ["the authority a transfer is pending to", check({ protocolRole: "pending_authority" }), "protocol_key"],
    ["the protocol's keeper (crank)", check({ protocolRole: "keeper" }), "protocol_key"],
    ["the protocol's attester", check({ protocolRole: "attester" }), "protocol_key"],
    ["a config read that failed", check({ protocolRole: "unreadable" }), "chain_unreadable"],
    ["a request that failed", "unreadable", "chain_unreadable"],
    ["a vault read that failed", check({ ownVault: { address: "v", status: "unreadable" } }), "chain_unreadable"],
    ["a link read that failed", check({ link: { address: "l", status: "unreadable", vault: null } }), "chain_unreadable"],
    ["a token read that failed", check({ tokens: { status: "unreadable", items: [], count: null, emptyAccounts: null } }), "chain_unreadable"],
    ["an answer about another address", check({ wallet: TRADING_0 }), "chain_unreadable"],
    ["an answer about another owner's vault", check({ owner: TRADING_0 }), "chain_unreadable"],
  ];

  it.each(CHAIN)("refuses %s", (_, answer, expected) => {
    expect(reason(run({ check: answer }))).toBe(expected);
  });

  it("puts what the wallet holds in front of the person, the count of the rest and the empty token accounts included", () => {
    expect(run({ check: check({ tokens: { status: "exists", items: [HOLDING], count: 12, emptyAccounts: 3 } }) })).toEqual({
      kind: "go",
      needsLink: true,
      lamports: 50_000_000n,
      holdings: { holdings: [HOLDING], count: 12, emptyAccounts: 3 },
    });
    expect(run({ check: check({ tokens: { status: "exists", items: [], count: 0, emptyAccounts: 1 } }) })).toMatchObject({ holdings: { holdings: [], count: 0, emptyAccounts: 1 } });
  });

  it("A LISTING TOO LARGE TO READ is warned about with nothing named — never waved through, never refused for good", () => {
    expect(run({ check: check({ tokens: { status: "too_many", items: [], count: null, emptyAccounts: null } }) })).toEqual({
      kind: "go",
      needsLink: true,
      lamports: 50_000_000n,
      holdings: { holdings: [], count: null, emptyAccounts: null },
    });
  });

  it("goes with an unknown balance rather than an invented one", () => {
    expect(run({ check: check({ lamports: null }) })).toMatchObject({ kind: "go", lamports: null });
    expect(startingPointLine(null)).toBeNull();
    expect(startingPointLine(1_500_000_000n)).toBe(HOLDINGS_COPY.startingPoint("1.5"));
  });
});

describe("the refusals' words", () => {
  it("say nothing was sent wherever something could have been", () => {
    for (const message of [PREFLIGHT_COPY.ownsVault, PREFLIGHT_COPY.protocolKey, PREFLIGHT_COPY.linkedElsewhere, PREFLIGHT_COPY.chainUnreadable, PREFLIGHT_COPY.connectedWallet]) {
      expect(message).toMatch(/nothing was sent/i);
    }
  });

  it("name the cap with the number the code enforces", () => {
    expect(PREFLIGHT_COPY.full).toContain(String(MAX_TRADING_WALLETS));
  });
});
