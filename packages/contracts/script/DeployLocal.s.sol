// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {IOwnable2Step, NuvemDeploymentBase} from "./DeployNuvem.s.sol";
import {VaultFactory} from "../src/factory/VaultFactory.sol";
import {NuvemTypes} from "../src/types/NuvemTypes.sol";
import {MockTargetToken} from "../src/mocks/MockTargetToken.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";
import {AdapterRegistry} from "../src/registry/AdapterRegistry.sol";

/// @dev Local-only stand-in for an external Safe. It is intentionally
///      permissionless and must never be used outside this Anvil script.
contract LocalCallExecutor {
    function getThreshold() external pure returns (uint256) {
        return 3;
    }

    function getOwners() external pure returns (address[] memory owners) {
        owners = new address[](5);
        owners[0] = address(0x1001);
        owners[1] = address(0x1002);
        owners[2] = address(0x1003);
        owners[3] = address(0x1004);
        owners[4] = address(0x1005);
    }

    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        bool success;
        (success, result) = target.call(data);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
    }
}

/// @notice Fully reproducible, no-broadcast local deployment.
/// @dev This script advances local time by seven days to execute governance
///      bootstrap actions. It intentionally refuses to run on non-Anvil chains.
contract DeployLocal is NuvemDeploymentBase {
    error LocalChainOnly(uint256 chainId);

    struct LocalDeployment {
        Deployment core;
        MockWETH weth;
        MockTargetToken secondaryToken;
        LocalCallExecutor corporateMultisig;
        LocalCallExecutor sampleVaultAdmin;
        address sampleVault;
        bytes32 sampleVaultId;
    }

    function run() external returns (LocalDeployment memory local) {
        if (block.chainid != LOCAL_CHAIN_ID) revert LocalChainOnly(block.chainid);

        local.weth = new MockWETH();
        // A second ERC-20 with no protocol role, so local runs can exercise
        // `withdrawToken` against something that is not WETH.
        local.secondaryToken = new MockTargetToken("Mock Secondary", "mSEC");
        local.corporateMultisig = new LocalCallExecutor();
        local.sampleVaultAdmin = new LocalCallExecutor();

        address guardian = vm.addr(uint256(keccak256("NUVEM_LOCAL_GUARDIAN")));
        address treasury = vm.addr(uint256(keccak256("NUVEM_LOCAL_TREASURY")));
        address attester = vm.addr(uint256(keccak256("NUVEM_LOCAL_ATTESTER")));

        DeploymentConfig memory config = DeploymentConfig({
            corporateMultisig: address(local.corporateMultisig),
            guardian: guardian,
            treasury: treasury,
            attester: attester,
            weth: address(local.weth),
            initialFeeBps: 100,
            canaryApproved: false,
            governanceDelay: GOVERNANCE_DELAY,
            disposableTestDeployment: false
        });
        local.core = _deployCore(config);

        _finalizeLocalGovernance(local.core, local.corporateMultisig);
        (local.sampleVaultId, local.sampleVault) = _createSampleVault(local.core, local.sampleVaultAdmin);

        _logDeployment(local.core);
        console2.log("Local secondary token", address(local.secondaryToken));
        console2.log("Local sample vault", local.sampleVault);
        console2.log("Local sample vault ID");
        console2.logBytes32(local.sampleVaultId);
    }

    /// @dev Kept as a `scheduleBatch` of one rather than a plain `schedule` so the
    ///      salt derivation and the operation shape asserted by DeploymentScripts
    ///      stay stable now that adapter registration is gone.
    function _finalizeLocalGovernance(Deployment memory deployment, LocalCallExecutor corporateMultisig) private {
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory payloads = new bytes[](1);

        targets[0] = address(deployment.factory);
        payloads[0] = abi.encodeCall(IOwnable2Step.acceptOwnership, ());

        bytes32 predecessor;
        bytes32 salt = keccak256(abi.encode("NUVEM_LOCAL_GOVERNANCE_BOOTSTRAP_V1", address(deployment.factory)));
        corporateMultisig.execute(
            address(deployment.timelock),
            abi.encodeCall(
                TimelockController.scheduleBatch, (targets, values, payloads, predecessor, salt, GOVERNANCE_DELAY)
            )
        );
        vm.warp(block.timestamp + GOVERNANCE_DELAY);
        deployment.timelock.executeBatch(targets, values, payloads, predecessor, salt);
    }

    function _createSampleVault(Deployment memory deployment, LocalCallExecutor sampleVaultAdmin)
        private
        returns (bytes32 vaultId, address vault)
    {
        NuvemTypes.VaultPolicy memory policy = NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: 10 ether});
        NuvemTypes.VaultInitialization memory initialization = NuvemTypes.VaultInitialization({
            weth: deployment.weth,
            pauseController: address(deployment.pauseController),
            attesterRegistry: address(deployment.attesterRegistry),
            settlementExecutor: address(deployment.settlementExecutor),
            policy: policy
        });

        bytes memory result = sampleVaultAdmin.execute(
            address(deployment.factory),
            abi.encodeCall(
                VaultFactory.createVault,
                (keccak256("NUVEM_LOCAL_SAMPLE_VAULT"), deployment.cohortId, abi.encode(initialization))
            )
        );
        return abi.decode(result, (bytes32, address));
    }
}
