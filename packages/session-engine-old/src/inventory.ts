// FIFO lot inventory, tracking whether each unit was acquired with cash.
//
// This is what separates "sold something you bought" from "sold something that
// arrived for free". Both look identical in the cash delta — the second one just
// manufactures profit out of nothing — and the wallet this engine was built for
// is holding 160 units of exactly that hazard right now.

export type Basis = "CASH_BASIS" | "ZERO_BASIS";

export interface Lot {
  readonly amount: bigint;
  readonly basis: Basis;
  readonly blockNumber: bigint;
}

export interface Acquisition {
  readonly token: string;
  readonly amount: bigint;
  readonly basis: Basis;
  readonly blockNumber: bigint;
}

export interface Disposal {
  readonly token: string;
  readonly amount: bigint;
  readonly blockNumber: bigint;
}

export interface DisposalOutcome {
  readonly token: string;
  readonly fromCashBasis: bigint;
  readonly fromZeroBasis: bigint;
  /** Disposed more than the inventory knows about — replay started too late. */
  readonly uncovered: bigint;
}

export class TokenInventory {
  private readonly lots = new Map<string, Lot[]>();

  acquire({ token, amount, basis, blockNumber }: Acquisition): void {
    if (amount <= 0n) return;
    const queue = this.lots.get(token) ?? [];
    queue.push({ amount, basis, blockNumber });
    this.lots.set(token, queue);
  }

  /** Consumes oldest-first and reports what basis the consumed units carried. */
  dispose({ token, amount }: Disposal): DisposalOutcome {
    let remaining = amount;
    let fromCashBasis = 0n;
    let fromZeroBasis = 0n;
    const queue = this.lots.get(token) ?? [];

    while (remaining > 0n && queue.length > 0) {
      const lot = queue[0]!;
      const take = lot.amount <= remaining ? lot.amount : remaining;
      if (lot.basis === "CASH_BASIS") fromCashBasis += take;
      else fromZeroBasis += take;
      remaining -= take;
      if (take === lot.amount) queue.shift();
      else queue[0] = { ...lot, amount: lot.amount - take };
    }
    this.lots.set(token, queue);

    // Unknown provenance is not the same as free: it means the replay window was
    // too short to know, which must refuse rather than assume either way.
    return { token, fromCashBasis, fromZeroBasis, uncovered: remaining };
  }

  balanceOf(token: string): bigint {
    return (this.lots.get(token) ?? []).reduce((sum, lot) => sum + lot.amount, 0n);
  }

  zeroBasisBalanceOf(token: string): bigint {
    return (this.lots.get(token) ?? [])
      .filter((lot) => lot.basis === "ZERO_BASIS")
      .reduce((sum, lot) => sum + lot.amount, 0n);
  }

  tokens(): string[] {
    return [...this.lots.keys()].filter((token) => this.balanceOf(token) > 0n).sort();
  }

  snapshot(): Record<string, { total: string; zeroBasis: string }> {
    const out: Record<string, { total: string; zeroBasis: string }> = {};
    for (const token of this.tokens()) {
      out[token] = {
        total: this.balanceOf(token).toString(),
        zeroBasis: this.zeroBasisBalanceOf(token).toString(),
      };
    }
    return out;
  }
}
