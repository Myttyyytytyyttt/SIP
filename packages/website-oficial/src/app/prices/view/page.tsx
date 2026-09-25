/**
 * /prices — public, server-rendered, and complete in the first response.
 *
 * WHO IT IS FOR. Somebody with no wallet and no session: today such a reader can
 * see nothing of the two things this product actually depends on — the Pyth
 * accounts that gate the SOL conversion, and the PreStocks mints the baskets buy.
 * This page is those facts, with the age or the source of every number beside it.
 *
 * NO PRIVY, NO CLIENT COMPONENT, NO FETCH IN THE BROWSER. The page mounts no
 * provider (the leaderboard's comment says why making a stranger download a
 * wallet SDK to read a page is a bad trade) and ships no client half at all, so
 * it renders with JavaScript off. `force-dynamic` because every figure is read at
 * request time and a cached price is a lie with a timestamp on it.
 */
import type { Metadata } from "next";

import { PricesView } from "@/components/prices-view";
import { SiteFooter } from "@/components/site-footer";
import { loadPrices } from "@/lib/prices-data";

export const metadata: Metadata = {
  title: "Prices — SaverFi",
  description:
    "SOL/USDC against Pyth, SPYx against its push account, ANTHROPIC against the issuer's own marks and its mint's transfer fee, and why each of the eight PreStocks is or is not offered. Read on the server, every figure with its age.",
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function PricesPage() {
  const model = await loadPrices();
  return (
    <div className="flex min-h-dvh flex-col">
      <PricesView model={model} />
      <SiteFooter now={model.builtAt} className="mt-auto" />
    </div>
  );
}
