// The real Privy adapter's transport, against a fetch that never leaves the
// process: where it sends the app secret, how many times it tries, and what the
// SDK logs while it does.
//
// No network and no credential: the fetch below records each request and
// answers it itself, and the app secret is a throwaway string.

import { generateP256KeyPair } from "@privy-io/node";
import { Secret } from "@sip/worker/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { buildKeeperPolicy } from "../src/privy-policy.js";
import { createPrivyPolicyClient } from "../src/privy-policy-client.js";
import { PRIVY_API_URL } from "../src/privy-signer.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
}

/** A fetch that answers every request with `status` and `body`, and remembers what was asked. */
function answering(status: number, body: unknown): { readonly fetch: typeof globalThis.fetch; readonly sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    sent.push({
      url: request?.url ?? String(input),
      method: init?.method ?? request?.method ?? "GET",
      headers: new Headers(init?.headers ?? request?.headers),
    });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, sent };
}

const credentials = {
  appId: "sipprivyapp0000000000000001",
  appSecret: new Secret("privy-app-secret-NeverSent-0009", "privyAppSecret"),
};

describe("createPrivyPolicyClient", () => {
  it("sends to api.privy.io and logs no request details, whatever PRIVY_API_BASE_URL and PRIVY_API_LOG say", async () => {
    vi.stubEnv("PRIVY_API_BASE_URL", "http://127.0.0.1:9/");
    vi.stubEnv("PRIVY_API_LOG", "debug");
    const logged = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
    ];
    const { fetch, sent } = answering(404, { error: "Policy not found" });

    await expect(createPrivyPolicyClient(credentials, { fetch }).getPolicy("keeperPolicy000000000001")).rejects.toMatchObject({ status: 404 });
    expect(sent.map((request) => new URL(request.url).origin)).toEqual([PRIVY_API_URL]);
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });

  it("tries each create once, even on a 504, and sends the policy with an idempotency key", async () => {
    const { fetch, sent } = answering(504, { error: "gateway timeout" });
    const client = createPrivyPolicyClient(credentials, { fetch });
    const { publicKey } = await generateP256KeyPair();

    await expect(client.createKeyQuorum({ publicKey, displayName: "sip-solana-policy-admin" })).rejects.toMatchObject({ status: 504 });
    expect(sent).toHaveLength(1);
    await expect(client.createPolicy(buildKeeperPolicy(SIP_PROGRAM_ID), "adminQuorum0000000000001")).rejects.toMatchObject({ status: 504 });
    expect(sent).toHaveLength(2);

    expect(sent.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["POST", "/v1/key_quorums"],
      ["POST", "/v1/policies"],
    ]);
    expect(sent[1]!.headers.get("privy-idempotency-key")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
