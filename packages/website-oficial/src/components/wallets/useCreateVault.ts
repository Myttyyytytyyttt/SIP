"use client";

/**
 * The state machine behind CreateVaultCard: preview → sign → receipt.
 *
 * Ported from HEAD (fd927b0) src/components/CreateVaultCard.tsx, with the JSX
 * split off into CreateVaultCard.tsx and every Solana, basket and profit path
 * dropped.
 *
 * The browser does no chain reads at all. It asks /api/create-vault to prepare
 * the call — the server builds `initData` from
 * VaultFactory.protocolConfiguration(), predicts the CREATE2 address, checks the
 * cohort, and SIMULATES the transaction so a revert is named before anything is
 * signed. Only then does the wallet get asked for a signature.
 *
 * The chain switch is forced immediately before signing, because Privy only
 * *prompts* an external wallet to switch on connect: the user may have declined,
 * or switched away since. And the provider is requested AFTER the switch:
 * Privy's own JSDoc on `switchChain` says it does not update provider instances
 * already handed out.
 */

import type { ConnectedWallet } from "@privy-io/react-auth";
import { useCallback, useEffect, useRef, useState } from "react";
import { createWalletClient, custom, getAddress, type Address, type Hex } from "viem";

import { vaultFactoryAbi } from "@/lib/abi";
import { ROBINHOOD_CHAIN_ID, robinhoodChain } from "@/lib/chain";
import { UINT128_MAX, type PublicConfig } from "@/lib/config";
import { parseTagged } from "@/lib/serialize";

/**
 * Structural twin of `Read<T>` in src/lib/vault.ts. Declared here rather than
 * imported because vault.ts is server-only and this hook runs in the browser;
 * the shapes are identical, so either side's values satisfy the other.
 */
export type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/**
 * Wire shape of `POST /api/create-vault {action:"preview"}` — HEAD's
 * CreateVaultPreview. Declared locally for the same reason as `Read`: the
 * route's types may live in vault.ts. `cohortId` is a uint32 on chain; it
 * arrives as a number, or as a tagged bigint if the route serialises
 * PublicConfig.cohortId as-is — both are accepted and narrowed before signing.
 */
export interface CreateVaultPreview {
  readonly userSalt: Hex;
  readonly initData: Hex;
  readonly cohortId: number | bigint;
  readonly cohortRegistered: boolean;
  readonly vaultId: Hex | null;
  readonly predicted: Address | null;
  readonly predictionError: string | null;
  /** null when the simulation succeeded; the decoded revert otherwise. */
  readonly simulationError: string | null;
}

/** Wire shape of `POST /api/create-vault {action:"receipt"}`. */
export type ReceiptState =
  | { readonly state: "pending" }
  | { readonly state: "success" }
  | { readonly state: "reverted" };

interface ApiError {
  readonly error: string;
}

/** Where the write is, for the button label and for disabling everything else. */
export type CreatePhase = "idle" | "switching" | "signing" | "confirming";

export interface CreateVaultState {
  readonly label: string;
  readonly setLabel: (next: string) => void;
  readonly trimmedLabel: string;
  /** null while nothing has been asked for (empty name) or a request is in flight. */
  readonly preview: Read<CreateVaultPreview> | null;
  /** True from the moment the name changes until the route answers. */
  readonly previewing: boolean;
  readonly phase: CreatePhase;
  readonly txHash: Hex | null;
  /** The vault's address once the receipt says success; null before. */
  readonly created: Address | null;
  readonly failure: string | null;
  /** Every precondition holds: the button may be pressed. */
  readonly canCreate: boolean;
  readonly create: () => Promise<void>;
}

/** Two lines: a viem revert puts the useful part (the error name) on the second. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const lines = error.message.split("\n").filter((line) => line.trim() !== "");
    return lines.slice(0, 2).join(" ").trim();
  }
  return String(error);
}

/** HEAD's debounce: typing in the name field must not hammer the route. */
const PREVIEW_DEBOUNCE_MS = 350;

export function useCreateVault({
  admin,
  config,
  wallet,
  onCreated,
}: {
  admin: Address;
  config: PublicConfig;
  wallet: ConnectedWallet | null;
  onCreated: (vault: Address) => void;
}): CreateVaultState {
  const [label, setLabel] = useState("SIP pension");
  const [preview, setPreview] = useState<Read<CreateVaultPreview> | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [phase, setPhase] = useState<CreatePhase>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [created, setCreated] = useState<Address | null>(null);

  // The parent may re-render mid-flight (the receipt poll runs up to two
  // minutes); the callback that fires is always the latest one it passed.
  const onCreatedRef = useRef(onCreated);
  useEffect(() => {
    onCreatedRef.current = onCreated;
  }, [onCreated]);

  const trimmedLabel = label.trim();

  useEffect(() => {
    // A stale preview is worse than none: the salt it carries belongs to the
    // previous name, and signing it would put the vault at an address other
    // than the one the name on screen implies.
    setPreview(null);
    if (trimmedLabel === "") {
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/create-vault", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "preview",
              owner: admin,
              label: trimmedLabel,
              // No ceiling. `maxAggregateRolling30dWei` is a uint128 the contract
              // refuses to set to zero (PersonalVault.sol:916), so "unlimited" is
              // expressed as the largest value the field can hold — more ETH than
              // will ever exist. It is not a number a saver should be asked for,
              // and a low one is worse than useless: the ceiling is shared by
              // EVERY trading wallet in the vault, so one wallet exhausting it
              // silently blocks all the others for up to 30 days. (HEAD's 1e18
              // default would have done exactly that after 1 ETH of skims.)
              capWei: UINT128_MAX.toString(),
            }),
          });
          const text = await response.text();
          if (cancelled) return;
          if (!response.ok) {
            let message = text.slice(0, 300);
            try {
              message = (JSON.parse(text) as ApiError).error;
            } catch {
              /* keep the raw body */
            }
            setPreview({ ok: false, error: message });
            return;
          }
          setPreview({ ok: true, value: parseTagged<CreateVaultPreview>(text) });
        } catch (error) {
          if (!cancelled) setPreview({ ok: false, error: describe(error) });
        } finally {
          if (!cancelled) setPreviewing(false);
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [admin, trimmedLabel]);

  const canCreate =
    phase === "idle" &&
    created === null &&
    wallet !== null &&
    trimmedLabel !== "" &&
    preview !== null &&
    preview.ok &&
    preview.value.predicted !== null &&
    preview.value.cohortRegistered &&
    preview.value.simulationError === null;

  const create = useCallback(async () => {
    if (preview === null || !preview.ok || wallet === null || phase !== "idle" || created !== null) return;
    const prepared = preview.value;
    // `onCreated` needs the address, and the only place the browser can learn
    // it is the server's CREATE2 prediction — no prediction, no write.
    if (prepared.predicted === null) return;
    setFailure(null);
    setTxHash(null);
    try {
      setPhase("switching");
      await wallet.switchChain(ROBINHOOD_CHAIN_ID);

      setPhase("signing");
      const provider = await wallet.getEthereumProvider();
      const chain = robinhoodChain(config.walletRpcUrl, config.explorerUrl);
      const walletClient = createWalletClient({
        account: admin,
        chain,
        // Privy types getEthereumProvider() with its OWN `EIP1193Provider`
        // interface, not viem's — and it declares viem 2.55.5 while this
        // workspace pins 2.55.8 (pnpm dedupes them today; it need not tomorrow).
        // This cast crosses that boundary and does nothing else.
        transport: custom(provider as Parameters<typeof custom>[0]),
      });

      // Gas estimation and broadcast go through the wallet's own provider — the
      // server already simulated this exact call, so a revert would have been
      // reported in the preview rather than costing the user a failed transaction.
      const hash = await walletClient.writeContract({
        address: getAddress(config.factory),
        abi: vaultFactoryAbi,
        functionName: "createVault",
        // uint32 on chain, so viem wants a number here whichever way the route
        // serialised it.
        args: [prepared.userSalt, Number(prepared.cohortId), prepared.initData],
        chain,
        account: admin,
      });
      setTxHash(hash);

      setPhase("confirming");
      const outcome = await pollReceipt(hash);
      if (outcome === "reverted") {
        setFailure("The transaction was included but reverted. Nothing was created.");
        return;
      }
      if (outcome === "timeout") {
        setFailure(
          "The transaction was sent but has not been included yet. It may still land — reload in a moment " +
            "rather than sending a second one, which would create a different pension or revert.",
        );
        return;
      }
      setCreated(prepared.predicted);
      onCreatedRef.current(prepared.predicted);
    } catch (error) {
      setFailure(describe(error));
    } finally {
      setPhase("idle");
    }
  }, [admin, config.factory, config.walletRpcUrl, created, phase, preview, wallet]);

  return {
    label,
    setLabel,
    trimmedLabel,
    preview,
    previewing,
    phase,
    txHash,
    created,
    failure,
    canCreate,
    create,
  };
}

/** HEAD's receipt timing: a poll every 3 s, for two minutes. */
const RECEIPT_INTERVAL_MS = 3_000;
const RECEIPT_DEADLINE_MS = 120_000;

/**
 * Receipts are fetched from the server, not from the wallet: the wallet may be on
 * a different chain by then, and the RPC that can answer authoritatively is the
 * one this deployment is pinned to.
 */
async function pollReceipt(hash: Hex): Promise<"success" | "reverted" | "timeout"> {
  const deadline = Date.now() + RECEIPT_DEADLINE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_INTERVAL_MS));
    try {
      const response = await fetch("/api/create-vault", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "receipt", hash }),
      });
      if (!response.ok) continue;
      const outcome = parseTagged<ReceiptState>(await response.text());
      if (outcome.state === "success") return "success";
      if (outcome.state === "reverted") return "reverted";
    } catch {
      // A transient network error is not evidence about the transaction.
    }
  }
  return "timeout";
}
