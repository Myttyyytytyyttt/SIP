/**
 * The bottom of the page: what SIP is, in one line, and the way out of it.
 *
 * SERVER COMPONENT, and it stays one. There is no state here and nothing to
 * hydrate — which is the point of taking `now` as a prop instead of reading the
 * clock. `new Date().getFullYear()` in a client component renders one year on
 * the server and possibly another in the browser; every date on this page comes
 * from the dashboard's own `now` for exactly that reason, and the copyright is
 * not the place to break the rule.
 *
 * IT SAYS NOTHING THE RULE CAN CONTRADICT. "How it works" is deliberately
 * written without the rate or the threshold in it: those live in SavingsRule
 * and the user can change them, and a footer that says 2% under a panel set to
 * 1% is worse than a footer that says neither. It does not pick a mode either:
 * a vault measures its trading as volume or as realized profit. The strip at
 * the top of the main column is where the live numbers belong.
 *
 * The brand marks are inline SVG because lucide-react 1.x REMOVED its brand
 * icons — there is no `Twitter`, `Github` or `Twitch` export to import (verified
 * against the installed 1.41.0). Mail is a real lucide icon and comes from there.
 */

import { Mail } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { Separator } from "@/components/ui/separator";
import { LABEL, MONO } from "@/lib/classes";
import { cn } from "@/lib/utils";

/**
 * PLACEHOLDERS, and the `#` is the honest part: none of these pages exist yet,
 * exactly like the header's own nav. `/wallets` is deliberately NOT here — the
 * way into wallet management is the sidebar's "Manage wallets", which opens a
 * modal over the dashboard; a second, worse door in the footer would undo that.
 */
const LINKS = [
  { title: "Pension", href: "/" },
  // A real route now, not an anchor into a sidebar that only exists from lg up.
  { title: "Activity", href: "/activity" },
  { title: "Docs", href: "#" },
  { title: "Privacy", href: "#" },
  { title: "Terms", href: "#" },
] as const;

/** The product in three lines. No numbers — see the note at the top of the file. */
const STEPS = [
  "Trade where you already trade — GMGN, Axiom, your own router.",
  "A slice of that trading — of its volume, or of its realized profit — is set aside.",
  "When the pile is big enough, it buys your basket.",
] as const;

/**
 * One look for every link in here, so the list and the icons cannot drift apart.
 * The focus ring is spelled out because these are plain anchors: everything else
 * on the page is a shadcn Button and carries its own, and the browser default is
 * nearly invisible against this ground.
 */
const QUIET =
  "rounded-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

export function SiteFooter({ now, className }: { now: string; className?: string }) {
  // ISO 8601, always `YYYY-…` — the same string the rest of the page dates from.
  const year = now.slice(0, 4);

  return (
    <footer className={cn("border-t", className)}>
      {/* Full-bleed with the main column's own padding: the dashboard above is not centred in a container, so neither is this. */}
      <div className="px-4 lg:px-6">
        {/*
          THREE COLUMNS, NOT TWO. The page above is full-bleed, so this is too —
          and a two-block footer pinned to opposite edges of a 1440 viewport is a
          third of a screen of nothing in the middle. Three columns fill the width
          at the sizes people actually use it; the prose is capped so it does not
          stretch into an unreadable line on an ultrawide.
        */}
        <div className="grid gap-10 py-10 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            {/* The mark, then the header's wordmark at the other end of the page. h2, not h1 — the page already has one. */}
            <div className="flex items-center gap-2.5">
              <SipMark className="h-7 w-auto" />
              <div className="flex items-baseline gap-2">
                <h2 className="font-semibold tracking-tight">SaverFi</h2>
              </div>
            </div>

            <p className="mt-3 max-w-sm text-sm text-muted-foreground">
              A pension you build one trade at a time. A slice of your trading — its volume or its realized profit —
              put aside and invested, wherever you happen to be trading.
            </p>
          </div>

          <div>
            <h3 className={LABEL}>Explore</h3>
            <ul className="mt-4 space-y-2.5 text-sm">
              {LINKS.map(({ title, href }) => (
                <li key={title}>
                  <Link className={QUIET} href={href}>
                    {title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className={LABEL}>How it works</h3>
            <ol className="mt-4 max-w-sm space-y-3 text-sm">
              {STEPS.map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span className={cn(MONO, "text-xs leading-5 text-muted-foreground")}>{index + 1}</span>
                  <span className="leading-5 text-muted-foreground">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <Separator />

        <div className="flex flex-col-reverse items-center justify-between gap-x-2 gap-y-5 py-6 text-sm sm:flex-row">
          <span className="text-muted-foreground">
            © <span className={MONO}>{year}</span> SaverFi. Your keys, your pension.
          </span>

          <div className="flex items-center gap-5">
            <a aria-label="Email" className={QUIET} href="#">
              <Mail className="size-4" aria-hidden />
            </a>
            <a aria-label="X" className={QUIET} href="#">
              <XMark />
            </a>
            <a aria-label="GitHub" className={QUIET} href="#">
              <GitHubMark />
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

/**
 * THE MARK, ONE PER THEME.
 *
 * The source art is two flat PNGs with no alpha — black on white, white on
 * black — so either one dropped straight in would paint its own rectangle over
 * the page. `public/logo/sip-mark-*.png` are the ink cut out of them: the same
 * shape, transparent ground, trimmed to the glyph (218 x 256 of the original
 * 5504 x 3072 sheet, which was almost all margin).
 *
 * Two <Image>s rather than one recoloured asset, because a PNG cannot take
 * `currentColor`. `dark:` is the class-strategy variant next-themes sets on
 * <html> before React hydrates, so the right one is on screen from the first
 * paint — no flash of the wrong ink.
 *
 * alt="" on purpose: the wordmark beside it already says SIP, and a screen
 * reader announcing the name twice is worse than not announcing the image.
 */
const MARK = { width: 218, height: 256 } as const;

function SipMark({ className }: { className?: string }) {
  return (
    <>
      <Image alt="" className={cn("dark:hidden", className)} src="/logo/sip-mark-black.png" {...MARK} />
      <Image alt="" className={cn("hidden dark:block", className)} src="/logo/sip-mark-white.png" {...MARK} />
    </>
  );
}

/**
 * Brand marks, inline. `currentColor` and `size-4` so they take the link's
 * colour and match the lucide icon beside them at every size.
 */
function XMark() {
  return (
    <svg aria-hidden className="size-4" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg aria-hidden className="size-4" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}
