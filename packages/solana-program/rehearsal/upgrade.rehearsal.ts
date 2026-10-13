// L3: the upgrade rehearsal (scaling ADR §5.7–§5.8), on a throwaway validator.
//
//   SIP_REHEARSAL_OLD_SO=<the deployed sip_vault.so> pnpm rehearse:upgrade
//
// THE OLD BINARY IS MAINNET'S, OR NOTHING STARTS: SIP_REHEARSAL_OLD_SO must
// hash to 60e94348… (a `solana program dump` of 6kA9H9zQ… taken read-only from
// mainnet, or an anchor build of the commit that produced it: the build is
// reproducible). It is preloaded at the REAL program id, upgradeable by a key
// made here. The new binary is target/deploy/sip_vault.so (SIP_REHEARSAL_NEW_SO
// overrides), and the rehearsal prints its sha256: the hash U3 freezes.
//
// WHAT IT PROVES, IN ORDER, AND STOPS AT THE FIRST FAILURE (--bail):
//  1. the old binary at the real id, ProgramData as on mainnet (563,701 bytes);
//  2. under it, with the DEPLOYED IDL (what every client runs today): config,
//     four vaults (two PROFIT, two VOLUME) linked and settled with settle_v2;
//     set_policy_v3 and settle_v3 are not instructions there;
//  3. the upgrade, by the very `solana program deploy` command
//     scripts/sip-deploy.sh upgrade runs: ProgramData is EXTENDED by the CLI
//     itself and holds the new bytes, same authority, buffer closed;
//  4. every account the old binary wrote decodes the same under both IDLs;
//  5. the old vaults settle with settle_v2 exactly as before, through the old
//     client; one old vault moves to ROUND-UP and one to FIXED and settle
//     through settle_v3; a new saver opens round-up in one transaction;
//     settle_v2 refuses the per-trade vaults; an old client reads their Settled;
//  6. ROLLBACK to 60e94348 by the same command: per-trade vaults rest,
//     withdraw works, set_policy_v2 brings one home, PROFIT and VOLUME settle;
//     and Trap 1 on the old binary, shown: settle_v2 on a vault left in mode 2
//     pays base × skim_bps, which is why no keeper may send it (T-N1);
//  7. FORWARD again: no second extension, both per-trade paths back.
//
// SIP_REHEARSAL_MAINNET_FEATURES=1 copies mainnet's active feature set into the
// validator's genesis (a read of public feature accounts), so the loader runs
// the upgrade and the extension the way mainnet would.
// SIP_REHEARSAL_REPORT=<path> also writes the measured numbers as JSON.

import * as anchor from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pollingConfirm } from "../tests/config-fixture";
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
import { fixedAmountLamports, pricesHash, pricesHashWords, roundupTradeLamports } from "../scripts/per-trade";
import { linkWalletWithConsent } from "../scripts/link-consent";
import {
  DEPLOYED_PROGRAM_SHA256,
  PACKAGE_DIR,
  SIP_VAULT_PROGRAM_ID,
  holdsBinary,
  pythFixture,
  pythFixtureAccounts,
  readProgramData,
  sha256File,
  startValidator,
  type Validator,
} from "./validator";

const SOL = BigInt(LAMPORTS_PER_SOL);
const bn = (value: bigint | number) => new anchor.BN(value.toString());
const MAINNET_PROGRAMDATA_LEN = 563_701;

const OLD_SO = process.env.SIP_REHEARSAL_OLD_SO ?? "";
const NEW_SO = process.env.SIP_REHEARSAL_NEW_SO || join(PACKAGE_DIR, "target", "deploy", "sip_vault.so");
const DEPLOYED_IDL = JSON.parse(readFileSync(join(PACKAGE_DIR, "tests", "fixtures", "sip_vault.deployed-60e94348.json"), "utf8")) as anchor.Idl;
const NEW_IDL_PATH = join(PACKAGE_DIR, "target", "idl", "sip_vault.json");

type Client = anchor.Program<anchor.Idl>;

describe("L3 upgrade rehearsal: 60e94348 → this build → back → forward", function () {
  this.timeout(30 * 60_000);

  const authority = Keypair.generate();
  const attester = Keypair.generate();
  const report: Record<string, unknown> = {};
  let validator: Validator;
  let provider: anchor.AnchorProvider;
  let oldClient: Client;
  let newClient: Client;
  let authorityKey: string;
  let oldBytes: Buffer;
  let newBytes: Buffer;

  const connection = () => provider.connection;
  const pyth150 = pythFixture("sol-usd-150");

  const expectFailure = async (p: Promise<unknown>, needle: string) => {
    try {
      await p;
    } catch (err) {
      assert.include(String(err), needle, `expected failure mentioning "${needle}"`);
      return;
    }
    assert.fail(`expected a failure mentioning "${needle}", but it succeeded`);
  };

  const slotAbove = async (above: bigint): Promise<bigint> => {
    for (;;) {
      const slot = BigInt(await connection().getSlot());
      if (slot > above) return slot;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  /**
   * One upgrade (or rollback) with scripts/sip-deploy.sh upgrade's own
   * `program deploy` flags. Returns once the new bytes are INVOCABLE: in the
   * slot of the upgrade itself the loader answers "Program is not deployed",
   * which a keeper sending then sees as one failed simulation.
   */
  const deploy = async (so: string, label: string) => {
    const copy = join(validator.dir, `${label}.so`);
    copyFileSync(so, copy);
    const bufferKeypair = Keypair.generate();
    const buffer = validator.keyFile(`${label}-buffer`, bufferKeypair);
    const started = Date.now();
    const result = validator.solanaCli(authorityKey, [
      "program",
      "deploy",
      copy,
      "--program-id",
      SIP_VAULT_PROGRAM_ID.toBase58(),
      "--buffer",
      buffer,
      "--upgrade-authority",
      authorityKey,
      "--fee-payer",
      authorityKey,
      "--use-rpc",
      "--with-compute-unit-price",
      "20000",
      "--max-sign-attempts",
      "100",
    ]);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.strictEqual(result.status, 0, `solana program deploy (${label}) failed:\n${output.slice(-3_000)}`);
    await slotAbove(BigInt(await connection().getSlot()) + 1n);
    return { seconds: (Date.now() - started) / 1_000, output: output.trim().split("\n").slice(-6), buffer: bufferKeypair.publicKey };
  };

  /** A vault owner, its vault and one linked trading wallet. */
  class Saver {
    readonly owner = Keypair.generate();
    readonly wallet = Keypair.generate();
    readonly vault: PublicKey;
    readonly link: PublicKey;
    readonly perTrade: PublicKey;
    constructor(readonly label: string) {
      [this.vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), this.owner.publicKey.toBuffer()], SIP_VAULT_PROGRAM_ID);
      [this.link] = PublicKey.findProgramAddressSync([Buffer.from("link"), this.wallet.publicKey.toBuffer()], SIP_VAULT_PROGRAM_ID);
      [this.perTrade] = PublicKey.findProgramAddressSync([Buffer.from("per_trade"), this.vault.toBuffer()], SIP_VAULT_PROGRAM_ID);
    }

    async fund() {
      for (const [to, sol] of [
        [this.owner.publicKey, 2],
        [this.wallet.publicKey, 20],
      ] as const) {
        const tx = new Transaction().add(anchor.web3.SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: to, lamports: sol * LAMPORTS_PER_SOL }));
        await provider.sendAndConfirm(tx, []);
      }
    }

    async openWithOldClient(mode: number) {
      await this.fund();
      await oldClient.methods
        .createVaultV2(mode, 2_000, 20, bn(60_000_000n), bn(0n))
        .accounts({ owner: this.owner.publicKey })
        .signers([this.owner])
        .rpc();
      await linkWalletWithConsent(oldClient, { owner: this.owner.publicKey, wallet: this.wallet }).signers([this.owner, this.wallet]).rpc();
    }

    async setPolicyV3(client: Client, mode: number) {
      return client.methods
        .setPolicyV3(mode, 100, 1_000_000, 100, 10_000_000, bn(300_000_000n), bn(60_000_000n), bn(0n), false)
        .accounts({ owner: this.owner.publicKey })
        .signers([this.owner])
        .rpc();
    }

    async balance() {
      return BigInt(await connection().getBalance(this.vault));
    }

    /** settle_v2, honest for the vault's own mode and active rate (Trap 1 included), through `client`. */
    async settleV2(client: Client, baseLamports: bigint) {
      const link = (await client.account.tradingLink.fetch(this.link)) as any;
      const vault = (await client.account.vault.fetch(this.vault)) as any;
      const end = await slotAbove(BigInt(link.frontierSlot.toString()) + 1n);
      const inputs: AttestationInputs = {
        programId: SIP_VAULT_PROGRAM_ID,
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
      const before = await this.balance();
      await client.methods
        .settleV2(inputs.mode, bn(inputs.sessionStartSlot), bn(end), bn(baseLamports), bn(inputs.validUntilSlot))
        .accountsPartial({ wallet: this.wallet.publicKey, vault: this.vault, tradingLink: this.link })
        .preInstructions([attestationInstruction(attester.secretKey, inputs)])
        .signers([this.wallet])
        .rpc();
      return (await this.balance()) - before;
    }

    /** settle_v3 through the new client: a round-up window of `trades`, or `count` fixed trades. */
    async settleV3(spec: { trades?: { x: bigint; price: bigint }[]; count?: number }) {
      const link = (await newClient.account.tradingLink.fetch(this.link)) as any;
      const vault = (await newClient.account.vault.fetch(this.vault)) as any;
      const policy = (await newClient.account.perTradePolicy.fetch(this.perTrade)) as any;
      const end = await slotAbove(BigInt(link.frontierSlot.toString()) + 1n);
      const roundUp = vault.skimMode === MODE_ROUNDUP;
      const trades = spec.trades ?? [];
      const count = roundUp ? trades.length : (spec.count ?? 0);
      const inputs: AttestationV3Inputs = {
        programId: SIP_VAULT_PROGRAM_ID,
        wallet: this.wallet.publicKey,
        vault: this.vault,
        linkEpoch: BigInt(link.epoch.toString()),
        settlementNonce: BigInt(link.settlementNonce.toString()),
        sessionStartSlot: BigInt(link.frontierSlot.toString()),
        sessionEndSlot: end,
        amountLamports: roundUp
          ? trades.reduce((sum, trade) => sum + roundupTradeLamports(trade.x, trade.price, policy.roundupUnitCents), 0n)
          : fixedAmountLamports(count, policy.fixedLamports),
        mode: vault.skimMode,
        policyNonce: BigInt(vault.policyNonce.toString()),
        validUntilSlot: end + 10_000n,
        tradeCount: count,
        priceMinUsdE6: roundUp ? trades.reduce((min, trade) => (trade.price < min ? trade.price : min), trades[0]!.price) : 0n,
        modeParam: BigInt(roundUp ? policy.roundupUnitCents : policy.fixedLamports),
        minTrade: BigInt(roundUp ? policy.minTradeCents : policy.minTradeLamports),
        pricesHash: roundUp
          ? pricesHash(trades.map((trade, index) => ({ slot: BigInt(index), signature: Buffer.alloc(64, index + 1), priceUsdE6: trade.price })))
          : Buffer.alloc(32),
      };
      const words = pricesHashWords(inputs.pricesHash);
      const before = await this.balance();
      const signature = await newClient.methods
        .settleV3(
          inputs.mode,
          bn(inputs.sessionStartSlot),
          bn(end),
          count,
          bn(inputs.amountLamports),
          bn(inputs.priceMinUsdE6),
          bn(words[0]),
          bn(words[1]),
          bn(words[2]),
          bn(words[3]),
          bn(inputs.validUntilSlot),
        )
        .accountsPartial({ wallet: this.wallet.publicKey, vault: this.vault, tradingLink: this.link, perTradePolicy: this.perTrade, pythSolUsd: roundUp ? pyth150 : null })
        .preInstructions([attestationV3Instruction(attester.secretKey, inputs)])
        .signers([this.wallet])
        .rpc();
      return { paid: (await this.balance()) - before, signature, amount: inputs.amountLamports };
    }
  }

  const profit = new Saver("old PROFIT");
  const volume = new Saver("old VOLUME");
  const toRoundUp = new Saver("old PROFIT → ROUND-UP");
  const toFixed = new Saver("old VOLUME → FIXED");
  const fresh = new Saver("new ROUND-UP saver");
  const paidUnderOld: Record<string, bigint> = {};
  let roundUpSignature = "";

  before(async () => {
    if (OLD_SO === "" || !existsSync(OLD_SO)) throw new Error("SIP_REHEARSAL_OLD_SO must name the deployed sip_vault.so");
    assert.strictEqual(sha256File(OLD_SO), DEPLOYED_PROGRAM_SHA256, "SIP_REHEARSAL_OLD_SO is not the binary on mainnet");
    if (!existsSync(NEW_SO) || !existsSync(NEW_IDL_PATH)) throw new Error("the new build is missing: run anchor build first");
    oldBytes = readFileSync(OLD_SO);
    newBytes = readFileSync(NEW_SO);
    report.oldBinary = { sha256: DEPLOYED_PROGRAM_SHA256, bytes: oldBytes.length };
    report.newBinary = { sha256: sha256File(NEW_SO), bytes: newBytes.length };
    report.mainnetFeatures = process.env.SIP_REHEARSAL_MAINNET_FEATURES === "1";

    validator = await startValidator({
      mint: authority.publicKey,
      programs: [{ id: SIP_VAULT_PROGRAM_ID, so: OLD_SO, authority: authority.publicKey }],
      accounts: pythFixtureAccounts(),
      mainnetFeatures: report.mainnetFeatures === true,
    });
    authorityKey = validator.keyFile("upgrade-authority", authority);
    provider = new anchor.AnchorProvider(pollingConfirm(validator.connection), new anchor.Wallet(authority), { commitment: "confirmed" });
    oldClient = new anchor.Program(DEPLOYED_IDL, provider);
    newClient = new anchor.Program(JSON.parse(readFileSync(NEW_IDL_PATH, "utf8")) as anchor.Idl, provider);
  });

  after(async () => {
    if (validator !== undefined) report.validatorStopped = await validator.stop();
    console.log(`\nL3 rehearsal report:\n${JSON.stringify(report, null, 2)}`);
    if (process.env.SIP_REHEARSAL_REPORT) writeFileSync(process.env.SIP_REHEARSAL_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  });

  it("1. serves mainnet's binary at the real id, with mainnet's ProgramData size, upgradeable by this run's key", async () => {
    const programData = await readProgramData(connection(), SIP_VAULT_PROGRAM_ID);
    assert.strictEqual(programData.length, MAINNET_PROGRAMDATA_LEN);
    assert.isTrue(holdsBinary(programData.elf, oldBytes));
    assert.isTrue(programData.authority?.equals(authority.publicKey));
    report.programDataBefore = { bytes: programData.length, lamports: programData.lamports };
  });

  it("2a. under the old binary and the deployed IDL: config, four vaults linked, each settled with settle_v2", async () => {
    const [programData] = PublicKey.findProgramAddressSync([SIP_VAULT_PROGRAM_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));
    await oldClient.methods.initConfig(attester.publicKey).accountsPartial({ authority: authority.publicKey, programData }).rpc();
    await profit.openWithOldClient(MODE_PROFIT);
    await volume.openWithOldClient(MODE_VOLUME);
    await toRoundUp.openWithOldClient(MODE_PROFIT);
    await toFixed.openWithOldClient(MODE_VOLUME);
    paidUnderOld.profit = await profit.settleV2(oldClient, SOL / 10n);
    paidUnderOld.volume = await volume.settleV2(oldClient, 10n * SOL);
    assert.strictEqual(paidUnderOld.profit, SOL / 50n, "20 % of 0.1 SOL");
    assert.strictEqual(paidUnderOld.volume, SOL / 50n, "0.2 % of 10 SOL");
    assert.strictEqual(await toRoundUp.settleV2(oldClient, SOL / 10n), SOL / 50n);
    assert.strictEqual(await toFixed.settleV2(oldClient, 10n * SOL), SOL / 50n);
  });

  it("2b. the old binary has no per-trade door: set_policy_v3 and settle_v3 are not instructions", async () => {
    await expectFailure(toRoundUp.setPolicyV3(newClient, MODE_ROUNDUP), "InstructionFallbackNotFound");
    await expectFailure(
      newClient.methods
        .settleV3(MODE_ROUNDUP, bn(0), bn(1), 0, bn(0), bn(1), bn(0), bn(0), bn(0), bn(0), bn(10))
        .accountsPartial({ wallet: toRoundUp.wallet.publicKey, vault: toRoundUp.vault, tradingLink: toRoundUp.link, perTradePolicy: toRoundUp.perTrade, pythSolUsd: pyth150 })
        .signers([toRoundUp.wallet])
        .rpc(),
      "InstructionFallbackNotFound",
    );
  });

  it("3. the upgrade, by sip-deploy.sh's own command: the CLI extends ProgramData and lands the new bytes", async () => {
    const before = await readProgramData(connection(), SIP_VAULT_PROGRAM_ID);
    const payerBefore = BigInt(await connection().getBalance(authority.publicKey));
    const needed = newBytes.length + 45;
    const rentBefore = BigInt(await connection().getMinimumBalanceForRentExemption(before.length));
    const rentNeeded = BigInt(await connection().getMinimumBalanceForRentExemption(needed));
    const bufferRent = BigInt(await connection().getMinimumBalanceForRentExemption(newBytes.length + 37));
    const upgrade = await deploy(NEW_SO, "upgrade");
    const after = await readProgramData(connection(), SIP_VAULT_PROGRAM_ID);
    const payerAfter = BigInt(await connection().getBalance(authority.publicKey));
    assert.strictEqual(after.length, needed, "ProgramData now holds exactly the new binary");
    assert.isTrue(holdsBinary(after.elf, newBytes), "and its bytes are the new build");
    assert.isTrue(after.authority?.equals(authority.publicKey), "the upgrade authority did not move");
    assert.isNull(await connection().getAccountInfo(upgrade.buffer), "the write buffer was closed into the upgrade");
    assert.isTrue(BigInt(after.lamports) >= rentNeeded, "ProgramData is rent-exempt at its new size");
    report.upgrade = {
      seconds: upgrade.seconds,
      cliTail: upgrade.output,
      programDataBytes: { before: before.length, after: after.length, grownBy: after.length - before.length },
      programDataLamports: { before: before.lamports, after: after.lamports, grownBy: after.lamports - before.lamports },
      localRent: { before: rentBefore.toString(), needed: rentNeeded.toString(), extension: (rentNeeded - rentBefore).toString(), writeBufferPeak: bufferRent.toString() },
      payerSpent: (payerBefore - payerAfter).toString(),
    };
  });

  it("4. every account the old binary wrote decodes the same under the deployed IDL and the new one", async () => {
    const canon = (value: unknown) => JSON.stringify(value, (_key, v) => (v instanceof anchor.BN ? `bn:${v.toString()}` : v instanceof PublicKey ? v.toBase58() : v));
    const checks: [string, PublicKey][] = [["protocolConfig", PublicKey.findProgramAddressSync([Buffer.from("config")], SIP_VAULT_PROGRAM_ID)[0]]];
    for (const saver of [profit, volume, toRoundUp, toFixed]) checks.push(["vault", saver.vault], ["tradingLink", saver.link]);
    for (const [kind, address] of checks) {
      const decodedOld = await (oldClient.account as any)[kind].fetch(address);
      const decodedNew = await (newClient.account as any)[kind].fetch(address);
      assert.strictEqual(canon(decodedNew), canon(decodedOld), `${kind} ${address.toBase58()}`);
    }
    report.accountsDecoded = checks.length;
  });

  it("5a. the old PROFIT and VOLUME vaults settle with settle_v2, through the OLD client, exactly as before", async () => {
    assert.strictEqual(await profit.settleV2(oldClient, SOL / 10n), paidUnderOld.profit);
    assert.strictEqual(await volume.settleV2(oldClient, 10n * SOL), paidUnderOld.volume);
  });

  it("5b. an old vault moves to ROUND-UP and saves $0.40 of a $1.60 trade: 2,666,666 lamports", async () => {
    await toRoundUp.setPolicyV3(newClient, MODE_ROUNDUP);
    const { paid, signature } = await toRoundUp.settleV3({ trades: [{ x: 10_666_667n, price: 150_000_000n }] });
    assert.strictEqual(paid, 2_666_666n);
    roundUpSignature = signature;
  });

  it("5c. an old vault moves to FIXED and saves exactly count × F", async () => {
    await toFixed.setPolicyV3(newClient, MODE_FIXED);
    const { paid } = await toFixed.settleV3({ count: 7 });
    assert.strictEqual(paid, 7_000_000n);
  });

  it("5d. a new saver opens ROUND-UP in one transaction, create_vault_v2 + set_policy_v3, and settles", async () => {
    await fresh.fund();
    const create = await newClient.methods.createVaultV2(MODE_PROFIT, 2_000, 20, bn(60_000_000n), bn(0n)).accounts({ owner: fresh.owner.publicKey }).instruction();
    const policy = await newClient.methods
      .setPolicyV3(MODE_ROUNDUP, 100, 1_000_000, 100, 10_000_000, bn(300_000_000n), bn(60_000_000n), bn(0n), false)
      .accounts({ owner: fresh.owner.publicKey })
      .instruction();
    await provider.sendAndConfirm(new Transaction().add(create, policy), [fresh.owner]);
    await linkWalletWithConsent(newClient, { owner: fresh.owner.publicKey, wallet: fresh.wallet }).signers([fresh.owner, fresh.wallet]).rpc();
    const { paid } = await fresh.settleV3({ trades: [{ x: 50_000_000n, price: 146_000_000n }] });
    assert.strictEqual(paid, roundupTradeLamports(50_000_000n, 146_000_000n, 100));
  });

  it("5e. settle_v2 refuses the per-trade vaults; the old client reads their Settled and skips the new event", async () => {
    await expectFailure(toRoundUp.settleV2(oldClient, SOL), "ModeNeedsSettleV3");
    await expectFailure(toFixed.settleV2(oldClient, SOL), "ModeNeedsSettleV3");
    const parser = new anchor.EventParser(SIP_VAULT_PROGRAM_ID, new anchor.BorshCoder(DEPLOYED_IDL));
    const tx = await connection().getTransaction(roundUpSignature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const events = [...parser.parseLogs(tx?.meta?.logMessages ?? [])];
    assert.deepEqual(events.map((event) => event.name.toLowerCase()), ["settled"]);
    assert.strictEqual((events[0]!.data as any).paid.toString(), "2666666");
  });

  it("6. ROLLBACK to 60e94348 by the same command: per-trade vaults rest, exits and PROFIT/VOLUME keep working", async () => {
    const rollback = await deploy(OLD_SO, "rollback");
    const programData = await readProgramData(connection(), SIP_VAULT_PROGRAM_ID);
    assert.isTrue(holdsBinary(programData.elf, oldBytes), "the old bytes, with zeros after them");
    assert.strictEqual(programData.length, newBytes.length + 45, "ProgramData never shrinks");
    report.rollback = { seconds: rollback.seconds, programDataBytes: programData.length };

    await expectFailure(toRoundUp.settleV3({ trades: [{ x: 10_666_667n, price: 150_000_000n }] }), "InstructionFallbackNotFound");
    // withdraw never depended on the mode
    const owner = toRoundUp.owner;
    const before = BigInt(await connection().getBalance(owner.publicKey));
    await oldClient.methods.withdraw(bn(1_000_000n)).accounts({ owner: owner.publicKey }).signers([owner]).rpc();
    assert.isAbove(Number(BigInt(await connection().getBalance(owner.publicKey)) - before), 0);
    // set_policy_v2 brings the FIXED vault home to VOLUME, and it settles
    await oldClient.methods.setPolicyV2(MODE_VOLUME, 2_000, 20, false, bn(60_000_000n), bn(0n)).accounts({ owner: toFixed.owner.publicKey }).signers([toFixed.owner]).rpc();
    assert.strictEqual(await toFixed.settleV2(oldClient, 10n * SOL), SOL / 50n);
    assert.strictEqual(await profit.settleV2(oldClient, SOL / 10n), paidUnderOld.profit);
    assert.strictEqual(await volume.settleV2(oldClient, 10n * SOL), paidUnderOld.volume);

    // TRAP 1, ON THE OLD BINARY: a v2 attestation for the vault left in mode 2
    // verifies there and pays base × skim_bps. Nothing on chain stops it before
    // the upgrade or after a rollback; only a keeper that never sends v2 to
    // modes 2 and 3 does (ADR §5.6, T-N1).
    assert.strictEqual(await toRoundUp.settleV2(oldClient, SOL / 10n), (SOL / 10n) * 2_000n / 10_000n);
  });

  it("7. FORWARD again: the new bytes, no second extension, and both per-trade paths back", async () => {
    const before = await readProgramData(connection(), SIP_VAULT_PROGRAM_ID);
    const forward = await deploy(NEW_SO, "forward");
    const after = await readProgramData(connection(), SIP_VAULT_PROGRAM_ID);
    assert.isTrue(holdsBinary(after.elf, newBytes));
    assert.strictEqual(after.length, before.length, "already large enough");
    assert.strictEqual(after.lamports, before.lamports, "no rent added");
    report.forward = { seconds: forward.seconds };

    const { paid } = await toRoundUp.settleV3({ trades: [{ x: 10_666_667n, price: 150_000_000n }] });
    assert.strictEqual(paid, 2_666_666n, "the vault left in ROUND-UP settles through v3 again");
    assert.strictEqual(await toFixed.settleV2(oldClient, 10n * SOL), SOL / 50n, "the one brought home settles through v2");
    await expectFailure(toFixed.settleV3({ count: 1 }), "ModeNeedsSettleV2");
    await expectFailure(toRoundUp.settleV2(oldClient, SOL / 10n), "ModeNeedsSettleV3");
  });
});
