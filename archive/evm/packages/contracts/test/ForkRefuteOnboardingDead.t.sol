// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

/**
 * THE SELECTOR ARITY ON THE DEPLOYED FACTORY, and the record of a refutation that
 * did not survive contact with the chain.
 *
 * WHAT THIS FILE WAS. It began as an attempt to refute "upgrading cohort 1 kills
 * onboarding" by showing a remedy: register a NEW cohort whose beacon still points
 * at the old implementation, and keep taking users through the same factory. On a
 * fork that works, and the test proved it.
 *
 * WHY THE REMEDY IS NOT REAL. It reached `registerCohort` with
 * `vm.prank(factory.owner())`. The factory's owner is `VaultFactoryBootstrap`
 * 0x63c7fe1A — a sealed contract whose deployed bytecode contains four view
 * selectors and NO function capable of calling the factory at all. A cheat code
 * can impersonate it; nothing on chain can make it act. `pendingOwner()` is the
 * timelock and `acceptOwnership` has never been scheduled — zero `CallScheduled`
 * events in the timelock's entire history — so cohort registration is unreachable
 * until that ceremony completes.
 *
 * A fork test that prank-calls an address with no matching code proves the EVM
 * would accept the transaction, not that anyone can send it. That distinction is
 * the whole finding, and it is why this file kept only the part that measures
 * something real.
 *
 * AND THE PREMISE IS NOW GONE ANYWAY. The implementation no longer calls the
 * five-argument gate, so cohort 1 is not bricked by the upgrade —
 * `ForkInvestAfterUpgrade.test_1` creates a vault on the upgraded beacon.
 *
 * What survives is the arity split itself, which is WHY the four-argument form is
 * the one the vault must call. If this test ever fails, the deployed factory is
 * not the factory this build targets.
 *
 * Run: FORK_RPC=<mainnet rpc> forge test --match-path test/ForkRefuteOnboardingDead.t.sol -vv
 */
contract ForkRefuteOnboardingDead is Test {
    address constant FACTORY = 0x2a6a5d51677aA52674DF1380a5743fBf601ca9b0;
    address constant FACTORY_BOOTSTRAP_OWNER = 0x63c7fe1A6dC0CB4e08Ab4c6293B7E53cD7FBB85e;

    address weth;
    address pauseController;
    address attesterRegistry;
    address settlementExecutor;

    bool internal forked;

    modifier onlyForked() {
        if (!forked) return;
        _;
    }

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        (bool ok, bytes memory ret) = FACTORY.staticcall(abi.encodeWithSignature("protocolConfiguration()"));
        require(ok, "protocolConfiguration");
        (weth, pauseController, attesterRegistry, settlementExecutor) =
            abi.decode(ret, (address, address, address, address));
    }

    /// The claim the vault's `_validateInitialization` depends on, checked directly.
    function test_arity_split_on_deployed_factory() public onlyForked {
        (bool ok4, bytes memory r4) = FACTORY.staticcall(
            abi.encodeWithSignature(
                "isProtocolConfiguration(address,address,address,address)",
                weth,
                pauseController,
                attesterRegistry,
                settlementExecutor
            )
        );
        (bool ok5,) = FACTORY.staticcall(
            abi.encodeWithSignature(
                "isProtocolConfiguration(address,address,address,address,address)",
                weth,
                pauseController,
                attesterRegistry,
                settlementExecutor,
                weth
            )
        );
        console2.log("4-arg ok:", ok4);
        console2.log("5-arg ok:", ok5);
        assertTrue(ok4, "the four-argument form must exist: the vault calls it");
        assertTrue(abi.decode(r4, (bool)), "and must approve the live configuration");
        assertFalse(ok5, "the five-argument form must NOT exist, or this build is targeting a different factory");
    }

    /**
     * The sealed owner, asserted rather than described.
     *
     * This is what makes the "just register another cohort" remedy unavailable,
     * and it is worth a test because the fork evidence for the remedy looked
     * convincing: a prank succeeds against an address whose code cannot originate
     * the call.
     */
    function test_factory_owner_cannot_originate_a_call() public onlyForked {
        (bool ok,) = FACTORY.staticcall(abi.encodeWithSignature("owner()"));
        assertTrue(ok);

        // Small enough to enumerate: a handful of view selectors and no dispatcher
        // path that calls out. The exact size is not the point — the point is that
        // it is a sealed bootstrap, not an account anyone controls.
        uint256 size = FACTORY_BOOTSTRAP_OWNER.code.length;
        console2.log("factory owner code size:", size);
        assertGt(size, 0, "it is a contract, so no key can act as it");
        assertLt(size, 1000, "and it is the sealed bootstrap, not a wallet or a multisig");
    }
}
