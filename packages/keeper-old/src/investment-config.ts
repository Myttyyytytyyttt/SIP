// What the supervisor needs before it may buy anything.
//
// SEPARATE FROM KeeperConfig ON PURPOSE. Settlement and investment fail
// independently and an operator running only the first should not have to
// configure the second — a keeper that refuses to start because a pool
// parameter is missing would take settlement down for a feature nobody asked it
// to run. So investing is OFF unless it is configured, and a configuration that
// is present but wrong is a hard error rather than a silent skip.
//
// THE POOLS ARE THE DANGEROUS FIELD. They must name the SAME pools the deployed
// adapter pins: the keeper quotes them to build its floor, and a floor computed
// against a pool the adapter will never trade in describes a trade that will not
// happen. Mainnet carries hookless USDG/stock pools at 85%, 90% and 99.9%, so
// the gap between "a pool" and "the pool" is most of a purchase.

import { isAddress, getAddress, type Address } from "viem";

export interface StockPoolConfig {
  readonly fee: number;
  readonly tickSpacing: number;
}

export interface InvestmentConfig {
  readonly poolManager: Address;
  readonly usdg: Address;
  readonly wethUsdgFee: number;
  readonly wethUsdgTickSpacing: number;
  /** Keyed by lowercased target asset. */
  readonly stockPools: ReadonlyMap<string, StockPoolConfig>;
  /**
   * Assets quoted by previewDeposit rather than by a pool, keyed by the
   * basket's targetAsset (lowercase) with the CONTRACT TO ASK as the value.
   *
   * SEPARATE FROM THE POOL LIST, because these are not pools: a deposit or a
   * desk sale delivers, it does not swap. The quoter is usually the asset
   * itself (spUSDG previews its own deposit) but not always: the perp desk
   * sells pBTC3x while the previewDeposit worth asking is the desk's own.
   * An asset absent from both maps is refused rather than quoted by a guess.
   */
  readonly sharesQuoters: ReadonlyMap<string, Address>;
  readonly toleranceBps: number;
  /** How long a purchase waits for its receipt before being left outstanding. */
  readonly receiptTimeoutMs: number;
}

export type InvestmentConfigResult =
  /** Not configured. Settlement carries on; the vault simply does not invest. */
  | { readonly kind: "DISABLED" }
  | { readonly kind: "OK"; readonly config: InvestmentConfig }
  /** Configured and unusable. Never treated as DISABLED — see below. */
  | { readonly kind: "INVALID"; readonly problems: readonly string[] };

/**
 * Fifty basis points, matching `quote.ts`.
 *
 * It is a read-to-fill staleness budget, not a slippage allowance: the pool fees
 * are already inside the quote. Measured against this route's own swap history,
 * the worst adverse move is about 12 bps over five seconds and 18 over a minute,
 * so 50 is roughly three times the worst case a purchase can sit through.
 */
const DEFAULT_TOLERANCE_BPS = 50;
const DEFAULT_RECEIPT_TIMEOUT_MS = 90_000;

const address = (raw: string | undefined, name: string, problems: string[]): Address | null => {
  if (raw === undefined || raw.trim() === "") {
    problems.push(`${name} is required when investing is configured`);
    return null;
  }
  if (!isAddress(raw.trim())) {
    problems.push(`${name} is not an address: ${raw}`);
    return null;
  }
  return getAddress(raw.trim());
};

/**
 * Reads the investment configuration, or explains why there is none.
 *
 * `NUVEM_INVEST_POOLS` IS THE SWITCH. Its absence means an operator has not
 * asked for this and settlement should carry on untouched. Its presence means
 * they have, and then every other field is required — because a half-configured
 * investment path that silently does nothing is the failure this whole subsystem
 * is built to avoid.
 */
export function loadInvestmentConfig(env: NodeJS.ProcessEnv): InvestmentConfigResult {
  const raw = env.NUVEM_INVEST_POOLS?.trim();
  if (raw === undefined || raw === "") {
    // THE SWITCH STAYS THE SWITCH — but an env that ASKED for share
    // destinations while the switch is off must be named, not swallowed.
    // "Present but ignored" is the exact silent-skip this module's contract
    // forbids, and it is how NUVEM_INVEST_DESKS set on a keeper without pools
    // would read as a mysteriously dead listing.
    const asked = [
      (env.NUVEM_INVEST_YIELD_VAULT?.trim() ?? "") !== "" ? "NUVEM_INVEST_YIELD_VAULT" : null,
      (env.NUVEM_INVEST_DESKS?.trim() ?? "") !== "" ? "NUVEM_INVEST_DESKS" : null,
    ].filter((name) => name !== null);
    if (asked.length > 0) {
      return {
        kind: "INVALID",
        problems: [
          `${asked.join(" and ")} ${asked.length === 1 ? "is" : "are"} set but NUVEM_INVEST_POOLS, ` +
            "the investing switch, is not — the share destinations would be silently ignored. " +
            "Set NUVEM_INVEST_POOLS too, or unset them.",
        ],
      };
    }
    return { kind: "DISABLED" };
  }

  const problems: string[] = [];
  const poolManager = address(env.NUVEM_POOL_MANAGER, "NUVEM_POOL_MANAGER", problems);
  const usdg = address(env.NUVEM_USDG, "NUVEM_USDG", problems);

  // SHARE DESTINATIONS: assets quoted by previewDeposit rather than by a pool.
  //
  // Two sources feed one map. NUVEM_INVEST_YIELD_VAULT is the original single
  // 4626 (spUSDG) and quotes ITSELF. NUVEM_INVEST_DESKS is <asset>:<quoter>
  // pairs for destinations whose quote lives at a DIFFERENT contract — the
  // Nuvem perp desk sells pBTC3x but the previewDeposit worth asking is the
  // desk's own (NAV minus its immutable spread), never the pToken's, whose
  // preview reverts while Arcus keeps deposits gated.
  const sharesQuoters = new Map<string, Address>();
  const rawYield = env.NUVEM_INVEST_YIELD_VAULT?.trim();
  if (rawYield !== undefined && rawYield !== "") {
    const yieldVault = address(rawYield, "NUVEM_INVEST_YIELD_VAULT", problems);
    if (yieldVault !== null && usdg !== null && yieldVault.toLowerCase() === usdg.toLowerCase()) {
      // The same guard the desks have: dollars are the DOLLARS route, and a
      // "yield vault" that IS USDG would shadow it with a previewDeposit call
      // against a plain ERC-20.
      problems.push("NUVEM_INVEST_YIELD_VAULT is USDG itself — dollars are the DOLLARS route, not a yield vault");
    } else if (yieldVault !== null) {
      sharesQuoters.set(yieldVault.toLowerCase(), yieldVault);
    }
  }
  let rawDesks = env.NUVEM_INVEST_DESKS?.trim();
  // The pasted-name mistake, absorbed: "NUVEM_INVEST_DESKS=0x…" in the VALUE
  // field would otherwise fail isAddress, invalidate the whole config, and
  // stop every account from claiming — a hosting-UI slip must not cost that.
  if (rawDesks !== undefined && rawDesks.startsWith("NUVEM_INVEST_DESKS=")) {
    rawDesks = rawDesks.slice("NUVEM_INVEST_DESKS=".length).trim();
  }
  if (rawDesks !== undefined && rawDesks !== "") {
    for (const entry of rawDesks.split(",").map((e) => e.trim()).filter((e) => e !== "")) {
      const [asset, quoter, ...rest] = entry.split(":");
      if (asset === undefined || quoter === undefined || rest.length > 0) {
        problems.push(`NUVEM_INVEST_DESKS entry "${entry}" is not <asset>:<quoter>`);
        continue;
      }
      const assetAddress = address(asset, "NUVEM_INVEST_DESKS asset", problems);
      const quoterAddress = address(quoter, "NUVEM_INVEST_DESKS quoter", problems);
      if (assetAddress === null || quoterAddress === null) continue;
      const key = assetAddress.toLowerCase();
      if (usdg !== null && key === usdg.toLowerCase()) {
        problems.push(`NUVEM_INVEST_DESKS lists USDG itself (${asset}) — dollars are the DOLLARS route, not a desk`);
        continue;
      }
      if (sharesQuoters.has(key)) {
        problems.push(`NUVEM_INVEST_DESKS lists ${asset} more than once (or it is already the yield vault)`);
        continue;
      }
      sharesQuoters.set(key, quoterAddress);
    }
  }

  const stockPools = new Map<string, StockPoolConfig>();
  for (const entry of raw.split(",").map((e) => e.trim()).filter((e) => e !== "")) {
    const [asset, fee, tickSpacing, ...rest] = entry.split(":");
    if (asset === undefined || fee === undefined || tickSpacing === undefined || rest.length > 0) {
      problems.push(`NUVEM_INVEST_POOLS entry "${entry}" is not <asset>:<fee>:<tickSpacing>`);
      continue;
    }
    if (!isAddress(asset)) {
      problems.push(`NUVEM_INVEST_POOLS entry "${entry}" does not start with an address`);
      continue;
    }
    const feeNum = Number(fee);
    const tickNum = Number(tickSpacing);
    if (!Number.isInteger(feeNum) || feeNum < 0) {
      problems.push(`NUVEM_INVEST_POOLS: fee "${fee}" for ${asset} is not a whole number`);
      continue;
    }
    // A NON-POSITIVE TICK SPACING NAMES A POOL THAT CANNOT EXIST, and a PoolKey
    // built from one hashes to an id nothing lives at — every read returns zero
    // and the tick reports "the pinned pool is empty", which sends whoever is
    // on call looking at liquidity instead of at this line.
    if (!Number.isInteger(tickNum) || tickNum <= 0) {
      problems.push(`NUVEM_INVEST_POOLS: tickSpacing "${tickSpacing}" for ${asset} must be a positive whole number`);
      continue;
    }
    const key = getAddress(asset).toLowerCase();
    if (stockPools.has(key)) {
      problems.push(`NUVEM_INVEST_POOLS lists ${asset} more than once`);
      continue;
    }
    stockPools.set(key, { fee: feeNum, tickSpacing: tickNum });
  }

  if (stockPools.size === 0 && problems.length === 0) {
    problems.push("NUVEM_INVEST_POOLS is set but lists no usable pools");
  }

  // ONE ROUTE PER ASSET. An asset in both maps would be quoted by whichever
  // branch runs first — a silent tie-break nobody chose. Refused by name.
  for (const key of sharesQuoters.keys()) {
    if (stockPools.has(key)) {
      problems.push(`${key} is listed both as a pool (NUVEM_INVEST_POOLS) and a share destination — pick one route`);
    }
  }

  const wethUsdgFee = Number(env.NUVEM_WETH_USDG_FEE ?? "200");
  const wethUsdgTickSpacing = Number(env.NUVEM_WETH_USDG_TICK_SPACING ?? "4");
  if (!Number.isInteger(wethUsdgFee) || wethUsdgFee < 0) {
    problems.push(`NUVEM_WETH_USDG_FEE is not a whole number: ${env.NUVEM_WETH_USDG_FEE}`);
  }
  if (!Number.isInteger(wethUsdgTickSpacing) || wethUsdgTickSpacing <= 0) {
    problems.push(`NUVEM_WETH_USDG_TICK_SPACING must be a positive whole number: ${env.NUVEM_WETH_USDG_TICK_SPACING}`);
  }

  const toleranceBps = Number(env.NUVEM_INVEST_TOLERANCE_BPS ?? String(DEFAULT_TOLERANCE_BPS));
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps >= 10_000) {
    problems.push(`NUVEM_INVEST_TOLERANCE_BPS must be a whole number in [0, 10000): ${env.NUVEM_INVEST_TOLERANCE_BPS}`);
  }

  if (problems.length > 0 || poolManager === null || usdg === null) {
    return { kind: "INVALID", problems };
  }

  return {
    kind: "OK",
    config: {
      poolManager,
      usdg,
      wethUsdgFee,
      wethUsdgTickSpacing,
      stockPools,
      sharesQuoters,
      toleranceBps,
      receiptTimeoutMs: Number(env.NUVEM_INVEST_RECEIPT_TIMEOUT_MS ?? String(DEFAULT_RECEIPT_TIMEOUT_MS)),
    },
  };
}

/** One line for the startup log, so an operator can see what was understood. */
export function describeInvestmentConfig(result: InvestmentConfigResult): string {
  if (result.kind === "DISABLED") {
    return "investing: off (NUVEM_INVEST_POOLS is not set); settlement is unaffected";
  }
  if (result.kind === "INVALID") {
    return `investing: MISCONFIGURED — ${result.problems.join("; ")}`;
  }
  const { config } = result;
  const quoters =
    config.sharesQuoters.size === 0
      ? "no share destinations"
      : `${config.sharesQuoters.size} share destination(s): ${[...config.sharesQuoters.entries()]
          .map(([asset, quoter]) => (asset === quoter.toLowerCase() ? quoter : `${asset} via ${quoter}`))
          .join(", ")}`;
  return (
    `investing: on, ${config.stockPools.size} pool(s), ` +
    `${quoters}, ` +
    `tolerance ${config.toleranceBps} bps, ` +
    `WETH/USDG ${config.wethUsdgFee}/${config.wethUsdgTickSpacing}`
  );
}
