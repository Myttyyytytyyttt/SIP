// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IAdapterRegistry {
    function getAdapter(bytes32 adapterId) external view returns (address);

    function isAdapterActive(bytes32 adapterId) external view returns (bool);

    function adapterStatusEpoch(bytes32 adapterId) external view returns (uint64);

    function adapterRuntimeCodeHash(bytes32 adapterId) external view returns (bytes32);

    function resolveActiveAdapter(bytes32 adapterId, uint64 expectedStatusEpoch) external view returns (address);
}
