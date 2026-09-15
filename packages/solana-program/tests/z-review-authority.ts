// Review gate: who may create the protocol config, and who may change it.
//
// FINDING 10. init_config.rs:33 binds `program` to the ProgramData passed
// beside it. Without that line, line 38 checks the signer against the upgrade
// authority of ANY upgradeable program: anyone who can deploy a program of
// their own passes its ProgramData and creates the config as its authority.
// Here the provider is the upgrade authority of both workspace programs, so
// it passes toy_venue's ProgramData. Line 38 is satisfied, and the only thing
// left to refuse the call is line 33.
//
// WHY PART OF THIS RUNS IN A ROOT HOOK, BEFORE EVERY SPEC. Anchor creates an
// account marked `init` before it checks any other account's constraints
// (anchor-syn 0.32.1, codegen/accounts/try_accounts.rs, generate_constraints:
// init fields first, then everything else). Once the config PDA exists, the
// init's system-program allocate fails with "already in use" and line 33 is
// never evaluated. That means line 33 can only be tested while the config does
// not exist yet. This file sorts last, and every earlier spec creates the
// config. So the probe runs in a mocha root-level `before`, which runs before
// any describe block in any file. It never throws, because a failed root hook
// would skip the whole run. It records what happened, and the test below
// asserts on that record. The second test shows the "already in use" path
// directly, once the config exists.
//
// THE PROBE CANNOT CHANGE SHARED STATE, even against a mutated program. Every
// init_config it sends carries a tripwire after it: a 1-lamport transfer from
// a key with no lamports, which always fails and reverts the transaction. If
// line 33 were gone, the probe would get the tripwire's error instead of
// NotUpgradeAuthority. The test fails, and no config appears for the other
// specs to inherit.
//
// FINDING 16. has_one = authority on set_keeper, set_attester and
// set_protocol_paused refuses a stranger, and a completed two-step transfer
// really moves that power: the ORIGINAL authority is refused afterwards. The
// authority is handed back at the end, and after() puts back anything a failed
// test left moved.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import { SipVault } from "../target/types/sip_vault";
import { configPdaFor, ensureConfig, pollingConfirm, programDataFor, TEST_ATTESTER } from "./config-fixture";

// Error numbers clients match on. errors.rs appends only, so these never move.
const NOT_UPGRADE_AUTHORITY = { code: "NotUpgradeAuthority", number: 6024 };
const CONSTRAINT_HAS_ONE = { code: "ConstraintHasOne", number: 2001 };

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

// UpgradeableLoaderState, bincode: a u32 tag, then the variant.
//   Program     = 2: programdata_address Pubkey             (bytes 4..36)
//   ProgramData = 3: slot u64 (4..12), Option<Pubkey> authority (tag 12, key 13..45)
const LOADER_PROGRAM = 2;
const LOADER_PROGRAM_DATA = 3;

const readProgramDataAddress = (data: Buffer): PublicKey => {
  assert.strictEqual(data.readUInt32LE(0), LOADER_PROGRAM, "not an upgradeable Program account");
  return new PublicKey(data.subarray(4, 36));
};

const readUpgradeAuthority = (data: Buffer): PublicKey | null => {
  assert.strictEqual(data.readUInt32LE(0), LOADER_PROGRAM_DATA, "not a ProgramData account");
  return data[12] === 1 ? new PublicKey(data.subarray(13, 45)) : null;
};

/** What a call that was expected to fail produced instead, when it did not fail. */
const SUCCEEDED = { succeeded: true } as const;

const thrownBy = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (err) {
    return err;
  }
  return SUCCEEDED;
};

const describeThrown = (thrown: unknown): string =>
  thrown === SUCCEEDED ? "IT SUCCEEDED" : String(thrown).slice(0, 800);

/** The parts of @coral-xyz/anchor's AnchorError these assertions read. Matched by shape, not instanceof. */
interface AnchorErrorShape {
  error: { errorCode: { code: string; number: number }; origin?: unknown; comparedValues?: unknown[] };
  logs: string[];
  program: { toBase58(): string };
}

const asAnchorError = (thrown: unknown, what: string): AnchorErrorShape => {
  const shape = thrown as Partial<AnchorErrorShape> | null;
  assert.isTrue(
    shape !== null && typeof shape === "object" && shape.error !== undefined && shape.error.errorCode !== undefined,
    `${what}: expected an AnchorError, got ${describeThrown(thrown)}`,
  );
  return shape as AnchorErrorShape;
};

/** Every log line of a failed transaction: AnchorError.logs, or SendTransactionError's own. */
const logsOf = (thrown: unknown): string[] | undefined => {
  const candidate = thrown as { logs?: unknown; transactionLogs?: unknown } | null;
  if (candidate === null || typeof candidate !== "object") return undefined;
  if (Array.isArray(candidate.logs)) return candidate.logs as string[];
  if (Array.isArray(candidate.transactionLogs)) return candidate.transactionLogs as string[];
  return undefined;
};

const isAnchorErrorLog = (line: string) => line.startsWith("Program log: AnchorError");

/**
 * init_config naming the shared test attester, signed by `authority`, with
 * `programData` in the ProgramData slot. The tripwire after it always fails,
 * so the transaction never lands, whatever the program does with it.
 */
const initConfigBehindTripwire = (program: Program<SipVault>, authority: PublicKey, programData: PublicKey) => {
  const broke = Keypair.generate();
  return program.methods
    .initConfig(TEST_ATTESTER.publicKey)
    .accountsPartial({ authority, programData })
    .postInstructions([SystemProgram.transfer({ fromPubkey: broke.publicKey, toPubkey: authority, lamports: 1 })])
    .signers([broke])
    .rpc();
};

// ── FINDING 10 probe: a mocha ROOT hook, so it runs before any spec creates the config ──

interface InitGateProbe {
  setupError?: string;
  configExistedBefore?: boolean;
  provider?: PublicKey;
  sipVault?: PublicKey;
  sipVaultProgramData?: PublicKey;
  sipVaultRecordedProgramData?: PublicKey;
  toyVenueProgramData?: PublicKey;
  toyVenueProgramDataOwner?: PublicKey;
  toyVenueUpgradeAuthority?: PublicKey | null;
  /** init_config with toy_venue's ProgramData. */
  refused?: unknown;
  /** The identical call with sip_vault's own ProgramData. */
  control?: unknown;
  configExistedAfter?: boolean;
}

let initGateProbe: InitGateProbe | null = null;

const probeInitGate = async (): Promise<InitGateProbe> => {
  const probe: InitGateProbe = {};
  try {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.sipVault as Program<SipVault>;
    const toyVenueId = (anchor.workspace.toyVenue as { programId: PublicKey }).programId;
    const connection = pollingConfirm(provider.connection);
    const configPda = configPdaFor(program.programId);

    probe.provider = provider.wallet.publicKey;
    probe.sipVault = program.programId;
    probe.configExistedBefore = (await connection.getAccountInfo(configPda)) !== null;
    // Nothing is sent against a config that already exists: the probe would prove nothing.
    if (probe.configExistedBefore) return probe;

    probe.sipVaultProgramData = programDataFor(program.programId);
    const sipVaultAccount = await connection.getAccountInfo(program.programId);
    if (sipVaultAccount === null) throw new Error("sip_vault is not deployed");
    probe.sipVaultRecordedProgramData = readProgramDataAddress(sipVaultAccount.data);

    probe.toyVenueProgramData = programDataFor(toyVenueId);
    const toyProgramData = await connection.getAccountInfo(probe.toyVenueProgramData);
    if (toyProgramData === null) throw new Error("toy_venue has no ProgramData: is [test] upgradeable still true?");
    probe.toyVenueProgramDataOwner = toyProgramData.owner;
    probe.toyVenueUpgradeAuthority = readUpgradeAuthority(toyProgramData.data);

    probe.refused = await thrownBy(initConfigBehindTripwire(program, probe.provider, probe.toyVenueProgramData));
    probe.control = await thrownBy(initConfigBehindTripwire(program, probe.provider, probe.sipVaultProgramData));
    probe.configExistedAfter = (await connection.getAccountInfo(configPda)) !== null;
  } catch (err) {
    probe.setupError = String(err);
  }
  return probe;
};

before("z-review-authority: probe init_config's ProgramData binding before any spec creates the config", async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<InitGateProbe>((resolve) => {
    timer = setTimeout(() => resolve({ setupError: "the probe did not finish within 90 s" }), 90_000);
  });
  try {
    initGateProbe = await Promise.race([probeInitGate(), deadline]);
  } catch (err) {
    initGateProbe = { setupError: String(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
});

describe("z-review FINDING 10: init_config binds the program to its own ProgramData", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault as Program<SipVault>;
  const connection = pollingConfirm(provider.connection);
  const configPda = configPdaFor(program.programId);

  before(async () => {
    await ensureConfig(program, provider.wallet.publicKey);
  });

  it("refuses the upgrade authority passing another program's ProgramData, with NotUpgradeAuthority from line 33", async () => {
    const probe = initGateProbe;
    assert.isNotNull(probe, "the root hook never ran");
    const p = probe!;
    assert.isUndefined(p.setupError, `the probe itself failed: ${p.setupError}`);
    assert.isFalse(
      p.configExistedBefore,
      "the config existed before any spec ran (a reused ledger?): line 33 cannot be reached once it exists, so this proves nothing",
    );

    // The setup this depends on: line 38 WOULD pass, so only line 33 is left to refuse.
    assert.strictEqual(String(p.toyVenueProgramDataOwner), UPGRADEABLE_LOADER.toBase58(), "toy_venue's ProgramData is a loader account");
    assert.isNotNull(p.toyVenueUpgradeAuthority, "toy_venue must still be upgradeable");
    assert.strictEqual(
      String(p.toyVenueUpgradeAuthority),
      String(p.provider),
      "the provider is toy_venue's upgrade authority, so line 38 is satisfied by this signer",
    );
    assert.strictEqual(
      String(p.sipVaultRecordedProgramData),
      String(p.sipVaultProgramData),
      "sip_vault's program account points at its own ProgramData",
    );
    assert.notStrictEqual(String(p.toyVenueProgramData), String(p.sipVaultProgramData), "the two ProgramData accounts differ");

    // THE REFUSAL. Lines 33 and 38 raise the same code; the account name tells
    // them apart. Line 33 is on `program`, line 38 is on `program_data`.
    const err = asAnchorError(p.refused, "init_config with toy_venue's ProgramData");
    assert.strictEqual(err.error.errorCode.code, NOT_UPGRADE_AUTHORITY.code);
    assert.strictEqual(err.error.errorCode.number, NOT_UPGRADE_AUTHORITY.number);
    assert.strictEqual(err.error.origin, "program", "raised by the constraint on `program` (line 33), not on `program_data` (line 38)");
    assert.strictEqual(err.program.toBase58(), String(p.sipVault), "raised by sip_vault itself");

    // THE CONTROL. The same signer, attester and tripwire with sip_vault's own
    // ProgramData get through both constraints and the handler. Only the
    // tripwire after them fails. So the refusal above was about which
    // ProgramData was passed, and nothing else.
    const logs = logsOf(p.control);
    assert.isDefined(logs, `the control call returned no logs: ${describeThrown(p.control)}`);
    const sip = String(p.sipVault);
    const invoked = logs!.indexOf(`Program ${sip} invoke [1]`);
    const succeeded = logs!.indexOf(`Program ${sip} success`);
    const tripped = logs!.findIndex((line) => line.startsWith(`Program ${SystemProgram.programId.toBase58()} failed`));
    assert.isAtLeast(invoked, 0, `init_config ran in the control: ${logs!.join(" | ")}`);
    assert.isAbove(succeeded, invoked, `init_config succeeded with sip_vault's own ProgramData: ${logs!.join(" | ")}`);
    assert.isAbove(tripped, succeeded, `and only the tripwire after it failed: ${logs!.join(" | ")}`);
    assert.isFalse(logs!.some(isAnchorErrorLog), "the control raised no AnchorError");

    assert.isFalse(p.configExistedAfter, "neither probe call left a config behind");
  });

  it("once the config exists, the same call dies in the init's allocate, before line 33 is evaluated", async () => {
    const before = (await connection.getAccountInfo(configPda))!.data;
    const toyVenueId = (anchor.workspace.toyVenue as { programId: PublicKey }).programId;

    const thrown = await thrownBy(
      initConfigBehindTripwire(program, provider.wallet.publicKey, programDataFor(toyVenueId)),
    );
    const logs = logsOf(thrown) ?? [];
    assert.isTrue(
      logs.some((line) => line.includes("already in use")),
      `expected the system program to refuse allocating the existing PDA, got ${describeThrown(thrown)}`,
    );
    assert.isFalse(
      logs.some(isAnchorErrorLog),
      "no account constraint ran: Anchor creates `init` accounts before it checks any other account",
    );
    assert.isTrue((await connection.getAccountInfo(configPda))!.data.equals(before), "the config is unchanged");
  });
});

describe("z-review FINDING 16: only the config's authority changes it, and a transfer moves that power", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault as Program<SipVault>;
  const connection = pollingConfirm(provider.connection);
  const original = provider.wallet.publicKey;
  const configPda = configPdaFor(program.programId);
  const successor = Keypair.generate();

  type ConfigState = Awaited<ReturnType<typeof program.account.protocolConfig.fetch>>;
  /** The config as it stood before this block, restored field by field in after(). */
  let snapshot: ConfigState | null = null;

  const fetchConfig = () => program.account.protocolConfig.fetch(configPda);
  const configBytes = async (): Promise<Buffer> => {
    const info = await connection.getAccountInfo(configPda);
    assert.isNotNull(info, "the config exists");
    return info!.data;
  };

  /** Signed by `who`, or by the provider wallet when "provider". */
  type Who = Keypair | "provider";
  const keyOf = (who: Who) => (who === "provider" ? original : who.publicKey);
  const signersOf = (who: Who) => (who === "provider" ? [] : [who]);

  const setKeeperBy = (who: Who, keeper: PublicKey) =>
    program.methods.setKeeper(keeper).accountsPartial({ authority: keyOf(who), config: configPda }).signers(signersOf(who)).rpc();
  const setAttesterBy = (who: Who, attester: PublicKey) =>
    program.methods.setAttester(attester).accountsPartial({ authority: keyOf(who), config: configPda }).signers(signersOf(who)).rpc();
  const setPausedBy = (who: Who, paused: boolean) =>
    program.methods.setProtocolPaused(paused).accountsPartial({ authority: keyOf(who), config: configPda }).signers(signersOf(who)).rpc();
  const transferBy = (who: Who, to: PublicKey) =>
    program.methods.transferAuthority(to).accountsPartial({ authority: keyOf(who), config: configPda }).signers(signersOf(who)).rpc();
  const acceptBy = (who: Who) =>
    program.methods.acceptAuthority().accountsPartial({ pendingAuthority: keyOf(who), config: configPda }).signers(signersOf(who)).rpc();

  /**
   * has_one = authority refused it: ConstraintHasOne on `config`, having
   * compared the stored authority (left) with the signer (right).
   */
  const expectHasOneRefusal = (thrown: unknown, stored: PublicKey, signer: PublicKey, what: string) => {
    const err = asAnchorError(thrown, what);
    assert.strictEqual(err.error.errorCode.code, CONSTRAINT_HAS_ONE.code, what);
    assert.strictEqual(err.error.errorCode.number, CONSTRAINT_HAS_ONE.number, what);
    assert.strictEqual(err.error.origin, "config", `${what}: raised by the has_one on config`);
    const compared = err.error.comparedValues;
    assert.isTrue(compared !== undefined && compared.length === 2, `${what}: has_one logs the two keys it compared`);
    assert.strictEqual(String(compared![0]), stored.toBase58(), `${what}: left is the authority the config stores`);
    assert.strictEqual(String(compared![1]), signer.toBase58(), `${what}: right is the key that signed`);
    assert.strictEqual(err.program.toBase58(), program.programId.toBase58(), `${what}: raised by sip_vault`);
  };

  before(async () => {
    await ensureConfig(program, original);
    const baseline = await fetchConfig();
    assert.strictEqual(
      baseline.authority.toBase58(),
      original.toBase58(),
      "an earlier spec left the config's authority moved: nothing here can run as the provider",
    );
    snapshot = baseline;
  });

  // Runs whether or not a test failed. Authority first, since only the
  // authority can put back the rest.
  after(async () => {
    if (snapshot === null) return;
    const baseline = snapshot;
    let config = await fetchConfig();

    if (!config.authority.equals(original)) {
      assert.strictEqual(
        config.authority.toBase58(),
        successor.publicKey.toBase58(),
        "restore: the authority is a key this spec never proposed, so it cannot be handed back",
      );
      // Sending the identical proposal again could be dropped as already processed.
      if (!config.pendingAuthority.equals(original)) await transferBy(successor, original);
      await acceptBy("provider");
      config = await fetchConfig();
    }

    if (!config.pendingAuthority.equals(baseline.pendingAuthority)) {
      if (baseline.pendingAuthority.equals(PublicKey.default)) {
        // The only way back to "nothing pending": propose yourself, then accept.
        await transferBy("provider", original);
        await acceptBy("provider");
      } else {
        await transferBy("provider", baseline.pendingAuthority);
      }
    }
    if (!config.keeper.equals(baseline.keeper)) await setKeeperBy("provider", baseline.keeper);
    if (!config.attester.equals(baseline.attester)) await setAttesterBy("provider", baseline.attester);
    if (config.paused !== baseline.paused) await setPausedBy("provider", baseline.paused);

    const restored = await fetchConfig();
    assert.strictEqual(restored.authority.toBase58(), baseline.authority.toBase58(), "restored authority");
    assert.strictEqual(restored.pendingAuthority.toBase58(), baseline.pendingAuthority.toBase58(), "restored pending authority");
    assert.strictEqual(restored.keeper.toBase58(), baseline.keeper.toBase58(), "restored keeper");
    assert.strictEqual(restored.attester.toBase58(), baseline.attester.toBase58(), "restored attester");
    assert.strictEqual(restored.paused, baseline.paused, "restored pause");
  });

  it("refuses set_keeper from a stranger naming itself keeper, and the config is unchanged", async () => {
    const stranger = Keypair.generate();
    const held = await configBytes();
    expectHasOneRefusal(
      await thrownBy(setKeeperBy(stranger, stranger.publicKey)),
      original,
      stranger.publicKey,
      "set_keeper signed by a stranger",
    );
    assert.isTrue((await configBytes()).equals(held), "the refused set_keeper wrote nothing");
  });

  it("refuses set_attester from a stranger naming itself attester, and the config is unchanged", async () => {
    const stranger = Keypair.generate();
    const held = await configBytes();
    // A real key, not the default: the handler's own zero check must not be what refuses it.
    expectHasOneRefusal(
      await thrownBy(setAttesterBy(stranger, stranger.publicKey)),
      original,
      stranger.publicKey,
      "set_attester signed by a stranger",
    );
    assert.isTrue((await configBytes()).equals(held), "the refused set_attester wrote nothing");
  });

  it("after transfer_authority and accept_authority, the ORIGINAL authority is refused by set_keeper, set_attester and set_protocol_paused", async () => {
    await transferBy("provider", successor.publicKey);
    await acceptBy(successor);
    const moved = await fetchConfig();
    assert.strictEqual(moved.authority.toBase58(), successor.publicKey.toBase58(), "accept_authority moved the authority");
    assert.strictEqual(moved.pendingAuthority.toBase58(), PublicKey.default.toBase58(), "and cleared the proposal");

    const held = await configBytes();
    expectHasOneRefusal(
      await thrownBy(setKeeperBy("provider", Keypair.generate().publicKey)),
      successor.publicKey,
      original,
      "set_keeper by the original authority after the transfer",
    );
    expectHasOneRefusal(
      await thrownBy(setAttesterBy("provider", Keypair.generate().publicKey)),
      successor.publicKey,
      original,
      "set_attester by the original authority after the transfer",
    );
    expectHasOneRefusal(
      await thrownBy(setPausedBy("provider", !moved.paused)),
      successor.publicKey,
      original,
      "set_protocol_paused by the original authority after the transfer",
    );
    assert.isTrue((await configBytes()).equals(held), "none of the three refused calls wrote a byte");

    // The control: the same three instructions signed by the successor go
    // through. It writes back the values already stored, so nothing moves.
    // The refusals above were about who signed, not a broken instruction.
    await setKeeperBy(successor, moved.keeper);
    await setAttesterBy(successor, moved.attester);
    await setPausedBy(successor, moved.paused);
    assert.isTrue((await configBytes()).equals(held), "the successor's writes changed nothing");

    // Handed back, so the provider is the authority again for after() and every later spec.
    await transferBy(successor, original);
    await acceptBy("provider");
    const back = await fetchConfig();
    assert.strictEqual(back.authority.toBase58(), original.toBase58(), "the provider is the authority again");
    assert.strictEqual(back.pendingAuthority.toBase58(), PublicKey.default.toBase58(), "with nothing pending");
  });
});
