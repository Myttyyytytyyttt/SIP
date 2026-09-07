// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IFeeCollector {
    function treasury() external view returns (address);

    function withdrawERC20(address token, uint256 amount) external;

    function withdrawAllERC20(address token) external returns (uint256 amount);
}
