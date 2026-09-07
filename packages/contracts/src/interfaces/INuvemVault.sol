// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NuvemTypes} from "../types/NuvemTypes.sol";

interface INuvemVault {
    function initialize(bytes32 vaultId, address vaultAdmin, address factory, uint32 cohortId, bytes calldata initData)
        external;

    function vaultId() external view returns (bytes32);
    function vaultAdmin() external view returns (address);
    function adminEpoch() external view returns (uint64);
    function localPauseEpoch() external view returns (uint64);
    function settlementPaused() external view returns (bool);
    function vaultPolicyNonce() external view returns (uint64);
    function settlementExecutor() external view returns (address);

    function getTradingAccount(address account) external view returns (NuvemTypes.TradingAccount memory);
    function getVaultPolicy() external view returns (NuvemTypes.VaultPolicy memory);
    function policyHash(address account) external view returns (bytes32);
    function accountRollingCapStatus(address account) external view returns (NuvemTypes.RollingCapStatus memory);
    function aggregateRollingCapStatus() external view returns (NuvemTypes.RollingCapStatus memory);

    function acceptSettlement(NuvemTypes.SettlementRecord calldata record) external payable;
}

