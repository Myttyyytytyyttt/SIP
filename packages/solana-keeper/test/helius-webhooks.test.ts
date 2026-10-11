// The Helius webhook client and its sync (src/helius-webhooks.ts), against an
// in-memory Helius: no network, no key, and a fetch that can be made to fail
// in every way a real one does — including the ways that quote the URL, which
// is where the API key lives.

import { inspect } from "node:util";
import { Secret } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import {
  HeliusWebhookError,
  LIST_ADDRESS_CAP,
  MAX_WEBHOOK_ADDRESSES,
  MIN_EDIT_INTERVAL_MS,
  RECHECK_MS,
  SYNC_FAILURE_ALERT_STREAK,
  SYNC_FAILURE_CRITICAL_AFTER_MS,
  WebhookSync,
  createHeliusWebhookClient,
  ensureWebhook,
  syncDue,
  type HeliusWebhook,
  type SyncReport,
} from "../src/helius-webhooks.js";

const API_KEY = "HeliusApiKeyNeverInAnError0042";
const SECRET = "doorbell-secret-0123456789abcdef0123456789abcdef";
const URL_ = "https://keeper.up.railway.app/hooks/helius";
const apiKey = new Secret(API_KEY, "heliusApiKey");
const secret = new Secret(SECRET, "doorbellSecret");

interface Call {
  readonly method: string;
  readonly path: string;
  readonly key: string | null;
  readonly body: unknown;
}

/** An in-memory Helius webhooks API: enough of it to hold state across two keeper instances. */
function fakeHelius(initial: HeliusWebhook[] = []) {
  const hooks: HeliusWebhook[] = initial.map((hook) => ({ ...hook }));
  const calls: Call[] = [];
  let next = 1;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, path: url.pathname, key: url.searchParams.get("api-key"), body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.pathname === "/v0/webhooks" && method === "GET") return json(hooks);
    if (url.pathname === "/v0/webhooks" && method === "POST") {
      const created = { webhookID: `wh-0000-000000-${String(next++).padStart(6, "0")}`, active: true, ...body };
      hooks.push(created);
      return json(created);
    }
    const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const index = hooks.findIndex((hook) => hook.webhookID === id);
    if (index < 0) return json({ error: "not found" }, 404);
    if (method === "PUT") {
      hooks[index] = { ...hooks[index]!, ...body };
      return json(hooks[index]);
    }
    if (method === "PATCH") {
      hooks[index] = { ...hooks[index]!, ...body };
      return json(hooks[index]);
    }
    return json({ error: "method" }, 405);
  };
  return { hooks, calls, fetchImpl };
}

const client = (fetchImpl: typeof fetch, timeoutMs?: number) =>
  createHeliusWebhookClient({ apiKey, alsoScrub: [secret], fetch: fetchImpl, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

/** Every way an error could be printed: message, stack, JSON, inspect, and its cause. */
const printed = (error: unknown): string =>
  [String(error), (error as Error).stack ?? "", JSON.stringify(error), inspect(error, { depth: 8 }), inspect((error as { cause?: unknown }).cause)].join("\n");

async function caught(promise: Promise<unknown>): Promise<HeliusWebhookError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HeliusWebhookError);
    return error as HeliusWebhookError;
  }
  throw new Error("expected a rejection");
}

describe("the client", () => {
  it("speaks the four calls the webhook needs, with the key in the query and the FULL object on a PUT", async () => {
    const helius = fakeHelius();
    const api = client(helius.fetchImpl);
    const body = {
      webhookURL: URL_,
      webhookType: "raw" as const,
      accountAddresses: ["a", "b"],
      transactionTypes: ["ANY"] as const,
      authHeader: SECRET,
      txnStatus: "all" as const,
    };
    const created = await api.create(body);
    await api.list();
    await api.update(created.webhookID, { ...body, accountAddresses: ["a", "b", "c"] });
    await api.setActive(created.webhookID, true);
    expect(helius.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v0/webhooks",
      "GET /v0/webhooks",
      `PUT /v0/webhooks/${created.webhookID}`,
      `PATCH /v0/webhooks/${created.webhookID}`,
    ]);
    for (const call of helius.calls) expect(call.key).toBe(API_KEY);
    expect(helius.calls[0]!.body).toEqual(body);
    expect(helius.calls[2]!.body).toEqual({ ...body, accountAddresses: ["a", "b", "c"] });
    expect(helius.calls[3]!.body).toEqual({ active: true });
  });

  it("names the method, the path without its query, and the status — and scrubs what the body echoes", async () => {
    const echoing: typeof fetch = async (input) =>
      new Response(`{"error":"bad request to ${String(input)} with authHeader ${SECRET} and key ${API_KEY}"}`, { status: 400 });
    const error = await caught(client(echoing).update("wh-123456789", {
      webhookURL: URL_,
      webhookType: "raw",
      accountAddresses: [],
      transactionTypes: ["ANY"],
      authHeader: SECRET,
      txnStatus: "all",
    }));
    expect(error).toMatchObject({ method: "PUT", path: "/v0/webhooks/{webhookID}", status: 400 });
    expect(error.message).toContain("Helius PUT /v0/webhooks/{webhookID} answered 400");
    const text = printed(error);
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("?api-key=");
    expect(error.excerpt.length).toBeLessThanOrEqual(201);
  });

  // THE INCIDENT THIS GUARDS IS THE ONE WITH NO BODY AT ALL: undici's TypeError
  // "fetch failed" carries the URL in its cause, and some runtimes put it in the
  // message. Either one, printed by a logger that follows causes, is the key.
  it("never lets a rejected fetch carry the URL out, in its message or in its cause", async () => {
    const leaky: typeof fetch = async (input) => {
      const cause = Object.assign(new Error(`connect ECONNREFUSED ${String(input)}`), { code: "ECONNREFUSED", url: String(input) });
      throw new TypeError(`fetch failed for ${String(input)}`, { cause });
    };
    const error = await caught(client(leaky).list());
    expect(error.status).toBeNull();
    expect(error.message).toContain("GET /v0/webhooks did not answer");
    expect(error.message).toContain("TypeError (ECONNREFUSED)");
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(printed(error)).not.toContain(API_KEY);
  });

  it("gives up after its timeout instead of holding the sync forever", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const error = await caught(client(hanging, 20).list());
    expect(error.message).toContain("TimeoutError");
    expect(printed(error)).not.toContain(API_KEY);
  });

  it("refuses an answer that is not what it asked for", async () => {
    const html: typeof fetch = async () => new Response("<html>gateway</html>", { status: 200 });
    expect((await caught(client(html).list())).excerpt).toBe("the answer is not JSON");
  });
});

describe("ensureWebhook", () => {
  const spec = { url: URL_, authHeader: SECRET, addresses: ["w2", "v1", "w1", "v1"] };

  it("creates a raw webhook for every transaction type when there is none, with the addresses sorted and unique", async () => {
    const helius = fakeHelius();
    const result = await ensureWebhook(client(helius.fetchImpl), spec, true);
    expect(result).toMatchObject({ action: "created", watched: ["v1", "w1", "w2"], active: true });
    expect(helius.hooks).toHaveLength(1);
    expect(helius.hooks[0]).toMatchObject({
      webhookURL: URL_,
      webhookType: "raw",
      transactionTypes: ["ANY"],
      authHeader: SECRET,
      txnStatus: "all",
      accountAddresses: ["v1", "w1", "w2"],
    });
  });

  it("never creates a second one: a restart, and a second instance, find the first by its exact URL", async () => {
    const helius = fakeHelius([{ webhookID: "someone-elses", webhookURL: "https://other.example.test/hook", accountAddresses: [] }]);
    await ensureWebhook(client(helius.fetchImpl), spec, true);
    const again = await ensureWebhook(client(helius.fetchImpl), spec, true);
    const third = await ensureWebhook(client(helius.fetchImpl), spec, true);
    expect(again.action).toBe("unchanged");
    expect(third.action).toBe("unchanged");
    expect(helius.hooks.filter((hook) => hook.webhookURL === URL_)).toHaveLength(1);
    expect(helius.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(helius.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("PUTs the full object when the address set, or the secret, differs — and holds the PUT back when edits are not allowed", async () => {
    const helius = fakeHelius();
    await ensureWebhook(client(helius.fetchImpl), spec, true);
    const held = await ensureWebhook(client(helius.fetchImpl), { ...spec, addresses: [...spec.addresses, "w3"] }, false);
    expect(held).toMatchObject({ action: "held", watched: ["v1", "w1", "w2"] });
    expect(helius.calls.filter((call) => call.method === "PUT")).toHaveLength(0);

    const updated = await ensureWebhook(client(helius.fetchImpl), { ...spec, addresses: [...spec.addresses, "w3"] }, true);
    expect(updated).toMatchObject({ action: "updated", watched: ["v1", "w1", "w2", "w3"] });
    const put = helius.calls.find((call) => call.method === "PUT")!;
    expect(put.body).toEqual({
      webhookURL: URL_,
      webhookType: "raw",
      accountAddresses: ["v1", "w1", "w2", "w3"],
      transactionTypes: ["ANY"],
      authHeader: SECRET,
      txnStatus: "all",
    });

    const rotated = await ensureWebhook(client(helius.fetchImpl), { ...spec, addresses: ["v1", "w1", "w2", "w3"], authHeader: `${SECRET}-rotated` }, true);
    expect(rotated.action).toBe("updated");
    expect(helius.hooks[0]!.authHeader).toBe(`${SECRET}-rotated`);
  });

  it("switches an auto-disabled webhook back on, even while edits are held", async () => {
    const helius = fakeHelius([{ webhookID: "wh-disabled-abcdef", webhookURL: URL_, webhookType: "raw", accountAddresses: ["v1", "w1", "w2"], transactionTypes: ["ANY"], authHeader: SECRET, txnStatus: "all", active: false }]);
    const result = await ensureWebhook(client(helius.fetchImpl), spec, false);
    expect(result).toMatchObject({ action: "unchanged", reactivated: true, active: true });
    expect(helius.calls.find((call) => call.method === "PATCH")?.body).toEqual({ active: true });
    expect(helius.hooks[0]!.active).toBe(true);
  });

  it("refuses more than Helius's 100,000 addresses before asking anything", async () => {
    const helius = fakeHelius();
    const many = Array.from({ length: MAX_WEBHOOK_ADDRESSES + 1 }, (_, index) => `address-${index}`);
    await expect(ensureWebhook(client(helius.fetchImpl), { ...spec, addresses: many }, true)).rejects.toThrow("100000");
    expect(helius.calls).toHaveLength(0);
  });
});

describe("when a sync is due", () => {
  const base = {
    now: 1_000_000_000,
    lastCheckAt: 1_000_000_000 - 60_000,
    lastEditAt: 1_000_000_000 - 60_000,
    lastFailed: false,
    lastAttemptFailed: false,
    stuck: false,
    differs: false,
  };

  it("syncs at once after boot, edits allowed", () => {
    expect(syncDue({ ...base, lastCheckAt: null, lastEditAt: null, differs: true })).toEqual({ due: true, allowEdit: true });
  });

  it("holds an address edit for ten minutes after the last one", () => {
    expect(syncDue({ ...base, differs: true })).toEqual({ due: false, allowEdit: false });
    expect(syncDue({ ...base, differs: true, lastEditAt: base.now - MIN_EDIT_INTERVAL_MS })).toEqual({ due: true, allowEdit: true });
  });

  it("looks again every ten minutes when nothing changed, and every sweep after a failure", () => {
    expect(syncDue(base).due).toBe(false);
    expect(syncDue({ ...base, lastCheckAt: base.now - RECHECK_MS }).due).toBe(true);
    expect(syncDue({ ...base, lastFailed: true })).toEqual({ due: true, allowEdit: false });
  });

  // S1. THE INCIDENT'S SECOND LOOP: a stuck webhook's addresses "differ" and its
  // debounce has long passed, so it was due every sweep — a GET every 60 s for
  // a webhook nothing would be sent to.
  it("does not look at a stuck webhook every sweep, only every RECHECK_MS — and at once when the addresses change", () => {
    const stuck = { ...base, differs: true, stuck: true, lastEditAt: base.now - 2 * MIN_EDIT_INTERVAL_MS };
    expect(syncDue(stuck)).toEqual({ due: false, allowEdit: true });
    expect(syncDue({ ...stuck, lastCheckAt: base.now - RECHECK_MS })).toEqual({ due: true, allowEdit: true });
    // A new address set is not the one it is stuck on.
    expect(syncDue({ ...stuck, stuck: false })).toEqual({ due: true, allowEdit: true });
  });

  // S2. A failed LIST says nothing about the PUT; a failed EDIT is not worth a
  // GET before its debounce lets the PUT go again.
  it("looks again next sweep after a failed list, and only after its debounce after a failed edit", () => {
    expect(syncDue({ ...base, lastFailed: true, lastAttemptFailed: false })).toEqual({ due: true, allowEdit: false });
    expect(syncDue({ ...base, lastFailed: true, lastAttemptFailed: true })).toEqual({ due: false, allowEdit: false });
    expect(syncDue({ ...base, lastFailed: true, lastAttemptFailed: true, lastEditAt: base.now - MIN_EDIT_INTERVAL_MS })).toEqual({
      due: true,
      allowEdit: true,
    });
  });

  it("pages after an hour of failures, not before", () => {
    expect(SYNC_FAILURE_CRITICAL_AFTER_MS).toBe(60 * 60_000);
    expect(LIST_ADDRESS_CAP).toBe(100);
  });
});

describe("the sync", () => {
  const T = 1_800_000_000_000;
  const quiet = () => undefined;

  function sync(fetchImpl: typeof fetch, over: Partial<{ url: string | null; secret: Secret | null; client: boolean }> = {}) {
    const watched: ReadonlySet<string>[] = [];
    const engine = new WebhookSync({
      client: over.client === false ? null : client(fetchImpl),
      url: over.url === undefined ? URL_ : over.url,
      secret: over.secret === undefined ? secret : over.secret,
      onSynced: (report) => watched.push(report.watched),
      log: quiet,
    });
    return { engine, watched };
  }

  it("manages nothing in an instance that is not acting, or that lacks a key or a URL, and says which", () => {
    const helius = fakeHelius();
    const notActing = sync(helius.fetchImpl).engine;
    expect(notActing.tick({ acting: false, addresses: ["a"], now: T })).toBeNull();
    expect(notActing.status()).toMatchObject({ managed: false, reason: expect.stringContaining("not the acting keeper") });
    const noKey = sync(helius.fetchImpl, { client: false }).engine;
    expect(noKey.tick({ acting: true, addresses: ["a"], now: T })).toBeNull();
    expect(noKey.status().reason).toContain("SIP_SOLANA_HELIUS_API_KEY");
    const noUrl = sync(helius.fetchImpl, { url: null }).engine;
    expect(noUrl.tick({ acting: true, addresses: ["a"], now: T })).toBeNull();
    expect(noUrl.status().reason).toContain("SIP_SOLANA_DOORBELL_URL");
    expect(helius.calls).toHaveLength(0);
  });

  it("runs one sync at a time: a tick while one is in flight starts nothing", async () => {
    const helius = fakeHelius();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: typeof fetch = async (input, init) => {
      await gate;
      return helius.fetchImpl(input, init);
    };
    const { engine } = sync(slow);
    const first = engine.tick({ acting: true, addresses: ["a"], now: T });
    expect(first).not.toBeNull();
    expect(engine.tick({ acting: true, addresses: ["a", "b"], now: T + 60_000 })).toBeNull();
    release();
    await first;
    expect(helius.calls.filter((call) => call.method === "GET")).toHaveLength(1);
  });

  it("tells the doorbell what Helius holds, and holds a second edit back for ten minutes", async () => {
    const helius = fakeHelius();
    const { engine, watched } = sync(helius.fetchImpl);
    await engine.tick({ acting: true, addresses: ["w1", "v1"], now: T });
    expect([...watched.at(-1)!].sort()).toEqual(["v1", "w1"]);
    // A new link one minute later: the edit is not due yet, so no request at all.
    expect(engine.tick({ acting: true, addresses: ["w1", "v1", "w2", "v2"], now: T + 60_000 })).toBeNull();
    await engine.tick({ acting: true, addresses: ["w1", "v1", "w2", "v2"], now: T + MIN_EDIT_INTERVAL_MS });
    expect([...watched.at(-1)!].sort()).toEqual(["v1", "v2", "w1", "w2"]);
    expect(helius.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(engine.status()).toMatchObject({ managed: true, addresses: 4, lastAction: "updated", consecutiveFailures: 0 });
    expect(engine.status().idSuffix).toHaveLength(6);
  });

  it("counts failures, warns doorbell-sync at the third in a row, and clears it on the next success", async () => {
    const helius = fakeHelius();
    let down = true;
    const flaky: typeof fetch = async (input, init) => {
      if (down) return new Response(`upstream error for key ${API_KEY}`, { status: 503 });
      return helius.fetchImpl(input, init);
    };
    const { engine } = sync(flaky);
    for (let i = 0; i < SYNC_FAILURE_ALERT_STREAK - 1; i += 1) {
      await engine.tick({ acting: true, addresses: ["a"], now: T + i * 60_000 });
      expect(engine.syncAlert()).toEqual({ fire: null, clear: false });
    }
    await engine.tick({ acting: true, addresses: ["a"], now: T + 5 * 60_000 });
    const alert = engine.syncAlert();
    expect(alert.fire).toMatchObject({ key: "doorbell-sync", severity: "warn" });
    expect(JSON.stringify(alert)).not.toContain(API_KEY);
    down = false;
    await engine.tick({ acting: true, addresses: ["a"], now: T + 6 * 60_000 });
    expect(engine.syncAlert()).toEqual({ fire: null, clear: true });
  });

  it("puts neither the key, the secret nor the whole webhook id on its status", async () => {
    const helius = fakeHelius();
    const { engine } = sync(helius.fetchImpl);
    await engine.tick({ acting: true, addresses: ["a"], now: T });
    const served = JSON.stringify(engine.status());
    expect(served).not.toContain(API_KEY);
    expect(served).not.toContain(SECRET);
    expect(served).not.toContain(helius.hooks[0]!.webhookID);
    expect(served).toContain(helius.hooks[0]!.webhookID.slice(-6));
  });
});

describe("the sync, under a logger that throws", () => {
  it("still resolves: a rejection would reach the unhandledRejection trap, which exits the keeper", async () => {
    const failing: typeof fetch = async () => new Response("down", { status: 503 });
    const engine = new WebhookSync({
      client: createHeliusWebhookClient({ apiKey: new Secret("HeliusApiKeyNeverInAnError0042", "heliusApiKey"), fetch: failing }),
      url: "https://keeper.up.railway.app/hooks/helius",
      secret: new Secret("doorbell-secret-0123456789abcdef0123456789abcdef", "doorbellSecret"),
      onSynced: () => undefined,
      log: () => {
        throw new Error("the logger broke");
      },
    });
    await expect(engine.tick({ acting: true, addresses: ["a"], now: 0 })).resolves.toBeUndefined();
    // And the guard is released, so the next sweep can try again.
    expect(engine.tick({ acting: true, addresses: ["a"], now: 60_000 })).not.toBeNull();
  });
});

// ── what the review of 2026-09-23 found ──────────────────────────────────────

/** A fetch in front of the fake Helius that can rewrite its list, or refuse a method. */
function shaped(
  helius: ReturnType<typeof fakeHelius>,
  over: { list?: (hooks: HeliusWebhook[]) => unknown[]; refuse?: string; freezePut?: boolean; mergePut?: boolean },
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (over.refuse === method) {
      helius.calls.push({ method, path: url.pathname, key: url.searchParams.get("api-key"), body: undefined });
      return new Response(JSON.stringify({ error: "refused" }), { status: 400 });
    }
    if (method === "GET" && url.pathname === "/v0/webhooks" && over.list !== undefined) {
      helius.calls.push({ method, path: url.pathname, key: url.searchParams.get("api-key"), body: undefined });
      return new Response(JSON.stringify(over.list(helius.hooks)), { status: 200 });
    }
    if (method === "PUT" && over.freezePut === true) {
      // ANSWERED 200, AND NOT KEPT: the list will go on showing the old object.
      helius.calls.push({ method, path: url.pathname, key: url.searchParams.get("api-key"), body: JSON.parse(String(init!.body)) });
      const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      return new Response(JSON.stringify(helius.hooks.find((hook) => hook.webhookID === id)), { status: 200 });
    }
    if (method === "PUT" && over.mergePut === true) {
      // ANSWERED 200, AND MERGED: the addresses sent are added to the ones held, none taken away.
      const body = JSON.parse(String(init!.body)) as HeliusWebhook;
      helius.calls.push({ method, path: url.pathname, key: url.searchParams.get("api-key"), body });
      const id = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      const index = helius.hooks.findIndex((hook) => hook.webhookID === id);
      const old = helius.hooks[index]!;
      helius.hooks[index] = { ...old, ...body, accountAddresses: [...new Set([...(old.accountAddresses ?? []), ...(body.accountAddresses ?? [])])] };
      return new Response(JSON.stringify(helius.hooks[index]), { status: 200 });
    }
    return helius.fetchImpl(input, init);
  };
}

/** One tick per 60 s sweep for an hour, each awaited; what was asked of Helius. */
async function anHour(engine: WebhookSync, addresses: readonly string[], helius: ReturnType<typeof fakeHelius>, start = 1_800_000_000_000) {
  for (let i = 0; i < 60; i += 1) await engine.tick({ acting: true, addresses, now: start + i * 60_000 });
  const count = (method: string) => helius.calls.filter((call) => call.method === method).length;
  return { list: count("GET"), create: count("POST"), update: count("PUT"), setActive: count("PATCH") };
}

const handMadeEnhanced: HeliusWebhook = {
  webhookID: "wh-hand-made-123456",
  webhookURL: URL_,
  webhookType: "enhanced",
  accountAddresses: ["someone-else"],
  transactionTypes: ["SWAP"],
  authHeader: "another-header",
  txnStatus: "success",
  active: true,
};

interface Logged {
  readonly level: string;
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

/** A sync over a fetch, with what it reported, what it logged, and (optionally) the doorbell's delivery counts. */
const syncOver = (
  fetchImpl: typeof fetch,
  reports: SyncReport[] = [],
  over: { deliveries?: () => { accepted: number; rejected: number }; secret?: Secret; logs?: Logged[] } = {},
) => {
  const own = over.secret ?? secret;
  return new WebhookSync({
    client: createHeliusWebhookClient({ apiKey, alsoScrub: [own], fetch: fetchImpl }),
    url: URL_,
    secret: own,
    onSynced: (report) => reports.push(report),
    log: (level, message, fields) => over.logs?.push({ level, message, fields }),
    ...(over.deliveries === undefined ? {} : { deliveries: over.deliveries }),
  });
};

describe("the sync does not pay for the same edit twice", () => {
  // THE INCIDENT: a PUT Helius refused (a hand-made "enhanced" webhook it would
  // not turn into "raw") was sent again EVERY SWEEP — 60 an hour, 100 credits a
  // request — because only a SUCCESSFUL edit started the ten-minute debounce.
  it("debounces a failing PUT by its attempt: at most one per ten minutes", async () => {
    const helius = fakeHelius([handMadeEnhanced]);
    const counts = await anHour(syncOver(shaped(helius, { refuse: "PUT" })), ["w1", "v1"], helius);
    expect(counts.update).toBeLessThanOrEqual(60 / (MIN_EDIT_INTERVAL_MS / 60_000));
    expect(counts.update).toBeGreaterThanOrEqual(1);
  });

  // (a) A list that does not echo authHeader made every look "differs": a PUT
  // every RECHECK_MS, forever, each reported as a success.
  it("never PUTs a header it wrote itself when the list leaves authHeader out, and stays healthy", async () => {
    const helius = fakeHelius();
    const withoutHeader = shaped(helius, { list: (hooks) => hooks.map(({ authHeader: _omitted, ...rest }) => rest) });
    const engine = syncOver(withoutHeader);
    const counts = await anHour(engine, ["w1", "v1"], helius);
    expect(counts.create).toBe(1);
    // This process created it with the secret: nothing to change, nothing to warn about.
    expect(counts.update).toBe(0);
    expect(engine.status().consecutiveFailures).toBe(0);
    expect(engine.syncAlert()).toEqual({ fire: null, clear: true });
  });

  it("PUTs a header it cannot see once per process, and then stays healthy", async () => {
    const helius = fakeHelius([{ ...handMadeEnhanced, webhookType: "raw", transactionTypes: ["ANY"], txnStatus: "all", accountAddresses: ["v1", "w1"] }]);
    const withoutHeader = shaped(helius, { list: (hooks) => hooks.map(({ authHeader: _omitted, ...rest }) => rest) });
    const engine = syncOver(withoutHeader);
    const counts = await anHour(engine, ["w1", "v1"], helius);
    expect(counts.update).toBe(1);
    expect(helius.hooks[0]!.authHeader).toBe(SECRET);
    expect(engine.status().consecutiveFailures).toBe(0);
  });

  // (b) A list that stores the URL in another form (a trailing slash) never
  // matched: a NEW webhook every ten minutes, each delivering every event.
  it("finds the webhook it created by its id when the URL comes back in another form, and never creates a second", async () => {
    const helius = fakeHelius();
    const slashed = shaped(helius, { list: (hooks) => hooks.map((hook) => ({ ...hook, webhookURL: `${hook.webhookURL}/` })) });
    const counts = await anHour(syncOver(slashed), ["w1", "v1"], helius);
    expect(counts.create).toBe(1);
    expect(helius.hooks).toHaveLength(1);
  });

  // (c) A PUT answered 200 whose change the list never shows: the same edit,
  // every ten minutes, forever, with no alert.
  it("stops sending an edit Helius did not keep, and warns doorbell-sync instead", async () => {
    const helius = fakeHelius();
    const engine = syncOver(shaped(helius, { freezePut: true }));
    await engine.tick({ acting: true, addresses: ["w1", "v1"], now: 1_800_000_000_000 });
    const counts = await anHour(engine, ["w1", "v1", "w2", "v2"], helius, 1_800_000_000_000 + MIN_EDIT_INTERVAL_MS);
    expect(counts.update).toBe(1);
    expect(engine.syncAlert().fire).toMatchObject({ key: "doorbell-sync" });
    expect(engine.status().lastSyncError).toContain("did not keep");
  });
});

describe("what a sync tells the doorbell", () => {
  const T = 1_800_000_000_000;
  const run = async (initial: HeliusWebhook[], addresses: readonly string[], fetchOver?: (helius: ReturnType<typeof fakeHelius>) => typeof fetch) => {
    const helius = fakeHelius(initial);
    const reports: SyncReport[] = [];
    const engine = new WebhookSync({
      client: client(fetchOver === undefined ? helius.fetchImpl : fetchOver(helius)),
      url: URL_,
      secret,
      onSynced: (report) => reports.push(report),
      log: () => undefined,
    });
    await engine.tick({ acting: true, addresses, now: T });
    return { reports, helius, engine };
  };
  const good = (over: Partial<HeliusWebhook> = {}): HeliusWebhook => ({
    webhookID: "wh-good-000000-abcdef",
    webhookURL: URL_,
    webhookType: "raw",
    accountAddresses: ["v1", "w1"],
    transactionTypes: ["ANY"],
    authHeader: SECRET,
    txnStatus: "all",
    active: true,
    ...over,
  });

  // A WINDOW IN WHICH HELIUS KNOWINGLY DROPPED DELIVERIES must end in a full
  // pass: auto-disabled, missing, or sending another header (403, never resent).
  it("reports a gap when it switches a disabled webhook back on", async () => {
    const { reports } = await run([good({ active: false })], ["w1", "v1"]);
    expect(reports.at(-1)!.gap).toContain("disabled");
  });

  it("reports a gap when it has to create the webhook", async () => {
    const { reports } = await run([], ["w1", "v1"]);
    expect(reports.at(-1)!.gap).toContain("did not exist");
    expect([...reports.at(-1)!.added].sort()).toEqual(["v1", "w1"]);
  });

  it("reports a gap when Helius held another Authorization header, and confirms the header once written", async () => {
    const { reports } = await run([good({ authHeader: "the-old-secret" })], ["w1", "v1"]);
    expect(reports.at(-1)!.gap).toContain("Authorization");
    expect(reports.at(-1)!.authConfirmed).toBe(true);
  });

  it("reports no gap, and only the addresses it added, for an ordinary address edit", async () => {
    const { reports } = await run([good()], ["w1", "v1", "w2", "v2"]);
    expect(reports.at(-1)!.gap).toBeNull();
    expect([...reports.at(-1)!.added].sort()).toEqual(["v2", "w2"]);
    expect(reports.at(-1)!.authConfirmed).toBe(true);
  });

  it("does not confirm a header it could not see and did not write", async () => {
    const { reports } = await run([good({ authHeader: "the-old-secret" })], ["w1", "v1"], (helius) => shaped(helius, { refuse: "PUT" }));
    expect(reports).toHaveLength(0);
    const held = await run([good({ authHeader: "the-old-secret", accountAddresses: ["v1", "w1"] })], ["w1", "v1"]);
    expect(held.reports.at(-1)!.authConfirmed).toBe(true);
  });
});

// ── what production showed on 2026-10-11 ─────────────────────────────────────
//
// THE INCIDENT. Every keeper PUT the webhook at boot ("synced action updated
// addresses 7") and, ten minutes later, read the list as an edit Helius did not
// keep: stuck, a failure every sweep (3,864 of them), a GET every 60 s, a warn
// that Telegram never forwards — and /status showing every link in the "new"
// lane while authenticated deliveries kept arriving. The list does not show
// what Helius holds; these are the ways it can fail to, each with its rule.

const MINUTE = 60_000;
const T_BOOT = 1_800_000_000_000;

/** A webhook already right in every respect: raw, ANY, all, our header, v1 and w1. */
const existing = (over: Partial<HeliusWebhook> = {}): HeliusWebhook => ({
  webhookID: "wh-existing-000000-abcdef",
  webhookURL: URL_,
  webhookType: "raw",
  accountAddresses: ["v1", "w1"],
  transactionTypes: ["ANY"],
  authHeader: SECRET,
  txnStatus: "all",
  active: true,
  ...over,
});

/** Ticks once a minute over [from, to] (minutes after `start`), calling `after` with each minute. */
async function minutes(engine: WebhookSync, addresses: readonly string[], from: number, to: number, after?: (minute: number) => void, start = T_BOOT) {
  for (let minute = from; minute <= to; minute += 1) {
    await engine.tick({ acting: true, addresses, now: start + minute * MINUTE });
    after?.(minute);
  }
}

const countOf = (helius: ReturnType<typeof fakeHelius>, method: string): number => helius.calls.filter((call) => call.method === method).length;

/** A header shown masked: its first and last four characters, stars between, the same length. */
const maskOf = (value: string): string => `${value.slice(0, 4)}${"*".repeat(value.length - 8)}${value.slice(-4)}`;
const masking = (helius: ReturnType<typeof fakeHelius>) =>
  shaped(helius, { list: (hooks) => hooks.map((hook) => ({ ...hook, authHeader: maskOf(hook.authHeader ?? "") })) });
const bearer = (helius: ReturnType<typeof fakeHelius>) =>
  shaped(helius, { list: (hooks) => hooks.map((hook) => ({ ...hook, authHeader: `Bearer ${hook.authHeader ?? ""}` })) });

describe("the header the list shows (H1)", () => {
  // T1
  it("takes a masked header whose visible ends are ours as ours: no PUT even at boot, no failure in an hour", async () => {
    const helius = fakeHelius([existing()]);
    const engine = syncOver(masking(helius));
    const counts = await anHour(engine, ["w1", "v1"], helius);
    expect(counts.update).toBe(0);
    const diff = engine.status().lastDiff!;
    expect(diff.auth).toMatchObject({
      state: "different",
      verdict: "masked-ours",
      hint: { looksMasked: true, prefixAgrees: true, suffixAgrees: true, length: "equal", visibleChars: 8 },
    });
    expect(diff.differs).toEqual([]);
    expect(engine.status().consecutiveFailures).toBe(0);
    expect(engine.syncAlert()).toEqual({ fire: null, clear: true });
  });

  // T2
  it("PUTs once over a masked header whose visible ends are another secret's, and is healthy after", async () => {
    const helius = fakeHelius([existing({ authHeader: "zz-another-secret-0123456789abcdef-yy" })]);
    const reports: SyncReport[] = [];
    const engine = syncOver(masking(helius), reports);
    const counts = await anHour(engine, ["w1", "v1"], helius);
    expect(counts.update).toBe(1);
    expect(reports[0]!.gap).toContain("Authorization");
    expect(engine.status().lastDiff!.auth.verdict).toBe("masked-ours");
    expect(engine.status().consecutiveFailures).toBe(0);
  });

  // T3
  it("PUTs a header it cannot match once per process, then trusts what it wrote: written-by-us, no failure, ≤ 7 GETs an hour", async () => {
    const helius = fakeHelius([existing()]);
    const engine = syncOver(bearer(helius));
    const counts = await anHour(engine, ["w1", "v1"], helius);
    expect(counts.update).toBe(1);
    expect(counts.list).toBeLessThanOrEqual(7);
    expect(engine.status().lastDiff!.auth).toMatchObject({
      state: "different",
      verdict: "written-by-us",
      evidence: "none",
      hint: { containsOurs: true, looksMasked: false, length: "longer" },
    });
    expect(engine.status().consecutiveFailures).toBe(0);
    // A DEPLOY: the next process has written nothing yet, and pays one PUT of its own.
    const next = syncOver(bearer(helius));
    await minutes(next, ["w1", "v1"], 60, 119);
    expect(countOf(helius, "PUT")).toBe(2);
    expect(next.status().consecutiveFailures).toBe(0);
  });

  // T4
  it("withdraws that trust when deliveries since the edit were refused and none accepted: stuck, one GET per ten minutes, warn, then a page at an hour", async () => {
    const helius = fakeHelius([existing()]);
    const delivered = { accepted: 0, rejected: 0 };
    const engine = syncOver(bearer(helius), [], { deliveries: () => ({ ...delivered }) });
    await engine.tick({ acting: true, addresses: ["w1", "v1"], now: T_BOOT });
    delivered.rejected += 3;
    const severity = new Map<number, string | null>();
    await minutes(engine, ["w1", "v1"], 1, 80, (minute) => severity.set(minute, engine.syncAlert().fire?.severity ?? null));
    expect(countOf(helius, "PUT")).toBe(1);
    expect(countOf(helius, "GET")).toBe(1 + 8);
    expect(engine.status().lastDiff!.auth).toMatchObject({ verdict: "differs", evidence: "refused" });
    expect(engine.status().lastSyncError).toContain("did not keep");
    // Stuck from minute 10: the third failure is minute 30, an hour of them is minute 70.
    expect(engine.status().failingSince).toBe(new Date(T_BOOT + 10 * MINUTE).toISOString());
    expect(severity.get(29)).toBeNull();
    expect(severity.get(30)).toBe("warn");
    expect(severity.get(69)).toBe("warn");
    expect(severity.get(70)).toBe("critical");
  });

  // T5
  it("calls the header proven once a delivery is accepted after the edit", async () => {
    const helius = fakeHelius([existing()]);
    const delivered = { accepted: 0, rejected: 0 };
    const engine = syncOver(bearer(helius), [], { deliveries: () => ({ ...delivered }) });
    await engine.tick({ acting: true, addresses: ["w1", "v1"], now: T_BOOT });
    delivered.rejected += 1;
    delivered.accepted += 1;
    await minutes(engine, ["w1", "v1"], 1, 30);
    expect(engine.status().lastDiff!.auth).toMatchObject({ verdict: "written-by-us", evidence: "proven" });
    expect(engine.status().consecutiveFailures).toBe(0);
    expect(countOf(helius, "PUT")).toBe(1);
  });
});

describe("the shape the list shows", () => {
  // T6
  it("takes RAW / ALL / [\"any\"] for raw / all / [\"ANY\"]: no PUT, nothing wrong, and the values as shown", async () => {
    const helius = fakeHelius([existing({ webhookType: "RAW", txnStatus: "ALL", transactionTypes: ["any"], encoding: "jsonParsed" })]);
    const engine = syncOver(helius.fetchImpl);
    const counts = await anHour(engine, ["w1", "v1"], helius);
    expect(counts.update).toBe(0);
    expect(engine.status().lastDiff!.shape).toEqual({ webhookType: "RAW", transactionTypes: ["any"], txnStatus: "ALL", encoding: "jsonParsed", wrong: [] });
    expect(engine.status().consecutiveFailures).toBe(0);
  });

  // T7
  it("PUTs over a hand-made enhanced webhook, naming every field that was wrong", async () => {
    const helius = fakeHelius([handMadeEnhanced]);
    const result = await ensureWebhook(client(helius.fetchImpl), { url: URL_, authHeader: SECRET, addresses: ["w1", "v1"] }, true);
    expect(result.action).toBe("updated");
    expect(result.diff!.shape).toMatchObject({ webhookType: "enhanced", transactionTypes: ["SWAP"], txnStatus: "success" });
    expect(result.diff!.shape.wrong).toEqual(["webhookType", "transactionTypes", "txnStatus"]);
    expect(result.diff!.differs).toEqual(["addresses", "auth", "shape"]);
    expect(result.gap).toContain("raw webhook");
  });
});

describe("the addresses the list shows (H2)", () => {
  // T8 — THE ONE PRODUCTION MOST LIKELY HIT.
  it("trusts the addresses it wrote when the list leaves accountAddresses out, and tells the doorbell Helius holds them all", async () => {
    const helius = fakeHelius([existing()]);
    const reports: SyncReport[] = [];
    const engine = syncOver(shaped(helius, { list: (hooks) => hooks.map(({ accountAddresses: _omitted, ...rest }) => rest) }), reports);
    const counts = await anHour(engine, ["w1", "v1", "w2"], helius);
    expect(counts.update).toBe(1);
    expect(counts.list).toBeLessThanOrEqual(7);
    expect(engine.status().lastDiff!.addresses).toMatchObject({ listed: false, held: 0, missing: 3, verdict: "written-unlisted" });
    expect(engine.status().lastDiff!.differs).toEqual([]);
    expect([...reports.at(-1)!.watched].sort()).toEqual(["v1", "w1", "w2"]);
    expect(engine.status().consecutiveFailures).toBe(0);
  });

  // T9
  it("is not stuck on a list cut at Helius's 100 addresses", async () => {
    const many = Array.from({ length: 120 }, (_, index) => `address-${String(index).padStart(3, "0")}`);
    const helius = fakeHelius();
    const reports: SyncReport[] = [];
    const capped = shaped(helius, { list: (hooks) => hooks.map((hook) => ({ ...hook, accountAddresses: (hook.accountAddresses ?? []).slice(0, LIST_ADDRESS_CAP) })) });
    const engine = syncOver(capped, reports);
    const counts = await anHour(engine, many, helius);
    expect(counts.create).toBe(1);
    expect(counts.update).toBe(0);
    expect(engine.status().lastDiff!.addresses).toMatchObject({ held: 100, desired: 120, missing: 20, extra: 0, verdict: "list-capped" });
    expect(reports.at(-1)!.watched.size).toBe(120);
    expect(engine.status().consecutiveFailures).toBe(0);
  });

  // T10
  it("is stuck on an empty list after its edit with no delivery since, and healthy once one is accepted", async () => {
    const emptied = (helius: ReturnType<typeof fakeHelius>) => shaped(helius, { list: (hooks) => hooks.map((hook) => ({ ...hook, accountAddresses: [] })) });

    const silent = fakeHelius([existing()]);
    const stuck = syncOver(emptied(silent), [], { deliveries: () => ({ accepted: 0, rejected: 0 }) });
    const quiet = await anHour(stuck, ["w1", "v1"], silent);
    expect(quiet.update).toBe(1);
    expect(quiet.list).toBeLessThanOrEqual(7);
    expect(stuck.status().lastDiff!.addresses).toMatchObject({ listed: true, held: 0, verdict: "differs" });
    expect(stuck.status().lastDiff!.auth.evidence).toBe("none");
    expect(stuck.status().lastSyncError).toContain("did not keep");

    const heard = fakeHelius([existing()]);
    const delivered = { accepted: 0, rejected: 0 };
    const healthy = syncOver(emptied(heard), [], { deliveries: () => ({ ...delivered }) });
    await healthy.tick({ acting: true, addresses: ["w1", "v1"], now: T_BOOT });
    delivered.accepted += 2;
    await minutes(healthy, ["w1", "v1"], 1, 59);
    expect(countOf(heard, "PUT")).toBe(1);
    expect(healthy.status().lastDiff!.addresses.verdict).toBe("written-unlisted");
    expect(healthy.status().lastDiff!.auth.evidence).toBe("proven");
    expect(healthy.status().consecutiveFailures).toBe(0);
  });

  // T11
  it("takes a PUT that merged — every address it sent, plus an old one — as done", async () => {
    const helius = fakeHelius([existing({ accountAddresses: ["old-address-1"] })]);
    const engine = syncOver(shaped(helius, { mergePut: true }));
    const counts = await anHour(engine, ["w1", "v1"], helius);
    expect(counts.update).toBe(1);
    expect(engine.status().lastDiff!.addresses).toMatchObject({ missing: 0, extra: 1, extraSample: ["old-address-1"], verdict: "extra-only" });
    expect(engine.status().consecutiveFailures).toBe(0);
  });
});

describe("an edit Helius really did not keep", () => {
  // T12
  it("is looked at every ten minutes, not every sweep, and names the addresses it lacks — in the list and in the PUT's answer", async () => {
    const helius = fakeHelius();
    const engine = syncOver(shaped(helius, { freezePut: true }));
    await engine.tick({ acting: true, addresses: ["w1", "v1"], now: T_BOOT });
    await minutes(engine, ["w1", "v1", "w2", "v2"], 10, 69);
    expect(countOf(helius, "PUT")).toBe(1);
    expect(countOf(helius, "GET") - 1).toBeLessThanOrEqual(7);
    expect(engine.status().lastDiff!.addresses).toMatchObject({ verdict: "differs", missing: 2, missingSample: ["v2", "w2"] });
    expect(engine.status().lastEditEcho!.addresses).toMatchObject({ missing: 2, missingSample: ["v2", "w2"] });
    expect(engine.status().lastSyncError).toContain("did not keep");
  });

  // T13
  it("keeps the answer to every create and PUT, described, as lastEditEcho", async () => {
    const helius = fakeHelius();
    const engine = syncOver(helius.fetchImpl);
    await engine.tick({ acting: true, addresses: ["w1", "v1"], now: T_BOOT });
    expect(engine.status().lastEditEcho).toMatchObject({ source: "edit-answer", differs: [], addresses: { held: 2, missing: 0 } });
    expect(engine.status().lastDiff).toBeNull();
    await engine.tick({ acting: true, addresses: ["w1", "v1", "w2"], now: T_BOOT + MIN_EDIT_INTERVAL_MS });
    expect(engine.status().lastEditEcho).toMatchObject({ source: "edit-answer", differs: [], addresses: { held: 3, missing: 0 } });
    expect(engine.status().lastDiff).toMatchObject({ source: "list", differs: ["addresses"], addresses: { missing: 1, missingSample: ["w2"] } });
  });
});

describe("what the diagnostics may carry", () => {
  // T14. A secret of its own: the shared SECRET contains the word "secret", which a field name could contain too.
  const OWN = "Q7mZ2vKp9XwR4tLb8NcY3hJs6FdG1aEu";
  const own = new Secret(OWN, "doorbellSecret");
  const windows = Array.from({ length: OWN.length - 5 }, (_, index) => OWN.slice(index, index + 6));

  it("never carries six characters of the header in a row — not in /status, a log line or doorbell-sync — whatever the list shows", async () => {
    // A WIDE MASK TOO: four visible characters a side could leak whole and never fill a six-character window.
    const wide = (value: string): string => `${value.slice(0, 10)}${"*".repeat(Math.max(0, value.length - 20))}${value.slice(-10)}`;
    const views: Record<string, (helius: ReturnType<typeof fakeHelius>) => typeof fetch> = {
      masked: masking,
      "masked wide": (helius) => shaped(helius, { list: (hooks) => hooks.map((hook) => ({ ...hook, authHeader: wide(hook.authHeader ?? "") })) }),
      bearer,
      unlisted: (helius) => shaped(helius, { list: (hooks) => hooks.map(({ accountAddresses: _omitted, ...rest }) => rest) }),
      "upper case": (helius) => shaped(helius, { list: (hooks) => hooks.map((hook) => ({ ...hook, authHeader: `${hook.authHeader ?? ""}`.toUpperCase() })) }),
      frozen: (helius) => shaped(helius, { freezePut: true }),
    };
    for (const [name, view] of Object.entries(views)) {
      for (const held of [OWN, `${OWN.slice(0, 12)}-the-old-one-${OWN.slice(-12)}`]) {
        const helius = fakeHelius([existing({ authHeader: held })]);
        const logs: Logged[] = [];
        const delivered = { accepted: 0, rejected: 0 };
        const engine = syncOver(view(helius), [], { secret: own, logs, deliveries: () => ({ ...delivered }) });
        await engine.tick({ acting: true, addresses: ["w1", "v1"], now: T_BOOT });
        delivered.rejected += 1;
        await minutes(engine, ["w1", "v1", "w2"], 10, 90);
        const served = [JSON.stringify(engine.status()), JSON.stringify(engine.syncAlert()), JSON.stringify(logs)].join("\n");
        expect(logs.length, name).toBeGreaterThan(0);
        for (const window of windows) expect(served, `${name}: six characters of the header`).not.toContain(window);
      }
    }
  });
});

describe("doorbell-sync pages", () => {
  // E1
  it("over a Helius outage: a look every sweep, warn at the third failure, still warn at minute 59, critical at 60, cleared by a success", async () => {
    const helius = fakeHelius();
    let down = true;
    let asked = 0;
    const flaky: typeof fetch = async (input, init) => {
      if (down) {
        asked += 1;
        return new Response("upstream error", { status: 503 });
      }
      return helius.fetchImpl(input, init);
    };
    const engine = syncOver(flaky);
    const severity = new Map<number, string | null>();
    await minutes(engine, ["w1", "v1"], 0, 60, (minute) => severity.set(minute, engine.syncAlert().fire?.severity ?? null));
    expect(asked).toBe(61);
    expect(severity.get(1)).toBeNull();
    expect(severity.get(2)).toBe("warn");
    expect(severity.get(59)).toBe("warn");
    expect(severity.get(60)).toBe("critical");
    const page = engine.syncAlert().fire!;
    expect(page.title).toContain("out of step for an hour");
    expect(page.detail).toContain("60 min");
    expect(engine.status().failingSince).toBe(new Date(T_BOOT).toISOString());
    down = false;
    await engine.tick({ acting: true, addresses: ["w1", "v1"], now: T_BOOT + 61 * MINUTE });
    expect(engine.syncAlert()).toEqual({ fire: null, clear: true });
    expect(engine.status().failingSince).toBeNull();
  });

  // E2
  it("over a webhook stuck for two hours: warn, then critical, with what the last look saw", async () => {
    const helius = fakeHelius();
    const engine = syncOver(shaped(helius, { freezePut: true }));
    await engine.tick({ acting: true, addresses: ["w1", "v1"], now: T_BOOT });
    const severity = new Map<number, string | null>();
    await minutes(engine, ["w1", "v1", "w2", "v2"], 10, 130, (minute) => severity.set(minute, engine.syncAlert().fire?.severity ?? null));
    // The PUT at minute 10, stuck from minute 20: the third failure is minute 40, an hour of them minute 80.
    expect(countOf(helius, "GET")).toBe(1 + 13);
    expect(severity.get(39)).toBeNull();
    expect(severity.get(40)).toBe("warn");
    expect(severity.get(79)).toBe("warn");
    expect(severity.get(80)).toBe("critical");
    expect(severity.get(130)).toBe("critical");
    expect(engine.syncAlert().fire!.detail).toContain("addresses 2/4 listed (missing 2) differs");
  });
});
