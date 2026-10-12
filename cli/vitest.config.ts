import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The entry point only wires the terminal to run(); everything it calls is covered.
      exclude: ["src/**/*.test.ts", "src/apgctl.ts"],
      reporter: ["text-summary"],
      // `npm run coverage` (what `make unit-cli` runs) fails below these.
      thresholds: { lines: 80, statements: 80, branches: 75 },
    },
  },
});
