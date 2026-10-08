"use client";

/**
 * THE LANDING'S GROUND (owner, 10-08: "prefiero los grids", over an aurora): the
 * launch film's blueprint left behind as the page's floor, drawn in code — no
 * footage, nothing fetched, sharp at any size.
 *
 * The lines repeat the rhythm of the S's own edges (the film's H_LINES/V_LINES
 * in launch-video's MarkBuild), hairline and faint, strongest around the frame
 * and fading to the edges; now and then a point of light runs along one of them
 * toward the frame — a slice arriving — and the frame sits in a slow emerald
 * halo, the S's bloom. It appears with the page (data-loaded), drifts with the
 * scroll a little slower than the frame (--p), and stands still under reduced
 * motion.
 */

import { useEffect, useRef } from "react";

import { usd } from "@/lib/format";

/** The S's grid in the film (launch-video MarkBuild): its edges, on a 1272×1488 mark. */
const MARK_H_LINES = [0, 271, 497, 607, 880, 989, 1219, 1488] as const;
const MARK_V_LINES = [0, 275, 998, 1272] as const;
/** One repeat of that rhythm on the page, in CSS pixels. */
const TILE_W = 520;
const TILE_H = (TILE_W * 1488) / 1272;
const hLines = MARK_H_LINES.map((y) => (y / 1488) * TILE_H);
const vLines = MARK_V_LINES.map((x) => (x / 1272) * TILE_W);

/** The S's seven pieces, vectorised in launch-video (src/components/Logo.tsx), on its 1272×1488 grid. */
const MARK_W = 1272;
const MARK_H = 1488;
const MARK_PIECES: readonly (readonly (readonly [number, number])[])[] = [
  [[275, 0], [998, 0], [998, 271], [275, 271]],
  [[998, 0], [1272, 271], [1272, 497], [998, 497]],
  [[0, 271], [275, 271], [275, 607], [0, 607]],
  [[0, 607], [998, 607], [1272, 880], [275, 880]],
  [[998, 880], [1272, 880], [1272, 1219], [998, 1219]],
  [[0, 989], [275, 989], [275, 1219], [0, 1219]],
  [[0, 1219], [998, 1219], [998, 1488], [275, 1488]],
];

/**
 * The marks that drift beside the headline: the basket's two assets and what
 * savings arrive as. Nearer ones are larger, sharper and move more with the
 * scroll (--depth); farther ones are small, dim and soft.
 */
const FLOATS = [
  { src: "/stocks/SPYx.png", x: "52%", y: "15%", size: 34, opacity: 0.55, blur: 0, drift: 9, depth: 1 },
  { src: "/stocks/ANTHROPIC.png", x: "61%", y: "27%", size: 26, opacity: 0.4, blur: 1.2, drift: 11, depth: 0.7 },
  { src: "/stocks/SOL.png", x: "45%", y: "29%", size: 18, opacity: 0.3, blur: 2, drift: 13, depth: 0.45 },
  { src: "/stocks/USDC.png", x: "66%", y: "10%", size: 16, opacity: 0.28, blur: 2.4, drift: 12, depth: 0.35 },
] as const;

/** A light every this often, on a line picked in turn: calm, one at a time. */
const PULSE_EVERY_MS = 1700;
const PULSE_MS = 2600;

export function LandingBackdrop() {
  const pulses = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = pulses.current;
    if (!layer) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let n = 0;
    const spawn = () => {
      // Nothing while the tab is hidden: a browser throttles the timer, and a
      // burst of queued lights on return would be the opposite of calm.
      if (document.hidden) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const horizontal = n % 3 !== 2;
      const fromStart = n % 2 === 0;
      n += 1;
      const el = document.createElement("span");
      el.className = horizontal ? "sf-pulse sf-pulse-h" : "sf-pulse sf-pulse-v";
      if (horizontal) {
        // A horizontal line of the grid, in the band the frame sits in.
        const rows: number[] = [];
        for (let y = vh * 0.45; y < vh * 0.95; y += TILE_H) for (const dy of hLines) rows.push(Math.round(y + dy - TILE_H / 2));
        const y = rows[(n * 5) % rows.length] ?? vh * 0.7;
        el.style.top = `${y}px`;
        el.style.setProperty("--from", fromStart ? "-12vw" : "112vw");
        el.style.setProperty("--to", fromStart ? "34vw" : "66vw");
        el.style.setProperty("--flip", fromStart ? "1" : "-1");
      } else {
        const cols: number[] = [];
        for (let x = vw / 2 - TILE_W * 2; x < vw / 2 + TILE_W * 2; x += TILE_W) for (const dx of vLines) cols.push(Math.round(x + dx));
        const x = cols[(n * 3) % cols.length] ?? vw / 2;
        el.style.left = `${x}px`;
        el.style.setProperty("--from", "-14vh");
        el.style.setProperty("--to", "40vh");
      }
      el.style.animationDuration = `${PULSE_MS}ms`;
      el.addEventListener("animationend", () => el.remove(), { once: true });
      layer.appendChild(el);
    };
    const first = window.setTimeout(spawn, 900);
    const timer = window.setInterval(spawn, PULSE_EVERY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      layer.replaceChildren();
    };
  }, []);

  return (
    <div className="sf-backdrop sf-grid" aria-hidden>
      <svg className="sf-grid-lines" width="100%" height="100%">
        <defs>
          {/* Centred on the screen, so the S's rhythm sits symmetric around the frame. */}
          <pattern id="sf-grid-tile" width={TILE_W} height={TILE_H} patternUnits="userSpaceOnUse" x="50%" y="62%">
            {vLines.map((x) => (
              <line key={`v${x}`} x1={x} x2={x} y1={0} y2={TILE_H} />
            ))}
            {hLines.map((y) => (
              <line key={`h${y}`} x1={0} x2={TILE_W} y1={y} y2={y} />
            ))}
            {/* The film's 45° guides, dashed and fainter still. */}
            <line className="sf-grid-diag" x1={0} y1={TILE_H * 0.18} x2={TILE_W * 0.82} y2={TILE_H} />
            <circle className="sf-grid-node" cx={vLines[1]} cy={hLines[2]} r={1.6} />
            <circle className="sf-grid-node" cx={vLines[2]} cy={hLines[5]} r={1.6} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#sf-grid-tile)" />
      </svg>
      {/* The S itself, enormous and faint, behind the frame: the intro's S leaves its shadow on the page. */}
      <svg className="sf-giant-s" viewBox={`0 0 ${MARK_W} ${MARK_H}`} preserveAspectRatio="xMidYMid meet">
        {MARK_PIECES.map((piece, i) => (
          <path key={i} d={`M${piece.map(([x, y]) => `${x} ${y}`).join(" L")} Z`} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      {/* The S's bloom, behind the frame. */}
      <div className="sf-halo" />
      <div ref={pulses} className="sf-pulses" />
      {/* What the pension buys and what it is paid in, drifting at different depths in the space beside the headline. */}
      <div className="sf-floats">
        {FLOATS.map((f) => (
          <img
            key={f.src}
            className="sf-float"
            src={f.src}
            alt=""
            style={{ left: f.x, top: f.y, width: f.size, height: f.size, opacity: f.opacity, filter: f.blur ? `blur(${f.blur}px)` : undefined, animationDuration: `${f.drift}s`, ["--depth" as string]: f.depth }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * EXAMPLE ACTIVITY ON THE GROUND (owner, 10-08: "que se vea bonito" while there
 * are no users yet). Small glass cards in the gutters beside the frame, one
 * every few seconds: a slice put aside from a trade, a pile invested.
 *
 * WHAT A TRADE DOES, NOT WHO DID IT (owner, 10-08: no "Example" tag). The
 * amounts are made up, so a card names no one and no moment: no address, no
 * "just now". It shows what one trade puts aside and what a pile buys, the way
 * the frame shows "Example — nobody's pension" — never that strangers are saving
 * here right now. Once there is real activity, show the chain's own recent
 * settlements and buys instead, with their addresses.
 *
 * Only where the gutters can hold a card (they are measured beside the frame at
 * every card), only once the page has arrived, never while the scroll is taking
 * the frame into the app, never while the tab is hidden, never under reduced motion.
 */
interface ExampleEvent {
  readonly kind: "saved" | "invested";
  readonly usd: number;
  readonly token: string;
  /** For a slice: the trade it came from. */
  readonly trade?: { readonly side: "buy" | "sell"; readonly usd: number };
}

/** The traded tokens and the basket are the sample's (src/mocks/data.ts). */
const EXAMPLES: readonly ExampleEvent[] = [
  { kind: "saved", usd: 16.67, token: "CASHCAT", trade: { side: "sell", usd: 1667.22 } },
  { kind: "invested", usd: 25.53, token: "SPYx" },
  { kind: "saved", usd: 8.4, token: "OPENAI", trade: { side: "buy", usd: 840.1 } },
  { kind: "saved", usd: 20.35, token: "pBTC3x", trade: { side: "buy", usd: 2035.46 } },
  { kind: "invested", usd: 17.02, token: "ANTHROPIC" },
  { kind: "saved", usd: 3.67, token: "SPACEX", trade: { side: "sell", usd: 367.21 } },
  { kind: "saved", usd: 12.9, token: "ANTHROPIC", trade: { side: "sell", usd: 1290 } },
  { kind: "invested", usd: 10, token: "SPYx" },
  { kind: "saved", usd: 6.39, token: "OPENAI", trade: { side: "buy", usd: 638.96 } },
  { kind: "saved", usd: 27.34, token: "CASHCAT", trade: { side: "sell", usd: 2734.4 } },
  { kind: "invested", usd: 14.25, token: "ANTHROPIC" },
  { kind: "saved", usd: 9.15, token: "SPYx", trade: { side: "sell", usd: 914.79 } },
];

/** A card every this often, alternating sides; it stays CARD_MS, so a side never holds two. */
const CARD_EVERY_MS = 2600;
const CARD_MS = 4200;
const CARD_W = 236;
/** A beam's light takes this long to reach the frame; the card shows as it arrives. */
const BEAM_MS = 700;
/** Below this the gutters cannot hold a terminal and its beam, or a card: none of this shows. */
const MIN_GUTTER = 250;
const TERMINAL_W = 150;
const EDGE = 24;

/**
 * THE TERMINALS (owner, 10-08, from the launch film): where the trading happens.
 * A SaverFi wallet trades in any of them; a beam of light carries the slice from
 * the terminal to the frame — the vault — and the card says what it was.
 * `row` is the card's height in the frame, as a share of it.
 */
const TERMINALS = [
  { name: "Axiom", logo: "/landing/terminals/axiom.png", side: "left", row: 0.06 },
  { name: "GMGN", logo: "/landing/terminals/gmgn.png", side: "right", row: 0.12 },
  { name: "Photon", logo: "/landing/terminals/photon.png", side: "left", row: 0.74 },
] as const;
/** Where each side's card shows, as a share of the frame's height: between that side's terminals. */
const CARD_ROW = { left: 0.36, right: 0.44 } as const;

function card(event: ExampleEvent): HTMLElement {
  const el = document.createElement("div");
  el.className = `sf-toast sf-toast-${event.kind}`;
  const logo = document.createElement("img");
  logo.src = `/stocks/${event.token}.png`;
  logo.alt = "";
  logo.className = "sf-toast-logo";
  const body = document.createElement("div");
  body.className = "sf-toast-body";
  const top = document.createElement("div");
  top.className = "sf-toast-top";
  const title = document.createElement("span");
  title.className = "sf-toast-title";
  title.textContent = event.kind === "saved" ? `+${usd(event.usd)} put aside` : `Invested ${usd(event.usd)}`;
  top.append(title);
  const sub = document.createElement("div");
  sub.className = "sf-toast-sub";
  sub.textContent = event.kind === "saved" && event.trade !== undefined ? `1% of a ${usd(event.trade.usd)} ${event.token} ${event.trade.side}` : `in ${event.token}, from the pension's pile`;
  body.append(top, sub);
  el.append(logo, body);
  return el;
}

export function ExampleActivity() {
  const layer = useRef<HTMLDivElement>(null);
  const terminals = useRef<(HTMLDivElement | null)[]>([]);
  const beams = useRef<(HTMLDivElement | null)[]>([]);
  const cards = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = layer.current;
    const cardLayer = cards.current;
    const root = el?.closest(".landing-root");
    if (!el || !cardLayer || !root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // THE PLACES, measured from the frame: the terminals at the outer edge of each
    // gutter, a beam from each to the frame's side, the cards between them.
    let frameRect: DOMRect | null = null;
    const layout = (): boolean => {
      const frame = root.querySelector(".landing-box");
      if (!frame) return false;
      const r = frame.getBoundingClientRect();
      const vw = window.innerWidth;
      const fits = r.left >= MIN_GUTTER && vw - r.right >= MIN_GUTTER;
      el.toggleAttribute("data-placed", fits);
      if (!fits) return false;
      frameRect = r;
      TERMINALS.forEach((t, i) => {
        const node = terminals.current[i];
        const beam = beams.current[i];
        if (!node || !beam) return;
        const left = t.side === "left" ? EDGE : vw - EDGE - TERMINAL_W;
        const top = r.top + r.height * t.row;
        node.style.left = `${left}px`;
        node.style.top = `${top}px`;
        // From the terminal's inner edge to the frame's side, at the terminal's middle.
        const from = t.side === "left" ? left + TERMINAL_W : r.right + 6;
        const to = t.side === "left" ? r.left - 6 : left;
        beam.style.left = `${Math.min(from, to)}px`;
        beam.style.width = `${Math.abs(to - from)}px`;
        beam.style.top = `${top + 23}px`;
      });
      return true;
    };

    let n = 0;
    let side: "left" | "right" = "right";
    const lastTerminal = { left: 2, right: 1 };
    const timers: number[] = [];
    const spawn = () => {
      if (document.hidden || !root.hasAttribute("data-loaded") || root.hasAttribute("data-zooming")) return;
      if (!layout() || frameRect === null) return;
      const r = frameRect;
      side = side === "left" ? "right" : "left";
      const event = EXAMPLES[n % EXAMPLES.length]!;
      n += 1;
      const show = () => {
        const node = card(event);
        const vw = window.innerWidth;
        const gutter = side === "left" ? r.left : vw - r.right;
        const x = side === "left" ? (gutter - CARD_W) / 2 : r.right + (gutter - CARD_W) / 2;
        node.style.left = `${Math.round(x)}px`;
        node.style.top = `${Math.round(r.top + r.height * CARD_ROW[side])}px`;
        node.style.width = `${CARD_W}px`;
        node.style.animationDuration = `${CARD_MS}ms`;
        node.addEventListener("animationend", () => node.remove(), { once: true });
        cardLayer.appendChild(node);
      };
      if (event.kind === "invested") {
        // Bought from the pile in the vault: no terminal, no beam.
        show();
        return;
      }
      // A slice from a trade: the side's terminals take turns sending it.
      const options = TERMINALS.map((t, i) => ({ t, i })).filter(({ t }) => t.side === side);
      const pick = options.find(({ i }) => i !== lastTerminal[side]) ?? options[0];
      if (!pick) return show();
      lastTerminal[side] = pick.i;
      const beam = beams.current[pick.i];
      const terminal = terminals.current[pick.i];
      terminal?.classList.remove("sf-terminal-hot");
      if (terminal) void terminal.offsetWidth;
      terminal?.classList.add("sf-terminal-hot");
      if (beam) {
        const light = document.createElement("span");
        light.className = "sf-beam-light";
        light.style.animationDuration = `${BEAM_MS}ms`;
        if (side === "right") light.style.setProperty("--dir", "-1");
        light.addEventListener("animationend", () => light.remove(), { once: true });
        beam.appendChild(light);
      }
      timers.push(window.setTimeout(show, BEAM_MS - 120));
    };

    const onResize = () => layout();
    window.addEventListener("resize", onResize);
    const first = window.setTimeout(() => layout(), 1800);
    const timer = window.setInterval(spawn, CARD_EVERY_MS);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(first);
      window.clearInterval(timer);
      for (const t of timers) window.clearTimeout(t);
      cardLayer.replaceChildren();
    };
  }, []);

  return (
    <div ref={layer} className="sf-toasts" aria-hidden>
      {TERMINALS.map((t, i) => (
        <div key={`beam-${t.name}`} ref={(node) => { beams.current[i] = node; }} className="sf-beam" />
      ))}
      {TERMINALS.map((t, i) => (
        <div key={t.name} ref={(node) => { terminals.current[i] = node; }} className="sf-terminal" style={{ width: TERMINAL_W }}>
          <img src={t.logo} alt="" className="sf-terminal-logo" />
          <span className="sf-terminal-text">
            <span className="sf-terminal-name">{t.name}</span>
            <span className="sf-terminal-sub">SaverFi wallet</span>
          </span>
        </div>
      ))}
      <div ref={cards} />
    </div>
  );
}
