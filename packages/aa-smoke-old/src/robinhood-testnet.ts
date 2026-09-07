import { pathToFileURL } from "node:url";
import { parseSmokeConfig, secretValues } from "./config.js";
import { runSmoke } from "./runtime.js";

export function redactForOutput(
  message: string,
  secrets: readonly string[],
): string {
  let redacted = message;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.replace(/0x[0-9a-fA-F]{64,}/g, "[REDACTED_HEX]");
}

export async function main(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  let secrets: string[] = [];
  try {
    const config = parseSmokeConfig(env);
    secrets = secretValues(config);
    const result = await runSmoke(config);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown smoke failure.";
    process.stderr.write(
      `aa-smoke failed: ${redactForOutput(message, secrets)}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  await main();
}
