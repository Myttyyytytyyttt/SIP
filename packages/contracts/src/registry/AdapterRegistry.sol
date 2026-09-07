// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GuardianOwnable} from "../governance/GuardianOwnable.sol";
import {IAdapterRegistry} from "../interfaces/IAdapterRegistry.sol";

/// @notice Append-only registry of versioned investment adapters.
/// @dev An adapter address can never be replaced for an existing ID. The
///      guardian may only deactivate; governance alone may register/reactivate.
contract AdapterRegistry is GuardianOwnable, IAdapterRegistry {
    struct AdapterRecord {
        address adapter;
        bytes32 runtimeCodeHash;
        bool active;
        uint64 statusEpoch;
    }

    error InvalidAdapterId(bytes32 adapterId);
    error InvalidAdapter(address adapter);
    error AdapterAlreadyRegistered(bytes32 adapterId);
    error AdapterNotRegistered(bytes32 adapterId);
    error AdapterAlreadyActive(bytes32 adapterId);
    error AdapterAlreadyInactive(bytes32 adapterId);
    error AdapterInactive(bytes32 adapterId);
    error InvalidAdapterStatusEpoch(bytes32 adapterId, uint64 expectedEpoch, uint64 actualEpoch);
    error AdapterCodeChanged(bytes32 adapterId, bytes32 expectedCodeHash, bytes32 actualCodeHash);
    error AdapterIndexOutOfBounds(uint256 index, uint256 count);

    event AdapterRegistered(
        bytes32 indexed adapterId, address indexed adapter, bytes32 indexed runtimeCodeHash, uint64 statusEpoch
    );
    event AdapterDeactivated(
        bytes32 indexed adapterId, address indexed adapter, uint64 indexed statusEpoch, address caller
    );
    event AdapterReactivated(bytes32 indexed adapterId, address indexed adapter, uint64 indexed statusEpoch);

    mapping(bytes32 adapterId => AdapterRecord record) private _adapters;
    bytes32[] private _adapterIds;

    constructor(address initialOwner, address initialGuardian) GuardianOwnable(initialOwner, initialGuardian) {}

    function registerAdapter(bytes32 adapterId, address adapter) external onlyOwner {
        if (adapterId == bytes32(0)) revert InvalidAdapterId(adapterId);
        if (adapter == address(0) || adapter.code.length == 0) revert InvalidAdapter(adapter);
        if (_adapters[adapterId].adapter != address(0)) revert AdapterAlreadyRegistered(adapterId);

        bytes32 runtimeCodeHash = adapter.codehash;
        _adapters[adapterId] =
            AdapterRecord({adapter: adapter, runtimeCodeHash: runtimeCodeHash, active: true, statusEpoch: 1});
        _adapterIds.push(adapterId);

        emit AdapterRegistered(adapterId, adapter, runtimeCodeHash, 1);
    }

    function deactivateAdapter(bytes32 adapterId) external onlyOwnerOrGuardian {
        AdapterRecord storage record = _registeredAdapter(adapterId);
        if (!record.active) revert AdapterAlreadyInactive(adapterId);

        uint64 newEpoch = record.statusEpoch + 1;
        record.active = false;
        record.statusEpoch = newEpoch;

        emit AdapterDeactivated(adapterId, record.adapter, newEpoch, msg.sender);
    }

    function reactivateAdapter(bytes32 adapterId) external onlyOwner {
        AdapterRecord storage record = _registeredAdapter(adapterId);
        if (record.active) revert AdapterAlreadyActive(adapterId);
        _requireUnchangedCode(adapterId, record);

        uint64 newEpoch = record.statusEpoch + 1;
        record.active = true;
        record.statusEpoch = newEpoch;

        emit AdapterReactivated(adapterId, record.adapter, newEpoch);
    }

    function getAdapter(bytes32 adapterId) external view override returns (address) {
        return _adapters[adapterId].adapter;
    }

    function isAdapterActive(bytes32 adapterId) external view override returns (bool) {
        AdapterRecord storage record = _adapters[adapterId];
        return record.adapter != address(0) && record.active && record.adapter.codehash == record.runtimeCodeHash;
    }

    function adapterStatusEpoch(bytes32 adapterId) external view override returns (uint64) {
        return _adapters[adapterId].statusEpoch;
    }

    function adapterRuntimeCodeHash(bytes32 adapterId) external view override returns (bytes32) {
        return _adapters[adapterId].runtimeCodeHash;
    }

    function resolveActiveAdapter(bytes32 adapterId, uint64 expectedStatusEpoch)
        external
        view
        override
        returns (address adapter)
    {
        AdapterRecord storage record = _registeredAdapter(adapterId);
        if (!record.active) revert AdapterInactive(adapterId);
        if (record.statusEpoch != expectedStatusEpoch) {
            revert InvalidAdapterStatusEpoch(adapterId, expectedStatusEpoch, record.statusEpoch);
        }
        _requireUnchangedCode(adapterId, record);
        return record.adapter;
    }

    function adapterCount() external view returns (uint256) {
        return _adapterIds.length;
    }

    function adapterIdAt(uint256 index) external view returns (bytes32) {
        uint256 count = _adapterIds.length;
        if (index >= count) revert AdapterIndexOutOfBounds(index, count);
        return _adapterIds[index];
    }

    function _registeredAdapter(bytes32 adapterId) private view returns (AdapterRecord storage record) {
        record = _adapters[adapterId];
        if (record.adapter == address(0)) revert AdapterNotRegistered(adapterId);
    }

    function _requireUnchangedCode(bytes32 adapterId, AdapterRecord storage record) private view {
        bytes32 actualCodeHash = record.adapter.codehash;
        if (actualCodeHash != record.runtimeCodeHash) {
            revert AdapterCodeChanged(adapterId, record.runtimeCodeHash, actualCodeHash);
        }
    }
}
