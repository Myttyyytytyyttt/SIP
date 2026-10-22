/**
 * THE SOCIAL CARDS (owner, 10-22): the picture a link to SaverFi shows in a
 * search result's preview, on X, in Telegram or Discord. 1200 × 630, drawn by
 * next/og at BUILD time (src/app/opengraph-image.tsx for the site,
 * src/app/docs/[slug]/opengraph-image.tsx for each docs page), so a share costs
 * no rendering.
 *
 * THE LANDING'S LOOK, from its own values (landing.tsx): the #0A0B11 ground, its
 * emerald glow from the top left, the white mark, Geist (next/og's own font, the
 * site's typeface; regular is the one weight it ships). Its words are the
 * site's own — the landing's eyebrow and headline, and the docs' "a vault only
 * your own wallet can open" — never new claims; no address on the card, since
 * the host may still change (src/lib/site-url.ts).
 *
 * next/og draws with Satori: every box with more than one child must say
 * `display: flex`, and only inline styles exist.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ReactNode } from "react";

export const OG_SIZE = { width: 1200, height: 630 } as const;

const GROUND = "#0A0B11";
const EMERALD = "#34d399";
const MUTED = "rgba(255,255,255,0.6)";

/** The white mark, as a data URL: read from public/ when the card is built, which is at build time. */
export async function markDataUrl(): Promise<string> {
  const png = await readFile(join(process.cwd(), "public/logo/sip-mark-white.png"));
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** The ground, the glow, the mark and the name on top, the rule along the bottom; the card's words below. */
function Frame({ mark, docs, children }: { readonly mark: string; readonly docs: boolean; readonly children: ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px 78px",
        backgroundColor: GROUND,
        backgroundImage: "radial-gradient(circle at 12% 10%, rgba(16,185,129,0.20) 0%, rgba(16,185,129,0) 45%)",
        color: "#ffffff",
        position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        {/* A plain <img>: Satori draws it, next/image does not exist there. 218 × 256, at 52 px tall. */}
        <img src={mark} width={44} height={52} alt="" />
        <div style={{ display: "flex", fontSize: 42, letterSpacing: "-0.01em" }}>
          SaverFi
          {docs ? <span style={{ marginLeft: 12, color: MUTED }}>Docs</span> : null}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>{children}</div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 6,
          backgroundImage: `linear-gradient(90deg, ${EMERALD}, rgba(52,211,153,0) 70%)`,
        }}
      />
    </div>
  );
}

/** The site's card: the landing's eyebrow, its headline, and its promise. */
export function SiteCard({ mark }: { readonly mark: string }) {
  return (
    <Frame mark={mark} docs={false}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 28, color: "rgba(255,255,255,0.75)" }}>
        <div style={{ width: 12, height: 12, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.8)" }} />
        A pension that builds itself, on Solana
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 22, fontSize: 86, lineHeight: 1.02, letterSpacing: "-0.03em" }}>
        <span>A slice of every trade,</span>
        <span style={{ color: EMERALD }}>put aside for later.</span>
      </div>
      <div style={{ display: "flex", marginTop: 36, fontSize: 26, color: MUTED }}>Only your wallet can open your vault · Beta</div>
    </Frame>
  );
}

/** A docs page's card: its group, its title and its line, as the page shows them. */
export function DocCard({ mark, group, title, description }: { readonly mark: string; readonly group: string; readonly title: string; readonly description: string }) {
  return (
    <Frame mark={mark} docs>
      <div style={{ display: "flex", fontSize: 22, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.5)" }}>{group}</div>
      <div style={{ display: "flex", marginTop: 18, maxWidth: 1040, fontSize: title.length > 32 ? 64 : 76, lineHeight: 1.06, letterSpacing: "-0.025em" }}>
        {title}
      </div>
      <div style={{ display: "flex", marginTop: 22, maxWidth: 980, fontSize: 32, lineHeight: 1.3, color: MUTED }}>{description}</div>
    </Frame>
  );
}
