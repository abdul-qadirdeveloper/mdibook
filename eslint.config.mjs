import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // All logging goes through src/lib/logger.ts.
    files: ["src/**/*.{ts,tsx}"],
    rules: { "no-console": "error" },
  },
  {
    // src/domain is pure logic.
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/db", "**/lib/db", "**/generated/prisma/**", "@prisma/*", "pg"],
              message: "src/domain must not import the database.",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([".next/**", "next-env.d.ts", "generated/**", "playwright-report/**", "test-results/**"]),
]);
