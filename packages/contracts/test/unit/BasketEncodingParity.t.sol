// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

import {NuvemTypes} from "../../src/types/NuvemTypes.sol";

/**
 * The basket hash, emitted so the keeper's TypeScript encoder can be pinned to it.
 *
 * WHY THIS EXISTS AS A TEST RATHER THAN A COMMENT. `PersonalVault` stores only
 * `keccak256(abi.encode(BasketLeg[]))` and `invest` refuses any legs that do not
 * reproduce it (PersonalVault.sol:659 — "the hash IS the compare-and-swap on the
 * basket"). The keeper has to rebuild those legs from an event and re-encode them
 * off chain, in viem, by hand.
 *
 * A MISMATCH BETWEEN THE TWO ENCODERS DOES NOT THROW. It produces a different
 * hash, so every basket the keeper recovers looks tampered with, every purchase
 * is refused, and the operator is told the vault admin's own configuration is
 * corrupt. That is an outage that reports the wrong cause — the worst shape of
 * bug this codebase has.
 *
 * So the vectors below are printed by Solidity and asserted in
 * packages/keeper-old/test/investment-plan.test.ts. If `NuvemTypes.BasketLeg` ever
 * gains, loses or reorders a field, the two sides disagree and that test fails
 * with a diff instead of the system failing in production with a lie.
 */
contract BasketEncodingParityTest is Test {
    /// @dev Deliberately awkward: a non-round rate, a two-leg split that is not
    ///      50/50, and addresses that do not sort in the order they are listed.
    function testPrintsVectorsForTheKeeperEncoder() external pure {
        NuvemTypes.BasketLeg[] memory one = new NuvemTypes.BasketLeg[](1);
        one[0] = NuvemTypes.BasketLeg({
            targetAsset: 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,
            weightBps: 10_000,
            minOutRateWad: 8_369_047_843_000_000_000
        });
        console2.log("VECTOR one-leg");
        console2.logBytes32(keccak256(abi.encode(one)));

        NuvemTypes.BasketLeg[] memory two = new NuvemTypes.BasketLeg[](2);
        two[0] = NuvemTypes.BasketLeg({
            targetAsset: 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,
            weightBps: 6_000,
            minOutRateWad: 8_369_047_843_000_000_000
        });
        two[1] = NuvemTypes.BasketLeg({
            targetAsset: 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C,
            weightBps: 4_000,
            minOutRateWad: 1
        });
        console2.log("VECTOR two-leg");
        console2.logBytes32(keccak256(abi.encode(two)));

        // Order matters: the same legs the other way round must NOT collide.
        NuvemTypes.BasketLeg[] memory swapped = new NuvemTypes.BasketLeg[](2);
        swapped[0] = two[1];
        swapped[1] = two[0];
        console2.log("VECTOR two-leg-swapped");
        console2.logBytes32(keccak256(abi.encode(swapped)));
        assertTrue(
            keccak256(abi.encode(two)) != keccak256(abi.encode(swapped)),
            "leg order must change the hash, or the keeper could reorder a basket"
        );

        // An empty basket has a hash too, and it is NOT zero — which matters
        // because the vault uses zero to mean "never configured".
        NuvemTypes.BasketLeg[] memory none = new NuvemTypes.BasketLeg[](0);
        console2.log("VECTOR empty");
        console2.logBytes32(keccak256(abi.encode(none)));
        assertTrue(keccak256(abi.encode(none)) != bytes32(0), "an empty basket must not hash to the unset sentinel");
    }
}
