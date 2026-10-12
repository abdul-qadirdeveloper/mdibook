// Runs in every integration test worker before the test file is imported, so that
// src/lib/db.ts connects to the test database.
import { afterAll, beforeEach } from "vitest";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set.");
process.env.DATABASE_URL = url;

// Application log lines stay out of the test output. captureLogs() reads them when a test
// needs to.
beforeEach(async () => {
  const { setLogSink } = await import("@/lib/logger");
  setLogSink(() => {});
});

afterAll(async () => {
  const { db } = await import("@/lib/db");
  await db.$disconnect();
});
