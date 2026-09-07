// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Shared validation and configuration for the isolated public-testnet synthetic drill.
/// @dev Nothing in this base is used by the local 31337 drill or production deployment.
abstract contract PublicTestnetDrillBase is Script {
    uint256 public constant PUBLIC_TESTNET_CHAIN_ID = 46_630;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant TOKEN_SCALE = 1e18;
    bytes32 public constant BROADCAST_CONFIRMATION_HASH = keccak256("46630_SYNTHETIC_ONLY");

    bytes32 public constant PLATFORM_A = keccak256("PUBLIC_TESTNET_SYNTHETIC_PLATFORM_A");
    bytes32 public constant PLATFORM_B = keccak256("PUBLIC_TESTNET_SYNTHETIC_PLATFORM_B");

    bytes32 internal constant CONFIG_ACKNOWLEDGEMENT = "ACKNOWLEDGEMENT";
    bytes32 internal constant CONFIG_BPS = "SAVINGS_BPS";
    bytes32 internal constant CONFIG_BROADCAST = "BROADCAST_CONFIRMATION";
    bytes32 internal constant CONFIG_DEADLINE = "DEADLINE";
    bytes32 internal constant CONFIG_DEPLOYER_BALANCE = "DEPLOYER_BALANCE";
    bytes32 internal constant CONFIG_FUNDING = "PARTICIPANT_FUNDING";
    bytes32 internal constant CONFIG_LIQUIDITY = "MARKET_LIQUIDITY";
    bytes32 internal constant CONFIG_PNL = "POSITIVE_PNL";
    bytes32 internal constant CONFIG_PRICE = "MARKET_PRICE";
    bytes32 internal constant CONFIG_RUN_ID = "RUN_ID";
    bytes32 internal constant CONFIG_SETTLEMENT = "SETTLEMENT";
    bytes32 internal constant CONFIG_TRADE = "TRADE_AMOUNT";

    error DuplicateParticipant(address participant);
    error InvalidConfiguration(bytes32 field);
    error InvalidParticipant(address participant);
    error InvalidWeth(address weth);
    error PublicTestnetOnly(uint256 chainId);
    error Uint128Overflow(bytes32 field, uint256 value);
    error Uint16Overflow(bytes32 field, uint256 value);
    error Uint48Overflow(bytes32 field, uint256 value);
    error UnexpectedWethCodeHash(bytes32 expected, bytes32 actual);
    error UnexpectedWethMetadata();

    struct Participants {
        uint256 adminKey;
        uint256 vaultAdminKey;
        uint256 traderAKey;
        uint256 traderBKey;
        uint256 attesterKey;
        address admin;
        address vaultAdmin;
        address traderA;
        address traderB;
        address attester;
    }

    struct DrillConfig {
        bytes32 runId;
        address weth;
        bytes32 expectedWethCodeHash;
        uint256 vaultAdminFundingWei;
        uint256 traderAFundingWei;
        uint256 traderBFundingWei;
        uint256 marketLiquidityWei;
        uint256 deployerGasBudgetWei;
        uint256 participantGasBudgetWei;
        uint256 tradeAmountAWei;
        uint256 tradeAmountBWei;
        uint256 initialPriceWeiPerToken;
        uint256 finalPriceWeiPerToken;
        uint16 traderAInitialSavingsBps;
        uint16 traderAUpdatedSavingsBps;
        uint16 traderBSavingsBps;
        uint128 minContributionWei;
        uint128 tradingFloorWei;
        uint128 gasReserveWei;
        uint48 inviteLifetimeSeconds;
        uint48 transactionDeadlineSeconds;
    }

    struct TradeEconomics {
        uint256 stockAmountA;
        uint256 stockAmountB;
        uint256 sellAmountA;
        uint256 sellAmountB;
        uint256 grossProfitA;
        uint256 grossProfitB;
    }

    function _requirePublicTestnet() internal view {
        if (block.chainid != PUBLIC_TESTNET_CHAIN_ID) {
            revert PublicTestnetOnly(block.chainid);
        }
    }

    function _requireAcknowledgement() internal view {
        if (!vm.envBool("PUBLIC_TESTNET_DRILL_ACKNOWLEDGE_SYNTHETIC")) {
            revert InvalidConfiguration(CONFIG_ACKNOWLEDGEMENT);
        }
    }

    function _requireBroadcastConfirmation() internal view {
        if (
            keccak256(bytes(vm.envString("PUBLIC_TESTNET_DRILL_BROADCAST_CONFIRMATION"))) != BROADCAST_CONFIRMATION_HASH
        ) {
            revert InvalidConfiguration(CONFIG_BROADCAST);
        }
    }

    function _loadParticipants() internal view returns (Participants memory participants) {
        participants.adminKey = vm.envUint("PUBLIC_TESTNET_DRILL_DEPLOYER_PRIVATE_KEY");
        participants.vaultAdminKey = vm.envUint("PUBLIC_TESTNET_DRILL_VAULT_ADMIN_PRIVATE_KEY");
        participants.traderAKey = vm.envUint("PUBLIC_TESTNET_DRILL_TRADER_A_PRIVATE_KEY");
        participants.traderBKey = vm.envUint("PUBLIC_TESTNET_DRILL_TRADER_B_PRIVATE_KEY");
        participants.attesterKey = vm.envUint("PUBLIC_TESTNET_DRILL_ATTESTER_PRIVATE_KEY");

        if (
            participants.adminKey == 0 || participants.vaultAdminKey == 0 || participants.traderAKey == 0
                || participants.traderBKey == 0 || participants.attesterKey == 0
        ) {
            revert InvalidParticipant(address(0));
        }

        participants.admin = vm.addr(participants.adminKey);
        participants.vaultAdmin = vm.addr(participants.vaultAdminKey);
        participants.traderA = vm.addr(participants.traderAKey);
        participants.traderB = vm.addr(participants.traderBKey);
        participants.attester = vm.addr(participants.attesterKey);
        _validateParticipants(participants);
    }

    function _validateParticipants(Participants memory participants) internal pure {
        address[5] memory accounts = [
            participants.admin,
            participants.vaultAdmin,
            participants.traderA,
            participants.traderB,
            participants.attester
        ];
        for (uint256 i = 0; i < accounts.length; ++i) {
            if (accounts[i] == address(0)) revert InvalidParticipant(accounts[i]);
            for (uint256 j = i + 1; j < accounts.length; ++j) {
                if (accounts[i] == accounts[j]) revert DuplicateParticipant(accounts[i]);
            }
        }
    }

    function _loadConfig() internal view returns (DrillConfig memory config) {
        config.runId = vm.envBytes32("PUBLIC_TESTNET_DRILL_RUN_ID");
        config.weth = vm.envAddress("PUBLIC_TESTNET_DRILL_WETH_ADDRESS");
        config.expectedWethCodeHash = vm.envBytes32("PUBLIC_TESTNET_DRILL_WETH_CODEHASH");
        config.vaultAdminFundingWei = vm.envUint("PUBLIC_TESTNET_DRILL_VAULT_ADMIN_FUNDING_WEI");
        config.traderAFundingWei = vm.envUint("PUBLIC_TESTNET_DRILL_TRADER_A_FUNDING_WEI");
        config.traderBFundingWei = vm.envUint("PUBLIC_TESTNET_DRILL_TRADER_B_FUNDING_WEI");
        config.marketLiquidityWei = vm.envUint("PUBLIC_TESTNET_DRILL_MARKET_LIQUIDITY_WEI");
        config.deployerGasBudgetWei = vm.envUint("PUBLIC_TESTNET_DRILL_DEPLOYER_GAS_BUDGET_WEI");
        config.participantGasBudgetWei = vm.envUint("PUBLIC_TESTNET_DRILL_PARTICIPANT_GAS_BUDGET_WEI");
        config.tradeAmountAWei = vm.envUint("PUBLIC_TESTNET_DRILL_TRADE_A_WEI");
        config.tradeAmountBWei = vm.envUint("PUBLIC_TESTNET_DRILL_TRADE_B_WEI");
        config.initialPriceWeiPerToken = vm.envUint("PUBLIC_TESTNET_DRILL_INITIAL_PRICE_WEI");
        config.finalPriceWeiPerToken = vm.envUint("PUBLIC_TESTNET_DRILL_FINAL_PRICE_WEI");
        config.traderAInitialSavingsBps =
            _asUint16("TRADER_A_INITIAL_BPS", vm.envUint("PUBLIC_TESTNET_DRILL_TRADER_A_INITIAL_BPS"));
        config.traderAUpdatedSavingsBps =
            _asUint16("TRADER_A_UPDATED_BPS", vm.envUint("PUBLIC_TESTNET_DRILL_TRADER_A_UPDATED_BPS"));
        config.traderBSavingsBps = _asUint16("TRADER_B_BPS", vm.envUint("PUBLIC_TESTNET_DRILL_TRADER_B_BPS"));
        config.minContributionWei =
            _asUint128("MIN_CONTRIBUTION", vm.envUint("PUBLIC_TESTNET_DRILL_MIN_CONTRIBUTION_WEI"));
        config.tradingFloorWei = _asUint128("TRADING_FLOOR", vm.envUint("PUBLIC_TESTNET_DRILL_TRADING_FLOOR_WEI"));
        config.gasReserveWei = _asUint128("GAS_RESERVE", vm.envUint("PUBLIC_TESTNET_DRILL_GAS_RESERVE_WEI"));
        config.inviteLifetimeSeconds =
            _asUint48("INVITE_LIFETIME", vm.envUint("PUBLIC_TESTNET_DRILL_INVITE_LIFETIME_SECONDS"));
        config.transactionDeadlineSeconds =
            _asUint48("TX_DEADLINE", vm.envUint("PUBLIC_TESTNET_DRILL_TX_DEADLINE_SECONDS"));
    }

    function _validateConfig(DrillConfig memory config, Participants memory participants) internal view {
        if (config.runId == bytes32(0)) revert InvalidConfiguration(CONFIG_RUN_ID);
        _validateWeth(config.weth, config.expectedWethCodeHash);

        if (config.initialPriceWeiPerToken == 0 || config.finalPriceWeiPerToken <= config.initialPriceWeiPerToken) {
            revert InvalidConfiguration(CONFIG_PRICE);
        }
        if (config.tradeAmountAWei == 0 || config.tradeAmountBWei == 0) {
            revert InvalidConfiguration(CONFIG_TRADE);
        }
        if (
            config.traderAInitialSavingsBps == 0 || config.traderAInitialSavingsBps > BPS_DENOMINATOR
                || config.traderAUpdatedSavingsBps == 0 || config.traderAUpdatedSavingsBps > BPS_DENOMINATOR
                || config.traderAUpdatedSavingsBps == config.traderAInitialSavingsBps || config.traderBSavingsBps == 0
                || config.traderBSavingsBps > BPS_DENOMINATOR
        ) revert InvalidConfiguration(CONFIG_BPS);
        if (
            config.minContributionWei == 0
                || config.tradingFloorWei + config.gasReserveWei < config.tradingFloorWei
        ) revert InvalidConfiguration(CONFIG_SETTLEMENT);
        if (
            config.inviteLifetimeSeconds == 0 || config.inviteLifetimeSeconds > 7 days
                || config.transactionDeadlineSeconds == 0 || config.transactionDeadlineSeconds > 15 minutes
        ) revert InvalidConfiguration(CONFIG_DEADLINE);

        TradeEconomics memory economics = _tradeEconomics(config);
        if (economics.grossProfitA == 0 || economics.grossProfitB == 0) {
            revert InvalidConfiguration(CONFIG_PNL);
        }
        if (config.marketLiquidityWei < economics.grossProfitA + economics.grossProfitB) {
            revert InvalidConfiguration(CONFIG_LIQUIDITY);
        }

        uint256 reserveAndGas =
            uint256(config.tradingFloorWei) + uint256(config.gasReserveWei) + config.participantGasBudgetWei;
        if (
            config.vaultAdminFundingWei < config.participantGasBudgetWei
                || config.traderAFundingWei < config.tradeAmountAWei + reserveAndGas
                || config.traderBFundingWei < config.tradeAmountBWei + reserveAndGas
        ) revert InvalidConfiguration(CONFIG_FUNDING);

        uint256 grossContributionA =
            Math.mulDiv(economics.grossProfitA, config.traderAUpdatedSavingsBps, BPS_DENOMINATOR);
        uint256 grossContributionB = Math.mulDiv(economics.grossProfitB, config.traderBSavingsBps, BPS_DENOMINATOR);
        if (grossContributionA < config.minContributionWei || grossContributionB < config.minContributionWei) {
            revert InvalidConfiguration(CONFIG_SETTLEMENT);
        }

        uint256 requiredDeployerBalance = _requiredDeployerBalance(config);
        if (participants.admin.balance < requiredDeployerBalance) {
            revert InvalidConfiguration(CONFIG_DEPLOYER_BALANCE);
        }

        _asUint128("MAX_PER_SETTLEMENT", _max(config.traderAFundingWei, config.traderBFundingWei));
        _asUint128("MAX_ROLLING", config.traderAFundingWei + config.traderBFundingWei);
    }

    function _validateWeth(address weth, bytes32 expectedCodeHash) internal view {
        if (weth == address(0) || weth.code.length == 0 || expectedCodeHash == bytes32(0)) {
            revert InvalidWeth(weth);
        }
        bytes32 actualCodeHash = weth.codehash;
        if (actualCodeHash != expectedCodeHash) {
            revert UnexpectedWethCodeHash(expectedCodeHash, actualCodeHash);
        }

        try IERC20Metadata(weth).name() returns (string memory name_) {
            if (keccak256(bytes(name_)) != keccak256("WETH")) revert UnexpectedWethMetadata();
        } catch {
            revert UnexpectedWethMetadata();
        }
        try IERC20Metadata(weth).symbol() returns (string memory symbol_) {
            if (keccak256(bytes(symbol_)) != keccak256("WETH")) revert UnexpectedWethMetadata();
        } catch {
            revert UnexpectedWethMetadata();
        }
        try IERC20Metadata(weth).decimals() returns (uint8 decimals_) {
            if (decimals_ != 18) revert UnexpectedWethMetadata();
        } catch {
            revert UnexpectedWethMetadata();
        }
    }

    function _tradeEconomics(DrillConfig memory config) internal pure returns (TradeEconomics memory economics) {
        economics.stockAmountA = Math.mulDiv(config.tradeAmountAWei, TOKEN_SCALE, config.initialPriceWeiPerToken);
        economics.stockAmountB = Math.mulDiv(config.tradeAmountBWei, TOKEN_SCALE, config.initialPriceWeiPerToken);
        economics.sellAmountA = Math.mulDiv(economics.stockAmountA, config.finalPriceWeiPerToken, TOKEN_SCALE);
        economics.sellAmountB = Math.mulDiv(economics.stockAmountB, config.finalPriceWeiPerToken, TOKEN_SCALE);
        if (
            economics.stockAmountA == 0 || economics.stockAmountB == 0
                || economics.sellAmountA <= config.tradeAmountAWei || economics.sellAmountB <= config.tradeAmountBWei
        ) revert InvalidConfiguration(CONFIG_PNL);
        economics.grossProfitA = economics.sellAmountA - config.tradeAmountAWei;
        economics.grossProfitB = economics.sellAmountB - config.tradeAmountBWei;
    }

    function _requiredDeployerBalance(DrillConfig memory config) internal pure returns (uint256) {
        return config.vaultAdminFundingWei + config.traderAFundingWei + config.traderBFundingWei
            + config.marketLiquidityWei + config.deployerGasBudgetWei;
    }

    function _maxPerSettlement(DrillConfig memory config) internal pure returns (uint128) {
        return _asUint128("MAX_PER_SETTLEMENT", _max(config.traderAFundingWei, config.traderBFundingWei));
    }

    function _maxRollingContribution(DrillConfig memory config) internal pure returns (uint128) {
        return _asUint128("MAX_ROLLING", config.traderAFundingWei + config.traderBFundingWei);
    }

    function _deploymentPath() internal view returns (string memory) {
        return string.concat(
            vm.projectRoot(), "/deployments/public-testnet-synthetic-drill-", vm.toString(block.chainid), ".json"
        );
    }

    function _resultsPath() internal view returns (string memory) {
        return string.concat(
            vm.projectRoot(),
            "/deployments/public-testnet-synthetic-drill-results-",
            vm.toString(block.chainid),
            ".json"
        );
    }

    function _asUint16(bytes32 field, uint256 value) internal pure returns (uint16) {
        if (value > type(uint16).max) revert Uint16Overflow(field, value);
        return uint16(value);
    }

    function _asUint48(bytes32 field, uint256 value) internal pure returns (uint48) {
        if (value > type(uint48).max) revert Uint48Overflow(field, value);
        return uint48(value);
    }

    function _asUint128(bytes32 field, uint256 value) internal pure returns (uint128) {
        if (value > type(uint128).max) revert Uint128Overflow(field, value);
        return uint128(value);
    }

    function _max(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a : b;
    }
}
