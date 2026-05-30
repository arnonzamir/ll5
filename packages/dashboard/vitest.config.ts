import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror tsconfig "paths": "@/*" -> "./src/*" so unit tests can import
      // shared helpers across route folders (e.g. the agent runtime helpers
      // reused by the tenant console).
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 10000,
  },
});
