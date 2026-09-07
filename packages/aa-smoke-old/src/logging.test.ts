import { describe, expect, it } from "vitest";
import { redactForOutput } from "./robinhood-testnet.js";

describe("CLI output redaction", () => {
  it("removes configured credentials and 32-byte hex material from errors", () => {
    const apiKey = "alchemy-api-secret";
    const privateKey = `0x${"ab".repeat(32)}`;
    const output = redactForOutput(
      `request https://example.invalid/${apiKey} failed for ${privateKey}`,
      [apiKey, privateKey],
    );

    expect(output).not.toContain(apiKey);
    expect(output).not.toContain(privateKey);
    expect(output).toContain("[REDACTED]");
  });
});
