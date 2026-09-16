"use client";

/**
 * The one client-only wrapper. `'use client'` must be line 1 of this file:
 * PrivyProvider is a third-party React context that mounts dialogs and iframes,
 * so importing it from a server component is the classic App Router failure
 * ("createContext is not a function" / "window is not defined"). Ported from
 * the Nuvem dashboard's src/app/providers.tsx (HEAD fd927b0).
 *
 * It also carries the runtime configuration down to the rest of the tree. The
 * server read `process.env` per request and passed the result as a prop, so no
 * `NEXT_PUBLIC_*` value had to be baked into the bundle at build time — which is
 * what keeps one Docker image usable on both a VPS and Railway.
 *
 * What arrives here is SolanaPublicConfig, never the server configuration: the
 * keyed RPC URLs stay on the server. It is the minimum the Solana wallet screens
 * build on: external Solana wallets only for login, no embedded wallet minted on
 * login, and Privy's Solana RPC pointed at this app's own relay.
 */

import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors, useSolanaLedgerPlugin } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { createContext, useContext, useMemo } from "react";

import type { SolanaPublicConfig } from "@/lib/config";

const SolanaConfigContext = createContext<SolanaPublicConfig | null>(null);

/** The browser's share of the configuration, for the Solana wallet screens. */
export function useSolanaConfig(): SolanaPublicConfig {
  const config = useContext(SolanaConfigContext);
  if (config === null) {
    throw new Error("useSolanaConfig() was called outside <Providers>. Wrap the component in it.");
  }
  return config;
}

/**
 * The same configuration, or null outside <Providers>, for a component that can
 * say LESS without it rather than fail.
 *
 * The live dashboard uses this to name a missing keeper seat: worth saying when
 * the configuration is there, never worth a thrown error when it is not (a unit
 * test rendering one panel, or any tree mounted without the provider).
 */
export function useSolanaConfigOrNull(): SolanaPublicConfig | null {
  return useContext(SolanaConfigContext);
}

/**
 * Solana Ledger support, mounted INSIDE PrivyProvider. A Ledger signs
 * transactions but not the message Sign-In With Solana needs, so a Ledger-backed
 * Phantom fails to log in with "There was an error attempting to sign the
 * transaction" unless this is mounted. It does nothing for software wallets.
 */
function SolanaLedgerSetup() {
  useSolanaLedgerPlugin();
  return null;
}

/**
 * The relay URL, absolute. @solana/kit's HTTP transport is handed a URL, and the
 * loader only knows the origin when the page passed one, so a relative path is
 * resolved against the page here. During server rendering there is no page; the
 * placeholder origin is never called, because Privy issues no RPC while rendering.
 */
function absoluteRelayUrl(url: string): string {
  return new URL(url, typeof window === "undefined" ? "http://localhost" : window.location.origin).href;
}

function Providers({ config, children }: { config: SolanaPublicConfig; children: React.ReactNode }) {
  // DEFAULT AUTO-CONNECT, DELIBERATELY. It silently reconnects only wallets that
  // already trust this site. Turned off, Phantom is missing from useWallets()
  // after every reload until the user clicks again, and the first write after a
  // refresh fails for want of a signer.
  const connectors = useMemo(() => toSolanaWalletConnectors(), []);

  // THE RPC PRIVY SIGNS AGAINST: before an embedded wallet signs, Privy prices and
  // simulates the transaction through it. It is the same-origin /api/solana-rpc,
  // never the keyed upstream. The WebSocket is the key-free public one the server
  // validated; kit opens it only when a subscription runs.
  const rpcUrl = useMemo(() => absoluteRelayUrl(config.solanaRpcUrl), [config.solanaRpcUrl]);
  const solana = useMemo(
    () => ({
      rpcs: {
        "solana:mainnet": {
          rpc: createSolanaRpc(rpcUrl),
          rpcSubscriptions: createSolanaRpcSubscriptions(config.solanaWsUrl),
          blockExplorerUrl: "https://solscan.io",
        },
      },
    }),
    [rpcUrl, config.solanaWsUrl],
  );

  return (
    <SolanaConfigContext.Provider value={config}>
      <PrivyProvider
        appId={config.privyAppId}
        {...(config.privyClientId ? { clientId: config.privyClientId } : {})}
        config={{
          // The PENSION KEY is an EXTERNAL wallet (Phantom, Solflare, Backpack):
          // it holds the withdrawal key for every saving in the vault, and an
          // email-recoverable custody model is the wrong place for that. Nothing is
          // minted on login; trading wallets are created on demand by the wallet
          // screens. The ethereum entry stays an explicit "off" so a change in
          // Privy's defaults can never mint an EVM wallet here.
          loginMethods: ["wallet"],
          embeddedWallets: {
            ethereum: { createOnLogin: "off" },
            solana: { createOnLogin: "off" },
          },
          externalWallets: { solana: { connectors } },
          solana,

          appearance: {
            landingHeader: "Connect your pension key",
            loginMessage:
              "Only your pension key can withdraw. The program is upgradeable during the beta.",
            // THE MARK, IN THE INK THIS MODAL'S GROUND NEEDS. Privy's
            // appearance.theme defaults to 'light' and nothing here pins a
            // theme, so the dialog paints on Privy's standard white: the black
            // glyph is the one the site itself shows on light surfaces
            // (site-footer.tsx's SipMark, black under dark:hidden). The white
            // file is the same shape in white ink and would be invisible here;
            // the landing loader gets away with it only because globals.css
            // uses that PNG as a mask, where the alpha is all that is read and
            // the colour comes from the gradient behind it.
            //
            // Served same-origin from public/, which is what makes it paint at
            // all: the golden CSP's img-src is 'self' data: blob: and one
            // WalletConnect host — no Privy origin — so an off-origin logo
            // would silently fail. It must stay a /public path, and the CSP
            // must not gain a host for it.
            logo: "/logo/sip-mark-black.png",
            // Solana only: an EVM wallet has nothing to sign here, and Phantom
            // offered through an ethereum path starts SIWE against a Solana
            // account and fails.
            walletChainType: "solana-only",
            // ORDER IS THE PRODUCT DECISION: Phantom and Backpack first, then
            // Solflare, then any other Solana extension the browser carries.
            // Every entry is a Solana wallet; nothing EVM is offered here.
            walletList: ["phantom", "backpack", "solflare", "detected_solana_wallets"],
          },
        }}
      >
        <SolanaLedgerSetup />
        {children}
      </PrivyProvider>
    </SolanaConfigContext.Provider>
  );
}

export default Providers;
