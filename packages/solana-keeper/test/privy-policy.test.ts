// The keeper's Privy policy, the IDL its settle_v2 condition decodes with, the
// diff that checks a stored one, the admin key file, the error classes and the
// refusal probes.
//
// No network: the key pairs come from the SDK's own generateP256KeyPair (local
// WebCrypto), the errors are the SDK's own classes built with the bodies Privy
// returns, and the probes are decoded back with @solana/web3.js. What the policy
// lets through is read with a model of Privy's documented evaluation that
// decodes with Anchor's own coder (allows(), below), not with Privy. The admin key
// file is written into a temporary directory that plays both the repository and
// the place outside it.

import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APIConnectionError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  generateAuthorizationSignature,
  generateP256KeyPair,
} from "@privy-io/node";
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Ed25519Program, Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { afterAll, describe, expect, it } from "vitest";
import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID, idl, type SipVaultIdl } from "../src/idl.js";
import {
  AdminKeyFileError,
  COMPUTE_BUDGET_PROGRAM_ID,
  ED25519_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  PRIVY_IDL_MAX_BYTES,
  PROBE_MESSAGE,
  allowedInstructions,
  allowedPrograms,
  buildKeeperPolicy,
  buildMemoProbe,
  buildSelfTransferProbe,
  classifyPrivyError,
  diffPolicy,
  findRepositoryRoot,
  privyErrorCode,
  settleOnlyIdl,
  writeAdminKeyFile,
  type PolicyLike,
} from "../src/privy-policy.js";
import { buildTestSettle } from "./settle-transaction.js";

const policy = buildKeeperPolicy(SIP_PROGRAM_ID);

/** A policy as Privy stores it, mutable so a test can bend it. Assignable to PolicyLike. */
interface StoredCondition {
  field_source: string;
  field: string;
  operator: string;
  value: string | string[];
  idl?: unknown;
}
interface StoredPolicy {
  id: string;
  version: string;
  name: string;
  chain_type: string;
  owner_id: string | null;
  rules: { id: string; name: string; method: string; action: string; conditions: StoredCondition[] }[];
}

/** A stored copy of the built policy, with the fields Privy adds. */
function stored(over: Partial<StoredPolicy> = {}): StoredPolicy {
  const copy = JSON.parse(JSON.stringify(policy)) as StoredPolicy;
  copy.rules.forEach((rule, index) => (rule.id = `rule-${index}`));
  return { ...copy, id: "policy-1", owner_id: "admin-quorum-1", ...over };
}

/** The stored copy's instruction_name condition, to bend. */
const nameCondition = (copy: StoredPolicy): StoredCondition =>
  copy.rules.flatMap((rule) => rule.conditions).find((condition) => condition.field_source === "solana_instruction_data")!;

const fullInstruction = (name: string) => idl.instructions.find((instruction) => instruction.name === name)!;
const hex = (bytes: readonly number[]): string => Buffer.from(bytes).toString("hex");

/**
 * A MODEL OF PRIVY'S DOCUMENTED EVALUATION, not Privy: an instruction is
 * allowed when some ALLOW signAndSendTransaction rule's conditions all hold for
 * it, a programId condition by its program, an instruction_name condition by
 * decoding its data with the condition's own IDL — Anchor's coder, which matches
 * on the discriminator the data begins with, as Privy documents for its own.
 */
function allows(instruction: TransactionInstruction): boolean {
  return policy.rules.some(
    (rule) =>
      rule.action === "ALLOW" &&
      rule.method === "signAndSendTransaction" &&
      rule.conditions.every((condition) =>
        condition.field_source === "solana_program_instruction"
          ? instruction.programId.toBase58() === condition.value
          : new BorshInstructionCoder(condition.idl as unknown as Idl).decode(Buffer.from(instruction.data))?.name === condition.value,
      ),
  );
}

describe("settleOnlyIdl", () => {
  const subset = settleOnlyIdl();

  it("is the exported IDL's settle_v2 and nothing else, well inside Privy's 32 KB", () => {
    expect(subset.address).toBe(SIP_PROGRAM_ID);
    expect(subset.metadata).toEqual({ name: idl.metadata.name, version: idl.metadata.version, spec: idl.metadata.spec });
    expect(subset.instructions.map((instruction) => instruction.name)).toEqual(["settle_v2"]);
    expect(Object.keys(subset).sort()).toEqual(["address", "instructions", "metadata"]);
    expect(PRIVY_IDL_MAX_BYTES).toBe(32 * 1024);
    expect(Buffer.byteLength(JSON.stringify(subset))).toBeLessThan(1024);
    expect(Object.isFrozen(subset.instructions[0]!.accounts[0])).toBe(true);
  });

  it("keeps settle_v2 whole: its discriminator, every account in the program's order with its flags, every argument", () => {
    const settle = subset.instructions[0]!;
    const full = fullInstruction("settle_v2");
    expect(settle.discriminator).toEqual(full.discriminator);
    // Anchor's own derivation, so the IDL file is not trusted for it alone.
    expect(hex(settle.discriminator)).toBe(createHash("sha256").update("global:settle_v2").digest().subarray(0, 8).toString("hex"));
    expect(settle.accounts.map((account) => account.name)).toEqual(full.accounts.map((account) => account.name));
    for (const [index, account] of full.accounts.entries()) {
      const plain = account as { writable?: boolean; signer?: boolean; address?: string };
      expect(settle.accounts[index], account.name).toEqual({
        name: account.name,
        ...(plain.writable ? { writable: true } : {}),
        ...(plain.signer ? { signer: true } : {}),
        ...(plain.address !== undefined ? { address: plain.address } : {}),
      });
    }
    expect(settle.args).toEqual(full.args);
  });

  it("decodes the settle the keeper sends exactly as the whole IDL does, and resolves no other sip-vault instruction", async () => {
    const { transaction } = await buildTestSettle();
    const data = Buffer.from(transaction.instructions[1]!.data);
    const bySubset = new BorshInstructionCoder(subset as unknown as Idl).decode(data);
    const byFull = new BorshInstructionCoder(idl).decode(data);
    expect(bySubset?.name).toBe("settle_v2");
    expect(JSON.stringify(bySubset)).toBe(JSON.stringify(byFull));

    const others = idl.instructions.filter((instruction) => instruction.name !== "settle_v2");
    expect(others.map((instruction) => instruction.name)).toEqual(expect.arrayContaining(["create_vault_v2", "link_wallet", "withdraw"]));
    for (const instruction of others) {
      // The discriminator, then more zero bytes than any argument list needs.
      const bytes = Buffer.concat([Buffer.from(instruction.discriminator), Buffer.alloc(512)]);
      expect(new BorshInstructionCoder(subset as unknown as Idl).decode(bytes), instruction.name).toBeNull();
    }
  });

  it("refuses an IDL it could not carry whole, rather than send Privy a different program", () => {
    const bent = (change: (settle: Record<string, unknown>) => void): SipVaultIdl => {
      const copy = JSON.parse(JSON.stringify(idl)) as SipVaultIdl;
      change(copy.instructions.find((instruction) => instruction.name === "settle_v2") as unknown as Record<string, unknown>);
      return copy;
    };
    expect(() => settleOnlyIdl({ ...idl, instructions: idl.instructions.filter((instruction) => instruction.name !== "settle_v2") })).toThrow(
      /has no settle_v2 instruction/,
    );
    expect(() =>
      settleOnlyIdl(bent((settle) => ((settle["args"] as { type: unknown }[])[0]!.type = { defined: { name: "InvestmentLeg" } }))),
    ).toThrow(/argument mode is not a primitive/);
    expect(() => settleOnlyIdl(bent((settle) => ((settle["accounts"] as unknown[])[0] = { name: "group", accounts: [] })))).toThrow(
      /account group is a group/,
    );
  });
});

describe("buildKeeperPolicy", () => {
  it("is exactly the settle_v2-only policy", () => {
    expect(JSON.stringify(policy)).toBe(
      JSON.stringify({
        version: "1.0",
        name: "SaverFi keeper — settle_v2 only",
        chain_type: "solana",
        rules: [
          {
            name: "Allow sip-vault settle_v2 only",
            method: "signAndSendTransaction",
            action: "ALLOW",
            conditions: [
              { field_source: "solana_program_instruction", field: "programId", operator: "eq", value: "6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J" },
              {
                field_source: "solana_instruction_data",
                field: "instruction_name",
                operator: "eq",
                value: "settle_v2",
                idl: {
                  address: "6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J",
                  metadata: { name: "sip_vault", version: "0.1.0", spec: "0.1.0" },
                  instructions: [
                    {
                      name: "settle_v2",
                      discriminator: [5, 41, 238, 141, 219, 81, 39, 145],
                      accounts: [
                        { name: "wallet", writable: true, signer: true },
                        { name: "vault", writable: true },
                        { name: "trading_link", writable: true },
                        { name: "config" },
                        { name: "instructions_sysvar", address: "Sysvar1nstructions1111111111111111111111111" },
                        { name: "system_program", address: "11111111111111111111111111111111" },
                      ],
                      args: [
                        { name: "mode", type: "u8" },
                        { name: "session_start_slot", type: "u64" },
                        { name: "session_end_slot", type: "u64" },
                        { name: "base_lamports", type: "u64" },
                        { name: "valid_until_slot", type: "u64" },
                      ],
                    },
                  ],
                },
              },
            ],
          },
          {
            name: "Allow the attester's Ed25519SigVerify",
            method: "signAndSendTransaction",
            action: "ALLOW",
            conditions: [{ field_source: "solana_program_instruction", field: "programId", operator: "eq", value: "Ed25519SigVerify111111111111111111111111111" }],
          },
          { name: "Deny private key export", method: "exportPrivateKey", action: "DENY", conditions: [] },
          { name: "Deny message signing", method: "signMessage", action: "DENY", conditions: [] },
        ],
      }),
    );
    expect(Object.isFrozen(policy.rules[0]!.conditions[1])).toBe(true);
  });

  it("allows the exported IDL's program and refuses the retired one, or any other", () => {
    expect(SIP_PROGRAM_ID).toBe(idl.address);
    expect(allowedPrograms(policy)[0]).toBe(idl.address);
    expect(() => buildKeeperPolicy(OLD_NUVEM_PROGRAM_ID)).toThrow(/a retired program/);
    expect(() => buildKeeperPolicy(Keypair.generate().publicKey.toBase58())).toThrow(/exported IDL's address/);
    expect(JSON.stringify(policy)).not.toContain(OLD_NUVEM_PROGRAM_ID);
  });

  it("has no '*' rule, an ALLOW rule per program, and exactly two programs: never ComputeBudget", () => {
    expect(policy.rules.map((rule) => rule.method)).not.toContain("*");
    expect(policy.rules.filter((rule) => rule.action === "ALLOW")).toHaveLength(2);
    expect(allowedPrograms(policy)).toEqual([SIP_PROGRAM_ID, ED25519_PROGRAM_ID]);
    expect(allowedInstructions(policy)).toEqual([`${SIP_PROGRAM_ID}: settle_v2 only`, `${ED25519_PROGRAM_ID}: any instruction`]);
    // A compute-budget-only transaction would pass an allowlist naming it and
    // spend the wallet's SOL as priority fees; the Privy settle path never needs it.
    expect(allowedPrograms(policy)).not.toContain(COMPUTE_BUDGET_PROGRAM_ID);
    // The literals are the programs web3.js means, not look-alikes.
    expect(Ed25519Program.programId.toBase58()).toBe(ED25519_PROGRAM_ID);
    expect(ComputeBudgetProgram.programId.toBase58()).toBe(COMPUTE_BUDGET_PROGRAM_ID);
  });

  it("never lets an IDL condition stand without its program beside it, in the same rule", () => {
    // An IDL condition matches whatever program the data is sent to (Privy's own warning).
    for (const rule of policy.rules) {
      const named = rule.conditions.filter((condition) => condition.field_source === "solana_instruction_data");
      if (named.length === 0) continue;
      expect(rule.conditions.filter((condition) => condition.field_source === "solana_program_instruction")).toEqual([
        { field_source: "solana_program_instruction", field: "programId", operator: "eq", value: SIP_PROGRAM_ID },
      ]);
    }
  });

  it("allows both top-level instructions of a settle built as settle-tick.ts builds it, read back from the bytes Privy is sent", async () => {
    const { transaction } = await buildTestSettle();
    // Privy evaluates the serialized transaction: every top-level instruction
    // in it must be ALLOWed, and settle_v2's System transfer is a CPI, not one.
    const sent = Transaction.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }));
    expect(sent.instructions.map((instruction) => instruction.programId.toBase58())).toEqual([ED25519_PROGRAM_ID, SIP_PROGRAM_ID]);
    for (const instruction of sent.instructions) expect(allows(instruction), instruction.programId.toBase58()).toBe(true);
  });

  it("refuses sip-vault's other instructions, and settle_v2's bytes sent to any other program", async () => {
    const { transaction, wallet } = await buildTestSettle();
    const settle = transaction.instructions[1]!;
    const program = new PublicKey(SIP_PROGRAM_ID);
    for (const name of ["create_vault_v2", "link_wallet", "withdraw", "set_policy_v2"]) {
      const data = Buffer.concat([Buffer.from(fullInstruction(name).discriminator), Buffer.alloc(64)]);
      expect(allows(new TransactionInstruction({ programId: program, keys: [], data })), name).toBe(false);
    }
    // The same data, another program: the discriminator alone allows nothing.
    const elsewhere = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: settle.keys, data: Buffer.from(settle.data) });
    expect(allows(elsewhere)).toBe(false);
    expect(allows(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wallet, lamports: 1 }))).toBe(false);
  });
});

describe("diffPolicy", () => {
  it("finds nothing in a stored copy with other names, ids and orders, or an IDL Privy re-wrote", () => {
    const copy = stored();
    copy.rules.reverse();
    copy.rules.forEach((rule) => (rule.name = `renamed ${rule.method}`));
    // The same instructions under the same discriminators, spelt differently: a string, hex, extra fields.
    const condition = nameCondition(copy);
    const rewritten = JSON.parse(JSON.stringify(condition.idl)) as { instructions: Record<string, unknown>[]; docs?: string[] };
    rewritten.instructions[0]!["discriminator"] = `0x${hex(fullInstruction("settle_v2").discriminator)}`;
    rewritten.docs = ["stored by Privy"];
    condition.idl = JSON.stringify(rewritten);
    expect(diffPolicy(policy, copy, { signerId: "keeper-signer-1" })).toMatchObject({
      identical: true,
      differences: [],
      owned: true,
      ownerIsSigner: false,
      ok: true,
    });
  });

  it("catches an IDL that names another instruction settle_v2, or names one more", () => {
    const renamed = stored();
    (nameCondition(renamed).idl as { instructions: { discriminator: number[] }[] }).instructions[0]!.discriminator = [
      ...fullInstruction("link_wallet").discriminator,
    ];
    const text = diffPolicy(policy, renamed).differences.join("\n");
    expect(text).toContain(`settle_v2=0x${hex(fullInstruction("link_wallet").discriminator)}`);
    expect(diffPolicy(policy, renamed).ok).toBe(false);

    const grown = stored();
    (nameCondition(grown).idl as { instructions: unknown[] }).instructions.push(fullInstruction("create_vault_v2"));
    expect(diffPolicy(policy, grown).differences.join("\n")).toContain(`create_vault_v2=0x${hex(fullInstruction("create_vault_v2").discriminator)}`);
  });

  it("reads today's program-only policy as different, naming the condition and the rule it lacks", () => {
    const today: PolicyLike = {
      chain_type: "solana",
      owner_id: "admin-quorum-1",
      rules: [
        {
          method: "signAndSendTransaction",
          action: "ALLOW",
          conditions: [{ field_source: "solana_program_instruction", field: "programId", operator: "in", value: [SIP_PROGRAM_ID, ED25519_PROGRAM_ID] }],
        },
        { method: "exportPrivateKey", action: "DENY", conditions: [] },
        { method: "signMessage", action: "DENY", conditions: [] },
      ],
    };
    const diff = diffPolicy(policy, today);
    expect(diff.ok).toBe(false);
    const text = diff.differences.join("\n");
    expect(text).toContain("is missing its condition solana_instruction_data.instruction_name eq (idl: settle_v2=0x0529ee8ddb512791) [settle_v2]");
    expect(text).toContain(`missing rule: ALLOW signAndSendTransaction when solana_program_instruction.programId eq [${ED25519_PROGRAM_ID}]`);
  });

  it("catches an added program", () => {
    const extra = Keypair.generate().publicKey.toBase58();
    const copy = stored();
    const ed25519 = copy.rules.find((rule) => rule.name === "Allow the attester's Ed25519SigVerify")!;
    ed25519.conditions[0]!.value = [ED25519_PROGRAM_ID, extra];
    const diff = diffPolicy(policy, copy);
    expect(diff.identical).toBe(false);
    expect(diff.ok).toBe(false);
    expect(diff.differences.join("\n")).toContain(`adds [${extra}]`);
  });

  it("reads an idl: null on a programId condition as nothing, and still names a missing IDL", () => {
    const copy = stored() as unknown as { rules: { conditions: Record<string, unknown>[] }[] };
    copy.rules[1]!.conditions[0]!["idl"] = null;
    expect(diffPolicy(policy, copy as unknown as PolicyLike).differences).toEqual([]);
    const missing = stored();
    nameCondition(missing).idl = null;
    expect(diffPolicy(policy, missing).differences.join("\n")).toContain("(idl: none)");
  });

  it("catches a dropped instruction_name condition", () => {
    const copy = stored();
    copy.rules[0]!.conditions = copy.rules[0]!.conditions.filter((condition) => condition.field_source !== "solana_instruction_data");
    expect(diffPolicy(policy, copy).differences).toEqual([
      `the ALLOW signAndSendTransaction rule for ${SIP_PROGRAM_ID} is missing its condition solana_instruction_data.instruction_name eq (idl: settle_v2=0x0529ee8ddb512791) [settle_v2]`,
    ]);
  });

  it("catches a changed action", () => {
    const copy = stored();
    copy.rules[3]!.action = "ALLOW";
    const diff = diffPolicy(policy, copy);
    expect(diff.ok).toBe(false);
    expect(diff.differences).toEqual(["the signMessage rule (always) is ALLOW; expected DENY"]);
  });

  it("catches a missing owner", () => {
    const diff = diffPolicy(policy, stored({ owner_id: null }), { signerId: "keeper-signer-1" });
    expect(diff).toMatchObject({ identical: true, owned: false, ownerId: null, ok: false });
    expect(diff.ownershipProblems.join("\n")).toContain("no owner_id");
  });

  it("catches an owner that is the keeper's own signer, when the signer id is given", () => {
    const diff = diffPolicy(policy, stored({ owner_id: "keeper-signer-1" }), { signerId: "keeper-signer-1" });
    expect(diff).toMatchObject({ identical: true, owned: true, ownerIsSigner: true, ok: false });
    expect(diffPolicy(policy, stored({ owner_id: "keeper-signer-1" })).ok).toBe(true);
  });

  it("names a '*' rule, a dropped program, the retired program and a wrong chain", () => {
    const copy = stored({ chain_type: "ethereum" });
    copy.rules.push({ id: "rule-9", name: "open", method: "*", action: "ALLOW", conditions: [] });
    copy.rules[0]!.conditions[0]!.value = [OLD_NUVEM_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID];
    const text = diffPolicy(policy, copy).differences.join("\n");
    expect(text).toContain("chain_type is ethereum");
    expect(text).toContain("unexpected rule: ALLOW * always (a '*' rule");
    expect(text).toContain(`drops [${SIP_PROGRAM_ID}]`);
    expect(text).toContain("names a retired program");
  });

  it("catches a missing rule", () => {
    const copy = stored();
    copy.rules.splice(2, 1);
    expect(diffPolicy(policy, copy).differences).toEqual(["missing rule: DENY exportPrivateKey always"]);
  });
});

describe("writeAdminKeyFile", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sip-privy-policy-")));
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  mkdirSync(join(repo, "packages"), { recursive: true });
  mkdirSync(outside, { mode: 0o700 });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function refusal(run: () => unknown): AdminKeyFileError {
    try {
      run();
    } catch (error) {
      if (error instanceof AdminKeyFileError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  }

  it("writes the key alone, mode 0600, in the form authorization_private_keys takes", async () => {
    const pair = await generateP256KeyPair();
    const path = join(outside, "admin.key");
    expect(writeAdminKeyFile(path, pair.privateKey, { repoRoot: repo })).toEqual({ path, mode: 0o600 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const contents = readFileSync(path, "utf8");
    expect(contents).toBe(pair.privateKey);

    // The SDK signs with the file's bytes as they are, and the signature verifies against the registered public key.
    const payload = new TextEncoder().encode("sip policy admin");
    const signature = generateAuthorizationSignature({ authorizationPrivateKey: contents, input: payload });
    const publicKey = createPublicKey({ key: Buffer.from(pair.publicKey, "base64"), format: "der", type: "spki" });
    expect(verify("sha256", payload, { key: publicKey, dsaEncoding: "der" }, Buffer.from(signature, "base64"))).toBe(true);
  });

  it("refuses an existing file and leaves it as it was", async () => {
    const [first, second] = await Promise.all([generateP256KeyPair(), generateP256KeyPair()]);
    const path = join(outside, "exists.key");
    writeAdminKeyFile(path, first.privateKey, { repoRoot: repo });
    const error = refusal(() => writeAdminKeyFile(path, second.privateKey, { repoRoot: repo }));
    expect(error.reason).toBe("EXISTS");
    expect(error.message).not.toContain(second.privateKey);
    expect(readFileSync(path, "utf8")).toBe(first.privateKey);
  });

  it("refuses a path inside the repository, directly or through a symlink", async () => {
    const pair = await generateP256KeyPair();
    for (const path of [join(repo, "admin.key"), join(repo, "packages", "admin.key")]) {
      expect(refusal(() => writeAdminKeyFile(path, pair.privateKey, { repoRoot: repo })).reason).toBe("INSIDE_REPOSITORY");
      expect(existsSync(path)).toBe(false);
    }

    symlinkSync(join(repo, "packages"), join(outside, "looks-outside"));
    const throughLink = refusal(() => writeAdminKeyFile(join(outside, "looks-outside", "admin.key"), pair.privateKey, { repoRoot: repo }));
    expect(throughLink.reason).toBe("INSIDE_REPOSITORY");
    expect(throughLink.message).not.toContain(pair.privateKey);
    expect(existsSync(join(repo, "packages", "admin.key"))).toBe(false);

    // A symlink as the file itself: O_EXCL refuses it, and its target is never created.
    symlinkSync(join(repo, "packages", "target.key"), join(outside, "link.key"));
    expect(refusal(() => writeAdminKeyFile(join(outside, "link.key"), pair.privateKey, { repoRoot: repo })).reason).toBe("EXISTS");
    expect(existsSync(join(repo, "packages", "target.key"))).toBe(false);
  });

  // Other spellings of the same directory, which a string comparison lets through.
  const swapCase = (text: string): string =>
    [...text].map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase())).join("");
  const caseVariant = swapCase(join(repo, "packages"));
  const firmlinkVariant = `/System/Volumes/Data${join(repo, "packages")}`;

  it.skipIf(!existsSync(caseVariant))("refuses the repository spelled in another letter case (case-insensitive volumes)", async () => {
    const pair = await generateP256KeyPair();
    expect(caseVariant.startsWith(repo)).toBe(false);
    const error = refusal(() => writeAdminKeyFile(join(caseVariant, "case.key"), pair.privateKey, { repoRoot: repo }));
    expect(error.reason).toBe("INSIDE_REPOSITORY");
    expect(error.message).not.toContain(pair.privateKey);
    expect(existsSync(join(repo, "packages", "case.key"))).toBe(false);
  });

  it.skipIf(process.platform !== "darwin" || !existsSync(firmlinkVariant))(
    "refuses the repository spelled through macOS's /System/Volumes/Data firmlink",
    async () => {
      const pair = await generateP256KeyPair();
      expect(firmlinkVariant.startsWith(repo)).toBe(false);
      const error = refusal(() => writeAdminKeyFile(join(firmlinkVariant, "firmlink.key"), pair.privateKey, { repoRoot: repo }));
      expect(error.reason).toBe("INSIDE_REPOSITORY");
      expect(existsSync(join(repo, "packages", "firmlink.key"))).toBe(false);
    },
  );

  it("refuses any directory under a .git entry: another checkout, or a worktree", async () => {
    const pair = await generateP256KeyPair();
    const checkout = join(outside, "other-checkout");
    mkdirSync(join(checkout, "deep"), { recursive: true });
    // A worktree's .git is a file; a checkout's is a directory. Either counts.
    writeFileSync(join(checkout, ".git"), "gitdir: /elsewhere/.git/worktrees/other-checkout\n");
    const error = refusal(() => writeAdminKeyFile(join(checkout, "deep", "admin.key"), pair.privateKey, { repoRoot: repo }));
    expect(error.reason).toBe("INSIDE_REPOSITORY");
    expect(error.message).toContain(".git");
    expect(existsSync(join(checkout, "deep", "admin.key"))).toBe(false);
  });

  it("refuses a missing directory and anything that is not a bare P-256 PKCS8 key", async () => {
    const pair = await generateP256KeyPair();
    expect(refusal(() => writeAdminKeyFile(join(outside, "missing", "admin.key"), pair.privateKey, { repoRoot: repo })).reason).toBe("NO_DIRECTORY");
    for (const notAKey of [`wallet-auth:${pair.privateKey}`, `${pair.privateKey}\n`, pair.publicKey, "not-a-key", ""]) {
      const error = refusal(() => writeAdminKeyFile(join(outside, "never.key"), notAKey, { repoRoot: repo }));
      expect(error.reason).toBe("NOT_A_KEY");
      expect(error.message).not.toContain(pair.privateKey);
    }
    expect(existsSync(join(outside, "never.key"))).toBe(false);
  });

  it("finds the repository this package lives in", () => {
    const found = findRepositoryRoot(new URL(".", import.meta.url).pathname);
    expect(existsSync(join(found, "packages", "solana-keeper", "package.json"))).toBe(true);
  });
});

describe("classifyPrivyError", () => {
  const headers = new Headers();

  it("reads POLICY_VIOLATION from Privy's code on the SDK's error body, in either case", () => {
    const denied = new BadRequestError(400, { error: "Policy violation", code: "policy_violation" }, undefined, headers);
    expect(classifyPrivyError(denied)).toBe("POLICY_VIOLATION");
    expect(privyErrorCode(denied)).toBe("policy_violation");
    expect(classifyPrivyError(new BadRequestError(400, { error: "denied", code: "POLICY_VIOLATION" }, undefined, headers))).toBe("POLICY_VIOLATION");
  });

  it("never calls a message that merely mentions a policy a violation", () => {
    expect(classifyPrivyError(new BadRequestError(400, { error: "policy violation" }, undefined, headers))).toBe("OTHER");
    expect(classifyPrivyError(new Error("POLICY_VIOLATION"))).toBe("OTHER");
  });

  it("recognises a failed simulation", () => {
    expect(
      classifyPrivyError(
        new BadRequestError(400, { error: "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit." }, undefined, headers),
      ),
    ).toBe("SIMULATION_FAILED");
    expect(classifyPrivyError(new BadRequestError(400, { error: "Wallet has insufficient funds for this transaction", code: "insufficient_funds" }, undefined, headers))).toBe(
      "SIMULATION_FAILED",
    );
  });

  it("recognises refused credentials and authorization signatures", () => {
    expect(classifyPrivyError(new AuthenticationError(401, { error: "Invalid app ID or app secret." }, undefined, headers))).toBe("AUTHORIZATION");
    expect(classifyPrivyError(new BadRequestError(400, { error: "No valid signatures", code: "zero_correct_authorization_signatures" }, undefined, headers))).toBe(
      "AUTHORIZATION",
    );
    // Thrown by the SDK itself before any request, when the key does not parse.
    expect(classifyPrivyError(new Error("Invalid wallet authorization private key"))).toBe("AUTHORIZATION");
  });

  it("calls everything else OTHER", () => {
    expect(classifyPrivyError(new NotFoundError(404, { error: "Wallet not found" }, undefined, headers))).toBe("OTHER");
    expect(classifyPrivyError(new InternalServerError(500, { error: "boom" }, undefined, headers))).toBe("OTHER");
    expect(classifyPrivyError(new APIConnectionError({ message: "Connection error." }))).toBe("OTHER");
    expect(classifyPrivyError("nope")).toBe("OTHER");
    expect(classifyPrivyError(null)).toBe("OTHER");
  });
});

describe("the refusal probes", () => {
  const wallet = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();

  it("self-transfer: one top-level System transfer of 1 lamport to itself, paid by the wallet, unsigned", () => {
    const transaction = Transaction.from(buildSelfTransferProbe(wallet, blockhash));
    expect(transaction.instructions).toHaveLength(1);
    expect(transaction.feePayer?.toBase58()).toBe(wallet.toBase58());
    expect(transaction.recentBlockhash).toBe(blockhash);
    expect(transaction.signatures.map((entry) => entry.signature)).toEqual([null]);
    const instruction = transaction.instructions[0]!;
    expect(instruction.programId.toBase58()).toBe(SystemProgram.programId.toBase58());
    expect(SystemInstruction.decodeInstructionType(instruction)).toBe("Transfer");
    const transfer = SystemInstruction.decodeTransfer(instruction);
    expect([transfer.fromPubkey.toBase58(), transfer.toPubkey.toBase58(), transfer.lamports]).toEqual([wallet.toBase58(), wallet.toBase58(), 1n]);
  });

  it("memo: one Memo instruction carrying the probe text and no accounts, paid by the wallet, unsigned", () => {
    const transaction = Transaction.from(buildMemoProbe(wallet.toBase58(), blockhash));
    expect(transaction.instructions).toHaveLength(1);
    expect(transaction.feePayer?.toBase58()).toBe(wallet.toBase58());
    expect(transaction.signatures.map((entry) => entry.signature)).toEqual([null]);
    const instruction = transaction.instructions[0]!;
    expect(instruction.programId.toBase58()).toBe(MEMO_PROGRAM_ID);
    expect(instruction.keys).toEqual([]);
    expect(Buffer.from(instruction.data).toString("utf8")).toBe(PROBE_MESSAGE);
  });

  it("targets no allowed program, and refuses a malformed blockhash", () => {
    for (const bytes of [buildSelfTransferProbe(wallet, blockhash), buildMemoProbe(wallet, blockhash)]) {
      for (const instruction of Transaction.from(bytes).instructions) expect(allowedPrograms(policy)).not.toContain(instruction.programId.toBase58());
    }
    expect(() => buildMemoProbe(wallet, "not-a-blockhash")).toThrow(/blockhash is not a base58 32-byte hash/i);
  });
});
