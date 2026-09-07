// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {VaultFactory} from "../../../src/factory/VaultFactory.sol";
import {IVaultFactory} from "../../../src/interfaces/IVaultFactory.sol";
import {AdapterRegistry} from "../../../src/registry/AdapterRegistry.sol";

contract FactoryVaultHarness {
    bytes32 public vaultId;
    address public vaultAdmin;
    address public factory;
    uint32 public cohortId;
    uint256 public marker;
    bool public initialized;

    error AlreadyInitialized();
    error UnauthorizedInitializer();
    error UnauthorizedAdmin();

    function initialize(
        bytes32 vaultId_,
        address vaultAdmin_,
        address factory_,
        uint32 cohortId_,
        bytes calldata initData
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (msg.sender != factory_) revert UnauthorizedInitializer();

        (address initialTradingAccount, uint256 marker_) = abi.decode(initData, (address, uint256));

        initialized = true;
        vaultId = vaultId_;
        vaultAdmin = vaultAdmin_;
        factory = factory_;
        cohortId = cohortId_;
        marker = marker_;

        if (initialTradingAccount != address(0)) {
            IVaultFactory(factory_).linkTradingAccount(initialTradingAccount);
        }
    }

    function linkTradingAccount(address tradingAccount) external {
        IVaultFactory(factory).linkTradingAccount(tradingAccount);
    }

    function unlinkTradingAccount(address tradingAccount) external {
        IVaultFactory(factory).unlinkTradingAccount(tradingAccount);
    }

    function transferVaultAdmin(address nextAdmin) external {
        if (msg.sender != vaultAdmin) revert UnauthorizedAdmin();
        address previousAdmin = vaultAdmin;
        IVaultFactory(factory).transferVaultAdmin(previousAdmin, nextAdmin);
        vaultAdmin = nextAdmin;
    }

    function version() external pure virtual returns (uint256) {
        return 1;
    }
}

contract FactoryVaultHarnessV2 is FactoryVaultHarness {
    function version() external pure override returns (uint256) {
        return 2;
    }
}

contract ERC1271AdminHarness {
    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;

    mapping(bytes32 digest => bool approved) public approvedDigests;

    function approveDigest(bytes32 digest) external {
        approvedDigests[digest] = true;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return approvedDigests[digest] ? MAGIC_VALUE : bytes4(0);
    }
}

contract ProtocolComponentHarness {}

contract VaultFactoryTest is Test {
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));
    VaultFactory internal factory;
    FactoryVaultHarness internal implementation;
    uint32 internal cohortId;
    address internal beacon;

    address internal vaultAdmin;
    uint256 internal vaultAdminPrivateKey;

    function setUp() external {
        implementation = new FactoryVaultHarness();
        factory = new VaultFactory(address(this));
        (cohortId, beacon) = factory.registerCohort(address(implementation), address(this));
        (vaultAdmin, vaultAdminPrivateKey) = makeAddrAndKey("vaultAdmin");
    }

    function testPredictsAndDeploysExactCreate2Address() external {
        bytes32 userSalt = keccak256("primary-vault");
        bytes memory initData = _initData(address(0), 42);

        (bytes32 predictedVaultId, address predictedVault) =
            factory.predictVault(vaultAdmin, userSalt, cohortId, initData);

        vm.prank(vaultAdmin);
        (bytes32 deployedVaultId, address deployedVault) = factory.createVault(userSalt, cohortId, initData);

        assertEq(deployedVaultId, predictedVaultId);
        assertEq(deployedVault, predictedVault);
        assertGt(deployedVault.code.length, 0);
        assertEq(factory.vaultById(deployedVaultId), deployedVault);
        assertEq(factory.vaultIdOf(deployedVault), deployedVaultId);
        assertEq(factory.cohortOfVault(deployedVault), cohortId);
        assertTrue(factory.isVault(deployedVault));

        FactoryVaultHarness vault = FactoryVaultHarness(deployedVault);
        assertEq(vault.vaultId(), deployedVaultId);
        assertEq(vault.vaultAdmin(), vaultAdmin);
        assertEq(vault.factory(), address(factory));
        assertEq(vault.cohortId(), cohortId);
        assertEq(vault.marker(), 42);
        assertTrue(vault.initialized());
    }

    function testVaultIdentityDoesNotContainTradingAccount() external {
        bytes32 userSalt = keccak256("stable-id");
        address firstTradingAccount = makeAddr("firstTradingAccount");
        bytes32 expectedVaultId = factory.computeVaultId(vaultAdmin, userSalt);

        vm.prank(vaultAdmin);
        (bytes32 deployedVaultId, address deployedVault) =
            factory.createVault(userSalt, cohortId, _initData(address(0), 1));

        FactoryVaultHarness(deployedVault).linkTradingAccount(firstTradingAccount);
        assertEq(deployedVaultId, expectedVaultId);
        assertEq(factory.computeVaultId(vaultAdmin, userSalt), expectedVaultId);
        assertEq(factory.activeVaultOf(firstTradingAccount), deployedVault);
    }

    function testInitializationCanClaimTradingAccountAtomically() external {
        address tradingAccount = makeAddr("initialTradingAccount");
        bytes32 userSalt = keccak256("callback-during-init");
        bytes memory initData = _initData(tradingAccount, 7);
        (, address predictedVault) = factory.predictVault(vaultAdmin, userSalt, cohortId, initData);

        vm.prank(vaultAdmin);
        (, address deployedVault) = factory.createVault(userSalt, cohortId, initData);

        assertEq(deployedVault, predictedVault);
        assertEq(factory.activeVaultOf(tradingAccount), deployedVault);
    }

    function testActiveTradingAccountCannotCreateItsOwnVault() external {
        address tradingAccount = makeAddr("linkedVaultAdmin");
        vm.prank(vaultAdmin);
        (, address existingVault) = factory.createVault(keccak256("existing-vault"), cohortId, _initData(address(0), 1));
        FactoryVaultHarness(existingVault).linkTradingAccount(tradingAccount);

        vm.prank(tradingAccount);
        vm.expectRevert(
            abi.encodeWithSelector(VaultFactory.TradingAccountAlreadyLinked.selector, tradingAccount, existingVault)
        );
        factory.createVault(keccak256("forbidden-admin-vault"), cohortId, _initData(address(0), 2));
    }

    function testRelayerCannotCreateVaultForActiveTradingAccount() external {
        (address tradingAccount, uint256 tradingAccountKey) = makeAddrAndKey("linkedRelayedVaultAdmin");
        vm.prank(vaultAdmin);
        (, address existingVault) =
            factory.createVault(keccak256("existing-relayed-vault"), cohortId, _initData(address(0), 1));
        FactoryVaultHarness(existingVault).linkTradingAccount(tradingAccount);

        bytes32 userSalt = keccak256("forbidden-relayed-admin-vault");
        bytes memory initData = _initData(address(0), 2);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 digest = factory.createVaultDigest(tradingAccount, userSalt, cohortId, keccak256(initData), 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(tradingAccountKey, digest);

        vm.expectRevert(
            abi.encodeWithSelector(VaultFactory.TradingAccountAlreadyLinked.selector, tradingAccount, existingVault)
        );
        factory.createVaultFor(tradingAccount, userSalt, cohortId, initData, deadline, abi.encodePacked(r, s, v));
    }

    function testCreateVaultForAcceptsAdminSignatureAndRejectsReplay() external {
        bytes32 userSalt = keccak256("relayed-vault");
        bytes memory initData = _initData(address(0), 99);
        uint256 deadline = block.timestamp + 1 days;
        uint256 nonce = factory.creationNonces(vaultAdmin);
        bytes32 digest = factory.createVaultDigest(vaultAdmin, userSalt, cohortId, keccak256(initData), nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(vaultAdminPrivateKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        bytes memory tamperedInitData = _initData(address(0), 100);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.InvalidVaultAdminSignature.selector, vaultAdmin));
        factory.createVaultFor(vaultAdmin, userSalt, cohortId, tamperedInitData, deadline, signature);

        (bytes32 vaultId, address vault) =
            factory.createVaultFor(vaultAdmin, userSalt, cohortId, initData, deadline, signature);
        assertEq(factory.creationNonces(vaultAdmin), nonce + 1);
        assertEq(factory.vaultById(vaultId), vault);

        vm.expectRevert(abi.encodeWithSelector(VaultFactory.InvalidVaultAdminSignature.selector, vaultAdmin));
        factory.createVaultFor(vaultAdmin, userSalt, cohortId, initData, deadline, signature);
    }

    function testDirectCreationInvalidatesOlderRelayedAuthorizationAfterAdminTransfer() external {
        bytes32 signedSalt = keccak256("signed-before-direct");
        bytes memory signedInitData = _initData(address(0), 77);
        uint256 deadline = block.timestamp + 30 days;
        bytes32 digest =
            factory.createVaultDigest(vaultAdmin, signedSalt, cohortId, keccak256(signedInitData), 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(vaultAdminPrivateKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(vaultAdmin);
        (, address vault) = factory.createVault(keccak256("direct-vault"), cohortId, _initData(address(0), 1));
        address nextAdmin = makeAddr("nextAdminAfterDirect");
        vm.prank(vaultAdmin);
        FactoryVaultHarness(vault).transferVaultAdmin(nextAdmin);

        assertEq(factory.creationNonces(vaultAdmin), 2);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.InvalidVaultAdminSignature.selector, vaultAdmin));
        factory.createVaultFor(vaultAdmin, signedSalt, cohortId, signedInitData, deadline, signature);
    }

    function testAdminTransferInvalidatesAuthorizationSignedWhileAdminOwnedVault() external {
        vm.prank(vaultAdmin);
        (, address vault) = factory.createVault(keccak256("owned-before-signing"), cohortId, _initData(address(0), 1));

        bytes32 signedSalt = keccak256("signed-while-owner");
        bytes memory signedInitData = _initData(address(0), 88);
        uint256 deadline = block.timestamp + 30 days;
        uint256 nonce = factory.creationNonces(vaultAdmin);
        bytes32 digest =
            factory.createVaultDigest(vaultAdmin, signedSalt, cohortId, keccak256(signedInitData), nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(vaultAdminPrivateKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        address nextAdmin = makeAddr("nextAdminAfterSignedAuthorization");
        vm.prank(vaultAdmin);
        FactoryVaultHarness(vault).transferVaultAdmin(nextAdmin);

        assertEq(factory.creationNonces(vaultAdmin), nonce + 1);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.InvalidVaultAdminSignature.selector, vaultAdmin));
        factory.createVaultFor(vaultAdmin, signedSalt, cohortId, signedInitData, deadline, signature);
    }

    function testAdminCanExplicitlyInvalidateCreationAuthorization() external {
        assertEq(factory.creationNonces(vaultAdmin), 0);
        vm.prank(vaultAdmin);
        factory.invalidateCreationNonce();
        assertEq(factory.creationNonces(vaultAdmin), 1);
    }

    function testCreateVaultForRejectsExpiredSignature() external {
        bytes32 userSalt = keccak256("expired-signature");
        bytes memory initData = _initData(address(0), 1);
        uint256 deadline = block.timestamp + 1;
        bytes32 digest = factory.createVaultDigest(vaultAdmin, userSalt, cohortId, keccak256(initData), 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(vaultAdminPrivateKey, digest);

        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.SignatureExpired.selector, deadline));
        factory.createVaultFor(vaultAdmin, userSalt, cohortId, initData, deadline, abi.encodePacked(r, s, v));
    }

    function testCreateVaultForSupportsErc1271VaultAdmin() external {
        ERC1271AdminHarness smartAdmin = new ERC1271AdminHarness();
        bytes32 userSalt = keccak256("smart-admin");
        bytes memory initData = _initData(address(0), 55);
        uint256 deadline = block.timestamp + 1 days;
        bytes32 digest =
            factory.createVaultDigest(address(smartAdmin), userSalt, cohortId, keccak256(initData), 0, deadline);
        smartAdmin.approveDigest(digest);

        (, address vault) =
            factory.createVaultFor(address(smartAdmin), userSalt, cohortId, initData, deadline, hex"1271");

        assertEq(FactoryVaultHarness(vault).vaultAdmin(), address(smartAdmin));
        assertEq(factory.creationNonces(address(smartAdmin)), 1);
    }

    function testFactoryOwnershipCannotBeRenounced() external {
        // An ownerless factory could never register another cohort, so every
        // existing cohort would lose its upgrade path permanently.
        vm.expectRevert(VaultFactory.RenounceDisabled.selector);
        factory.renounceOwnership();
        assertEq(factory.owner(), address(this));
    }

    function testCohortsAreAppendOnlyAndBeaconBelongsToUpgradeAuthority() external {
        assertEq(cohortId, 1);
        assertEq(UpgradeableBeacon(beacon).owner(), address(this));
        assertNotEq(UpgradeableBeacon(beacon).owner(), address(factory));
        assertEq(UpgradeableBeacon(beacon).implementation(), address(implementation));

        vm.prank(vaultAdmin);
        (, address existingVault) =
            factory.createVault(keccak256("upgrade-preserves-vault"), cohortId, _initData(address(0), 123));
        assertEq(FactoryVaultHarness(existingVault).version(), 1);
        assertEq(FactoryVaultHarness(existingVault).marker(), 123);

        FactoryVaultHarness secondImplementation = new FactoryVaultHarness();
        (uint32 secondCohortId, address secondBeacon) =
            factory.registerCohort(address(secondImplementation), address(this));

        assertEq(secondCohortId, 2);
        assertNotEq(secondBeacon, beacon);
        assertEq(factory.cohortCount(), 2);

        (
            address storedBeacon,
            address storedInitialImplementation,
            address storedUpgradeAuthority,
            uint64 registeredAtBlock
        ) = factory.cohorts(cohortId);
        assertEq(storedBeacon, beacon);
        assertEq(storedInitialImplementation, address(implementation));
        assertEq(storedUpgradeAuthority, address(this));
        assertEq(registeredAtBlock, block.number);

        FactoryVaultHarnessV2 upgradedImplementation = new FactoryVaultHarnessV2();
        UpgradeableBeacon(beacon).upgradeTo(address(upgradedImplementation));

        assertEq(UpgradeableBeacon(beacon).implementation(), address(upgradedImplementation));
        assertEq(FactoryVaultHarness(existingVault).version(), 2);
        assertEq(FactoryVaultHarness(existingVault).marker(), 123);
        (storedBeacon, storedInitialImplementation, storedUpgradeAuthority,) = factory.cohorts(cohortId);
        assertEq(storedBeacon, beacon);
        assertEq(storedInitialImplementation, address(implementation));
        assertEq(storedUpgradeAuthority, address(this));
    }

    function testRegisterCohortRejectsEoaUpgradeAuthority() external {
        address eoaAuthority = makeAddr("eoaAuthority");
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.NotAContract.selector, eoaAuthority));
        factory.registerCohort(address(implementation), eoaAuthority);
    }

    function testProtocolConfigurationIsCanonicalAndOneShot() external {
        ProtocolComponentHarness component = new ProtocolComponentHarness();
        VaultFactory.ProtocolConfiguration memory configuration = VaultFactory.ProtocolConfiguration({
            weth: address(component),
            pauseController: address(component),
            attesterRegistry: address(component),
            settlementExecutor: address(component)
        });

        address stranger = makeAddr("configurationStranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", stranger));
        factory.configureProtocol(configuration);

        factory.configureProtocol(configuration);
        assertTrue(
            factory.isProtocolConfiguration(
                address(component), address(component), address(component), address(component))
        );
        assertFalse(
            factory.isProtocolConfiguration(
                address(component), address(component), address(component), makeAddr("fakeExecutor"))
        );

        vm.expectRevert(VaultFactory.ProtocolAlreadyConfigured.selector);
        factory.configureProtocol(configuration);
    }

    function testTradingAccountIsExclusiveAcrossAllVaults() external {
        address secondAdmin = makeAddr("secondAdmin");
        address tradingAccount = makeAddr("sharedTradingAccount");

        vm.prank(vaultAdmin);
        (, address firstVault) = factory.createVault(keccak256("first"), cohortId, _initData(address(0), 1));
        vm.prank(secondAdmin);
        (, address secondVault) = factory.createVault(keccak256("second"), cohortId, _initData(address(0), 2));

        FactoryVaultHarness(firstVault).linkTradingAccount(tradingAccount);
        assertEq(factory.activeVaultOf(tradingAccount), firstVault);

        vm.expectRevert(
            abi.encodeWithSelector(VaultFactory.TradingAccountAlreadyLinked.selector, tradingAccount, firstVault)
        );
        FactoryVaultHarness(secondVault).linkTradingAccount(tradingAccount);

        vm.expectRevert(
            abi.encodeWithSelector(
                VaultFactory.TradingAccountNotLinkedToCaller.selector, tradingAccount, firstVault, secondVault
            )
        );
        FactoryVaultHarness(secondVault).unlinkTradingAccount(tradingAccount);

        FactoryVaultHarness(firstVault).unlinkTradingAccount(tradingAccount);
        FactoryVaultHarness(secondVault).linkTradingAccount(tradingAccount);
        assertEq(factory.activeVaultOf(tradingAccount), secondVault);
    }

    function testOnlyRegisteredVaultCanCallTradingAccountCallbacks() external {
        address tradingAccount = makeAddr("unauthorizedTradingAccount");

        vm.expectRevert(abi.encodeWithSelector(VaultFactory.CallerNotRegisteredVault.selector, address(this)));
        factory.linkTradingAccount(tradingAccount);

        assertEq(factory.activeVaultOf(tradingAccount), address(0));
    }

    function testVaultAdminCannotAlsoBeLinkedAsATradingAccount() external {
        address secondAdmin = makeAddr("roleSeparatedAdmin");

        vm.prank(vaultAdmin);
        (, address firstVault) = factory.createVault(keccak256("role-first"), cohortId, _initData(address(0), 1));
        vm.prank(secondAdmin);
        (, address secondVault) = factory.createVault(keccak256("role-second"), cohortId, _initData(address(0), 2));

        vm.expectRevert(
            abi.encodeWithSelector(VaultFactory.VaultAdminCannotBeTradingAccount.selector, secondAdmin, secondVault)
        );
        FactoryVaultHarness(firstVault).linkTradingAccount(secondAdmin);
    }

    function testCannotCreateSamePermanentVaultTwice() external {
        bytes32 userSalt = keccak256("single-per-id");
        bytes memory initData = _initData(address(0), 1);

        vm.prank(vaultAdmin);
        (, address vault) = factory.createVault(userSalt, cohortId, initData);

        vm.expectRevert(abi.encodeWithSelector(VaultFactory.VaultAdminAlreadyRegistered.selector, vaultAdmin, vault));
        vm.prank(vaultAdmin);
        factory.createVault(userSalt, cohortId, initData);

        vm.expectRevert(abi.encodeWithSelector(VaultFactory.VaultAdminAlreadyRegistered.selector, vaultAdmin, vault));
        vm.prank(vaultAdmin);
        factory.createVault(keccak256("different-salt"), cohortId, initData);

        assertEq(factory.vaultOfAdmin(vaultAdmin), vault);
    }

    function _initData(address initialTradingAccount, uint256 marker) internal pure returns (bytes memory) {
        return abi.encode(initialTradingAccount, marker);
    }
}
