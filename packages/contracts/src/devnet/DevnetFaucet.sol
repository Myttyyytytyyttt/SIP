// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Local-devnet faucet used to fund deterministic trading accounts.
/// @dev This contract is deliberately excluded from production deployment scripts.
contract DevnetFaucet is Ownable, ReentrancyGuard {
    error AlreadyClaimed(address account);
    error FaucetEmpty(uint256 requested, uint256 available);
    error InvalidClaimAmount(uint256 claimAmount);
    error InvalidRecipient(address recipient);

    event FaucetFunded(address indexed sender, uint256 amount);
    event FaucetClaimed(address indexed recipient, uint256 amount);

    uint256 public immutable claimAmount;
    mapping(address account => bool claimed) public hasClaimed;

    constructor(address initialOwner, uint256 claimAmount_) payable Ownable(initialOwner) {
        if (claimAmount_ == 0) revert InvalidClaimAmount(0);
        claimAmount = claimAmount_;
        if (msg.value != 0) emit FaucetFunded(msg.sender, msg.value);
    }

    receive() external payable {
        emit FaucetFunded(msg.sender, msg.value);
    }

    function claim() external nonReentrant {
        _claim(msg.sender);
    }

    /// @notice Owner-funded alternative for accounts that do not yet have gas.
    function drip(address recipient) external onlyOwner nonReentrant {
        _claim(recipient);
    }

    function _claim(address recipient) private {
        if (recipient == address(0)) revert InvalidRecipient(address(0));
        if (hasClaimed[recipient]) revert AlreadyClaimed(recipient);

        uint256 available = address(this).balance;
        if (available < claimAmount) revert FaucetEmpty(claimAmount, available);

        hasClaimed[recipient] = true;
        Address.sendValue(payable(recipient), claimAmount);
        emit FaucetClaimed(recipient, claimAmount);
    }
}
