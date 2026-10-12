import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "tests/architecture.test.ts"],
        },
      },
      {
        // Real PostgreSQL, one file at a time: every file resets the same database.
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          fileParallelism: false,
          globalSetup: ["tests/helpers/global-setup.ts"],
          setupFiles: ["tests/helpers/setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
