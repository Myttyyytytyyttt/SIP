// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {INuvemVault} from "../interfaces/INuvemVault.sol";
import {IVaultFactory} from "../interfaces/IVaultFactory.sol";

/// @title VaultFactory
/// @notice Deploys permanent vault addresses into append-only upgrade cohorts.
/// @dev Each cohort has one immutable beacon address. The beacon's implementation may
///      only be upgraded by the authority supplied when the cohort is registered.
contract VaultFactory is IVaultFactory, EIP712, Ownable2Step {
    struct Cohort {
        address beacon;
        address initialImplementation;
        address upgradeAuthority;
        uint64 registeredAtBlock;
    }

    struct ProtocolConfiguration {
        address weth;
        address pauseController;
        address attesterRegistry;
        address settlementExecutor;
        // NO adapterRegistry HERE, and that is the corrected design rather than an
        // omission. Pinning it in the factory made it a per-vault value supplied at
        // creation — which meant it could never reach a vault that already existed,
        // because `initialize` runs once. It is now an immutable of the
        // PersonalVault IMPLEMENTATION, so a beacon upgrade delivers it to every
        // proxy in the cohort at once, chosen by governance rather than by whoever
        // created the vault. See PersonalVault's constructor.
        //
        // This shape also matches the factory deployed on mainnet, which answers
        // protocolConfiguration() with four words and can never gain a fifth —
        // `configureProtocol` is one-shot and already fired.
    }

    bytes32 public constant CREATE_VAULT_TYPEHASH = keccak256(
        "CreateVault(address vaultAdmin,bytes32 userSalt,uint32 cohortId,bytes32 initDataHash,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant VAULT_ID_TYPEHASH =
        keccak256("VaultId(uint256 chainId,address factory,address vaultAdmin,bytes32 userSalt)");

    uint32 public cohortCount;
    bool public protocolConfigured;
    ProtocolConfiguration public protocolConfiguration;

    mapping(uint32 cohortId => Cohort cohort) public cohorts;
    mapping(bytes32 vaultId => address vault) public vaultById;
    mapping(address vault => bytes32 vaultId) public vaultIdOf;
    mapping(address vault => uint32 cohortId) public cohortOfVault;
    mapping(address vault => bool registered) public override isVault;
    mapping(address vaultAdmin => uint256 nonce) public creationNonces;
    mapping(address vaultAdmin => address vault) public override vaultOfAdmin;

    /// @notice Global trading-account ownership across every factory vault and cohort.
    mapping(address tradingAccount => address vault) public override activeVaultOf;

    error ZeroAddress();
    error RenounceDisabled();
    error NotAContract(address account);
    error InvalidCohort(uint32 cohortId);
    error CohortIdOverflow();
    error ProtocolAlreadyConfigured();
    error VaultAlreadyExists(bytes32 vaultId, address vault);
    error VaultAdminAlreadyRegistered(address vaultAdmin, address vault);
    error VaultAddressAlreadyRegistered(address vault, bytes32 vaultId);
    error UnexpectedVaultAddress(address expected, address actual);
    error SignatureExpired(uint256 deadline);
    error InvalidVaultAdminSignature(address vaultAdmin);
    error CallerNotRegisteredVault(address caller);
    error TradingAccountAlreadyLinked(address tradingAccount, address activeVault);
    error VaultAdminCannotBeTradingAccount(address account, address vault);
    error TradingAccountNotLinkedToCaller(address tradingAccount, address activeVault, address caller);
    error VaultAdminNotLinkedToCaller(address vaultAdmin, address linkedVault, address caller);

    event CohortRegistered(
        uint32 indexed cohortId, address indexed beacon, address indexed initialImplementation, address upgradeAuthority
    );

    event ProtocolConfigured(
        address indexed weth,
        address indexed settlementExecutor,
        address indexed pauseController,
        address attesterRegistry
    );

    event VaultDeployed(
        bytes32 indexed vaultId, uint32 cohortId, address indexed vaultAdmin, address indexed vault, bytes32 userSalt
    );

    event TradingAccountLinked(address indexed tradingAccount, address indexed vault, bytes32 indexed vaultId);

    event TradingAccountUnlinked(address indexed tradingAccount, address indexed vault, bytes32 indexed vaultId);

    event VaultAdminRegistryTransferred(
        address indexed previousAdmin, address indexed nextAdmin, address indexed vault
    );
    event CreationNonceAdvanced(address indexed vaultAdmin, uint256 newNonce, address indexed caller);

    constructor(address initialOwner) EIP712("Nuvem Vault Factory", "1") Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    /// @dev Disabled. Renouncing would permanently prevent registering new
    ///      cohorts and completing the pending ownership handoff, leaving every
    ///      existing cohort without an upgrade path forever.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice Permanently pins the protocol components accepted by canonical
    ///         PersonalVault initializers. This prevents a creator from
    ///         substituting a fake token, pause controller, attester registry or
    ///         settlement executor in `initData`.
    function configureProtocol(ProtocolConfiguration calldata configuration) external onlyOwner {
        if (protocolConfigured) revert ProtocolAlreadyConfigured();
        _requireContract(configuration.weth);
        _requireContract(configuration.pauseController);
        _requireContract(configuration.attesterRegistry);
        _requireContract(configuration.settlementExecutor);

        protocolConfiguration = configuration;
        protocolConfigured = true;
        emit ProtocolConfigured(
            configuration.weth,
            configuration.settlementExecutor,
            configuration.pauseController,
            configuration.attesterRegistry
        );
    }

    function isProtocolConfiguration(
        address weth,
        address pauseController,
        address attesterRegistry,
        address settlementExecutor
    ) external view override returns (bool) {
        ProtocolConfiguration storage configuration = protocolConfiguration;
        return protocolConfigured && configuration.weth == weth && configuration.pauseController == pauseController
            && configuration.attesterRegistry == attesterRegistry
            && configuration.settlementExecutor == settlementExecutor;
    }

    /// @notice Registers a new append-only cohort and deploys its beacon.
    /// @param initialImplementation Audited PersonalVault implementation for the cohort.
    /// @param upgradeAuthority Deployed timelock or governance contract that exclusively owns the beacon.
    /// @return cohortId Sequential, non-zero cohort identifier.
    /// @return beacon Newly deployed UpgradeableBeacon controlled by `upgradeAuthority`.
    function registerCohort(address initialImplementation, address upgradeAuthority)
        external
        onlyOwner
        returns (uint32 cohortId, address beacon)
    {
        if (initialImplementation == address(0) || upgradeAuthority == address(0)) {
            revert ZeroAddress();
        }
        if (initialImplementation.code.length == 0) {
            revert NotAContract(initialImplementation);
        }
        if (upgradeAuthority.code.length == 0) {
            revert NotAContract(upgradeAuthority);
        }

        unchecked {
            cohortId = cohortCount + 1;
        }
        if (cohortId == 0) revert CohortIdOverflow();

        beacon = address(new UpgradeableBeacon(initialImplementation, upgradeAuthority));

        cohorts[cohortId] = Cohort({
            beacon: beacon,
            initialImplementation: initialImplementation,
            upgradeAuthority: upgradeAuthority,
            registeredAtBlock: uint64(block.number)
        });
        cohortCount = cohortId;

        emit CohortRegistered(cohortId, beacon, initialImplementation, upgradeAuthority);
    }

    /// @notice Creates a vault controlled by the caller.
    /// @dev Trading accounts are deliberately absent from the vault identity and address.
    function createVault(bytes32 userSalt, uint32 cohortId, bytes calldata initData)
        external
        returns (bytes32 vaultId, address vault)
    {
        _advanceCreationNonce(msg.sender);
        return _createVault(msg.sender, userSalt, cohortId, initData);
    }

    /// @notice Creates a vault through a relayer using the vault admin's EIP-712 authorization.
    /// @dev Supports both ECDSA accounts and ERC-1271 contract admins.
    function createVaultFor(
        address vaultAdmin,
        bytes32 userSalt,
        uint32 cohortId,
        bytes calldata initData,
        uint256 deadline,
        bytes calldata signature
    ) external returns (bytes32 vaultId, address vault) {
        if (vaultAdmin == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert SignatureExpired(deadline);

        uint256 nonce = creationNonces[vaultAdmin];
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(CREATE_VAULT_TYPEHASH, vaultAdmin, userSalt, cohortId, keccak256(initData), nonce, deadline)
            )
        );

        if (!SignatureChecker.isValidSignatureNow(vaultAdmin, digest, signature)) {
            revert InvalidVaultAdminSignature(vaultAdmin);
        }

        // Consume before external calls in proxy construction. A failed deployment rolls
        // the nonce back with the rest of the transaction.
        _advanceCreationNonce(vaultAdmin);

        return _createVault(vaultAdmin, userSalt, cohortId, initData);
    }

    /// @notice Invalidates every outstanding relayed creation authorization.
    function invalidateCreationNonce() external {
        _advanceCreationNonce(msg.sender);
    }

    /// @notice Claims a trading account for the calling vault.
    /// @dev The account remains exclusive globally until that same vault releases it.
    function linkTradingAccount(address tradingAccount) external override {
        bytes32 vaultId = _requireRegisteredVault(msg.sender);
        if (tradingAccount == address(0)) revert ZeroAddress();
        address administeredVault = vaultOfAdmin[tradingAccount];
        if (administeredVault != address(0)) {
            revert VaultAdminCannotBeTradingAccount(tradingAccount, administeredVault);
        }

        address currentVault = activeVaultOf[tradingAccount];
        if (currentVault != address(0)) {
            revert TradingAccountAlreadyLinked(tradingAccount, currentVault);
        }

        activeVaultOf[tradingAccount] = msg.sender;
        emit TradingAccountLinked(tradingAccount, msg.sender, vaultId);
    }

    /// @notice Releases a trading account from the calling vault.
    function unlinkTradingAccount(address tradingAccount) external override {
        bytes32 vaultId = _requireRegisteredVault(msg.sender);
        address currentVault = activeVaultOf[tradingAccount];
        if (currentVault != msg.sender) {
            revert TradingAccountNotLinkedToCaller(tradingAccount, currentVault, msg.sender);
        }

        delete activeVaultOf[tradingAccount];
        emit TradingAccountUnlinked(tradingAccount, msg.sender, vaultId);
    }

    /// @notice Synchronizes the permanent one-vault-per-admin registry after
    ///         the registered vault completes its two-step admin transfer.
    function transferVaultAdmin(address previousAdmin, address nextAdmin) external override {
        _requireRegisteredVault(msg.sender);
        if (previousAdmin == address(0) || nextAdmin == address(0)) revert ZeroAddress();

        address linkedVault = vaultOfAdmin[previousAdmin];
        if (linkedVault != msg.sender) {
            revert VaultAdminNotLinkedToCaller(previousAdmin, linkedVault, msg.sender);
        }
        address existingVault = vaultOfAdmin[nextAdmin];
        if (existingVault != address(0)) {
            revert VaultAdminAlreadyRegistered(nextAdmin, existingVault);
        }
        address linkedTradingVault = activeVaultOf[nextAdmin];
        if (linkedTradingVault != address(0)) {
            revert TradingAccountAlreadyLinked(nextAdmin, linkedTradingVault);
        }

        delete vaultOfAdmin[previousAdmin];
        vaultOfAdmin[nextAdmin] = msg.sender;
        _advanceCreationNonce(previousAdmin);
        emit VaultAdminRegistryTransferred(previousAdmin, nextAdmin, msg.sender);
    }

    /// @notice Derives the permanent identifier for an admin-selected salt.
    function computeVaultId(address vaultAdmin, bytes32 userSalt) public view returns (bytes32) {
        if (vaultAdmin == address(0)) revert ZeroAddress();
        return keccak256(abi.encode(VAULT_ID_TYPEHASH, block.chainid, address(this), vaultAdmin, userSalt));
    }

    /// @notice Predicts the exact CREATE2 vault address for creation parameters.
    /// @dev `initData` affects proxy init code and therefore must exactly match creation.
    function predictVault(address vaultAdmin, bytes32 userSalt, uint32 cohortId, bytes calldata initData)
        external
        view
        returns (bytes32 vaultId, address predicted)
    {
        vaultId = computeVaultId(vaultAdmin, userSalt);
        predicted = _predictVault(vaultId, vaultAdmin, cohortId, initData);
    }

    /// @notice Returns the signed digest consumed by `createVaultFor`.
    function createVaultDigest(
        address vaultAdmin,
        bytes32 userSalt,
        uint32 cohortId,
        bytes32 initDataHash,
        uint256 nonce,
        uint256 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(CREATE_VAULT_TYPEHASH, vaultAdmin, userSalt, cohortId, initDataHash, nonce, deadline))
        );
    }

    function _createVault(address vaultAdmin, bytes32 userSalt, uint32 cohortId, bytes calldata initData)
        internal
        returns (bytes32 vaultId, address vault)
    {
        if (vaultAdmin == address(0)) revert ZeroAddress();
        address adminVault = vaultOfAdmin[vaultAdmin];
        if (adminVault != address(0)) {
            revert VaultAdminAlreadyRegistered(vaultAdmin, adminVault);
        }
        address linkedTradingVault = activeVaultOf[vaultAdmin];
        if (linkedTradingVault != address(0)) {
            revert TradingAccountAlreadyLinked(vaultAdmin, linkedTradingVault);
        }

        Cohort memory cohort = _requireCohort(cohortId);
        vaultId = computeVaultId(vaultAdmin, userSalt);

        address existingVault = vaultById[vaultId];
        if (existingVault != address(0)) {
            revert VaultAlreadyExists(vaultId, existingVault);
        }

        bytes memory initializationCall =
            abi.encodeCall(INuvemVault.initialize, (vaultId, vaultAdmin, address(this), cohortId, initData));
        address predicted = Create2.computeAddress(
            vaultId,
            keccak256(abi.encodePacked(type(BeaconProxy).creationCode, abi.encode(cohort.beacon, initializationCall)))
        );

        bytes32 registeredId = vaultIdOf[predicted];
        if (isVault[predicted]) {
            revert VaultAddressAlreadyRegistered(predicted, registeredId);
        }

        // Reserve the predicted identity before the proxy constructor delegate-calls
        // initialize. This authorizes factory callbacks made during initialization.
        // Any constructor failure atomically reverts these reservations.
        vaultById[vaultId] = predicted;
        vaultIdOf[predicted] = vaultId;
        cohortOfVault[predicted] = cohortId;
        isVault[predicted] = true;
        vaultOfAdmin[vaultAdmin] = predicted;

        vault = address(new BeaconProxy{salt: vaultId}(cohort.beacon, initializationCall));
        if (vault != predicted) revert UnexpectedVaultAddress(predicted, vault);

        emit VaultDeployed(vaultId, cohortId, vaultAdmin, vault, userSalt);
    }

    function _predictVault(bytes32 vaultId, address vaultAdmin, uint32 cohortId, bytes calldata initData)
        internal
        view
        returns (address)
    {
        Cohort memory cohort = _requireCohort(cohortId);
        bytes memory initializationCall =
            abi.encodeCall(INuvemVault.initialize, (vaultId, vaultAdmin, address(this), cohortId, initData));

        return Create2.computeAddress(
            vaultId,
            keccak256(abi.encodePacked(type(BeaconProxy).creationCode, abi.encode(cohort.beacon, initializationCall)))
        );
    }

    function _requireCohort(uint32 cohortId) internal view returns (Cohort memory cohort) {
        cohort = cohorts[cohortId];
        if (cohort.beacon == address(0)) revert InvalidCohort(cohortId);
    }

    function _requireRegisteredVault(address caller) internal view returns (bytes32 vaultId) {
        vaultId = vaultIdOf[caller];
        if (!isVault[caller] || vaultById[vaultId] != caller) {
            revert CallerNotRegisteredVault(caller);
        }
    }

    function _requireContract(address account) private view {
        if (account == address(0)) revert ZeroAddress();
        if (account.code.length == 0) revert NotAContract(account);
    }

    function _advanceCreationNonce(address vaultAdmin) private {
        uint256 newNonce = creationNonces[vaultAdmin] + 1;
        creationNonces[vaultAdmin] = newNonce;
        emit CreationNonceAdvanced(vaultAdmin, newNonce, msg.sender);
    }
}
