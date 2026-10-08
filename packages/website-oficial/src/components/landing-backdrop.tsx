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

/** The S's grid in the film (launch-video MarkBuild): its edges, on a 1272×1488 mark. */
const MARK_H_LINES = [0, 271, 497, 607, 880, 989, 1219, 1488] as const;
const MARK_V_LINES = [0, 275, 998, 1272] as const;
/** One repeat of that rhythm on the page, in CSS pixels. */
const TILE_W = 520;
const TILE_H = (TILE_W * 1488) / 1272;
const hLines = MARK_H_LINES.map((y) => (y / 1488) * TILE_H);
const vLines = MARK_V_LINES.map((x) => (x / 1272) * TILE_W);

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
      {/* The S's bloom, behind the frame. */}
      <div className="sf-halo" />
      <div ref={pulses} className="sf-pulses" />
    </div>
  );
}
