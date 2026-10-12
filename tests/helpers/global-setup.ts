// Runs once before the integration tests: makes sure the test database exists and is migrated.
// Integration tests use real PostgreSQL. The database is never mocked.
import { execSync } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Copy .env.example to .env and start PostgreSQL with `make db`.",
    );
  }
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  // Every test file empties this database, so it must not be the development one.
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error("TEST_DATABASE_URL must name a database that ends in _test.");
  }

  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: maintenance.toString(), options: "-c TimeZone=UTC" }) });
  try {
    const existing = await client.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (existing.length === 0) await client.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await client.$disconnect();
  }

  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
