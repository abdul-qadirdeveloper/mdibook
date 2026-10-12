// The database client. The only file that imports the generated Prisma client.
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../../generated/prisma/client";

const globalForDb = globalThis as unknown as { medibookDb?: PrismaClient };

/**
 * Connection settings. Every session runs in UTC (R67): the adapter reads and writes
 * timestamps as if the session zone were UTC, so any other zone would shift every instant.
 */
export function connectionConfig(connectionString: string | undefined) {
  return { connectionString, options: "-c TimeZone=UTC" };
}

function createClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg(connectionConfig(process.env.DATABASE_URL)),
    // Query logging can show parameter values, so it is on in local development only (R79).
    log: process.env.NODE_ENV === "development" ? ["query"] : [],
  });
}

export const db: PrismaClient = globalForDb.medibookDb ?? createClient();
if (process.env.NODE_ENV !== "production") globalForDb.medibookDb = db;

/** A client inside db.$transaction. */
export type Tx = Prisma.TransactionClient;
/** Either the client or a transaction: anything that can run a query. */
export type DbClient = PrismaClient | Tx;

export { Prisma };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for the random ids the database generates (R9). */
export function isId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The index a unique violation was raised on, or null if the error is not a unique violation. */
export function violatedUniqueIndex(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return null;
  const meta = error.meta as
    | { driverAdapterError?: { cause?: { constraint?: { index?: string } } } }
    | undefined;
  return meta?.driverAdapterError?.cause?.constraint?.index ?? "unknown";
}
