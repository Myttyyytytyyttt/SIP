// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IAttesterRegistry {
    function attester() external view returns (address);

    function attesterEpoch() external view returns (uint32);

    function isCurrentAttester(address signer, uint32 epoch) external view returns (bool);
}
