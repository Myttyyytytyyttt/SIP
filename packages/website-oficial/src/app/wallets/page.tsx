/**
 * /wallets — the deep link to the wallets surface: pension key, vault, trading wallets.
 *
 * SERVER COMPONENT. It reads the environment at request time (never a
 * NEXT_PUBLIC_ value baked into the bundle), and renders nothing that depends
 * on Privy or wallet state — that starts inside <Providers>. A missing variable
 * renders the checklist instead of a broken page.
 *
 * With a configuration it mounts <Providers> around WalletsScreen, the same
 * screen the dashboard's "Manage wallets" modal shows.
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
import { toSolanaPublicConfig, type ConfigProblem, type SolanaPublicConfig } from "@/lib/config";
import { loadConfig } from "@/lib/load-config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Wallets — SaverFi",
  description: "Your pension key, your vault, and the trading wallets linked to it.",
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
            <h1 className="font-semibold tracking-tight">SaverFi</h1>
            <span className="text-xs text-muted-foreground">Wallets</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 p-4 lg:p-6">
        {loaded.ok ? <SolanaScreen config={toSolanaPublicConfig(loaded.config)} /> : <SetupCard problems={loaded.problems} />}
      </main>
    </div>
  );
}

/** The provider mounts, and everything that depends on Privy starts inside it. */
function SolanaScreen({ config }: { config: SolanaPublicConfig }) {
  return (
    <Providers config={config}>
      <WalletsScreen />
    </Providers>
  );
}

/**
 * The "collect every problem into a checklist" shape: fix all of them, redeploy,
 * reload. The list itself is shared with the dashboard's setup modal — this
 * route only supplies the card around it.
 */
function SetupCard({ problems }: { problems: readonly ConfigProblem[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>The wallets page is not configured</CardTitle>
        <CardDescription>
          The server is missing what it needs to read the chain. Set these in the deployment&apos;s environment, redeploy (or restart a local server),
          and reload.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SetupChecklist problems={problems} />
      </CardContent>
    </Card>
  );
}
