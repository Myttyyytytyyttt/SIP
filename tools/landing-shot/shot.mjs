// Regenerates the landing's screenshot of the dashboard.
//
//   cd tools/landing-shot && npm i && BASE=http://localhost:3002 npm run shot
//
// Uses the Chrome already installed (channel: "chrome"): no browser download.
// Address a DEV server as localhost, never 127.0.0.1 — the HMR origin check
// fails on the latter and the page never hydrates, which shows up as an empty
// chart. A production server (`next build && next start`) works on either.
//
// It waits for the chart's CURVE, not just the page: recharts draws it after a
// ResizeObserver tick and animates it in, and a screenshot taken on "loaded"
// captures a blank panel where the growth should be.
import { chromium } from "playwright";

const base = process.env.BASE ?? "http://localhost:3002";
const out = new URL("../../packages/website-oficial/public/landing/app-dark.png", import.meta.url).pathname;

const browser = await chromium.launch({ channel: "chrome", headless: true });
// 1056 tall, clipped to 1000: the app's header is hidden (the landing's own
// frame has a title bar, and a second wordmark and a Live/Mock control mean
// nothing in a still), and the sidebar is sized against a header that is not
// there — the extra 56px keep its foot off the picture.
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1056 }, deviceScaleFactor: 2, colorScheme: "dark" });
const page = await ctx.newPage();
await page.goto(`${base}/?mode=mock`, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForFunction(
  () => /Sample data/.test(document.body.innerText) && [...document.querySelectorAll("main svg path")].some((p) => (p.getAttribute("d") ?? "").length > 400),
  null,
  { timeout: 90_000 },
);
await page.evaluate(() => document.fonts.ready);
await page.addStyleTag({ content: "nextjs-portal{display:none!important}header{display:none!important}" });
await page.waitForTimeout(2200);
const tabs = await page.$$eval('[role="tab"]', (ts) => ts.map((t) => `${t.textContent.trim()}:${t.getAttribute("data-state")}${t.hasAttribute("disabled") ? ":disabled" : ""}`));
if (!tabs.includes("Mock:active") || !tabs.includes("Live:inactive:disabled")) throw new Error(`not the example-without-a-key state: ${tabs.join(" ")}`);
await page.screenshot({ path: out, type: "png", clip: { x: 0, y: 0, width: 1600, height: 1000 } });
console.log(`wrote ${out}`);
await browser.close();
