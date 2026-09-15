"use client";

/**
 * TAKE MONEY OUT: SOL above the vault's rent floor, and each token it holds.
 *
 * SOL. The balance, what Solana keeps as rent, and what can be withdrawn; an
 * amount typed in SOL (at most 9 decimals, read as text into lamports) or Max,
 * which is exactly the withdrawable lamports. With nothing to withdraw, where
 * savings come from and the vault's address to send a test amount to.
 *
 * TOKENS. The vault's largest holding of each mint, with the RPC's display
 * amount as it is (SPYx's is scaled, so it is never computed from raw), and 25 %,
 * 50 % and All taken from the raw amount, All being the raw amount itself. wSOL
 * arrives as SOL; SPYx carries the issuer's powers and the account it may create.
 * When the vault's listing cannot be read (anyone can open enough token accounts
 * for the vault to make it too large), the vault's own wSOL, USDC and SPYx
 * accounts, read by address, are offered instead, and the card says so. Each
 * withdrawal names the account its row showed, which the build route re-reads.
 *
 * Each withdrawal is one Phantom approval; the flow checks the amount and the
 * accounts before Phantom is asked.
 */

import { OFFERED_LEGS, USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";
import { RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { AddressLine } from "@/components/wallets/AddressLine";
import { TxProgress } from "@/components/wallets/TxProgress";
import { useVaultWrite, type TokenWithdrawRequest } from "@/hooks/use-vault-actions";
import { useVaultScreen } from "@/hooks/use-vault-state";
import { AmountError, SOL_DECIMALS, formatSol, formatUnits, parseUnits, rawFrom, shareOfRaw } from "@/lib/amounts";
import { LABEL } from "@/lib/classes";
import type { HoldingJson, VaultStateJson } from "@/lib/vault-api";
import { INVEST_COPY, VAULT_COPY, WITHDRAW_COPY, shortAddress } from "@/lib/vault-copy";

type VaultWrite = ReturnType<typeof useVaultWrite>;

/** The shares a token row offers, in percent. */
export const TOKEN_SHARES = [25, 50, 100] as const;

/** "wSOL", "USDC", an offered leg's symbol, or the mint shortened. */
export function tokenLabel(mint: string): string {
  if (mint === WSOL_MINT) return "wSOL";
  if (mint === USDC_MINT) return "USDC";
  return OFFERED_LEGS.find((leg) => leg.mint === mint)?.symbol ?? shortAddress(mint);
}

/** The largest holding of each mint, in the order first seen: the account the build route withdraws from. */
export function largestHoldings(items: readonly HoldingJson[]): HoldingJson[] {
  const byMint = new Map<string, HoldingJson>();
  for (const item of items) {
    const amount = rawFrom(item.amountRaw);
    if (amount === null || amount === 0n) continue;
    const current = byMint.get(item.mint);
    if (current === undefined || (rawFrom(current.amountRaw) ?? 0n) < amount) byMint.set(item.mint, item);
  }
  return [...byMint.values()];
}

export type TokenRows =
  | { readonly source: "listing"; readonly rows: HoldingJson[] }
  /** The listing could not be read; these are the vault's own associated accounts, read by address. */
  | { readonly source: "own_accounts"; readonly rows: HoldingJson[] }
  | { readonly source: "unreadable"; readonly rows: readonly [] };

/**
 * What the token section offers: the largest holding of each mint the vault's
 * listing found, or, when that listing could not be read (someone can open enough
 * token accounts for the vault to make it too large), the vault's own wSOL, USDC
 * and leg accounts that hold something, read by address.
 */
export function tokenRows(state: VaultStateJson): TokenRows {
  if (state.holdings.status === "exists") return { source: "listing", rows: largestHoldings(state.holdings.items) };
  if (state.vaultTokenAccounts.status !== "exists") return { source: "unreadable", rows: [] };
  const own = state.vaultTokenAccounts.items.flatMap((item): HoldingJson[] =>
    item.status === "exists" && typeof item.amountRaw === "string" && typeof item.decimals === "number" && typeof item.uiAmount === "string"
      ? [{ tokenAccount: item.address, mint: item.mint, amountRaw: item.amountRaw, decimals: item.decimals, uiAmount: item.uiAmount, tokenProgram: item.tokenProgram }]
      : [],
  );
  return { source: "own_accounts", rows: largestHoldings(own) };
}

/** "wSOL, USDC and SPYx": the vault's own token accounts, in the order the state lists them. */
const OWN_ACCOUNT_SYMBOLS = (() => {
  const symbols = ["wSOL", "USDC", ...OFFERED_LEGS.map((leg) => leg.symbol)];
  return `${symbols.slice(0, -1).join(", ")} and ${symbols[symbols.length - 1]}`;
})();

/** The text Max puts in the field: exactly the withdrawable lamports, as SOL. */
export const maxWithdrawalText = (withdrawableLamports: bigint): string => formatUnits(withdrawableLamports, SOL_DECIMALS);

export type Withdrawal = { readonly ok: true; readonly lamports: bigint } | { readonly ok: false; readonly message: string };

/** The SOL amount typed, in lamports, or why it cannot be withdrawn. */
export function readWithdrawal(text: string, withdrawableLamports: bigint): Withdrawal {
  try {
    const lamports = parseUnits(text, SOL_DECIMALS, WITHDRAW_COPY.amount);
    if (lamports === 0n) return { ok: false, message: WITHDRAW_COPY.zero };
    if (lamports > withdrawableLamports) return { ok: false, message: WITHDRAW_COPY.aboveWithdrawable(formatSol(withdrawableLamports)) };
    return { ok: true, lamports };
  } catch (error) {
    if (error instanceof AmountError) return { ok: false, message: error.message };
    throw error;
  }
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className={LABEL}>{label}</dt>
      <dd>
        <Num>{children}</Num>
      </dd>
    </div>
  );
}

export function WithdrawCard() {
  const screen = useVaultScreen();
  const sol = useVaultWrite("withdraw:sol");
  const tokens = useVaultWrite("withdraw:tokens");
  const [amountText, setAmountText] = useState("");
  if (screen === null) return null;
  const { view } = screen;

  const header = (description: ReactNode) => (
    <CardHeader>
      <CardTitle>{WITHDRAW_COPY.title}</CardTitle>
      {description}
      <CardAction>
        <Button type="button" variant="outline" size="sm" onClick={() => screen.refresh()}>
          <RefreshCw aria-hidden />
          {WITHDRAW_COPY.refresh}
        </Button>
      </CardAction>
    </CardHeader>
  );

  if (view.kind === "loading") {
    return (
      <Card aria-busy="true" aria-label={WITHDRAW_COPY.title}>
        <CardHeader>
          <CardTitle>{WITHDRAW_COPY.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (view.kind === "unreadable" || view.state.vault.status === "unreadable") return <Card>{header(<CardDescription role="alert">{VAULT_COPY.unreadable}</CardDescription>)}</Card>;
  const { state } = view;
  if (state.vault.status === "missing") return <Card>{header(<CardDescription>{WITHDRAW_COPY.needsVault}</CardDescription>)}</Card>;

  return (
    <Card>
      {header(null)}
      <CardContent className="space-y-6">
        <SolSection state={state} write={sol} amountText={amountText} setAmountText={setAmountText} />
        <TokenSection state={state} write={tokens} />
      </CardContent>
    </Card>
  );
}

function SolSection({
  state,
  write,
  amountText,
  setAmountText,
}: {
  readonly state: VaultStateJson;
  readonly write: VaultWrite;
  readonly amountText: string;
  readonly setAmountText: (text: string) => void;
}) {
  const { vault } = state;
  const lamports = rawFrom(vault.lamports) ?? 0n;
  const rentFloor = rawFrom(vault.rentFloor) ?? 0n;
  const withdrawable = rawFrom(vault.withdrawableLamports) ?? 0n;
  const reading = readWithdrawal(amountText, withdrawable);
  const blocked = write.running || write.busyElsewhere || write.unconfirmed;
  // While investing is on, an armed keeper wraps and converts SOL that reaches the vault at its next sweep.
  const investing = state.policy.status === "exists" && state.policy.state?.enabled === true;

  return (
    <section className="space-y-3" data-section="sol">
      <h3 className={LABEL}>{WITHDRAW_COPY.sol}</h3>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Fact label={WITHDRAW_COPY.balance}>{formatSol(lamports)} SOL</Fact>
        <Fact label={WITHDRAW_COPY.withdrawable}>{formatSol(withdrawable)} SOL</Fact>
      </dl>
      <p className="text-xs text-muted-foreground">{WITHDRAW_COPY.keptAsRent(formatSol(rentFloor))}</p>
      {investing ? (
        <p role="note" className="text-xs">
          {WITHDRAW_COPY.investingOn}
        </p>
      ) : null}
      {withdrawable === 0n ? (
        <div className="space-y-1">
          <p className="text-xs">{WITHDRAW_COPY.empty}</p>
          <div className={LABEL}>{WITHDRAW_COPY.vaultAddress}</div>
          <AddressLine address={vault.address} />
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="withdraw-sol-amount">{WITHDRAW_COPY.amount}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="withdraw-sol-amount"
              inputMode="decimal"
              autoComplete="off"
              value={amountText}
              disabled={blocked}
              onChange={(event) => setAmountText(event.target.value)}
              className="max-w-48 font-mono"
            />
            <span className="text-sm text-muted-foreground">SOL</span>
            <Button type="button" size="sm" variant="ghost" disabled={blocked} onClick={() => setAmountText(maxWithdrawalText(withdrawable))}>
              {WITHDRAW_COPY.max}
            </Button>
          </div>
          {amountText.trim() !== "" && !reading.ok ? (
            <p role="alert" className="text-xs text-destructive">
              {reading.message}
            </p>
          ) : null}
          <Button
            type="button"
            disabled={blocked || !reading.ok}
            aria-busy={write.running}
            // An explicit amount: the flow gets the lamports read from the field, never a click event.
            onClick={() => {
              if (reading.ok) void write.withdraw(reading.lamports);
            }}
          >
            {write.running ? WITHDRAW_COPY.withdrawing : WITHDRAW_COPY.withdrawSol}
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{WITHDRAW_COPY.solRule(formatSol(rentFloor))}</p>
      <TxProgress
        progress={write.progress}
        successLabel={WITHDRAW_COPY.withdrawn}
        onBuildAgain={() => void write.buildAgain()}
        onCheckAgain={() => void write.checkAgain()}
        onDismiss={() => write.dismiss()}
      />
    </section>
  );
}

function TokenSection({ state, write }: { readonly state: VaultStateJson; readonly write: VaultWrite }) {
  const offered = tokenRows(state);
  const blocked = write.running || write.busyElsewhere || write.unconfirmed;
  const withdraw = (request: TokenWithdrawRequest): void => void write.withdrawToken(request);

  return (
    <section className="space-y-3" data-section="tokens">
      <h3 className={LABEL}>{WITHDRAW_COPY.tokens}</h3>
      {offered.source === "unreadable" ? (
        <p className="text-xs text-muted-foreground">{WITHDRAW_COPY.tokensUnreadable}</p>
      ) : (
        <>
          {offered.source === "own_accounts" ? <p className="text-xs text-muted-foreground">{WITHDRAW_COPY.tokensOwnAccountsOnly(OWN_ACCOUNT_SYMBOLS)}</p> : null}
          {offered.rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">{offered.source === "own_accounts" ? WITHDRAW_COPY.ownAccountsEmpty : WITHDRAW_COPY.noTokens}</p>
          ) : (
            <ul className="divide-y">
              {offered.rows.map((holding) => (
                <TokenRow key={holding.tokenAccount} holding={holding} rents={state.rents} blocked={blocked} onWithdraw={withdraw} />
              ))}
            </ul>
          )}
        </>
      )}
      <TxProgress
        progress={write.progress}
        successLabel={WITHDRAW_COPY.withdrawn}
        onBuildAgain={() => void write.buildAgain()}
        onCheckAgain={() => void write.checkAgain()}
        onDismiss={() => write.dismiss()}
      />
    </section>
  );
}

function TokenRow({
  holding,
  rents,
  blocked,
  onWithdraw,
}: {
  readonly holding: HoldingJson;
  readonly rents: VaultStateJson["rents"];
  readonly blocked: boolean;
  readonly onWithdraw: (request: TokenWithdrawRequest) => void;
}) {
  const amount = rawFrom(holding.amountRaw) ?? 0n;
  const leg = OFFERED_LEGS.find((entry) => entry.mint === holding.mint);
  const legRent = rawFrom(rents?.legTokenAccounts[holding.mint]);

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0" data-mint={holding.mint}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{tokenLabel(holding.mint)}</span>
        <Num>{holding.uiAmount}</Num>
      </div>
      {holding.mint === WSOL_MINT ? <p className="text-xs text-muted-foreground">{WITHDRAW_COPY.wsolNote}</p> : null}
      {leg !== undefined ? (
        <>
          <p className="text-xs text-muted-foreground">{INVEST_COPY.freezeShort}</p>
          <p className="text-xs text-muted-foreground">{WITHDRAW_COPY.createsLegAccount(leg.symbol, legRent === null ? "some" : formatSol(legRent))}</p>
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {TOKEN_SHARES.map((percent) => {
          const share = shareOfRaw(amount, percent);
          return (
            <Button
              key={percent}
              type="button"
              size="sm"
              variant="outline"
              disabled={blocked || share === 0n}
              onClick={() => onWithdraw({ mint: holding.mint, amountRaw: share, vaultTokenAccount: holding.tokenAccount, tokenProgram: holding.tokenProgram })}
            >
              {WITHDRAW_COPY.share(percent)}
            </Button>
          );
        })}
      </div>
    </li>
  );
}
