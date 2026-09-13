// Best-effort writer of the Solana drill's result into the `nuvem_solana`
// read-model schema, so the website shows the vault's history without walking
// mainnet's short-lived RPC history.
//
// SELF-CONTAINED, on purpose. The lab imports nothing from packages/keeper (the
// isolation the lab promised), so this repeats the keeper's read-model rules
// rather than sharing its code: DERIVED and REBUILDABLE, never a source of
// truth, and a write failure is a warning — the drill's on-chain result already
// happened and must never be undone by a database hiccup.
//
// Off unless NUVEM_SOLANA_DATABASE_URL (or DATABASE_URL) is set.

import pg from "pg";

export interface SolanaSettlement {
  readonly walletAddr: string;
  readonly nonce: bigint;
  readonly vaultAddr: string;
  readonly profitRaw: bigint;
  readonly contributionRaw: bigint;
  readonly txRef: string;
  readonly slot: bigint;
}

export interface SolanaInvestment {
  readonly vaultAddr: string;
  readonly target: string;
  readonly spentRaw: bigint;
  readonly receivedRaw: bigint;
  readonly txRef: string;
  readonly slot: bigint;
}

function databaseUrl(): string | null {
  const url = process.env.NUVEM_SOLANA_DATABASE_URL ?? process.env.DATABASE_URL;
  return url && url.trim() !== "" ? url.trim() : null;
}

/** Records both events under nuvem_solana; logs and swallows any failure. */
export async function recordDrillHistory(
  vault: { addr: string; owner: string; skimBps: number },
  link: { walletAddr: string },
  settlement: SolanaSettlement,
  investment: SolanaInvestment | null,
): Promise<void> {
  const url = databaseUrl();
  if (url === null) {
    console.log("history: no NUVEM_SOLANA_DATABASE_URL — skipping (the website simply won't show this run)");
    return;
  }
  const sslmode = (() => {
    try {
      return new URL(url).searchParams.get("sslmode")?.toLowerCase() ?? null;
    } catch {
      return null;
    }
  })();
  const client = new pg.Client({
    connectionString: url,
    ssl: sslmode === "disable" ? false : { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO nuvem_solana.vault (vault_addr, owner_addr, skim_bps)
       VALUES ($1,$2,$3) ON CONFLICT (vault_addr) DO UPDATE SET skim_bps = EXCLUDED.skim_bps`,
      [vault.addr, vault.owner, vault.skimBps],
    );
    await client.query(
      `INSERT INTO nuvem_solana.trading_link (wallet_addr, vault_addr, active)
       VALUES ($1,$2,true) ON CONFLICT (wallet_addr)
       DO UPDATE SET vault_addr = EXCLUDED.vault_addr, active = true`,
      [link.walletAddr, vault.addr],
    );
    await client.query(
      `INSERT INTO nuvem_solana.settlement_event
         (wallet_addr, nonce, vault_addr, profit_raw, contribution_raw, tx_ref, height)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (wallet_addr, nonce) DO NOTHING`,
      [
        settlement.walletAddr,
        settlement.nonce.toString(),
        settlement.vaultAddr,
        settlement.profitRaw.toString(),
        settlement.contributionRaw.toString(),
        settlement.txRef,
        settlement.slot.toString(),
      ],
    );
    if (investment !== null) {
      await client.query(
        `INSERT INTO nuvem_solana.investment_event
           (vault_addr, target, spent_raw, received_raw, tx_ref, height)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tx_ref) DO NOTHING`,
        [
          investment.vaultAddr,
          investment.target,
          investment.spentRaw.toString(),
          investment.receivedRaw.toString(),
          investment.txRef,
          investment.slot.toString(),
        ],
      );
    }
    console.log("history: recorded to nuvem_solana");
  } catch (error) {
    console.log(`history: write failed (drill result unaffected): ${error instanceof Error ? error.message : error}`);
  } finally {
    await client.end().catch(() => {});
  }
}
