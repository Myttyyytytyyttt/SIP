// Photographs the live dashboard in each state it can be in.
//
//   cd tools/landing-shot && npm i && node live-states.mjs
//
// (From a git worktree, playwright lives in the main checkout's copy of this
// folder: NODE_PATH=<main>/tools/landing-shot/node_modules node live-states.mjs)
//
// WHY A STUB RATHER THAN A WALLET. Which state the dashboard is in is decided by
// what Privy reports, and driving the real Privy headlessly means a real wallet
// extension and a real login. So `next dev` is started with SIP_WEB_PRIVY_STUB=1,
// which aliases the SDK to test/stubs/privy-react-auth.ts, and each page is given
// its Privy answer through a global before any script runs. The alias is refused
// in production twice over (next.config.mjs's NODE_ENV gate, and the stub's own
// import-time throw), and scripts/next-config.test.ts pins both.
//
// THE NUMBERS ARE THE LOCAL PROOF'S. /api/solana-live is answered from the
// fixtures test-local/live-local.local.test.ts wrote against a real validator,
// so these pictures show figures that really came off a chain. Nothing here
// reaches mainnet or production.
//
// Uses the Chrome already installed (channel: "chrome"): no browser download.
// Addresses the dev server as localhost, never 127.0.0.1 — the HMR origin check
// fails on the latter and the page never hydrates.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const PORT = 3017;
const ORIGIN = `http://localhost:${PORT}`;
const WEB = fileURLToPath(new URL("../../packages/website-oficial/", import.meta.url));
const SCRATCH = "/private/tmp/claude-501/-Users-walch-ProyectosCT-SIP/000bd5d8-c92a-4302-833e-5a5e037798dc/scratchpad";
const FIXTURES = process.env.SIP_LIVE_FIXTURE_OUT ?? join(SCRATCH, "live-fixtures");
const OUT = process.env.SIP_SHOT_OUT ?? join(SCRATCH, "screens", "web-panel-live");

const failures = [];
const results = [];
const fail = (state, message) => {
  failures.push(`${state}: ${message}`);
  console.error(`  FAIL ${state}: ${message}`);
};

// ── the fixtures the local proof wrote ───────────────────────────────────────

function fixture(name) {
  const path = join(FIXTURES, name);
  if (!existsSync(path)) {
    throw new Error(`missing fixture ${path}. Run the local proof first:\n  SIP_LOCAL_PROGRAM_SO=… SIP_LIVE_FIXTURE_OUT=${FIXTURES} pnpm --dir packages/website-oficial test:local`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

const activeSnapshot = fixture("active-snapshot.json");
const activeActivity = fixture("active-activity.json");
const noVaultSnapshot = fixture("novault-snapshot.json");

const ACTIVE_OWNER = activeSnapshot.owner;
const ACTIVE_TRADING = activeSnapshot.wallets?.[0]?.wallet ?? null;
const NOVAULT_OWNER = noVaultSnapshot.owner;

/** A Privy user record shaped like the real one: an external Phantom key, and an embedded trading wallet. */
function userFor(owner, trading) {
  const verified = { firstVerifiedAt: "2026-09-15T00:00:00.000Z", latestVerifiedAt: "2026-09-15T00:00:00.000Z" };
  const phantom = { type: "wallet", address: owner, chainType: "solana", walletClientType: "phantom", connectorType: "solana_adapter", imported: false, delegated: false, walletIndex: null, ...verified };
  const accounts = [phantom];
  if (trading !== null) {
    accounts.push({ type: "wallet", address: trading, chainType: "solana", walletClientType: "privy", connectorType: "embedded", imported: false, delegated: true, walletIndex: 0, id: "wallet-id-stub", ...verified });
  }
  return { id: "did:privy:screenshot", createdAt: "2026-09-15T00:00:00.000Z", wallet: phantom, linkedAccounts: accounts, mfaMethods: [], hasAcceptedTerms: false, isGuest: false };
}

// ── the dev server ───────────────────────────────────────────────────────────

const tcpRefused = (port, host) =>
  new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (refused) => {
      socket.destroy();
      resolve(refused);
    };
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
    setTimeout(() => done(false), 1500);
  });

const portRefused = async (port) => (await tcpRefused(port, "127.0.0.1")) && (await tcpRefused(port, "::1"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startDevServer() {
  if (!(await portRefused(PORT))) throw new Error(`port ${PORT} is in use. Nothing was started, and nothing was stopped.`);

  const home = mkdtempSync(join(tmpdir(), "saverfi-shot-"));
  const child = spawn(join(WEB, "node_modules", ".bin", "next"), ["dev", "--port", String(PORT), "--hostname", "localhost"], {
    cwd: WEB,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      NODE_ENV: "development",
      NEXT_TELEMETRY_DISABLED: "1",
      // The whole point: the Privy SDK is aliased to the dev-only stub.
      SIP_WEB_PRIVY_STUB: "1",
      // Enough configuration for walletsConfigured to be true. The RPC is a
      // closed port on purpose — every live read is answered from a fixture.
      PRIVY_APP_ID: "screenshotstubappid000000",
      SIP_SOLANA_PROGRAM_ID: "6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J",
      SIP_TRUSTED_CLIENT_IP_HEADER: "x-real-ip",
      SIP_SOLANA_RPC_URLS: "http://127.0.0.1:9",
    },
  });

  let output = "";
  const keep = (chunk) => {
    output = (output + chunk.toString("utf8")).slice(-8000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);

  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const stop = async () => {
    if (!exited()) {
      child.kill("SIGTERM");
      for (let i = 0; i < 40 && !exited(); i += 1) await sleep(250);
      if (!exited()) child.kill("SIGKILL");
      for (let i = 0; i < 20 && !exited(); i += 1) await sleep(250);
    }
    rmSync(home, { recursive: true, force: true });
    return { exited: exited(), portRefused: await portRefused(PORT) };
  };

  const deadline = Date.now() + 180_000;
  for (;;) {
    if (exited()) throw new Error(`next dev exited (code ${child.exitCode}) before it answered\n${output.slice(-2000)}`);
    const health = await fetch(`${ORIGIN}/api/health`).catch(() => null);
    if (health?.status === 200) break;
    if (Date.now() >= deadline) {
      await stop();
      throw new Error(`GET /api/health did not answer 200 within 180 s\n${output.slice(-2000)}`);
    }
    await sleep(500);
  }
  return { stop, output: () => output };
}

// ── one shot ─────────────────────────────────────────────────────────────────

const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 375, height: 812 } };

async function shoot(browser, { state, device, path, stub, snapshot, activity, marker, theme = "light", check, act }) {
  const name = `${state}-${device}${theme === "dark" ? "-dark" : ""}`;
  const context = await browser.newContext({ viewport: VIEWPORTS[device], deviceScaleFactor: 2, colorScheme: theme });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.addInitScript((value) => {
    globalThis.__SAVERFI_PRIVY_STUB__ = value;
  }, stub);

  // Every live read is answered from the local proof's own recorded JSON.
  await page.route("**/api/solana-live", async (route) => {
    let action = "snapshot";
    try {
      action = JSON.parse(route.request().postData() ?? "{}").action ?? "snapshot";
    } catch {
      action = "snapshot";
    }
    const body = action === "activity" ? (activity ?? { vault: "", status: "exists", nextBefore: null, entries: [], gap: false }) : snapshot;
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(body) });
  });

  try {
    await page.goto(`${ORIGIN}${path}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    if (marker !== null) {
      try {
        // Case-insensitively: innerText is what the browser DRAWS, and the
        // section labels are drawn by CSS `text-transform: uppercase`, so
        // "Saved so far" comes back as "SAVED SO FAR".
        await page.waitForFunction((text) => document.body.innerText.toUpperCase().includes(text.toUpperCase()), marker, { timeout: 120_000 });
      } catch {
        // A bare "Timeout exceeded" says nothing about WHY. Carry what the page
        // actually showed, and what it complained about, into the failure.
        const shown = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 300)).catch(() => "<unreadable>");
        throw new Error(`never showed "${marker}" — console: ${consoleErrors.slice(0, 2).join(" | ") || "none"} — text: ${shown}`);
      }
    } else await page.waitForTimeout(400);
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    await page.waitForTimeout(600);
    if (act !== undefined) await act(page);

    if (check !== undefined) await check(page, (message) => fail(name, message));

    // Nothing may scroll sideways, at any width.
    const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    if (overflow.scrollWidth > overflow.clientWidth) fail(name, `scrolls sideways: ${overflow.scrollWidth} > ${overflow.clientWidth}`);
    if (consoleErrors.length > 0) fail(name, `console errors: ${consoleErrors.slice(0, 3).join(" | ")}`);

    mkdirSync(OUT, { recursive: true });
    const file = join(OUT, `${name}.png`);
    await page.screenshot({ path: file, type: "png", fullPage: true });

    const tabs = await page.$$eval('[role="tab"]', (list) => list.map((tab) => `${tab.textContent.trim()}:${tab.getAttribute("data-state")}${tab.hasAttribute("disabled") ? ":disabled" : ""}`));
    results.push({ state: name, file, url: page.url(), tabs, consoleErrors, scrollWidth: overflow.scrollWidth, clientWidth: overflow.clientWidth });
    console.log(`  wrote ${file}`);
  } catch (error) {
    // One state that will not render must not cost the other seven their shot:
    // it is recorded as a failure, and the run still exits non-zero at the end.
    fail(name, String(error?.message ?? error).split("\n")[0]);
  } finally {
    await context.close();
  }
}

// ── the states ───────────────────────────────────────────────────────────────

const DISCONNECTED = { ready: true, authenticated: false, user: null };
const CONNECTED = { ready: true, authenticated: true, user: userFor(ACTIVE_OWNER, ACTIVE_TRADING) };
const CONNECTED_EMPTY = { ready: true, authenticated: true, user: userFor(NOVAULT_OWNER, null) };

const text = async (page) => page.evaluate(() => document.body.innerText);
const mainText = async (page) => page.evaluate(() => document.querySelector("main")?.innerText ?? "");

/**
 * Does the rendered text carry this sentence?
 *
 * Compared case-insensitively for the same reason the marker is: innerText
 * returns what the browser DRAWS, and an uppercase label would otherwise make a
 * negative assertion pass for the wrong reason.
 */
const has = (body, sentence) => body.toUpperCase().includes(sentence.toUpperCase());

/**
 * Is the "Sample data" BADGE on the page?
 *
 * Deliberately not a substring search. The connect card offers a "See sample
 * data" button, and its label contains the badge's own words — so a text search
 * reports the sample as showing on a screen whose whole point is that it is not.
 * Only a leaf element whose ENTIRE text is the badge counts.
 */
const sampleBadge = (page) =>
  page.evaluate(() => Array.from(document.querySelectorAll("*")).some((node) => node.children.length === 0 && (node.textContent ?? "").trim() === "Sample data"));

const server = await startDevServer();
const browser = await chromium.launch({ channel: "chrome", headless: true });

try {
  // 1. Disconnected, Mock: the sample, and a Live tab that is a real choice.
  await shoot(browser, {
    state: "disconnected-mock",
    device: "desktop",
    path: "/?mode=mock",
    stub: DISCONNECTED,
    snapshot: activeSnapshot,
    activity: activeActivity,
    marker: "Sample data",
    check: async (page, bad) => {
      const tabs = await page.$$eval('[role="tab"]', (list) => list.map((tab) => `${tab.textContent.trim()}:${tab.getAttribute("data-state")}${tab.hasAttribute("disabled") ? ":disabled" : ""}`));
      if (!tabs.includes("Mock:active")) bad(`Mock is not active: ${tabs.join(" ")}`);
      if (!tabs.includes("Live:inactive")) bad(`Live is not an enabled, inactive tab: ${tabs.join(" ")}`);
    },
  });

  // 2. Disconnected, Live: an honest connect card and NOT one number.
  await shoot(browser, {
    state: "disconnected-live",
    device: "desktop",
    path: "/?mode=live",
    stub: DISCONNECTED,
    snapshot: activeSnapshot,
    activity: activeActivity,
    marker: "Connect your pension key",
    check: async (page, bad) => {
      if (await sampleBadge(page)) bad("shows the sample badge on Live");
      const main = await mainText(page);
      if (main.includes("$")) bad("shows a dollar figure with nobody connected");
      const tabs = await page.$$eval('[role="tab"]', (list) => list.map((tab) => `${tab.textContent.trim()}:${tab.getAttribute("data-state")}`));
      if (!tabs.includes("Live:active")) bad(`Live is not active: ${tabs.join(" ")}`);
    },
  });

  // 3. Connected: ?mode=mock must NOT win, and the toggle must be gone.
  for (const device of ["desktop", "mobile"]) {
    for (const theme of device === "desktop" ? ["light", "dark"] : ["light"]) {
      await shoot(browser, {
        state: "connected-live",
        device,
        theme,
        path: "/?mode=mock",
        stub: CONNECTED,
        snapshot: activeSnapshot,
        activity: activeActivity,
        marker: "Saved so far",
        check: async (page, bad) => {
          if ((await page.$$('[role="tablist"]')).length > 0) bad("the Live|Mock control is still in the navbar");
          const search = await page.evaluate(() => window.location.search);
          if (search !== "?mode=live") bad(`the URL was not normalized: ${search}`);
          const body = await text(page);
          if (await sampleBadge(page)) bad("shows the sample badge while connected");
          if (!has(body, "0.06 SOL")) bad("the hero does not carry the settled figure");
          if (!has(body, "Worth now")) bad("the pension card did not render");
          if ((await page.$$('a[href^="https://solscan.io/tx/"]')).length === 0) bad("no row links to Solscan");
          const invented = body.match(/Sold |Bought [A-Z]+x|Funded wallet|Streak/);
          if (invented !== null) bad(`shows an invented figure: ${invented[0]}`);
        },
      });
    }
  }

  // 3b. Mobile, with the activity sheet open.
  await shoot(browser, {
    state: "connected-sheet",
    device: "mobile",
    path: "/?mode=live",
    stub: CONNECTED,
    snapshot: activeSnapshot,
    activity: activeActivity,
    marker: "Saved so far",
    act: async (page) => {
      await page.click('button[aria-label="Open activity"]');
      await page.waitForTimeout(700);
    },
  });

  // 4. Connected with no vault on chain: the one next step, and no pension figures.
  await shoot(browser, {
    state: "no-vault",
    device: "desktop",
    path: "/",
    stub: CONNECTED_EMPTY,
    snapshot: noVaultSnapshot,
    activity: null,
    marker: "No vault yet",
    check: async (page, bad) => {
      const body = await text(page);
      if (!has(body, "Create vault")) bad("offers no way to create the vault");
      if (has(body, "Saved so far")) bad("shows a hero for a pension that does not exist");
      if ((await page.$$("main svg path")).length > 0) bad("draws a chart with no settlements");
    },
  });

  // 5. Privy still answering: a skeleton, never the sample.
  await shoot(browser, {
    state: "loading",
    device: "desktop",
    path: "/?mode=mock",
    stub: { ready: false, authenticated: false, user: null },
    snapshot: activeSnapshot,
    activity: activeActivity,
    marker: null,
    check: async (page, bad) => {
      if ((await page.$$('[aria-busy="true"]')).length === 0) bad("no aria-busy skeleton while Privy is still answering");
      if (await sampleBadge(page)) bad("painted the sample before Privy answered");
      if ((await page.$$('[role="tablist"]')).length > 0) bad("offered the choice before there was one");
    },
  });

  // 6. The activity page, connected.
  for (const device of ["desktop", "mobile"]) {
    await shoot(browser, {
      state: "activity",
      device,
      path: "/activity?mode=live",
      stub: CONNECTED,
      snapshot: activeSnapshot,
      activity: activeActivity,
      marker: "Saved so far",
      check: async (page, bad) => {
        if ((await page.$$('a[href^="https://solscan.io/tx/"]')).length === 0) bad("no row links to Solscan");
        const body = await text(page);
        if (!has(body, "Load older") && !has(body, "Complete history")) bad("says neither Load older nor Complete history");
      },
    });
  }
} finally {
  await browser.close();
  const stopped = await server.stop();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ results, failures, stopped }, null, 1));
  console.log(JSON.stringify({ event: "web-panel-live.screenshots", shots: results.length, failures, stopped }, null, 1));
  if (!stopped.exited || !stopped.portRefused) failures.push(`dev server did not stop cleanly: ${JSON.stringify(stopped)}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} shots passed.`);
