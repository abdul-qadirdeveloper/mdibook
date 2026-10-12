// Test database reset. Every integration test file starts from an empty database.
import { db } from "@/lib/db";

/**
 * Empties every table. Audit events are append-only, including against TRUNCATE, so the reset
 * switches that one trigger off for the length of its own transaction. Only tests do this.
 */
export async function resetDb(): Promise<void> {
  await db.$transaction([
    db.$executeRawUnsafe('ALTER TABLE "AuditEvent" DISABLE TRIGGER "AuditEvent_no_truncate"'),
    db.$executeRawUnsafe('TRUNCATE "Clinic", "User", "Specialty", "AuditEvent", "StaffLookupLog" CASCADE'),
    db.$executeRawUnsafe('ALTER TABLE "AuditEvent" ENABLE TRIGGER "AuditEvent_no_truncate"'),
  ]);
}

/** The SQLSTATE and constraint text of a database error raised through Prisma. */
export function dbError(error: unknown): { sqlState: string | null; text: string } {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: Record<string, unknown> } } } | null)?.meta;
  const cause = meta?.driverAdapterError?.cause ?? {};
  const sqlState = (cause.originalCode ?? cause.code ?? null) as string | null;
  const text = String(cause.originalMessage ?? cause.message ?? (error as Error)?.message ?? "");
  return { sqlState, text };
}

/** Runs a statement that must fail, and returns the database's error. */
export async function expectDbError(run: () => Promise<unknown>): Promise<{ sqlState: string | null; text: string }> {
  try {
    await run();
  } catch (error) {
    return dbError(error);
  }
  throw new Error("Expected the database to refuse this, but it was accepted");
}
