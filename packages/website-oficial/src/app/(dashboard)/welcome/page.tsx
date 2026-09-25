/**
 * /welcome — the landing, whoever is looking (see components/welcome-landing.tsx).
 * Inside the (dashboard) layout for the Privy session the landing's Connect uses.
 */

import { WelcomeLanding } from "@/components/welcome-landing";
import { loadConfig } from "@/lib/load-config";

export const dynamic = "force-dynamic";

export default function WelcomePage() {
  return <WelcomeLanding walletsConfigured={loadConfig().ok} />;
}
