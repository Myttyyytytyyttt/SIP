import { defineConfig } from "vitest/config";

// The local end-to-end proof, and only it: `pnpm --dir packages/solana-keeper
// test:local`. vitest.config.ts never matches test-local/, so `pnpm test` starts
// no validator. One file at a time, because every file would want the same
// ports; in forked processes, because the validator's exit and signal hooks
// (test-local/local-validator.ts) need a process of their own, not a thread.
export default defineConfig({
  test: {
    include: ["test-local/**/*.local.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: "forks",
  },
});
