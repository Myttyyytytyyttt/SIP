// The checklist gives every row its own React key, even when several problems
// name the same variable (the core emits one per bad SIP_SOLANA_RPC_URLS entry).

import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { SetupChecklist } from "@/components/wallets/SetupChecklist";

describe("SetupChecklist", () => {
  it("keys each row uniquely when problems share a variable", () => {
    const problems = [
      { variable: "SIP_SOLANA_RPC_URLS", message: "entry #1 is not an http(s) URL", howToFix: "Use https:// URLs." },
      { variable: "SIP_SOLANA_RPC_URLS", message: "entry #2 is not an http(s) URL", howToFix: "Use https:// URLs." },
      { variable: "SIP_TRUSTED_CLIENT_IP_HEADER", message: "required", howToFix: "Name the edge's header." },
    ];
    const list = SetupChecklist({ problems }) as ReactElement<{ children: readonly ReactElement[] }>;
    const keys = list.props.children.map((row) => row.key);
    expect(keys).toHaveLength(problems.length);
    expect(new Set(keys).size).toBe(problems.length);
  });
});
