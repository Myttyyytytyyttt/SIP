// The per-trade modes: ROUND-UP (2) and FIXED (3), through set_policy_v3 and
// settle_v3, and the one guard settle_v2 gained.
//
// EVERY REFUSAL IS ASSERTED BY NAME, as tests/settle.ts does: each guards money.
// A round-up amount above the bound is a keeper charging more than a unit per
// trade; a price below half of Pyth's is the scale bug that charges a whole
// trade; a v2 settle on a per-trade vault is Trap 1, the PROFIT rate applied to
// a number that is not a profit.
//
// The Pyth accounts are preloaded from tests/fixtures/pyth (Anchor.toml lists
// them for anchor test; rehearsal/run-suite.ts passes the same files).

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert } from "chai";
import { SipVault } from "../target/types/sip_vault";
import { configPdaFor, ensureConfig, pollingConfirm, TEST_ATTESTER } from "./config-fixture";
import {
  attestationInstruction,
  attestationV3Instruction,
  MODE_FIXED,
  MODE_PROFIT,
  MODE_ROUNDUP,
  MODE_VOLUME,
  type AttestationInputs,
  type AttestationV3Inputs,
} from "../scripts/attestation";
import {
  fixedAmountLamports,
  pricesHash,
  pricesHashWords,
  roundupBoundLamports,
  roundupTradeLamports,
  type PricedTrade,
} from "../scripts/per-trade";
import { linkWalletWithConsent } from "../scripts/link-consent";

const pyth = (name: string): PublicKey =>
  new PublicKey(
    (JSON.parse(readFileSync(join(__dirname, "fixtures", "pyth", `${name}.json`), "utf8")) as { pubkey: string }).pubkey,
  );
const PYTH_150 = pyth("sol-usd-150");
const PYTH_MAINNET_FRESH = pyth("sol-usd-mainnet-fresh");
const PYTH_MAINNET_STALE = pyth("sol-usd-mainnet-stale");
const PYTH_PARTIAL = pyth("sol-usd-150-partial");
const PYTH_USDC = pyth("usdc-usd-fresh");
const PYTH_WRONG_OWNER = pyth("sol-usd-150-wrong-owner");

const DEPLOYED_IDL = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "sip_vault.deployed-60e94348.json"), "utf8"),
) as anchor.Idl;

const SOL = BigInt(LAMPORTS_PER_SOL);
const bn = (value: bigint | number) => new anchor.BN(value.toString());
const ZERO_HASH = Buffer.alloc(32);
const sig = (byte: number) => Buffer.alloc(64, byte);

interface PerTradePolicy {
  mode: number;
  unitCents: number;
  fixedLamports: number;
  minTradeCents: number;
  minTradeLamports: number;
  dailyCap: bigint;
  maxContribution: bigint;
  walletReserve: bigint;
  paused: boolean;
}

/** $1 unit, $1 minimum; F = 0.001 SOL, 0.01 SOL minimum; 0.06 SOL per settle, 0.3 SOL a day. */
const ROUNDUP: PerTradePolicy = {
  mode: MODE_ROUNDUP,
  unitCents: 100,
  fixedLamports: 1_000_000,
  minTradeCents: 100,
  minTradeLamports: 10_000_000,
  dailyCap: 300_000_000n,
  maxContribution: 60_000_000n,
  walletReserve: 0n,
  paused: false,
};
const FIXED: PerTradePolicy = { ...ROUNDUP, mode: MODE_FIXED };

describe("sip-vault per-trade modes: set_policy_v3 and settle_v3", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault as Program<SipVault>;
  const connection = pollingConfirm(provider.connection);
  const attester = TEST_ATTESTER;

  const airdrop = async (to: PublicKey, sol: number) => {
    await connection.confirmTransaction(await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL));
  };

  const slotAbove = async (above: bigint): Promise<bigint> => {
    for (;;) {
      const slot = BigInt(await connection.getSlot());
      if (slot > above) return slot;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  const expectFailure = async (p: Promise<unknown>, needle: string) => {
    try {
      await p;
    } catch (err) {
      assert.include(String(err), needle, `expected failure mentioning "${needle}"`);
      return;
    }
    assert.fail(`expected a failure mentioning "${needle}", but it succeeded`);
  };

  /** Every event a transaction emitted, by name, decoded with `idl`. */
  const eventsOf = async (signature: string, idl: anchor.Idl = program.idl as anchor.Idl) => {
    const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(idl));
    for (let attempt = 0; attempt < 40; attempt++) {
      const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (tx?.meta?.logMessages) {
        return [...parser.parseLogs(tx.meta.logMessages)].map((event) => ({ name: event.name, data: event.data as any }));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`transaction ${signature} never became visible`);
  };

  /** One owner, one vault, one linked trading wallet. */
  class Saver {
    readonly owner = Keypair.generate();
    readonly wallet = Keypair.generate();
    readonly vault: PublicKey;
    readonly link: PublicKey;
    readonly perTrade: PublicKey;

    constructor() {
      [this.vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), this.owner.publicKey.toBuffer()], program.programId);
      [this.link] = PublicKey.findProgramAddressSync([Buffer.from("link"), this.wallet.publicKey.toBuffer()], program.programId);
      [this.perTrade] = PublicKey.findProgramAddressSync([Buffer.from("per_trade"), this.vault.toBuffer()], program.programId);
    }

    setPolicyV3Ix(p: PerTradePolicy): Promise<TransactionInstruction> {
      return program.methods
        .setPolicyV3(p.mode, p.unitCents, p.fixedLamports, p.minTradeCents, p.minTradeLamports, bn(p.dailyCap), bn(p.maxContribution), bn(p.walletReserve), p.paused)
        .accounts({ owner: this.owner.publicKey })
        .instruction();
    }

    async setPolicyV3(over: Partial<PerTradePolicy>, base: PerTradePolicy) {
      const tx = new Transaction().add(await this.setPolicyV3Ix({ ...base, ...over }));
      return provider.sendAndConfirm(tx, [this.owner]);
    }

    setPolicyV2(mode: number, skimBps = 2_000, volumeBps = 20, maxContribution = 60_000_000n, walletReserve = 0n) {
      return program.methods
        .setPolicyV2(mode, skimBps, volumeBps, false, bn(maxContribution), bn(walletReserve))
        .accounts({ owner: this.owner.publicKey })
        .signers([this.owner])
        .rpc();
    }

    /** create_vault_v2 (mode 0) and, when given, set_policy_v3 in ONE transaction; then the link. */
    async open(perTrade: PerTradePolicy | null, createMode = MODE_PROFIT) {
      await airdrop(this.owner.publicKey, 2);
      await airdrop(this.wallet.publicKey, 20);
      const create = await program.methods
        .createVaultV2(createMode, 2_000, 20, bn(60_000_000n), bn(0n))
        .accounts({ owner: this.owner.publicKey })
        .instruction();
      const tx = new Transaction().add(create);
      if (perTrade !== null) tx.add(await this.setPolicyV3Ix(perTrade));
      await provider.sendAndConfirm(tx, [this.owner]);
      await linkWalletWithConsent(program, { owner: this.owner.publicKey, wallet: this.wallet }).signers([this.owner, this.wallet]).rpc();
      return this;
    }

    linkState() {
      return program.account.tradingLink.fetch(this.link);
    }

    policy() {
      return program.account.perTradePolicy.fetch(this.perTrade);
    }

    /**
     * What an honest keeper signs for the link's CURRENT nonce and epoch and the
     * vault's CURRENT mode, policy nonce and PerTradePolicy, over a fresh window.
     */
    async inputs(over: Partial<AttestationV3Inputs> = {}): Promise<AttestationV3Inputs> {
      const link = await this.linkState();
      const vault = await program.account.vault.fetch(this.vault);
      const policy = await this.policy();
      const end = await slotAbove(BigInt(link.frontierSlot.toString()) + 1n);
      const roundUp = vault.skimMode === MODE_ROUNDUP;
      return {
        programId: program.programId,
        wallet: this.wallet.publicKey,
        vault: this.vault,
        linkEpoch: BigInt(link.epoch.toString()),
        settlementNonce: BigInt(link.settlementNonce.toString()),
        sessionStartSlot: BigInt(link.frontierSlot.toString()),
        sessionEndSlot: end,
        amountLamports: 0n,
        mode: vault.skimMode,
        policyNonce: BigInt(vault.policyNonce.toString()),
        validUntilSlot: end + 10_000n,
        tradeCount: 0,
        priceMinUsdE6: 0n,
        modeParam: BigInt(roundUp ? policy.roundupUnitCents : policy.fixedLamports),
        minTrade: BigInt(roundUp ? policy.minTradeCents : policy.minTradeLamports),
        pricesHash: roundUp ? pricesHash([]) : ZERO_HASH,
        ...over,
      };
    }

    /** A ROUND-UP window of `trades` ({x lamports, price}) priced by scripts/per-trade.ts, as the keeper will. */
    async roundUpInputs(trades: readonly { x: bigint; price: bigint }[], over: Partial<AttestationV3Inputs> = {}) {
      const policy = await this.policy();
      const priced: PricedTrade[] = trades.map((trade, index) => ({ slot: 1_000n + BigInt(index), signature: sig(index + 1), priceUsdE6: trade.price }));
      const amount = trades.reduce((sum, trade) => sum + roundupTradeLamports(trade.x, trade.price, policy.roundupUnitCents), 0n);
      const priceMin = trades.reduce((min, trade) => (trade.price < min ? trade.price : min), trades[0]?.price ?? 0n);
      return this.inputs({ tradeCount: trades.length, amountLamports: amount, priceMinUsdE6: priceMin, pricesHash: pricesHash(priced), ...over });
    }

    settleV3(
      inputs: AttestationV3Inputs,
      options: {
        args?: Partial<AttestationV3Inputs>;
        signWith?: Keypair;
        pre?: TransactionInstruction[];
        oracle?: PublicKey | null;
      } = {},
    ): Promise<string> {
      const args = { ...inputs, ...options.args };
      const words = pricesHashWords(args.pricesHash);
      const pre = options.pre ?? [attestationV3Instruction((options.signWith ?? attester).secretKey, inputs)];
      const oracle = options.oracle !== undefined ? options.oracle : args.mode === MODE_ROUNDUP ? PYTH_150 : null;
      return program.methods
        .settleV3(
          args.mode,
          bn(args.sessionStartSlot),
          bn(args.sessionEndSlot),
          args.tradeCount,
          bn(args.amountLamports),
          bn(args.priceMinUsdE6),
          bn(words[0]),
          bn(words[1]),
          bn(words[2]),
          bn(words[3]),
          bn(args.validUntilSlot),
        )
        .accountsPartial({ wallet: this.wallet.publicKey, vault: this.vault, tradingLink: this.link, perTradePolicy: this.perTrade, pythSolUsd: oracle })
        .preInstructions(pre)
        .signers([this.wallet])
        .rpc();
    }

    /** settle_v2 with an attestation that is honest for the vault's own mode and active rate. */
    async settleV2(baseLamports: bigint) {
      const link = await this.linkState();
      const vault = await program.account.vault.fetch(this.vault);
      const end = await slotAbove(BigInt(link.frontierSlot.toString()) + 1n);
      const inputs: AttestationInputs = {
        programId: program.programId,
        wallet: this.wallet.publicKey,
        vault: this.vault,
        linkEpoch: BigInt(link.epoch.toString()),
        settlementNonce: BigInt(link.settlementNonce.toString()),
        sessionStartSlot: BigInt(link.frontierSlot.toString()),
        sessionEndSlot: end,
        baseLamports,
        mode: vault.skimMode,
        bps: vault.skimMode === MODE_VOLUME ? vault.volumeBps : vault.skimBps,
        policyNonce: BigInt(vault.policyNonce.toString()),
        validUntilSlot: end + 10_000n,
      };
      return program.methods
        .settleV2(inputs.mode, bn(inputs.sessionStartSlot), bn(inputs.sessionEndSlot), bn(baseLamports), bn(inputs.validUntilSlot))
        .accountsPartial({ wallet: this.wallet.publicKey, vault: this.vault, tradingLink: this.link })
        .preInstructions([attestationInstruction(attester.secretKey, inputs)])
        .signers([this.wallet])
        .rpc();
    }

    async balance() {
      return BigInt(await connection.getBalance(this.vault));
    }
  }

  /** The owner's example: one $1.60 trade at $150. */
  const ONE_DOLLAR_SIXTY = [{ x: 10_666_667n, price: 150_000_000n }];

  const roundUp = new Saver();
  const fixed = new Saver();

  before(async () => {
    await ensureConfig(program, provider.wallet.publicKey);
    await roundUp.open(ROUNDUP);
    await fixed.open(FIXED);
  });

  // ── set_policy_v3 ─────────────────────────────────────────────────────────

  describe("set_policy_v3", () => {
    it("opens a round-up vault in ONE transaction with create_vault_v2, and writes the PerTradePolicy", async () => {
      const vault = await program.account.vault.fetch(roundUp.vault);
      assert.strictEqual(vault.skimMode, MODE_ROUNDUP);
      assert.strictEqual(vault.policyNonce.toString(), "1", "create left 0, set_policy_v3 moved it");
      assert.strictEqual(vault.skimBps, 2_000, "both v2 rates stay as create_vault_v2 wrote them");
      assert.strictEqual(vault.volumeBps, 20);
      assert.strictEqual(vault.maxContribution.toString(), ROUNDUP.maxContribution.toString());
      const policy = await roundUp.policy();
      assert.isTrue(policy.vault.equals(roundUp.vault));
      assert.strictEqual(policy.version, 1);
      assert.strictEqual(policy.roundupUnitCents, 100);
      assert.strictEqual(policy.fixedLamports, 1_000_000);
      assert.strictEqual(policy.minTradeCents, 100);
      assert.strictEqual(policy.minTradeLamports, 10_000_000);
      assert.strictEqual(policy.dailyCapLamports.toString(), "300000000");
      assert.strictEqual(policy.dayIndex, 0);
      assert.strictEqual(policy.daySavedLamports.toString(), "0");
      const account = await connection.getAccountInfo(roundUp.perTrade);
      assert.strictEqual(account?.data.length, 104, "8 + 96 bytes");
      assert.isTrue(account?.owner.equals(program.programId));
    });

    it("refuses every out-of-range parameter, by name", async () => {
      const cases: [Partial<PerTradePolicy>, string][] = [
        [{ mode: MODE_PROFIT }, "InvalidPerTradeMode"],
        [{ mode: MODE_VOLUME }, "InvalidPerTradeMode"],
        [{ mode: 4 }, "InvalidPerTradeMode"],
        [{ unitCents: 150 }, "InvalidRoundUpUnit"],
        [{ unitCents: 10_100 }, "InvalidRoundUpUnit"],
        [{ fixedLamports: 99_999 }, "InvalidFixedAmount"],
        [{ mode: MODE_FIXED, fixedLamports: 100_000_001 }, "InvalidFixedAmount"],
        [{ minTradeCents: 10_001 }, "InvalidMinTrade"],
        [{ minTradeLamports: 1_000_000_001 }, "InvalidMinTrade"],
        [{ dailyCap: 0n }, "InvalidDailyCap"],
        [{ maxContribution: 0n }, "InvalidContributionCap"],
      ];
      for (const [over, error] of cases) await expectFailure(roundUp.setPolicyV3(over, ROUNDUP), error);
      assert.strictEqual((await program.account.vault.fetch(roundUp.vault)).policyNonce.toString(), "1", "nothing was written");
    });

    it("is the owner's alone: another signer cannot point it at this vault", async () => {
      const stranger = Keypair.generate();
      await airdrop(stranger.publicKey, 1);
      const p = ROUNDUP;
      await expectFailure(
        program.methods
          .setPolicyV3(p.mode, p.unitCents, p.fixedLamports, p.minTradeCents, p.minTradeLamports, bn(p.dailyCap), bn(p.maxContribution), bn(0n), false)
          .accountsPartial({ owner: stranger.publicKey, vault: roundUp.vault, perTradePolicy: roundUp.perTrade })
          .signers([stranger])
          .rpc(),
        "ConstraintSeeds",
      );
    });

    it("set_policy_v2 still cannot write modes 2 or 3", async () => {
      await expectFailure(roundUp.setPolicyV2(MODE_ROUNDUP), "InvalidMode");
      await expectFailure(roundUp.setPolicyV2(MODE_FIXED), "InvalidMode");
    });
  });

  // ── settle_v3, ROUND-UP ───────────────────────────────────────────────────

  describe("settle_v3 in ROUND-UP", () => {
    it("saves $0.40 of a $1.60 trade at $150: exactly 2,666,666 lamports, and says so in both events", async () => {
      const inputs = await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY);
      assert.strictEqual(inputs.amountLamports, 2_666_666n);
      const before = await roundUp.balance();
      const signature = await roundUp.settleV3(inputs);
      assert.strictEqual((await roundUp.balance()) - before, 2_666_666n);

      const vault = await program.account.vault.fetch(roundUp.vault);
      assert.strictEqual(vault.lifetimeSaved.toString(), "2666666");
      const link = await roundUp.linkState();
      assert.strictEqual(link.settlementNonce.toString(), "1");
      assert.strictEqual(link.frontierSlot.toString(), inputs.sessionEndSlot.toString());
      const policy = await roundUp.policy();
      assert.strictEqual(policy.daySavedLamports.toString(), "2666666");
      assert.approximately(policy.dayIndex, Math.floor(Date.now() / 86_400_000), 1, "the UTC day");

      const events = await eventsOf(signature);
      assert.deepEqual(events.map((event) => event.name.toLowerCase()), ["settled", "pertradesettled"], "Settled, then PerTradeSettled");
      const settled = events.find((event) => event.name.toLowerCase() === "settled")!.data;
      assert.strictEqual(settled.mode, MODE_ROUNDUP);
      assert.strictEqual(settled.baseLamports.toString(), "2666666");
      assert.strictEqual(settled.owed.toString(), "2666666");
      assert.strictEqual(settled.bps, 10_000);
      assert.strictEqual(settled.paid.toString(), "2666666");
      assert.strictEqual(settled.policyNonce.toString(), inputs.policyNonce.toString());
      const perTrade = events.find((event) => event.name.toLowerCase() === "pertradesettled")!.data;
      assert.strictEqual(perTrade.tradeCount, 1);
      assert.strictEqual(perTrade.priceMinUsdE6.toString(), "150000000");
      assert.isTrue(Buffer.from(perTrade.pricesHash).equals(Buffer.from(inputs.pricesHash)));
      assert.strictEqual(perTrade.modeParam.toString(), "100");
      assert.strictEqual(perTrade.minTrade.toString(), "100");
      assert.strictEqual(perTrade.dayIndex, policy.dayIndex);
      assert.strictEqual(perTrade.daySavedLamports.toString(), "2666666");
      assert.strictEqual(perTrade.settlementNonce.toString(), "0");
    });

    it("an old client, on the deployed IDL, reads the same Settled and skips the event it does not know", async () => {
      const inputs = await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY);
      const signature = await roundUp.settleV3(inputs);
      const old = await eventsOf(signature, DEPLOYED_IDL);
      assert.deepEqual(old.map((event) => event.name.toLowerCase()), ["settled"]);
      assert.strictEqual(old[0]!.data.paid.toString(), "2666666");
      assert.strictEqual(old[0]!.data.mode, MODE_ROUNDUP);
    });

    it("settles a window of several trades at different prices, signed at the lowest", async () => {
      const trades = [
        { x: 10_666_667n, price: 150_000_000n },
        { x: 50_000_000n, price: 146_000_000n },
        { x: 13_333_333n, price: 151_000_000n },
      ];
      const inputs = await roundUp.roundUpInputs(trades);
      assert.strictEqual(inputs.priceMinUsdE6, 146_000_000n);
      assert.isTrue(inputs.amountLamports <= roundupBoundLamports(3, 100, 146_000_000n));
      const before = await roundUp.balance();
      await roundUp.settleV3(inputs);
      assert.strictEqual((await roundUp.balance()) - before, inputs.amountLamports);
    });

    it("pays exactly the bound, and refuses one lamport more", async () => {
      const bound = roundupBoundLamports(1, 100, 150_000_000n);
      assert.strictEqual(bound, 6_666_667n);
      const above = await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY, { amountLamports: bound + 1n });
      await expectFailure(roundUp.settleV3(above), "PerTradeAmountAboveBound");
      const at = await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY, { amountLamports: bound });
      const before = await roundUp.balance();
      await roundUp.settleV3(at);
      assert.strictEqual((await roundUp.balance()) - before, bound);
    });

    it("refuses the scale bug: a price wrong by 10², which the bound alone lets through", async () => {
      // $1.50 instead of $150: the $1.60 trade now charges all of itself.
      const inputs = await roundUp.roundUpInputs([{ x: 10_666_667n, price: 1_500_000n }]);
      assert.strictEqual(inputs.amountLamports, 10_666_666n);
      assert.isTrue(inputs.amountLamports <= roundupBoundLamports(1, 100, 1_500_000n), "the bound passes it");
      await expectFailure(roundUp.settleV3(inputs), "PriceBelowOracleFloor");
    });

    it("the floor is exactly half of Pyth's price, read from mainnet's own account bytes", async () => {
      // $102.59321149: half is $51.296605745.
      const below = await roundUp.inputs({ tradeCount: 1, amountLamports: 1_000n, priceMinUsdE6: 51_296_605n });
      await expectFailure(roundUp.settleV3(below, { oracle: PYTH_MAINNET_FRESH }), "PriceBelowOracleFloor");
      const half = await roundUp.inputs({ tradeCount: 1, amountLamports: 1_000n, priceMinUsdE6: 51_296_606n });
      const before = await roundUp.balance();
      await roundUp.settleV3(half, { oracle: PYTH_MAINNET_FRESH });
      assert.strictEqual((await roundUp.balance()) - before, 1_000n);
    });

    it("refuses a Pyth price more than a day old", async () => {
      const inputs = await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY);
      await expectFailure(roundUp.settleV3(inputs, { oracle: PYTH_MAINNET_STALE }), "OracleStale");
    });

    it("refuses an oracle that is missing, partially verified, another feed, or not owned by the Pyth receiver", async () => {
      const inputs = await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY);
      await expectFailure(roundUp.settleV3(inputs, { oracle: null }), "OracleAccountInvalid");
      await expectFailure(roundUp.settleV3(inputs, { oracle: PYTH_PARTIAL }), "OracleAccountInvalid");
      await expectFailure(roundUp.settleV3(inputs, { oracle: PYTH_USDC }), "OracleAccountInvalid");
      await expectFailure(roundUp.settleV3(inputs, { oracle: PYTH_WRONG_OWNER }), "OracleAccountInvalid");
      await expectFailure(roundUp.settleV3(inputs, { oracle: roundUp.vault }), "OracleAccountInvalid");
    });

    it("refuses a round-up with no price", async () => {
      const inputs = await roundUp.inputs({ tradeCount: 1, amountLamports: 1_000n, priceMinUsdE6: 0n });
      await expectFailure(roundUp.settleV3(inputs), "PriceRequired");
    });

    it("refuses an amount with no counted trade", async () => {
      const inputs = await roundUp.inputs({ tradeCount: 0, amountLamports: 1n, priceMinUsdE6: 150_000_000n });
      await expectFailure(roundUp.settleV3(inputs), "PerTradeAmountMismatch");
    });

    it("settles an empty window: nothing moves and the frontier still advances", async () => {
      const before = await roundUp.linkState();
      const inputs = await roundUp.inputs({ tradeCount: 0, amountLamports: 0n, priceMinUsdE6: 150_000_000n });
      const balance = await roundUp.balance();
      await roundUp.settleV3(inputs);
      const after = await roundUp.linkState();
      assert.strictEqual(await roundUp.balance(), balance);
      assert.strictEqual(after.settlementNonce.toString(), (BigInt(before.settlementNonce.toString()) + 1n).toString());
      assert.strictEqual(after.frontierSlot.toString(), inputs.sessionEndSlot.toString());
    });

    it("rebuilds the unit, the minimum trade and the policy nonce from chain state: a signature over others fails", async () => {
      for (const over of [{ modeParam: 200n }, { minTrade: 0n }, { policyNonce: 0n }, { mode: MODE_FIXED }]) {
        const inputs = await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY, over);
        await expectFailure(roundUp.settleV3(inputs, { args: { mode: MODE_ROUNDUP } }), "AttestationMismatch");
      }
    });

    it("refuses numbers changed after signing: amount, count, price, prices hash", async () => {
      const inputs = await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY);
      for (const args of [
        { amountLamports: inputs.amountLamports + 1n },
        { tradeCount: 2 },
        { priceMinUsdE6: 150_000_001n },
        { pricesHash: pricesHash([{ slot: 1_000n, signature: sig(9), priceUsdE6: 150_000_000n }]) },
      ]) {
        await expectFailure(roundUp.settleV3(inputs, { args }), "AttestationMismatch");
      }
    });

    it("refuses another signer, no signature at all, and a V2 signature over the same numbers", async () => {
      const inputs = await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY);
      await expectFailure(roundUp.settleV3(inputs, { signWith: Keypair.generate() }), "WrongAttester");
      await expectFailure(roundUp.settleV3(inputs, { pre: [] }), "AttestationMissing");
      const v2 = attestationInstruction(attester.secretKey, {
        programId: program.programId,
        wallet: roundUp.wallet.publicKey,
        vault: roundUp.vault,
        linkEpoch: inputs.linkEpoch,
        settlementNonce: inputs.settlementNonce,
        sessionStartSlot: inputs.sessionStartSlot,
        sessionEndSlot: inputs.sessionEndSlot,
        baseLamports: inputs.amountLamports,
        mode: MODE_ROUNDUP,
        bps: 2_000,
        policyNonce: inputs.policyNonce,
        validUntilSlot: inputs.validUntilSlot,
      });
      await expectFailure(roundUp.settleV3(inputs, { pre: [v2] }), "AttestationMismatch");
    });

    it("refuses the other per-trade mode by name", async () => {
      const inputs = await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY);
      await expectFailure(roundUp.settleV3(inputs, { args: { mode: MODE_FIXED } }), "SkimModeMismatch");
    });

    it("keeps settle_v2's window rules and deadline", async () => {
      const link = await roundUp.linkState();
      const frontier = BigInt(link.frontierSlot.toString());
      const overlapping = await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY, { sessionStartSlot: frontier - 1n });
      await expectFailure(roundUp.settleV3(overlapping), "InvalidSessionWindow");
      const future = await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY, { sessionEndSlot: BigInt(await connection.getSlot()) + 5_000n });
      await expectFailure(roundUp.settleV3(future), "InvalidSessionWindow");
      const fresh = await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY);
      await expectFailure(roundUp.settleV3({ ...fresh, validUntilSlot: fresh.sessionEndSlot - 1n }), "AttestationExpired");
    });

    it("an attestation signed before a policy write dies after it, even a write that changed nothing", async () => {
      const inputs = await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY);
      await roundUp.setPolicyV3({}, ROUNDUP);
      await expectFailure(roundUp.settleV3(inputs), "AttestationMismatch");
    });

    it("stops while the vault is paused, and while the protocol is", async () => {
      await roundUp.setPolicyV3({ paused: true }, ROUNDUP);
      try {
        await expectFailure(roundUp.settleV3(await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY)), "VaultPaused");
      } finally {
        await roundUp.setPolicyV3({}, ROUNDUP);
      }
      const config = configPdaFor(program.programId);
      const pause = (paused: boolean) =>
        program.methods.setProtocolPaused(paused).accountsPartial({ authority: provider.wallet.publicKey, config }).rpc();
      await pause(true);
      try {
        await expectFailure(roundUp.settleV3(await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY)), "ProtocolPaused");
      } finally {
        await pause(false);
      }
    });

    it("clips at max_contribution: owed is the window, paid is the cap", async () => {
      // 30 trades of $1.60 owe 80,000,000 lamports; the cap is 60,000,000.
      const inputs = await roundUp.roundUpInputs(Array.from({ length: 30 }, () => ONE_DOLLAR_SIXTY[0]!));
      assert.strictEqual(inputs.amountLamports, 79_999_980n);
      const before = await roundUp.balance();
      const signature = await roundUp.settleV3(inputs);
      assert.strictEqual((await roundUp.balance()) - before, ROUNDUP.maxContribution);
      const settled = (await eventsOf(signature)).find((event) => event.name.toLowerCase() === "settled")!.data;
      assert.strictEqual(settled.owed.toString(), "79999980");
      assert.strictEqual(settled.paid.toString(), "60000000");
    });

    it("refuses a payment that would dip into the wallet's reserve, and leaves the window open", async () => {
      await roundUp.setPolicyV3({ walletReserve: 1_000n * SOL }, ROUNDUP);
      try {
        const before = await roundUp.linkState();
        await expectFailure(roundUp.settleV3(await roundUp.roundUpInputs(ONE_DOLLAR_SIXTY)), "WalletBelowReserve");
        const after = await roundUp.linkState();
        assert.strictEqual(after.frontierSlot.toString(), before.frontierSlot.toString());
        assert.strictEqual(after.settlementNonce.toString(), before.settlementNonce.toString());
      } finally {
        await roundUp.setPolicyV3({}, ROUNDUP);
      }
    });
  });

  // ── The daily cap ─────────────────────────────────────────────────────────

  describe("the daily cap", () => {
    const capped = new Saver();
    const CAP: PerTradePolicy = { ...FIXED, fixedLamports: 1_000_000, dailyCap: 5_000_000n };

    before(async () => {
      await capped.open(CAP);
    });

    /** What settle_v3 must pay given the counter it found: the model, so a UTC midnight mid-test cannot flake it. */
    const expectedPaid = (amount: bigint, cap: bigint, savedBefore: bigint, sameDay: boolean) => {
      const headroom = cap - (sameDay ? savedBefore : 0n);
      const room = headroom > 0n ? headroom : 0n;
      return [amount, CAP.maxContribution, room].reduce((a, b) => (a < b ? a : b));
    };

    const settleThree = async (cap: bigint) => {
      const before = await capped.policy();
      const balance = await capped.balance();
      const inputs = await capped.inputs({ tradeCount: 3, amountLamports: fixedAmountLamports(3, CAP.fixedLamports) });
      const signature = await capped.settleV3(inputs);
      const after = await capped.policy();
      const sameDay = after.dayIndex === before.dayIndex;
      const paid = expectedPaid(3_000_000n, cap, BigInt(before.daySavedLamports.toString()), sameDay);
      assert.strictEqual((await capped.balance()) - balance, paid, "paid");
      const saved = (sameDay ? BigInt(before.daySavedLamports.toString()) : 0n) + paid;
      assert.strictEqual(after.daySavedLamports.toString(), saved.toString(), "the day's counter");
      return { paid, signature, inputs };
    };

    it("clips at the day's headroom, then pays nothing and still moves the frontier: the excess is forgiven", async () => {
      const first = await settleThree(CAP.dailyCap);
      assert.strictEqual(first.paid, 3_000_000n);
      const second = await settleThree(CAP.dailyCap);
      assert.strictEqual(second.paid, 2_000_000n, "clipped to the 2,000,000 left");
      const settled = (await eventsOf(second.signature)).find((event) => event.name.toLowerCase() === "settled")!.data;
      assert.strictEqual(settled.owed.toString(), "3000000");
      assert.strictEqual(settled.paid.toString(), "2000000");
      const third = await settleThree(CAP.dailyCap);
      assert.strictEqual(third.paid, 0n, "the cap is reached: nothing moves");
      assert.strictEqual((await capped.linkState()).frontierSlot.toString(), third.inputs.sessionEndSlot.toString(), "and nothing is carried");
    });

    it("a policy write does not reset the day: raising the cap opens only the difference", async () => {
      const before = await capped.policy();
      await capped.setPolicyV3({ dailyCap: 8_000_000n }, CAP);
      const after = await capped.policy();
      assert.strictEqual(after.daySavedLamports.toString(), before.daySavedLamports.toString());
      assert.strictEqual(after.dayIndex, before.dayIndex);
      const next = await settleThree(8_000_000n);
      assert.strictEqual(next.paid, 3_000_000n, "5,000,000 saved, 3,000,000 left under the new 8,000,000");
    });
  });

  // ── settle_v3, FIXED ──────────────────────────────────────────────────────

  describe("settle_v3 in FIXED", () => {
    it("pays exactly trade_count × F, and both events say what was counted", async () => {
      const inputs = await fixed.inputs({ tradeCount: 7, amountLamports: fixedAmountLamports(7, FIXED.fixedLamports) });
      assert.strictEqual(inputs.amountLamports, 7_000_000n);
      assert.strictEqual(inputs.modeParam, 1_000_000n, "F is the signed mode_param");
      assert.strictEqual(inputs.minTrade, 10_000_000n, "min_trade_lamports is the signed minimum");
      const before = await fixed.balance();
      const signature = await fixed.settleV3(inputs);
      assert.strictEqual((await fixed.balance()) - before, 7_000_000n);
      const events = await eventsOf(signature);
      const settled = events.find((event) => event.name.toLowerCase() === "settled")!.data;
      assert.strictEqual(settled.mode, MODE_FIXED);
      assert.strictEqual(settled.paid.toString(), "7000000");
      const perTrade = events.find((event) => event.name.toLowerCase() === "pertradesettled")!.data;
      assert.strictEqual(perTrade.tradeCount, 7);
      assert.strictEqual(perTrade.priceMinUsdE6.toString(), "0");
      assert.isTrue(Buffer.from(perTrade.pricesHash).equals(ZERO_HASH));
      assert.strictEqual(perTrade.modeParam.toString(), "1000000");
      assert.strictEqual(perTrade.minTrade.toString(), "10000000");
    });

    it("refuses anything but count × F, one lamport either way", async () => {
      for (const amount of [6_999_999n, 7_000_001n, 6_000_000n]) {
        const inputs = await fixed.inputs({ tradeCount: 7, amountLamports: amount });
        await expectFailure(fixed.settleV3(inputs), "PerTradeAmountMismatch");
      }
      const none = await fixed.inputs({ tradeCount: 0, amountLamports: 1_000_000n });
      await expectFailure(fixed.settleV3(none), "PerTradeAmountMismatch");
    });

    it("refuses a price, a prices hash or an oracle account: fixed mode takes no price", async () => {
      const amount = fixedAmountLamports(2, FIXED.fixedLamports);
      await expectFailure(fixed.settleV3(await fixed.inputs({ tradeCount: 2, amountLamports: amount, priceMinUsdE6: 1n })), "PriceNotAllowed");
      await expectFailure(fixed.settleV3(await fixed.inputs({ tradeCount: 2, amountLamports: amount, pricesHash: pricesHash([]) })), "PriceNotAllowed");
      await expectFailure(fixed.settleV3(await fixed.inputs({ tradeCount: 2, amountLamports: amount }), { oracle: PYTH_150 }), "PriceNotAllowed");
    });

    it("settles an empty window to move the frontier", async () => {
      const inputs = await fixed.inputs({ tradeCount: 0, amountLamports: 0n });
      const before = await fixed.balance();
      await fixed.settleV3(inputs);
      assert.strictEqual(await fixed.balance(), before);
      assert.strictEqual((await fixed.linkState()).frontierSlot.toString(), inputs.sessionEndSlot.toString());
    });

    it("an F changed by a policy write voids what was signed at the old F", async () => {
      const inputs = await fixed.inputs({ tradeCount: 2, amountLamports: 2_000_000n });
      await fixed.setPolicyV3({ fixedLamports: 2_000_000 }, FIXED);
      try {
        await expectFailure(fixed.settleV3(inputs), "AttestationMismatch");
        const fresh = await fixed.inputs({ tradeCount: 2, amountLamports: 4_000_000n });
        const before = await fixed.balance();
        await fixed.settleV3(fresh);
        assert.strictEqual((await fixed.balance()) - before, 4_000_000n);
      } finally {
        await fixed.setPolicyV3({}, FIXED);
      }
    });
  });

  // ── The doors between v2 and v3 ───────────────────────────────────────────

  describe("settle_v2 and settle_v3 never cross", () => {
    it("settle_v2 refuses a round-up or fixed vault, even with an attestation that would verify (Trap 1)", async () => {
      await expectFailure(roundUp.settleV2(SOL), "ModeNeedsSettleV3");
      await expectFailure(fixed.settleV2(SOL), "ModeNeedsSettleV3");
    });

    it("settle_v3 refuses a vault that went back to VOLUME, whose PerTradePolicy stays behind; settle_v2 settles it", async () => {
      const back = await new Saver().open(ROUNDUP);
      await back.setPolicyV2(MODE_VOLUME);
      const inputs = await back.roundUpInputs(ONE_DOLLAR_SIXTY, { mode: MODE_VOLUME });
      await expectFailure(back.settleV3(inputs, { oracle: PYTH_150 }), "ModeNeedsSettleV2");
      const before = await back.balance();
      await back.settleV2(10n * SOL);
      assert.strictEqual((await back.balance()) - before, (10n * SOL * 20n) / 10_000n, "VOLUME's 20 bps of 10 SOL");
    });

    it("settle_v3 cannot run on a vault that never had a per-trade policy", async () => {
      const profit = await new Saver().open(null);
      const link = await profit.linkState();
      const end = await slotAbove(BigInt(link.frontierSlot.toString()) + 1n);
      const inputs: AttestationV3Inputs = {
        programId: program.programId,
        wallet: profit.wallet.publicKey,
        vault: profit.vault,
        linkEpoch: BigInt(link.epoch.toString()),
        settlementNonce: 0n,
        sessionStartSlot: 0n,
        sessionEndSlot: end,
        amountLamports: 0n,
        mode: MODE_PROFIT,
        policyNonce: 0n,
        validUntilSlot: end + 10_000n,
        tradeCount: 0,
        priceMinUsdE6: 0n,
        modeParam: 0n,
        minTrade: 0n,
        pricesHash: ZERO_HASH,
      };
      await expectFailure(profit.settleV3(inputs, { oracle: null }), "AccountNotInitialized");
      // and its v2 path is untouched by the guard
      const before = await profit.balance();
      await profit.settleV2(SOL / 10n);
      assert.strictEqual((await profit.balance()) - before, SOL / 50n, "PROFIT's 20 % of 0.1 SOL");
    });
  });
});
