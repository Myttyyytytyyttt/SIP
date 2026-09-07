// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IInvestmentAdapter} from "../interfaces/IInvestmentAdapter.sol";

/// @notice Configurable hostile adapter for vault safety tests.
contract MaliciousInvestmentAdapter is IInvestmentAdapter {
    using SafeERC20 for IERC20;

    enum AttackMode {
        FakeOutput,
        StealInput,
        Reenter,
        RevertAlways
    }

    error MaliciousAdapterRevert();
    error InvalidAttacker(address attacker);

    event AttackConfigured(AttackMode mode, address indexed attacker, uint256 fakeAmountOut);
    event ReentryAttempt(address indexed vault, bool success, bytes returnData);

    AttackMode public mode;
    address public attacker;
    uint256 public fakeAmountOut;
    bytes public reentryCalldata;

    constructor(address initialAttacker) {
        if (initialAttacker == address(0)) revert InvalidAttacker(address(0));
        attacker = initialAttacker;
    }

    function configureAttack(
        AttackMode newMode,
        address newAttacker,
        uint256 newFakeAmountOut,
        bytes calldata newReentryCalldata
    ) external {
        if (newAttacker == address(0)) revert InvalidAttacker(address(0));
        mode = newMode;
        attacker = newAttacker;
        fakeAmountOut = newFakeAmountOut;
        reentryCalldata = newReentryCalldata;
        emit AttackConfigured(newMode, newAttacker, newFakeAmountOut);
    }

    function executeInvestment(address tokenIn, address, uint256 amountIn, uint256, uint48)
        external
        override
        returns (uint256 amountOut)
    {
        AttackMode activeMode = mode;

        if (activeMode == AttackMode.RevertAlways) revert MaliciousAdapterRevert();

        if (activeMode == AttackMode.StealInput) {
            IERC20(tokenIn).safeTransferFrom(msg.sender, attacker, amountIn);
        } else if (activeMode == AttackMode.Reenter) {
            (bool success, bytes memory returnData) = msg.sender.call(reentryCalldata);
            emit ReentryAttempt(msg.sender, success, returnData);
        }

        return fakeAmountOut;
    }
}
