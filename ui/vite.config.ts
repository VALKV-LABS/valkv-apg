/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The admin serves the built files under /ui/. In development, `npm run dev`
// proxies the API to an admin on localhost:9000.
export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
  server: {
    proxy: { "/v1": "http://localhost:9000", "/ui/config.json": "http://localhost:9000" },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
