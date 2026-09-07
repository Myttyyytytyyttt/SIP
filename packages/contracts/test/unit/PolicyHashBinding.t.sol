// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// The preimage of `policyHash`, pinned.
//
// WHY THIS FILE EXISTS. `policyHash` is what every settlement attestation is
// signed against: the vault computes it, the attester signs over it, and
// `SettlementExecutor` re-derives it and refuses the settlement if it disagrees
// (SettlementExecutor.sol:334-337). Change the preimage and every attestation
// already signed becomes unspendable.
//
// AND NOTHING IN THE SUITE CAUGHT THAT. Every other test reads `policyHash` from
// the vault and compares it to itself — SettlementExecutor.t.sol:607,
// VaultReplayGuard.t.sol:173, PersonalVaultLifecycle.t.sol:443,
// SettlementProgressionL2.t.sol:226, VaultSettlement.invariant.t.sol:242 — and
// so does the keeper (packages/keeper-old/src/onchain.ts:443). A silent change to
// the field list, their order, or their types is therefore invisible to `forge
// test` and shows up only in production, as settlements that were fine an hour
// ago and now revert.
//
// The comment at PersonalVault.sol:536-542 asks a future reader not to "tidy"
// the last argument into `$.vaultPolicy`. That comment was, until this file, the
// only thing enforcing it. This is the test that makes it enforceable.
//
// HOW IT PINS. The preimage is rebuilt here from the vault's own public getters
// and hashed independently. Any change to the encoding in PersonalVault must be
// mirrored here or the test fails — and mirroring it is a deliberate edit that
// shows up in review, which is the entire point.

import {Test} from "forge-std/Test.sol";

import {VaultFactory} from "../../src/factory/VaultFactory.sol";
import {PersonalVault} from "../../src/vault/PersonalVault.sol";
import {NuvemTypes} from "../../src/types/NuvemTypes.sol";
import {ProtocolPauseController} from "../../src/governance/ProtocolPauseController.sol";
import {AttesterRegistry} from "../../src/registry/AttesterRegistry.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {VaultLens} from "../../src/periphery/VaultLens.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";

contract PolicyHashExecutorStub {}

contract PolicyHashBindingTest is Test {
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));
    VaultLens internal lens = new VaultLens();
    /// @dev abi.encode of the ten arguments: nine 32-byte words plus a
    ///      six-field TradingAccountPolicy at 32 bytes each.
    uint256 internal constant EXPECTED_PREIMAGE_BYTES = 9 * 32 + 6 * 32;

    address internal governance;
    address internal guardian;
    address internal attester;
    address internal vaultAdmin;
    address internal tradingWallet;
    uint256 internal tradingWalletKey;
    address internal settlementExecutor;

    MockWETH internal weth;
    ProtocolPauseController internal pauseController;
    AttesterRegistry internal attesterRegistry;
    VaultFactory internal factory;
    PersonalVault internal vault;
    uint32 internal cohortId;

    function setUp() external {
        governance = makeAddr("governance");
        guardian = makeAddr("guardian");
        attester = makeAddr("attester");
        vaultAdmin = makeAddr("vaultAdmin");
        (tradingWallet, tradingWalletKey) = makeAddrAndKey("tradingWallet");
        settlementExecutor = address(new PolicyHashExecutorStub());

        weth = new MockWETH();
        pauseController = new ProtocolPauseController(governance, guardian);
        attesterRegistry = new AttesterRegistry(governance, guardian, attester);

        PersonalVault implementation = new PersonalVault(address(adapterRegistry));
        factory = new VaultFactory(governance);

        vm.prank(governance);
        factory.configureProtocol(
            VaultFactory.ProtocolConfiguration({
                weth: address(weth),
                pauseController: address(pauseController),
                attesterRegistry: address(attesterRegistry),
                settlementExecutor: settlementExecutor
            })
        );

        vm.prank(governance);
        (cohortId,) = factory.registerCohort(address(implementation), address(this));

        NuvemTypes.VaultInitialization memory initialization = NuvemTypes.VaultInitialization({
            weth: address(weth),
            pauseController: address(pauseController),
            attesterRegistry: address(attesterRegistry),
            settlementExecutor: settlementExecutor,
            policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: type(uint128).max})
        });

        vm.prank(vaultAdmin);
        (, address vaultAddress) = factory.createVault(keccak256("policy-hash-fixture"), cohortId, abi.encode(initialization));
        vault = PersonalVault(payable(vaultAddress));

        uint48 deadline = uint48(block.timestamp + 1 days);
        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(tradingWallet, keccak256("gmgn"), _policy(2_000), deadline);

        // Activate, so the account's own epochs can be moved off their defaults.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(tradingWalletKey, vault.acceptTradingAccountDigest(tradingWallet));
        vault.acceptTradingAccountBySig(tradingWallet, deadline, abi.encodePacked(r, s, v));

        // MAKE THE FIXTURE DISCRIMINATE. Every uint64 in this preimage starts at
        // 0 or 1, so a reorder of two of them hashes identically and the suite
        // reports green against transposed code — which is exactly what happened
        // the first time this file was written, and why the assertion below
        // exists rather than a comment asking someone to be careful.
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(vaultAdmin);
            vault.setVaultPolicy(NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: uint128(1_000 ether + i)}));
        }
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(vaultAdmin);
            vault.setTradingAccountPolicy(tradingWallet, _policy(uint16(1_000 + i)));
        }
        // Each pause/unpause bumps bindingEpoch, pulling it off adminEpoch.
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(vaultAdmin);
            vault.pauseTradingAccount(tradingWallet);
            vm.prank(vaultAdmin);
            vault.unpauseTradingAccount(tradingWallet);
        }
    }

    function _policy(uint16 savingsBps) internal pure returns (NuvemTypes.TradingAccountPolicy memory) {
        return NuvemTypes.TradingAccountPolicy({
            savingsBps: savingsBps,
            minContributionWei: 1e12,
            maxPerSettlementWei: type(uint128).max,
            maxRolling30dWei: type(uint128).max,
            tradingFloorWei: 1e15,
            gasReserveWei: 5e14
        });
    }

    /**
     * A test whose fixture cannot tell two fields apart is not a test.
     *
     * The reorder assertion below can only detect a swap between fields whose
     * VALUES differ. Both epochs initialise to 1, so without this the suite would
     * report green against a preimage with two arguments transposed.
     */
    function testFixtureValuesAreDistinctEnoughToDetectAReorder() external view {
        NuvemTypes.TradingAccount memory a = vault.getTradingAccount(tradingWallet);
        uint256[4] memory scalars =
            [uint256(a.bindingEpoch), uint256(a.policyNonce), uint256(vault.vaultPolicyNonce()), uint256(vault.adminEpoch())];
        for (uint256 i = 0; i < scalars.length; i++) {
            for (uint256 j = i + 1; j < scalars.length; j++) {
                assertTrue(
                    scalars[i] != scalars[j],
                    "two preimage scalars share a value; a reorder between them would go undetected"
                );
            }
        }
    }

    /// @dev The preimage, rebuilt from the vault's own getters. Kept as a
    ///      separate function so the encoding under test is written out once, in
    ///      full, where a reviewer can read it against the source.
    function _preimage(address account) internal view returns (bytes memory) {
        NuvemTypes.TradingAccount memory tradingAccount = vault.getTradingAccount(account);
        return abi.encode(
            vault.vaultId(),
            address(vault),
            account,
            tradingAccount.bindingEpoch,
            tradingAccount.policyNonce,
            vault.vaultPolicyNonce(),
            vault.adminEpoch(),
            vault.settlementExecutor(),
            tradingAccount.policy,
            lens.getVaultPolicy(address(vault)).maxAggregateRolling30dWei
        );
    }

    /**
     * THE ONE THAT MATTERS. Reorder two fields, change a type, or encode the
     * VaultPolicy struct instead of its single member, and this fails.
     */
    function testPolicyHashPreimageIsExactlyTheseTenFieldsInThisOrder() external view {
        assertEq(vault.policyHash(tradingWallet), keccak256(_preimage(tradingWallet)));
    }

    /**
     * Catches an ADDED or REMOVED field, which reordering tests cannot: a new
     * argument still hashes consistently with an independently-updated test, so
     * the length is the thing that notices a field arrived at all.
     *
     * This is the guard that fires the day someone adds an investment field to
     * VaultPolicy and switches the last argument to encode the struct.
     */
    function testPolicyHashPreimageIsTheExpectedLength() external view {
        assertEq(_preimage(tradingWallet).length, EXPECTED_PREIMAGE_BYTES);
    }

    /**
     * The last argument is a DISCRETE uint128, not the VaultPolicy struct.
     *
     * Today the two encode identically, because VaultPolicy holds exactly one
     * field — which is precisely why the distinction is easy to erase by
     * accident and impossible to notice afterwards. Pinning it now means the
     * erasure fails here rather than in production.
     */
    function testPolicyHashEncodesTheAggregateCapAsAScalarNotAStruct() external view {
        NuvemTypes.TradingAccount memory tradingAccount = vault.getTradingAccount(tradingWallet);
        bytes memory asStruct = abi.encode(
            vault.vaultId(),
            address(vault),
            tradingWallet,
            tradingAccount.bindingEpoch,
            tradingAccount.policyNonce,
            vault.vaultPolicyNonce(),
            vault.adminEpoch(),
            vault.settlementExecutor(),
            tradingAccount.policy,
            lens.getVaultPolicy(address(vault))
        );
        // While VaultPolicy has one field these agree, and the assertion below
        // documents that they do. The moment a field is added they diverge, and
        // testPolicyHashPreimageIsTheExpectedLength is what fails.
        assertEq(keccak256(asStruct), vault.policyHash(tradingWallet));
        assertEq(asStruct.length, EXPECTED_PREIMAGE_BYTES);
    }

    /**
     * Two accounts of the same vault must not share a binding, or an attestation
     * signed for one would be spendable for the other.
     */
    function testPolicyHashDiffersPerAccount() external {
        address other = makeAddr("otherTradingWallet");
        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(other, keccak256("gmgn"), _policy(2_000), uint48(block.timestamp + 1 days));
        assertTrue(vault.policyHash(tradingWallet) != vault.policyHash(other));
    }
}
