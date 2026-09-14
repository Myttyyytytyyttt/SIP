// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {PublicTestnetDrillBase} from "../../../script/PublicTestnetDrillBase.s.sol";
import {DevnetSyntheticStock} from "../../../src/devnet/DevnetSyntheticStock.sol";
import {PublicTestnetFixedRateAdapter} from "../../../src/devnet/PublicTestnetFixedRateAdapter.sol";
import {MockWETH} from "../../../src/mocks/MockWETH.sol";

contract PublicTestnetWethShape is ERC20 {
    constructor() ERC20("WETH", "WETH") {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        Address.sendValue(payable(msg.sender), amount);
    }
}

contract PublicTestnetDrillHarness is PublicTestnetDrillBase {
    function requirePublicTestnet() external view {
        _requirePublicTestnet();
    }

    function requireAcknowledgement() external view {
        _requireAcknowledgement();
    }

    function requireBroadcastConfirmation() external view {
        _requireBroadcastConfirmation();
    }

    function validateConfig(DrillConfig calldata config, Participants calldata participants) external view {
        _validateConfig(config, participants);
    }

    function validateParticipants(Participants calldata participants) external pure {
        _validateParticipants(participants);
    }

    function validateWeth(address weth, bytes32 expectedCodeHash) external view {
        _validateWeth(weth, expectedCodeHash);
    }

    function tradeEconomics(DrillConfig calldata config) external pure returns (TradeEconomics memory) {
        return _tradeEconomics(config);
    }
}

contract PublicTestnetDrillScriptsTest is Test {
    PublicTestnetDrillHarness private harness;
    PublicTestnetWethShape private weth;
    PublicTestnetDrillBase.Participants private participants;

    function setUp() external {
        vm.chainId(46_630);
        vm.setEnv("PUBLIC_TESTNET_DRILL_ACKNOWLEDGE_SYNTHETIC", "false");
        vm.setEnv("PUBLIC_TESTNET_DRILL_BROADCAST_CONFIRMATION", "");
        harness = new PublicTestnetDrillHarness();
        weth = new PublicTestnetWethShape();
        participants.admin = makeAddr("publicTestnetAdmin");
        participants.vaultAdmin = makeAddr("publicTestnetVaultAdmin");
        participants.traderA = makeAddr("publicTestnetTraderA");
        participants.traderB = makeAddr("publicTestnetTraderB");
        participants.attester = makeAddr("publicTestnetAttester");
        vm.deal(participants.admin, 1 ether);
    }

    function testGuardAcceptsOnlyRobinhoodPublicTestnetChainId() external {
        harness.requirePublicTestnet();

        vm.chainId(31_337);
        vm.expectRevert(abi.encodeWithSelector(PublicTestnetDrillBase.PublicTestnetOnly.selector, 31_337));
        harness.requirePublicTestnet();
    }

    function testRequiresExplicitSyntheticAcknowledgement() external {
        vm.expectRevert(
            abi.encodeWithSelector(PublicTestnetDrillBase.InvalidConfiguration.selector, bytes32("ACKNOWLEDGEMENT"))
        );
        harness.requireAcknowledgement();

        vm.setEnv("PUBLIC_TESTNET_DRILL_ACKNOWLEDGE_SYNTHETIC", "true");
        harness.requireAcknowledgement();
    }

    function testRequiresExactIndependentBroadcastConfirmation() external {
        vm.expectRevert(
            abi.encodeWithSelector(
                PublicTestnetDrillBase.InvalidConfiguration.selector, bytes32("BROADCAST_CONFIRMATION")
            )
        );
        harness.requireBroadcastConfirmation();

        vm.setEnv("PUBLIC_TESTNET_DRILL_BROADCAST_CONFIRMATION", "46630_SYNTHETIC_ONLY");
        harness.requireBroadcastConfirmation();
    }

    function testValidatesWethMetadataAndRuntimeCodeHash() external view {
        harness.validateWeth(address(weth), address(weth).codehash);
    }

    function testRejectsChangedWethRuntimeCodeHash() external {
        bytes32 expected = keccak256("different-runtime");
        vm.expectRevert(
            abi.encodeWithSelector(
                PublicTestnetDrillBase.UnexpectedWethCodeHash.selector, expected, address(weth).codehash
            )
        );
        harness.validateWeth(address(weth), expected);
    }

    function testRejectsWethLikeContractWithUnexpectedMetadata() external {
        MockWETH mock = new MockWETH();
        vm.expectRevert(PublicTestnetDrillBase.UnexpectedWethMetadata.selector);
        harness.validateWeth(address(mock), address(mock).codehash);
    }

    function testRejectsDuplicateParticipants() external {
        participants.traderB = participants.traderA;
        vm.expectRevert(
            abi.encodeWithSelector(PublicTestnetDrillBase.DuplicateParticipant.selector, participants.traderA)
        );
        harness.validateParticipants(participants);
    }

    function testValidatesSmallBalanceAwareConfiguration() external view {
        PublicTestnetDrillBase.DrillConfig memory config = _validConfig();
        harness.validateConfig(config, participants);
        PublicTestnetDrillBase.TradeEconomics memory economics = harness.tradeEconomics(config);
        assertEq(economics.grossProfitA, 0.0005 ether);
        assertEq(economics.grossProfitB, 0.00025 ether);
    }

    function testRejectsTraderFundingThatCannotPreserveConfiguredReserves() external {
        PublicTestnetDrillBase.DrillConfig memory config = _validConfig();
        config.traderAFundingWei = config.tradeAmountAWei + config.tradingFloorWei + config.gasReserveWei;
        vm.expectRevert(
            abi.encodeWithSelector(PublicTestnetDrillBase.InvalidConfiguration.selector, bytes32("PARTICIPANT_FUNDING"))
        );
        harness.validateConfig(config, participants);
    }

    function testRejectsMarketLiquidityBelowSyntheticProfitLiability() external {
        PublicTestnetDrillBase.DrillConfig memory config = _validConfig();
        config.marketLiquidityWei = 0.00074 ether;
        vm.expectRevert(
            abi.encodeWithSelector(PublicTestnetDrillBase.InvalidConfiguration.selector, bytes32("MARKET_LIQUIDITY"))
        );
        harness.validateConfig(config, participants);
    }

    function testRejectsNonProfitablePriceConfiguration() external {
        PublicTestnetDrillBase.DrillConfig memory config = _validConfig();
        config.finalPriceWeiPerToken = config.initialPriceWeiPerToken;
        vm.expectRevert(
            abi.encodeWithSelector(PublicTestnetDrillBase.InvalidConfiguration.selector, bytes32("MARKET_PRICE"))
        );
        harness.validateConfig(config, participants);
    }

    function _validConfig() private view returns (PublicTestnetDrillBase.DrillConfig memory config) {
        config = PublicTestnetDrillBase.DrillConfig({
            runId: keccak256("public-testnet-unit-test"),
            weth: address(weth),
            expectedWethCodeHash: address(weth).codehash,
            vaultAdminFundingWei: 0.002 ether,
            traderAFundingWei: 0.004 ether,
            traderBFundingWei: 0.003 ether,
            marketLiquidityWei: 0.002 ether,
            deployerGasBudgetWei: 0.01 ether,
            participantGasBudgetWei: 0.0002 ether,
            tradeAmountAWei: 0.001 ether,
            tradeAmountBWei: 0.0005 ether,
            initialPriceWeiPerToken: 1 ether,
            finalPriceWeiPerToken: 1.5 ether,
            traderAInitialSavingsBps: 2_000,
            traderAUpdatedSavingsBps: 2_500,
            traderBSavingsBps: 3_000,
            minContributionWei: 1 gwei,
            tradingFloorWei: 0.0001 ether,
            gasReserveWei: 0.0001 ether,
            inviteLifetimeSeconds: 1 days,
            transactionDeadlineSeconds: 10 minutes
        });
    }
}

contract PublicTestnetFixedRateAdapterTest is Test {
    PublicTestnetWethShape private weth;
    DevnetSyntheticStock private stock;
    PublicTestnetFixedRateAdapter private adapter;

    function setUp() external {
        weth = new PublicTestnetWethShape();
        stock = new DevnetSyntheticStock(address(this), "Synthetic Test Stock", "nTEST");
        adapter = new PublicTestnetFixedRateAdapter(address(weth), stock, 2e18);
        stock.setMinter(address(adapter), true);
        vm.deal(address(this), 1 ether);
        weth.deposit{value: 0.01 ether}();
    }

    function testRateIsImmutableAndInvestmentUsesRealTokenDeltas() external {
        uint256 amountIn = 0.001 ether;
        weth.approve(address(adapter), amountIn);

        assertEq(
            adapter.executeInvestment(
                address(weth), address(stock), amountIn, 0.002 ether, uint48(block.timestamp + 1)
            ),
            0.002 ether
        );
        assertEq(adapter.RATE_WAD(), 2e18);
        assertEq(weth.balanceOf(address(adapter)), amountIn);
        assertEq(stock.balanceOf(address(this)), 0.002 ether);

        (bool success,) = address(adapter).call(abi.encodeWithSignature("setRateWad(uint256)", uint256(3e18)));
        assertFalse(success, "the public-testnet adapter must expose no rate setter");
        assertEq(adapter.RATE_WAD(), 2e18);
    }

    function testRejectsWrongInputAndTargetTokens() external {
        vm.expectRevert(abi.encodeWithSelector(PublicTestnetFixedRateAdapter.InvalidTokenIn.selector, address(stock)));
        adapter.executeInvestment(address(stock), address(stock), 1, 0, uint48(block.timestamp + 1));

        vm.expectRevert(
            abi.encodeWithSelector(PublicTestnetFixedRateAdapter.InvalidTargetAsset.selector, address(weth))
        );
        adapter.executeInvestment(address(weth), address(weth), 1, 0, uint48(block.timestamp + 1));
    }
}
