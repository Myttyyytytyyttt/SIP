// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NuvemTypes} from "../types/NuvemTypes.sol";

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @dev The one thing about a vault that is NOT in its storage: the adapter
///      registry is an immutable of the implementation behind the proxy, so it is
///      read as a call rather than as a slot. Every proxy on a given beacon
///      answers with the same address, which is exactly the property that lets a
///      beacon upgrade deliver it to vaults that already exist.
interface IVaultImplementation {
    function ADAPTER_REGISTRY() external view returns (address);
}

/**
 * @notice Reads a PersonalVault's storage and names what it finds.
 *
 * WHY THIS CONTRACT EXISTS. `PersonalVault` is a beacon implementation sealed
 * into a cohort, so its runtime size is a hard budget that can never be raised
 * afterwards. Fifteen getters that only off-chain callers ever used cost about
 * 1,050 bytes of dispatcher and return paths — measured, by deleting them — and
 * that was the difference between the investment path fitting under EIP-170 and
 * not. They were replaced by a single `extsload`, and this contract turns slots
 * back into values.
 *
 * IT EXPOSES NOTHING NEW. Every field below was a public getter before.
 *
 * WHAT IS DELIBERATELY NOT HERE. The getters `SettlementExecutor` calls on the
 * money path — `getTradingAccount`, `settlementPaused`, `settlementExecutor`,
 * `adminEpoch`, `localPauseEpoch`, `policyHash`, and the two rolling-cap views —
 * stayed on the vault. Routing those through a lens would put a second contract
 * between the executor and the truth, and a settlement would then depend on this
 * file being right. It is not on that path and must never be put on it.
 *
 * THE SLOT MAP IS MEASURED, NOT DERIVED. An earlier attempt at it was wrong:
 * `settlementExecutor` is an address with twelve spare bytes, and the compiler
 * greedily fills them with `cohortId` and `adminEpoch`, shifting everything below
 * by a slot from where reading the struct top to bottom suggests. Every constant
 * here is pinned by `VaultLens.t.sol`, which writes a distinct value into each
 * field and reads it back through this contract.
 */
contract VaultLens {
    /// @dev keccak256(abi.encode(uint256(keccak256("nuvem.storage.PersonalVault")) - 1)) & ~bytes32(uint256(0xff))
    uint256 internal constant BASE =
        uint256(0xe42e09f071b7e8aed0aad6a42ba1b4e3f8a0bc10a2919eea366981f9c3cd1200);

    uint256 internal constant SLOT_VAULT_ID = BASE + 0;
    uint256 internal constant SLOT_VAULT_ADMIN = BASE + 1;
    uint256 internal constant SLOT_PENDING_ADMIN = BASE + 2;
    uint256 internal constant SLOT_FACTORY = BASE + 3;
    uint256 internal constant SLOT_WETH = BASE + 4;
    uint256 internal constant SLOT_PAUSE_CONTROLLER = BASE + 5;
    uint256 internal constant SLOT_ATTESTER_REGISTRY = BASE + 6;
    /// @dev settlementExecutor(160) | cohortId(32) | adminEpoch(64)
    uint256 internal constant SLOT_EXECUTOR_PACKED = BASE + 7;
    /// @dev localPauseEpoch(64) | vaultPolicyNonce(64) | activeTradingAccountCount(64) | settlementPaused(8)
    uint256 internal constant SLOT_EPOCHS_PACKED = BASE + 8;
    uint256 internal constant SLOT_VAULT_POLICY = BASE + 9;
    uint256 internal constant SLOT_TRADING_ACCOUNTS = BASE + 10;
    uint256 internal constant SLOT_FRONTIER = BASE + 11;
    uint256 internal constant SLOT_USED_SESSIONS = BASE + 12;
    uint256 internal constant SLOT_LIFETIME_CONTRIBUTIONS = BASE + 45;
    /// @dev aggregateLifetimeContributions(128) | aggregateLifetimeInvested(128)
    uint256 internal constant SLOT_LIFETIME_TOTALS = BASE + 46;
    /// @dev adapterRegistry(160) | investmentPolicyNonce(64) | enabled(8) | paused(8)
    uint256 internal constant SLOT_INVESTMENT_PACKED = BASE + 47;
    uint256 internal constant SLOT_ADAPTER_ID = BASE + 48;
    uint256 internal constant SLOT_BASKET_HASH = BASE + 49;
    /// @dev minInvestmentWei(128) | maxInvestmentPerCallWei(128)
    uint256 internal constant SLOT_INVESTMENT_LIMITS = BASE + 50;
    uint256 internal constant SLOT_INVESTMENT_ROLLING_CAP = BASE + 51;

    struct VaultSnapshot {
        bytes32 vaultId;
        address vaultAdmin;
        address pendingVaultAdmin;
        address factory;
        address weth;
        address pauseController;
        address attesterRegistry;
        address adapterRegistry;
        uint32 cohortId;
        uint64 adminEpoch;
        uint64 localPauseEpoch;
        uint64 vaultPolicyNonce;
        uint64 activeTradingAccountCount;
        bool settlementPaused;
        uint128 maxAggregateRolling30dWei;
        uint128 aggregateLifetimeContributions;
        uint128 aggregateLifetimeInvested;
    }

    struct InvestmentSnapshot {
        bytes32 basketHash;
        bytes32 adapterId;
        address adapterRegistry;
        bool enabled;
        bool paused;
        uint64 policyNonce;
        uint128 minInvestmentWei;
        uint128 maxPerCallWei;
        uint128 maxRolling30dWei;
    }

    function _load(address vault, uint256 slot) private view returns (uint256) {
        return uint256(IExtsload(vault).extsload(bytes32(slot)));
    }

    /// @notice One round trip for the whole vault.
    /// @dev There is no verified Multicall3 on chain 4663, so the dashboard was
    ///      making a separate `eth_call` per getter. This is the same data in one.
    function vaultSnapshot(address vault) external view returns (VaultSnapshot memory s) {
        uint256 executorPacked = _load(vault, SLOT_EXECUTOR_PACKED);
        uint256 epochs = _load(vault, SLOT_EPOCHS_PACKED);
        uint256 totals = _load(vault, SLOT_LIFETIME_TOTALS);
        s = VaultSnapshot({
            vaultId: bytes32(_load(vault, SLOT_VAULT_ID)),
            vaultAdmin: address(uint160(_load(vault, SLOT_VAULT_ADMIN))),
            pendingVaultAdmin: address(uint160(_load(vault, SLOT_PENDING_ADMIN))),
            factory: address(uint160(_load(vault, SLOT_FACTORY))),
            weth: address(uint160(_load(vault, SLOT_WETH))),
            pauseController: address(uint160(_load(vault, SLOT_PAUSE_CONTROLLER))),
            attesterRegistry: address(uint160(_load(vault, SLOT_ATTESTER_REGISTRY))),
            // FROM THE IMPLEMENTATION, NOT FROM A SLOT. The registry stopped being
            // per-vault storage and became an immutable of the PersonalVault
            // implementation, because a storage field written in `initialize` can
            // never reach a vault that already exists. Reading S+47 for it — which
            // this line used to do — now returns the policy nonce and the two
            // investment flags, and would report them as an address.
            adapterRegistry: IVaultImplementation(vault).ADAPTER_REGISTRY(),
            cohortId: uint32(executorPacked >> 160),
            adminEpoch: uint64(executorPacked >> 192),
            localPauseEpoch: uint64(epochs),
            vaultPolicyNonce: uint64(epochs >> 64),
            activeTradingAccountCount: uint64(epochs >> 128),
            settlementPaused: ((epochs >> 192) & 1) == 1,
            maxAggregateRolling30dWei: uint128(_load(vault, SLOT_VAULT_POLICY)),
            aggregateLifetimeContributions: uint128(totals),
            aggregateLifetimeInvested: uint128(totals >> 128)
        });
    }

    function investmentSnapshot(address vault) external view returns (InvestmentSnapshot memory s) {
        uint256 packed = _load(vault, SLOT_INVESTMENT_PACKED);
        uint256 limits = _load(vault, SLOT_INVESTMENT_LIMITS);
        // OFFSETS MOVED WHEN `adapterRegistry` LEFT THIS SLOT. It used to occupy
        // the low 160 bits, pushing the nonce to 160 and the flags to 224/232.
        // With it gone the compiler packs from the bottom again: nonce at 0,
        // enabled at 64, paused at 72. Reading the old offsets against the new
        // layout yields a nonce of zero and both flags false — a vault that looks
        // switched off no matter how it is configured.
        s = InvestmentSnapshot({
            basketHash: bytes32(_load(vault, SLOT_BASKET_HASH)),
            adapterId: bytes32(_load(vault, SLOT_ADAPTER_ID)),
            adapterRegistry: IVaultImplementation(vault).ADAPTER_REGISTRY(),
            enabled: ((packed >> 64) & 1) == 1,
            paused: ((packed >> 72) & 1) == 1,
            policyNonce: uint64(packed),
            minInvestmentWei: uint128(limits),
            maxPerCallWei: uint128(limits >> 128),
            maxRolling30dWei: uint128(_load(vault, SLOT_INVESTMENT_ROLLING_CAP))
        });
    }

    // ── the individual reads, for callers that want one value ────────────────

    function vaultId(address vault) external view returns (bytes32) {
        return bytes32(_load(vault, SLOT_VAULT_ID));
    }

    function vaultAdmin(address vault) external view returns (address) {
        return address(uint160(_load(vault, SLOT_VAULT_ADMIN)));
    }

    function pendingVaultAdmin(address vault) external view returns (address) {
        return address(uint160(_load(vault, SLOT_PENDING_ADMIN)));
    }

    function factory(address vault) external view returns (address) {
        return address(uint160(_load(vault, SLOT_FACTORY)));
    }

    function weth(address vault) external view returns (address) {
        return address(uint160(_load(vault, SLOT_WETH)));
    }

    function pauseController(address vault) external view returns (address) {
        return address(uint160(_load(vault, SLOT_PAUSE_CONTROLLER)));
    }

    function attesterRegistry(address vault) external view returns (address) {
        return address(uint160(_load(vault, SLOT_ATTESTER_REGISTRY)));
    }

    function cohortId(address vault) external view returns (uint32) {
        return uint32(_load(vault, SLOT_EXECUTOR_PACKED) >> 160);
    }

    function vaultPolicyNonce(address vault) external view returns (uint64) {
        return uint64(_load(vault, SLOT_EPOCHS_PACKED) >> 64);
    }

    function activeTradingAccountCount(address vault) external view returns (uint64) {
        return uint64(_load(vault, SLOT_EPOCHS_PACKED) >> 128);
    }

    function getVaultPolicy(address vault) external view returns (NuvemTypes.VaultPolicy memory) {
        return NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: uint128(_load(vault, SLOT_VAULT_POLICY))});
    }

    function aggregateLifetimeContribution(address vault) external view returns (uint128) {
        return uint128(_load(vault, SLOT_LIFETIME_TOTALS));
    }

    function aggregateLifetimeInvested(address vault) external view returns (uint128) {
        return uint128(_load(vault, SLOT_LIFETIME_TOTALS) >> 128);
    }

    /// @dev `mapping(address => uint128)` at SLOT_LIFETIME_CONTRIBUTIONS.
    function lifetimeContribution(address vault, address account) external view returns (uint128) {
        return uint128(_load(vault, uint256(keccak256(abi.encode(account, bytes32(SLOT_LIFETIME_CONTRIBUTIONS))))));
    }

    /// @dev `mapping(address => mapping(uint64 => SettlementFrontier))`. Both ends
    ///      of the frontier share one slot, which is why the settlement path can
    ///      order the L2 range and check the L1 range for one SLOAD.
    /// @dev Same return shape as the getter this replaces, so call sites change
    ///      only in who they ask.
    function settlementFrontier(address vault, address account, uint64 bindingEpoch)
        external
        view
        returns (uint64 endBlockL1, uint64 endBlockL2)
    {
        bytes32 outer = keccak256(abi.encode(account, bytes32(SLOT_FRONTIER)));
        uint256 packed = _load(vault, uint256(keccak256(abi.encode(bindingEpoch, outer))));
        return (uint64(packed), uint64(packed >> 64));
    }

    /// @dev The session key is `keccak256(abi.encode(account, bindingEpoch, sessionId))`,
    ///      mirroring `PersonalVault._sessionKey`. Kept identical here on purpose:
    ///      a lens that derived it differently would report a replayed session as
    ///      unused, which is the one answer that must never be wrong.
    function isSessionUsed(address vault, address account, uint64 bindingEpoch, bytes32 sessionId)
        external
        view
        returns (bool)
    {
        bytes32 key = keccak256(abi.encode(account, bindingEpoch, sessionId));
        return _load(vault, uint256(keccak256(abi.encode(key, bytes32(SLOT_USED_SESSIONS))))) != 0;
    }
}
