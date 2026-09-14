/**
 * /wallets — the first REAL surface: pension key, vault, trading wallets.
 *
 * SERVER COMPONENT. It reads the environment at request time (never a
 * NEXT_PUBLIC_ value baked into the bundle), and renders nothing that depends
 * on Privy or wallet state — that starts inside <Providers>, gated on `ready`.
 * A missing variable renders the checklist instead of a broken page.
 *
 * Under SIP_CHAIN=solana the screen is a placeholder until the Solana wallet
 * screens exist, still inside <Providers> so the Solana Privy provider mounts
 * here exactly as it will for them.
 */

import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import Providers from "@/app/providers";
import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SetupChecklist } from "@/components/wallets/SetupChecklist";
import { WalletsScreen } from "@/components/wallets/WalletsScreen";
import {
  toPublicConfig,
  toSolanaPublicConfig,
  type ConfigProblem,
  type PublicConfig,
  type SolanaPublicConfig,
} from "@/lib/config";
import { loadConfig } from "@/lib/load-config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Wallets — SIP",
  description: "Your pension key, your vault, and the trading wallets that put aside a slice of every buy and sell.",
};

export default function WalletsPage() {
  const loaded = loadConfig();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 h-14 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/" aria-label="Back to the pension">
              <ArrowLeft aria-hidden />
            </Link>
          </Button>
          <div className="flex items-baseline gap-2">
            <h1 className="font-semibold tracking-tight">SIP</h1>
            <span className="text-xs text-muted-foreground">Wallets</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 p-4 lg:p-6">
        {loaded.ok ? (
          loaded.config.chain === "solana" ? (
            <SolanaScreen config={toSolanaPublicConfig(loaded.config)} />
          ) : (
            <Screen config={toPublicConfig(loaded.config)} />
          )
        ) : (
          <SetupCard problems={loaded.problems} />
        )}
      </main>
    </div>
  );
}

/** The browser's share of the configuration, built once and handed to both the provider and the screen. */
function Screen({ config }: { config: PublicConfig }) {
  return (
    <Providers config={config}>
      <WalletsScreen config={config} />
    </Providers>
  );
}

/** SIP_CHAIN=solana: the provider mounts, and the page says what is true. */
function SolanaScreen({ config }: { config: SolanaPublicConfig }) {
  return (
    <Providers config={config}>
      <Card>
        <CardHeader>
          <CardTitle>Solana wallets are on their way</CardTitle>
          <CardDescription>
            This deployment runs on Solana. The screens for your pension key, your vault and your trading wallets are
            the next release. Nothing here can move funds yet.
          </CardDescription>
        </CardHeader>
      </Card>
    </Providers>
  );
}

/**
 * The "collect every problem into a checklist" shape: fix all of them, restart,
 * reload. The list itself is shared with the dashboard's setup modal — this
 * route only supplies the card around it.
 */
function SetupCard({ problems }: { problems: readonly ConfigProblem[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>The wallets page is not configured</CardTitle>
        <CardDescription>
          The server is missing what it needs to read the chain. Set these in the package&apos;s environment, restart,
          and reload.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SetupChecklist problems={problems} />
      </CardContent>
    </Card>
  );
}
