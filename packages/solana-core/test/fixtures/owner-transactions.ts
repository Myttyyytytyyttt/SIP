// Byte fixtures for every owner transaction the web builds, with its compute budget.
//
// FIXED INPUTS, SO FIXED BYTES. The keys come from Keypair.fromSeed(sha256(label))
// and exist for these fixtures alone; the blockhash is the one route.test.ts
// uses; the consent signature is ed25519, which is deterministic. So every hex
// string below is what the builders must produce, byte for byte.
//
// WHAT TIES THEM TO THE PROGRAM. builders.test.ts compares the builders with
// these strings; the web's local proof compares the SIP instruction data that
// LANDED on a validator running the tested sip_vault.so with the
// OWNER_INSTRUCTION_DATA_HEX entries (the data carries no key, so the proof's
// own keys do not matter); and link-consent.test.ts pins the consent bytes to the
// program's golden vector.
//
// A DELIBERATE UPDATE: `pnpm --dir packages/solana-core exec tsx
// bin/print-owner-fixtures.mts` prints the current values. It writes no file.

import { createHash } from "node:crypto";
import { Keypair } from "@solana/web3.js";

import { SPYX_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from "../../src/client/addresses";
import { base58Encode } from "../../src/client/base58";
import { toHex } from "../../src/client/idl";
import { parseLegacyMessage, splitWire } from "../../src/client/message";
import { BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES, DEFAULT_INVEST_CAPS, DEFAULT_VAULT_POLICY, OFFERED_LEGS, basketWeightsBps, ownerComputeBudget } from "../../src/client/product";
import { defaultInvestPolicy } from "../../src/client/rules";
import {
  buildCreateVaultV2,
  buildLinkWallet,
  buildSetInvestPolicy,
  buildSetPolicyV2,
  buildUnlinkWallet,
  buildWithdraw,
  buildWithdrawToken,
  prepareLinkWalletConsent,
  type BuiltTransaction,
} from "../../src/server/builders";
import { deriveVaultPda } from "../../src/server/pda";
import { vaultTokenAccountTargets } from "../../src/server/readers";
import { fromB64, signBytes } from "../helpers";

export const FIXTURE_BLOCKHASH = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff));
export const FIXTURE_LAST_VALID_BLOCK_HEIGHT = 300_000_150;

const seeded = (label: string): Keypair => Keypair.fromSeed(Uint8Array.from(createHash("sha256").update(label).digest()));

/** Test keys only: their seeds are in this file. */
export const FIXTURE_OWNER = seeded("sip-fixture-owner");
export const FIXTURE_WALLET = seeded("sip-fixture-wallet");

/** The Ed25519SigVerify offsets header SIP writes for a 140-byte consent: one signature, sig@48, key@16, message@112 length 140, every index u16::MAX. */
export const ED25519_CONSENT_HEADER_HEX = "01003000ffff1000ffff70008c00ffff";

/** 90 % of the wSOL/USDC pool's rate and 95 % of the SPYx/USDC pool's, from sqrt_price_x64 at mainnet slot 447313239 (clmm-price.test.ts). */
export const GOLDEN_CONVERT_FLOOR_WAD = 90_034_840_399_943_305n;
export const GOLDEN_SPYX_FLOOR_WAD = 124_719_467_624_105_690n;

/**
 * The min_investment of the ONE-leg policy below, pinned to one leg and NOT read
 * from OFFERED_LEGS.length. The fixture's basket is a single SPYx leg, so its
 * amount is the one-leg amount, 5 USDC; sizing it from the catalogue would move
 * SET_INVEST_POLICY_GOLDEN_FLOORS — and builders.test.ts, verify-tx.test.ts and
 * lighthouse.test.ts with it — every time the product gains or loses a leg,
 * which is a change in the product, not in the builders these bytes pin.
 */
export const FIXTURE_ONE_LEG_MIN_INVESTMENT = defaultInvestPolicy(1).minInvestment;

/**
 * The vault token accounts the one-leg fixture policy pays for, in the order the
 * build route lists them: wSOL, USDC, SPYx. This is the fixture's own basket,
 * not the catalogue's, for the same reason FIXTURE_ONE_LEG_MIN_INVESTMENT is.
 */
export const FIRST_POLICY_VAULT_TOKEN_ACCOUNTS = [
  { mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM },
  { mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM },
  { mint: SPYX_MINT, tokenProgram: TOKEN_2022_PROGRAM },
] as const;

/**
 * THE SAME FIXTURE KEYS, THE WHOLE CATALOGUE: set_invest_policy for every leg
 * OFFERED_LEGS holds, with the creations the build route now bundles beside it
 * (BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES, the first of vaultTokenAccountTargets'
 * order — wSOL and USDC). It stands BESIDE the one-leg golden above and pins no
 * byte of it.
 *
 * IT CARRIES NO HEX, DELIBERATELY. Its wire moves whenever the product gains or
 * loses a leg, which is not the builders changing, so pinning it would be a
 * golden that has to be reprinted for a product decision — the same reason
 * FIXTURE_ONE_LEG_MIN_INVESTMENT exists. What it is for is the size ceiling:
 * lighthouse.test.ts pushes it through Phantom's real rewrite and measures it.
 *
 * Every leg's floor is the SPYx one. min_out_rate_wad is a u128, so the value
 * changes no byte of the length these bytes are measured for.
 */
export const FULL_CATALOGUE_VAULT = deriveVaultPda(FIXTURE_OWNER.publicKey).toBase58();

/** The accounts the build route bundles ahead of the full-catalogue policy, read from the route's own order. */
export const FULL_CATALOGUE_BUNDLED_TOKEN_ACCOUNTS = vaultTokenAccountTargets(FULL_CATALOGUE_VAULT).slice(0, BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES);

/** Every account that catalogue's policy needs, bundled or left to the keeper: what the build route lists. */
export const FULL_CATALOGUE_TOKEN_ACCOUNT_TARGETS = vaultTokenAccountTargets(FULL_CATALOGUE_VAULT);

/** The SIP instruction's data, per fixture. It names no key. */
export const OWNER_INSTRUCTION_DATA_HEX = {
  CREATE_VAULT_V2_PROFIT_DEFAULTS: "95e05a32579f1fdd00d007c800008793030000000080f0fa0200000000",
  SET_POLICY_V2_DEFAULTS: "07aad030ac9e49df00d007c80000008793030000000080f0fa0200000000",
  LINK_WALLET: "565c1f92e433d1e6",
  UNLINK_WALLET: "dc79610dc189d19f",
  WITHDRAW_150000000: "b712469c946da12280d1f00800000000",
  WITHDRAW_TOKEN_100000000: "88ebb505656d395100e1f50500000000",
  WITHDRAW_TOKEN_12345678: "88ebb505656d39514e61bc0000000000",
  SET_INVEST_POLICY_GOLDEN_FLOORS:
    "3dbdfb587f676d1c0100000007e8dc2cde7b23a0d743f8f1276b657d8a9eea06950ba67a8d3033c53c4cde4f1027da864fecb117bb010000000000000000a5d5ca9e04cf5db590b714ba2fe32cb159133fc1c192b72257fd07d39cb0401ec6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61899672d735de3f010000000000000000404b4c000000000000ca9a3b000000000076be370700000001",
} as const;

export type OwnerFixtureName = keyof typeof OWNER_INSTRUCTION_DATA_HEX;

/** The whole unsigned transaction, per fixture: [SetComputeUnitLimit, SetComputeUnitPrice, (Ed25519SigVerify,) SIP]. */
export const OWNER_WIRE_HEX: Readonly<Record<OwnerFixtureName, string>> = {
  CREATE_VAULT_V2_PROFIT_DEFAULTS:
    "010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000305bdeba39784612f3ffc1323f298dc2a39b9112fc26245090deb714da405bc5e8ef34d9c7a7304f246ef2170b1218fda3af0f179ea8925ea2a4ea5db9cf82243b300000000000000000000000000000000000000000000000000000000000000005558bf44ccaa64f99e79069f610b9e6576ec90f774d5383cb66782e4ff9a4bf70306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a4000000001080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da030400050260ea000004000903a08601000000000003030001021d95e05a32579f1fdd00d007c800008793030000000080f0fa0200000000",
  SET_POLICY_V2_DEFAULTS:
    "010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000204bdeba39784612f3ffc1323f298dc2a39b9112fc26245090deb714da405bc5e8ef34d9c7a7304f246ef2170b1218fda3af0f179ea8925ea2a4ea5db9cf82243b35558bf44ccaa64f99e79069f610b9e6576ec90f774d5383cb66782e4ff9a4bf70306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a4000000001080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da0303000502409c000003000903a086010000000000020200011e07aad030ac9e49df00d007c80000008793030000000080f0fa0200000000",
  LINK_WALLET:
    "0200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000201070abdeba39784612f3ffc1323f298dc2a39b9112fc26245090deb714da405bc5e8ef57617a962e919a6b7a297472b6e249d51d2026f76bffcf0dcad39e5f1926b0874f4bff24108d7ffa7fcbd380ee1a498a0458d879d66b353566a49312a3cdd4c000000000000000000000000000000000000000000000000000000000000000043606e799ee7a8d4c57e3b1da8e267469ae0a28bec5a075c9db5cd3d48a9cb995558bf44ccaa64f99e79069f610b9e6576ec90f774d5383cb66782e4ff9a4bf70306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a40000000037d46d67c93fbbe12f9428f838d40ff0570744927f48a64fcca704480000000f34d9c7a7304f246ef2170b1218fda3af0f179ea8925ea2a4ea5db9cf82243b306a7d517187bd16635dad40455fdc2c0c124c68f215675a5dbbacb5f0800000001080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da0406000502a086010006000903a0860100000000000700fc0101003000ffff1000ffff70008c00fffff57617a962e919a6b7a297472b6e249d51d2026f76bffcf0dcad39e5f1926b080847e97ca0dcdd4da0d1e71216f119ef95a031d38d79101660701e3ce241f38e5f74725040bc7f0fba6d5954feae548e3d6e857ed002ed3f010087261297a002ff5349505f4c494e4b5f56315558bf44ccaa64f99e79069f610b9e6576ec90f774d5383cb66782e4ff9a4bf7f57617a962e919a6b7a297472b6e249d51d2026f76bffcf0dcad39e5f1926b08f34d9c7a7304f246ef2170b1218fda3af0f179ea8925ea2a4ea5db9cf82243b3bdeba39784612f3ffc1323f298dc2a39b9112fc26245090deb714da405bc5e8e05070001080204090308565c1f92e433d1e6",
  UNLINK_WALLET:
    "010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000305bdeba39784612f3ffc1323f298dc2a39b9112fc26245090deb714da405bc5e8e74f4bff24108d7ffa7fcbd380ee1a498a0458d879d66b353566a49312a3cdd4c5558bf44ccaa64f99e79069f610b9e6576ec90f774d5383cb66782e4ff9a4bf70306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a40000000f34d9c7a7304f246ef2170b1218fda3af0f179ea8925ea2a4ea5db9cf82243b301080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da0303000502409c000003000903a08601000000000002040000040108dc79610dc189d19f",
  WITHDRAW_150000000:
    "010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000204bdeba39784612f3ffc1323f298dc2a39b9112fc26245090deb714da405bc5e8ef34d9c7a7304f246ef2170b1218fda3af0f179ea8925ea2a4ea5db9cf82243b35558bf44ccaa64f99e79069f610b9e6576ec90f774d5383cb66782e4ff9a4bf70306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a4000000001080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da0303000502409c000003000903a0860100000000000202000110b712469c946da12280d1f00800000000",
  WITHDRAW_TOKEN_100000000:
    "01000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100070abdeba39784612f3ffc1323f298dc2a39b9112fc26245090deb714da405bc5e8eb50400bc8cf580c89953f7c57a1397942b61cb09373a658745ccf83098a4f25605a8ba7453b5a9cd0e89d37ec138a70d7a4c0a75c5bc47b22a50d62a4535fbdd00000000000000000000000000000000000000000000000000000000000000005558bf44ccaa64f99e79069f610b9e6576ec90f774d5383cb66782e4ff9a4bf78c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f8590306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a40000000f34d9c7a7304f246ef2170b1218fda3af0f179ea8925ea2a4ea5db9cf82243b3069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f0000000000106ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a901080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da0306000502400d030006000903a086010000000000040800070802010905031088ebb505656d395100e1f50500000000",
  WITHDRAW_TOKEN_12345678:
    "01000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100070abdeba39784612f3ffc1323f298dc2a39b9112fc26245090deb714da405bc5e8e559174d1a87ebb8148dbd08043abe11f0d13296dd90ce7026c6ddb64e3d272d69cb0a18a65896db60d39b704e2544bd026eeb4fa3f1e53e383729521d8e5cf2700000000000000000000000000000000000000000000000000000000000000005558bf44ccaa64f99e79069f610b9e6576ec90f774d5383cb66782e4ff9a4bf78c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f8590306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a40000000f34d9c7a7304f246ef2170b1218fda3af0f179ea8925ea2a4ea5db9cf82243b306ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc07e8dc2cde7b23a0d743f8f1276b657d8a9eea06950ba67a8d3033c53c4cde4f01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da0306000502400d030006000903a086010000000000040800070901020805031088ebb505656d39514e61bc0000000000",
  SET_INVEST_POLICY_GOLDEN_FLOORS:
    "010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000a0fbdeba39784612f3ffc1323f298dc2a39b9112fc26245090deb714da405bc5e8e559174d1a87ebb8148dbd08043abe11f0d13296dd90ce7026c6ddb64e3d272d6782c55ebe6f903cacfb6e0872e6fc618f430d6dead63e72503af8407213f4d1e8697ea78a3166d8b1752e9825831e855612c3f71cd1a4d74ca73ea8ba3776d8005a8ba7453b5a9cd0e89d37ec138a70d7a4c0a75c5bc47b22a50d62a4535fbdd00000000000000000000000000000000000000000000000000000000000000005558bf44ccaa64f99e79069f610b9e6576ec90f774d5383cb66782e4ff9a4bf78c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f8590306466fe5211732ffecadba72c39be7bc8ce5bbc5f7126b2c439b3a40000000c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61f34d9c7a7304f246ef2170b1218fda3af0f179ea8925ea2a4ea5db9cf82243b3069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f0000000000106ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a906ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc07e8dc2cde7b23a0d743f8f1276b657d8a9eea06950ba67a8d3033c53c4cde4f01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da0608000502e093040008000903a086010000000000070600040a0b050c0101070600020a09050c0101070600010a0e050d01010604000a0305a7013dbdfb587f676d1c0100000007e8dc2cde7b23a0d743f8f1276b657d8a9eea06950ba67a8d3033c53c4cde4f1027da864fecb117bb010000000000000000a5d5ca9e04cf5db590b714ba2fe32cb159133fc1c192b72257fd07d39cb0401ec6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61899672d735de3f010000000000000000404b4c000000000000ca9a3b000000000076be370700000001",
};

export interface OwnerFixture {
  readonly built: BuiltTransaction;
  readonly wireHex: string;
  /** The last instruction's data: the SIP instruction. */
  readonly dataHex: string;
}

const recent = { blockhash: FIXTURE_BLOCKHASH, lastValidBlockHeight: FIXTURE_LAST_VALID_BLOCK_HEIGHT };

function fixture(built: BuiltTransaction): OwnerFixture {
  const wire = fromB64(built.txBase64);
  const instructions = parseLegacyMessage(splitWire(wire).message).instructions;
  return { built, wireHex: toHex(wire), dataHex: toHex(instructions[instructions.length - 1]!.data) };
}

/** The full-catalogue policy, built now by the builder under test, with the creations the build route bundles. */
export function buildFullCatalogueInvestPolicy(): ReturnType<typeof buildSetInvestPolicy> {
  const weights = basketWeightsBps(OFFERED_LEGS.length);
  return buildSetInvestPolicy({
    owner: FIXTURE_OWNER.publicKey.toBase58(),
    legs: OFFERED_LEGS.map((leg, index) => ({ mint: leg.mint, weightBps: weights[index]!, minOutRateWad: GOLDEN_SPYX_FLOOR_WAD })),
    minConvertRateWad: GOLDEN_CONVERT_FLOOR_WAD,
    minInvestment: defaultInvestPolicy(OFFERED_LEGS.length).minInvestment,
    maxPerCall: DEFAULT_INVEST_CAPS.maxPerCall,
    maxRolling30d: DEFAULT_INVEST_CAPS.maxRolling30d,
    enabled: true,
    ...recent,
    computeBudget: ownerComputeBudget("set_invest_policy"),
    vaultTokenAccounts: FULL_CATALOGUE_BUNDLED_TOKEN_ACCOUNTS.map(({ mint, tokenProgram }) => ({ mint, tokenProgram })),
  });
}

/** Every fixture, built now by the builders under test. */
export function buildOwnerFixtures(): Readonly<Record<OwnerFixtureName, OwnerFixture>> {
  const owner = FIXTURE_OWNER.publicKey.toBase58();
  const wallet = FIXTURE_WALLET.publicKey.toBase58();
  const consent = fromB64(prepareLinkWalletConsent({ owner, wallet }).consentMessageBase64);
  return {
    CREATE_VAULT_V2_PROFIT_DEFAULTS: fixture(buildCreateVaultV2({ owner, ...DEFAULT_VAULT_POLICY, ...recent, computeBudget: ownerComputeBudget("create_vault_v2") })),
    SET_POLICY_V2_DEFAULTS: fixture(buildSetPolicyV2({ owner, ...DEFAULT_VAULT_POLICY, paused: false, ...recent, computeBudget: ownerComputeBudget("set_policy_v2") })),
    LINK_WALLET: fixture(
      buildLinkWallet({ owner, wallet, consentSignature: signBytes(FIXTURE_WALLET, consent), ...recent, computeBudget: ownerComputeBudget("link_wallet") }),
    ),
    UNLINK_WALLET: fixture(buildUnlinkWallet({ owner, wallet, ...recent, computeBudget: ownerComputeBudget("unlink_wallet") })),
    WITHDRAW_150000000: fixture(buildWithdraw({ owner, lamports: 150_000_000n, ...recent, computeBudget: ownerComputeBudget("withdraw") })),
    WITHDRAW_TOKEN_100000000: fixture(
      buildWithdrawToken({ owner, mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM, amountRaw: 100_000_000n, ...recent, computeBudget: ownerComputeBudget("withdraw_token") }),
    ),
    WITHDRAW_TOKEN_12345678: fixture(
      buildWithdrawToken({ owner, mint: SPYX_MINT, tokenProgram: TOKEN_2022_PROGRAM, amountRaw: 12_345_678n, ...recent, computeBudget: ownerComputeBudget("withdraw_token") }),
    ),
    SET_INVEST_POLICY_GOLDEN_FLOORS: fixture(
      buildSetInvestPolicy({
        owner,
        legs: [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: GOLDEN_SPYX_FLOOR_WAD }],
        minConvertRateWad: GOLDEN_CONVERT_FLOOR_WAD,
        minInvestment: FIXTURE_ONE_LEG_MIN_INVESTMENT,
        maxPerCall: DEFAULT_INVEST_CAPS.maxPerCall,
        maxRolling30d: DEFAULT_INVEST_CAPS.maxRolling30d,
        enabled: true,
        ...recent,
        computeBudget: ownerComputeBudget("set_invest_policy"),
        vaultTokenAccounts: FIRST_POLICY_VAULT_TOKEN_ACCOUNTS,
      }),
    ),
  };
}
