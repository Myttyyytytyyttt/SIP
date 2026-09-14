// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Synthetic stock used only by explicitly labelled Nuvem drills.
/// @dev Authorized local/public-testnet drill markets and adapters may mint and burn
///      for deterministic fills. This is not a share or Robinhood Stock Token.
contract DevnetSyntheticStock is ERC20, Ownable {
    error MinterStatusUnchanged(address account, bool enabled);
    error UnauthorizedMinter(address account);
    error ZeroMinter();

    event MinterUpdated(address indexed account, bool enabled);

    mapping(address account => bool enabled) public isMinter;

    constructor(address initialOwner, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        Ownable(initialOwner)
    {}

    modifier onlyMinter() {
        if (!isMinter[msg.sender]) revert UnauthorizedMinter(msg.sender);
        _;
    }

    function setMinter(address account, bool enabled) external onlyOwner {
        if (account == address(0)) revert ZeroMinter();
        if (isMinter[account] == enabled) revert MinterStatusUnchanged(account, enabled);
        isMinter[account] = enabled;
        emit MinterUpdated(account, enabled);
    }

    function mint(address recipient, uint256 amount) external onlyMinter {
        _mint(recipient, amount);
    }

    function burn(address account, uint256 amount) external onlyMinter {
        _burn(account, amount);
    }
}
