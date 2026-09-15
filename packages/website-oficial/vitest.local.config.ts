import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The local end-to-end proof, and only it: `pnpm --dir packages/website-oficial
// test:local`, after `pnpm --filter @sip/web run build`. vitest.config.ts never
// matches test-local/, so `pnpm test` starts no validator and no server. One file
// at a time, because every file would want the same ports; in forked processes,
// because the validator's exit and signal hooks need a process of their own.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The same stub vitest.config.ts uses: the proof imports @sip/solana-core/server's builders.
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test-local/**/*.local.test.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
