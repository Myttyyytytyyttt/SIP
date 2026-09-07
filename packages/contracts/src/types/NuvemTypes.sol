// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

library NuvemTypes {
    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint8 internal constant ROLLING_BUCKET_COUNT = 31;

    enum AccountStatus {
        NONE,
        PENDING,
        ACTIVE,
        PAUSED,
        REVOKED
    }

    struct TradingAccountPolicy {
        uint16 savingsBps;
        uint128 minContributionWei;
        uint128 maxPerSettlementWei;
        uint128 maxRolling30dWei;
        uint128 tradingFloorWei;
        uint128 gasReserveWei;
    }

    struct TradingAccount {
        AccountStatus status;
        bytes32 platformId;
        uint64 bindingEpoch;
        uint64 policyNonce;
        uint64 inviteNonce;
        uint64 inviteAdminEpoch;
        uint64 settlementNonce;
        uint64 activationBlock;
        uint64 revocationBlock;
        uint48 inviteDeadline;
        TradingAccountPolicy policy;
    }

    /// @dev Deliberately a one-field struct rather than a bare `uint128`.
    ///      `PersonalVault._vaultPolicyHash` abi.encodes `$.vaultPolicy`
    ///      wholesale, and re-adding an investment path later stays purely
    ///      additive at the type level.
    struct VaultPolicy {
        uint128 maxAggregateRolling30dWei;
    }

    struct VaultInitialization {
        address weth;
        address pauseController;
        address attesterRegistry;
        address settlementExecutor;
        VaultPolicy policy;
    }

    /// @dev Fixed-point scale for `BasketLeg.minOutRateWad`.
    uint256 internal constant OUTPUT_RATE_SCALE = 1e18;

    /// @dev Bounds the calldata a single `invest` can carry. Eight is well past
    ///      any basket a person reasons about, and the cap is what stops a caller
    ///      handing the vault a thousand-leg array to run out of gas inside.
    uint8 internal constant MAX_BASKET_LEGS = 8;

    /**
     * @notice One asset of an investment basket, and the floor it may be bought at.
     *
     * @dev NEVER STORED. The vault keeps only `keccak256(abi.encode(legs))` and the
     *      caller supplies the legs as calldata, which is checked against that hash.
     *      Three things follow, and the third is the one that made this the design:
     *
     *      - Changing a basket is one SSTORE instead of N, and shortening one
     *        cannot leave a stale leg behind, because there is nothing to leave.
     *      - The hash IS the compare-and-swap. A caller holding a basket the admin
     *        has since replaced fails the check on its own, with no separate nonce
     *        to remember to bump.
     *      - It costs no security. A compromised keeper still cannot substitute an
     *        asset: it can only present the exact legs the admin hashed.
     *
     *      `setInvestmentBasket` emits the legs, so the UI and the keeper rebuild
     *      them from logs rather than from a copy someone has to keep in sync.
     *
     * @param targetAsset   the token to buy — one of the canonical stock tokens
     * @param weightBps     share of the purchase, summing to BPS_DENOMINATOR
     * @param minOutRateWad the vault admin's own price floor, in output units per
     *                      wei of input, scaled by OUTPUT_RATE_SCALE. Defence in
     *                      depth: the adapter enforces an oracle bound too, but the
     *                      adapter is swappable by governance and this is not.
     */
    struct BasketLeg {
        address targetAsset;
        uint16 weightBps;
        uint128 minOutRateWad;
    }

    struct DailySpendBucket {
        uint32 dayIndex;
        uint128 amount;
    }

    struct RollingCapStatus {
        uint128 cap;
        uint128 spent;
        uint128 remaining;
        uint48 nextReleaseAt;
        uint128 nextReleaseAmount;
    }

    /// @notice The furthest point a given (account, bindingEpoch) has settled to.
    /// @dev Both ends share one storage slot, so enforcing progression on the L2
    ///      range and coherence on the L1 range together costs exactly what the
    ///      single L1 watermark cost before: one SLOAD and one SSTORE.
    struct SettlementFrontier {
        uint64 endBlockL1;
        uint64 endBlockL2;
    }

    /// @dev `startBlock`/`endBlock` are L1 block numbers, because on Arbitrum
    ///      Nitro Solidity's `block.number` is the L1 number and that is the only
    ///      clock a contract here can compare an attested height against. The
    ///      `*L2` pair is the trading session's real extent; it is ORDERED by the
    ///      vault but never BOUNDED, since no on-chain L2 clock is observable.
    struct SettlementAttestation {
        address account;
        address vault;
        address executor;
        uint256 chainId;
        uint64 bindingEpoch;
        uint64 policyNonce;
        uint64 adminEpoch;
        uint64 localPauseEpoch;
        uint64 globalPauseEpoch;
        uint64 settlementNonce;
        bytes32 policyHash;
        bytes32 sessionId;
        bytes32 ledgerRoot;
        uint64 startBlock;
        uint64 endBlock;
        uint64 startBlockL2;
        uint64 endBlockL2;
        uint256 cashStart;
        uint256 cashEnd;
        uint256 externalDeposits;
        uint256 externalWithdrawals;
        int256 realizedProfit;
        uint256 contribution;
        uint32 attesterEpoch;
        uint48 validAfter;
        uint48 deadline;
    }

    struct SettlementRecord {
        address account;
        uint64 bindingEpoch;
        uint64 policyNonce;
        uint64 settlementNonce;
        bytes32 policyHash;
        bytes32 sessionId;
        bytes32 ledgerRoot;
        uint64 startBlock;
        uint64 endBlock;
        uint64 startBlockL2;
        uint64 endBlockL2;
        uint128 contribution;
    }
}
