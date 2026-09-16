import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

/**
 * Geist for words, Geist Mono for every number — the two variables that
 * globals.css's @theme block reads. Loaded once, here.
 */
const sans = Geist({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

/**
 * One sentence, used by the page description and by both social cards, so a
 * change cannot land in one of the three and not the others.
 */
const DESCRIPTION =
  "A pension you build one trade at a time. A slice of your trading is put aside and invested in the assets you chose.";

export const metadata: Metadata = {
  title: "SaverFi — A pension that builds itself, on Solana",
  description: DESCRIPTION,
  // NO IMAGES AND NO `url`, so no metadataBase is needed: Next warns only for a
  // relative image URL. Phantom reads og:title before <title>, so the wallet
  // prompt says SaverFi; /wallets inherits this openGraph from the root layout.
  openGraph: { title: "SaverFi", siteName: "SaverFi", description: DESCRIPTION, type: "website" },
  twitter: { card: "summary", title: "SaverFi", description: DESCRIPTION },
  // NO `icons` KEY ON PURPOSE. Declaring one here overrides Next's file
  // convention, and the icons now come from src/app/{favicon.ico,icon.png,
  // apple-icon.png} — generated from the brand mark, content-hashed, and
  // emitted with their own sizes and types. The old public/favicon.ico was
  // Nuvem's mark and is gone: it would also have collided with app/favicon.ico.
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: next-themes writes the theme class onto <html>
    // before React hydrates, and that one attribute is allowed to differ.
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
