import { defineConfig } from "vitest/config";

// Runs the built CLI against a real admin (`make integ`). The tests share one
// workspace, so files run one at a time.
export default defineConfig({
  test: {
    include: ["test/integ/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
