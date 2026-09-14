import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // `server-only` throws unless the react-server condition is active. Next
    // aliases it for server layers; vitest does not, so the tests point it at
    // an empty module. test/client-entry.test.ts still asserts the real import
    // is the first line of src/server/index.ts.
    alias: { "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
