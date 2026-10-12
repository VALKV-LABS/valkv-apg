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
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // index.ts is process start-up; the rest of the service is what these tests drive.
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      reporter: ["text-summary", "text"],
      // `npm run coverage:integ` fails below these.
      thresholds: { lines: 80, statements: 80 },
    },
  },
});
