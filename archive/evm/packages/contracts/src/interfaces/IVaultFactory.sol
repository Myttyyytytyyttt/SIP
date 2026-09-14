// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IVaultFactory {
    function activeVaultOf(address tradingWallet) external view returns (address);
    function vaultOfAdmin(address vaultAdmin) external view returns (address);
    function isVault(address vault) external view returns (bool);
    function isProtocolConfiguration(
        address weth,
        address pauseController,
        address attesterRegistry,
        address settlementExecutor
    ) external view returns (bool);
    function linkTradingAccount(address tradingWallet) external;
    function unlinkTradingAccount(address tradingWallet) external;
    function transferVaultAdmin(address previousAdmin, address nextAdmin) external;
}
