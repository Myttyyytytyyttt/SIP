// FINDINGS 9 AND 13: the owner's exits are never blocked.
//
// Two switches stop this machine: the protocol's, which the config authority
// pulls, and the vault's own, which its owner pulls through set_policy_v2.
// Neither may keep an owner from leaving with their savings. So every exit runs
// here under each switch and must land exactly: the vault's native lamports, an
// SPL token, a Token-2022 token, the vault's wSOL, which must reach the owner as
// spendable SOL rather than as a wSOL account (withdraw_token.rs:120-129), and
// the owner's unlink of a trading wallet.
//
// A SWITCH THAT IS NOT LIVE PROVES NOTHING. Each test pulls its switch and then
// watches an instruction that switch gates be refused by name, in the very
// state the exit then succeeds in.
//
// Named z-review-* so mocha's --sort runs it after every existing spec. It
// shares their validator and their one ProtocolConfig: the protocol pause is
// lifted after every test, pass or fail, and left as this file found it. The
// vault pause needs no restoring: every test pauses a vault of its own.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createMint,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import { SipVault } from "../target/types/sip_vault";
import { MODE_PROFIT } from "../scripts/attestation";
import { linkWalletWithConsent } from "../scripts/link-consent";
import { configPdaFor, ensureConfig, pollingConfirm } from "./config-fixture";

describe("sip-vault review: the owner's exits survive both pauses (findings 9 and 13)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault as Program<SipVault>;
  const connection = pollingConfirm(provider.connection);
  const payer = (provider.wallet as anchor.Wallet).payer;
  const authority = provider.wallet.publicKey;
  const configPda = configPdaFor(program.programId);

  const CAP = new anchor.BN(LAMPORTS_PER_SOL);
  const NO_RESERVE = new anchor.BN(0);

  // The number beside each name: errors.rs only ever appends, and clients match on both.
  interface Refusal {
    readonly code: string;
    readonly number: number;
  }
  const VAULT_PAUSED: Refusal = { code: "VaultPaused", number: 6007 };
  const PROTOCOL_PAUSED: Refusal = { code: "ProtocolPaused", number: 6023 };

  /** A fresh owner, and the vault only they can withdraw from. */
  interface Saver {
    readonly owner: Keypair;
    readonly vault: PublicKey;
  }

  /** A token balance the vault PDA holds, and the token program that keeps it. */
  interface VaultHolding {
    readonly mint: PublicKey;
    readonly vaultToken: PublicKey;
    readonly tokenProgram: PublicKey;
  }

  const vaultOf = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], program.programId)[0];
  const policyOf = (vault: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("invest"), vault.toBuffer()], program.programId)[0];
  const linkOf = (wallet: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("link"), wallet.toBuffer()], program.programId)[0];

  const lamports = (account: PublicKey) => connection.getBalance(account);
  /** A token account's raw amount, as the decimal string the RPC reports. */
  const amountOf = async (account: PublicKey) => (await connection.getTokenAccountBalance(account)).value.amount;

  const fetchConfig = () => program.account.protocolConfig.fetch(configPda);
  const setProtocolPaused = (paused: boolean) =>
    program.methods.setProtocolPaused(paused).accountsPartial({ authority, config: configPda }).rpc();

  /** Fails unless `call` is refused with exactly this program error, by name and by number. */
  const expectRefusal = async (call: Promise<unknown>, refusal: Refusal, what: string) => {
    let succeeded = false;
    let thrown: unknown = null;
    try {
      await call;
      succeeded = true;
    } catch (error) {
      thrown = error;
    }
    assert.isFalse(succeeded, `${what}: expected ${refusal.code}, but it succeeded`);
    const errorCode = (thrown as { error?: { errorCode?: { code?: string; number?: number } } } | null)?.error
      ?.errorCode;
    assert.strictEqual(errorCode?.code, refusal.code, `${what}: refused for another reason: ${String(thrown)}`);
    assert.strictEqual(errorCode?.number, refusal.number, `${what}: ${refusal.code} must keep its number`);
  };

  const freshSaver = async (): Promise<Saver> => {
    const owner = Keypair.generate();
    await connection.confirmTransaction(await connection.requestAirdrop(owner.publicKey, 2 * LAMPORTS_PER_SOL));
    await program.methods
      .createVaultV2(MODE_PROFIT, 2_000, 20, CAP, NO_RESERVE)
      .accounts({ owner: owner.publicKey })
      .signers([owner])
      .rpc();
    return { owner, vault: vaultOf(owner.publicKey) };
  };

  /**
   * The vault's wSOL account holding `wrapped` lamports of wSOL, exactly as
   * wrap_sol leaves it: a native account under the vault PDA. Funded directly,
   * so no exit test here leans on a crank.
   */
  const wsolInVault = async (saver: Saver, wrapped: number): Promise<VaultHolding> => {
    const vaultToken = await createAssociatedTokenAccountIdempotent(
      connection, payer, NATIVE_MINT, saver.vault, undefined, TOKEN_PROGRAM_ID, undefined, true,
    );
    await provider.sendAndConfirm(
      new Transaction()
        .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vaultToken, lamports: wrapped }))
        .add(createSyncNativeInstruction(vaultToken)),
    );
    return { mint: NATIVE_MINT, vaultToken, tokenProgram: TOKEN_PROGRAM_ID };
  };

  interface TokenKind {
    readonly label: string;
    readonly tokenProgram: PublicKey;
    readonly decimals: number;
  }
  const TOKEN_KINDS: readonly TokenKind[] = [
    { label: "an SPL token (6 decimals, the USDC shape)", tokenProgram: TOKEN_PROGRAM_ID, decimals: 6 },
    { label: "a Token-2022 token (8 decimals, the xStocks shape)", tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: 8 },
  ];

  /** A fresh mint of `kind`, and `amount` of it in the vault's associated account. */
  const mintedInVault = async (saver: Saver, kind: TokenKind, amount: number): Promise<VaultHolding> => {
    const mint = await createMint(
      connection, payer, payer.publicKey, null, kind.decimals, Keypair.generate(), undefined, kind.tokenProgram,
    );
    const vaultToken = await createAssociatedTokenAccountIdempotent(
      connection, payer, mint, saver.vault, undefined, kind.tokenProgram, undefined, true,
    );
    await mintTo(connection, payer, mint, vaultToken, payer, amount, [], undefined, kind.tokenProgram);
    return { mint, vaultToken, tokenProgram: kind.tokenProgram };
  };

  /** The one account withdraw_token may pay into: the owner's associated account for the mint. */
  const ownerAccountOf = (saver: Saver, holding: VaultHolding) =>
    getAssociatedTokenAddressSync(holding.mint, saver.owner.publicKey, false, holding.tokenProgram);

  const withdrawToken = (saver: Saver, holding: VaultHolding, amount: number) =>
    program.methods
      .withdrawToken(new anchor.BN(amount))
      .accountsPartial({
        owner: saver.owner.publicKey,
        vault: saver.vault,
        tokenMint: holding.mint,
        vaultToken: holding.vaultToken,
        ownerToken: ownerAccountOf(saver, holding),
        tokenProgram: holding.tokenProgram,
      })
      .signers([saver.owner])
      .rpc();

  /**
   * An enabled investment policy with a conversion floor. wrap_sol loads it
   * before reading either switch, and with it in place the vault's pause is
   * the only thing that can stop the owner wrapping their own vault.
   */
  const setInvestPolicy = (saver: Saver) =>
    program.methods
      .setInvestPolicy(
        [{ mint: Keypair.generate().publicKey, weightBps: 10_000, minOutRateWad: new anchor.BN(1) }],
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
        new anchor.BN("30000000000000000"),
        new anchor.BN(1),
        new anchor.BN(1),
        new anchor.BN(1),
        true,
      )
      .accountsPartial({ owner: saver.owner.publicKey, vault: saver.vault, policy: policyOf(saver.vault) })
      .signers([saver.owner])
      .rpc();

  interface Brake {
    readonly label: string;
    /** Pulls the switch on this saver's world, and proves it live: an instruction it gates is refused by name. */
    readonly engage: (saver: Saver) => Promise<void>;
  }

  const PROTOCOL_PAUSE: Brake = {
    label: "the PROTOCOL paused by the config authority",
    engage: async (saver) => {
      await setProtocolPaused(true);
      assert.isTrue((await fetchConfig()).paused, "the protocol is paused");
      // link_wallet reads the protocol's switch and none of the vault's.
      const wallet = Keypair.generate();
      await expectRefusal(
        linkWalletWithConsent(program, { owner: saver.owner.publicKey, wallet }).signers([saver.owner, wallet]).rpc(),
        PROTOCOL_PAUSED,
        "the protocol pause is live",
      );
    },
  };

  const VAULT_PAUSE: Brake = {
    label: "the VAULT paused by its owner",
    engage: async (saver) => {
      await setInvestPolicy(saver);
      const vaultWsol = await createAssociatedTokenAccountIdempotent(
        connection, payer, NATIVE_MINT, saver.vault, undefined, TOKEN_PROGRAM_ID, undefined, true,
      );
      await program.methods
        .setPolicyV2(MODE_PROFIT, 2_000, 20, true, CAP, NO_RESERVE)
        .accounts({ owner: saver.owner.publicKey })
        .signers([saver.owner])
        .rpc();
      assert.isTrue((await program.account.vault.fetch(saver.vault)).paused, "the vault is paused");
      // The owner cranking their own vault clears may_crank, so the refusal is the pause's alone.
      await expectRefusal(
        program.methods
          .wrapSol(new anchor.BN(1_000))
          .accountsPartial({
            crank: saver.owner.publicKey,
            vault: saver.vault,
            policy: policyOf(saver.vault),
            vaultWsol,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([saver.owner])
          .rpc(),
        VAULT_PAUSED,
        "the vault pause is live",
      );
    },
  };

  /** The protocol pause as this file found it, put back when the file is done. */
  let pausedAsFound: boolean | undefined;

  before(async () => {
    await ensureConfig(program, authority);
    const config = await fetchConfig();
    assert.isTrue(
      config.authority.equals(authority),
      "the provider wallet must hold the config authority, or this file can neither pause the protocol nor restore it",
    );
    pausedAsFound = config.paused;
    // Setups link wallets, which a paused protocol refuses: every test starts from a running protocol.
    if (config.paused) await setProtocolPaused(false);
  });

  // A test's protocol pause ends with that test, whether it passed or not.
  afterEach(async () => {
    if ((await fetchConfig()).paused) await setProtocolPaused(false);
  });

  after(async () => {
    if (pausedAsFound === undefined) return;
    if ((await fetchConfig()).paused !== pausedAsFound) await setProtocolPaused(pausedAsFound);
  });

  for (const brake of [PROTOCOL_PAUSE, VAULT_PAUSE]) {
    describe(`with ${brake.label}`, () => {
      it("withdraw_token of the vault's wSOL pays the owner native SOL, and no wSOL account is left behind", async () => {
        const saver = await freshSaver();
        const WRAPPED = LAMPORTS_PER_SOL / 2;
        const wsol = await wsolInVault(saver, WRAPPED);
        const ownerWsol = ownerAccountOf(saver, wsol);
        await brake.engage(saver);

        // 1. The owner has no wSOL account: init_if_needed opens one, and the same instruction closes it.
        assert.isNull(await connection.getAccountInfo(ownerWsol), "precondition: the owner has no wSOL account");
        const FIRST = LAMPORTS_PER_SOL / 5;
        let ownerBefore = await lamports(saver.owner.publicKey);
        await withdrawToken(saver, wsol, FIRST);
        assert.strictEqual(
          (await lamports(saver.owner.publicKey)) - ownerBefore,
          FIRST,
          "the owner gains exactly the wSOL withdrawn, as SOL, and the account rent they fronted comes back",
        );
        assert.isNull(await connection.getAccountInfo(ownerWsol), "the owner's wSOL account is closed, not left holding it");
        assert.strictEqual(await amountOf(wsol.vaultToken), String(WRAPPED - FIRST), "the vault's wSOL fell by exactly that");

        // 2. The owner already holds wSOL of their own: that account is closed too, and everything in it unwraps.
        const OWN = 1_000_000;
        await createAssociatedTokenAccountIdempotent(connection, payer, NATIVE_MINT, saver.owner.publicKey);
        await provider.sendAndConfirm(
          new Transaction()
            .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ownerWsol, lamports: OWN }))
            .add(createSyncNativeInstruction(ownerWsol)),
        );
        assert.strictEqual(await amountOf(ownerWsol), String(OWN), "precondition: the owner holds wSOL of their own");
        const openLamports = (await connection.getAccountInfo(ownerWsol))!.lamports;
        const REST = WRAPPED - FIRST;
        ownerBefore = await lamports(saver.owner.publicKey);
        await withdrawToken(saver, wsol, REST);
        assert.strictEqual(
          (await lamports(saver.owner.publicKey)) - ownerBefore,
          REST + openLamports,
          "the owner gains the rest of the vault's wSOL plus everything their own wSOL account held, all as SOL",
        );
        assert.isNull(await connection.getAccountInfo(ownerWsol), "the existing wSOL account is closed as well");
        assert.strictEqual(await amountOf(wsol.vaultToken), "0", "every wSOL the vault held has left it");
      });

      for (const kind of TOKEN_KINDS) {
        it(`withdraw_token of ${kind.label} creates the owner's associated account, then credits it`, async () => {
          const saver = await freshSaver();
          const HELD = 5_000_000;
          const holding = await mintedInVault(saver, kind, HELD);
          const ownerToken = ownerAccountOf(saver, holding);
          await brake.engage(saver);

          // 1. No account yet: init_if_needed creates it, paid by the owner who signs.
          assert.isNull(await connection.getAccountInfo(ownerToken), "precondition: the owner has no account for this mint");
          const FIRST = 2_000_000;
          await withdrawToken(saver, holding, FIRST);
          const created = await connection.getAccountInfo(ownerToken);
          assert.isNotNull(created, "init_if_needed created the owner's associated account");
          assert.isTrue(created!.owner.equals(kind.tokenProgram), "under the mint's own token program");
          const account = await getAccount(connection, ownerToken, undefined, kind.tokenProgram);
          assert.isTrue(account.owner.equals(saver.owner.publicKey), "its authority is the owner");
          assert.isTrue(account.mint.equals(holding.mint), "for the withdrawn mint");
          assert.strictEqual(account.amount.toString(), String(FIRST), "credited with exactly the amount withdrawn");
          assert.strictEqual(await amountOf(holding.vaultToken), String(HELD - FIRST), "and the vault holds that much less");

          // 2. The account exists now: the other branch of init_if_needed, and the rest of the balance.
          await withdrawToken(saver, holding, HELD - FIRST);
          assert.strictEqual(await amountOf(ownerToken), String(HELD), "the existing account is credited on top");
          assert.strictEqual(await amountOf(holding.vaultToken), "0", "the vault holds none of it any more");
        });
      }

      it("withdraw pays the owner every lamport above the vault's rent floor", async () => {
        const saver = await freshSaver();
        await provider.sendAndConfirm(
          new Transaction().add(
            SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: saver.vault, lamports: LAMPORTS_PER_SOL }),
          ),
        );
        await brake.engage(saver);

        const vaultInfo = await connection.getAccountInfo(saver.vault);
        assert.isNotNull(vaultInfo, "precondition: the vault exists");
        const floor = await connection.getMinimumBalanceForRentExemption(vaultInfo!.data.length);
        const withdrawable = vaultInfo!.lamports - floor;
        assert.strictEqual(withdrawable, LAMPORTS_PER_SOL, "precondition: the vault holds the 1 SOL deposited above its floor");
        const ownerBefore = await lamports(saver.owner.publicKey);

        await program.methods
          .withdraw(new anchor.BN(withdrawable))
          .accounts({ owner: saver.owner.publicKey })
          .signers([saver.owner])
          .rpc();

        assert.strictEqual(await lamports(saver.vault), floor, "the vault keeps its rent floor and nothing else");
        assert.strictEqual((await lamports(saver.owner.publicKey)) - ownerBefore, withdrawable, "the owner received all of it");
      });

      it("unlink_wallet signed by the owner closes the link and refunds its rent to the owner", async () => {
        const saver = await freshSaver();
        const wallet = Keypair.generate();
        // Linked before the switch is pulled: a paused protocol refuses link_wallet.
        await linkWalletWithConsent(program, { owner: saver.owner.publicKey, wallet })
          .signers([saver.owner, wallet])
          .rpc();
        const link = linkOf(wallet.publicKey);
        await brake.engage(saver);

        assert.isTrue(
          (await program.account.tradingLink.fetch(link)).vault.equals(saver.vault),
          "precondition: the wallet is linked to this vault",
        );
        const linkInfo = await connection.getAccountInfo(link);
        const rent = linkInfo!.lamports;
        assert.strictEqual(
          rent,
          await connection.getMinimumBalanceForRentExemption(linkInfo!.data.length),
          "precondition: the link account holds exactly its rent",
        );
        const ownerBefore = await lamports(saver.owner.publicKey);

        await program.methods
          .unlinkWallet()
          .accountsPartial({
            authority: saver.owner.publicKey,
            owner: saver.owner.publicKey,
            vault: saver.vault,
            tradingLink: link,
          })
          .signers([saver.owner])
          .rpc();

        assert.isNull(await connection.getAccountInfo(link), "the link account is closed");
        assert.strictEqual(
          (await lamports(saver.owner.publicKey)) - ownerBefore,
          rent,
          "its rent went back to the owner, who paid it at link time",
        );
      });
    });
  }
});
