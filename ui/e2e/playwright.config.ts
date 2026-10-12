import { defineConfig } from "@playwright/test";

// The tests share one control plane and create real resources, so they run in order.
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env["BASE_URL"] ?? "http://localhost:9000",
    colorScheme: "dark",
    trace: "off",
  },
});
