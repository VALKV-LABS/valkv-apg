import { defineConfig } from "vitest/config";

// Integration tests run against a real Postgres (spec DB-6). They share one
// database, so files run one at a time.
export default defineConfig({
  test: {
    include: ["test/integ/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
