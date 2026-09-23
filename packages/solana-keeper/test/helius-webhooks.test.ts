// The Helius webhook client and its sync (src/helius-webhooks.ts), against an
// in-memory Helius: no network, no key, and a fetch that can be made to fail
// in every way a real one does — including the ways that quote the URL, which
// is where the API key lives.

import { inspect } from "node:util";
import { Secret } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import {
  HeliusWebhookError,
  MAX_WEBHOOK_ADDRESSES,
  MIN_EDIT_INTERVAL_MS,
  RECHECK_MS,
  SYNC_FAILURE_ALERT_STREAK,
  WebhookSync,
  createHeliusWebhookClient,
  ensureWebhook,
  syncDue,
  type HeliusWebhook,
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
  const base = { now: 1_000_000_000, lastCheckAt: 1_000_000_000 - 60_000, lastEditAt: 1_000_000_000 - 60_000, lastFailed: false, differs: false };

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
      onWatched: (set) => watched.push(set),
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
      onWatched: () => undefined,
      log: () => {
        throw new Error("the logger broke");
      },
    });
    await expect(engine.tick({ acting: true, addresses: ["a"], now: 0 })).resolves.toBeUndefined();
    // And the guard is released, so the next sweep can try again.
    expect(engine.tick({ acting: true, addresses: ["a"], now: 60_000 })).not.toBeNull();
  });
});
