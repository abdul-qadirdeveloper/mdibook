// Shared input schemas: ids, instants, reason codes. Route handlers validate against these
// before acting. Validation problems name the field and the problem, never the value (R89).
import { z } from "zod";
import { CANCEL_REASON_CODES, SCHEDULE_CHANGE_REASON_CODES } from "@/domain/reason-codes";
import { isLocalDate } from "@/domain/time";
import type { FieldProblem } from "@/lib/errors";

/** A random opaque id (R9). */
export const idSchema = z.uuid();

/** A UTC instant, as an ISO 8601 string with "Z" or an offset. Parsed to a Date. */
export const instantSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

/** A calendar date, "YYYY-MM-DD". */
export const localDateSchema = z.string().refine(isLocalDate);

/** A date of birth: a calendar date that is not in the future. */
export const dateOfBirthSchema = localDateSchema.refine(
  (value) => value <= new Date().toISOString().slice(0, 10) && value >= "1900-01-01",
);

/** Reason for visit: free text of at most 200 characters (R20). */
export const reasonForVisitSchema = z.string().trim().min(1).max(200);

export const cancelReasonCodeSchema = z.enum(CANCEL_REASON_CODES);
export const scheduleChangeReasonCodeSchema = z.enum(SCHEDULE_CHANGE_REASON_CODES);

/** The Idempotency-Key header (R27). */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Turns a schema failure into field problems. Built from issue codes, never from the input. */
export function fieldProblems(error: z.ZodError, prefix = ""): FieldProblem[] {
  const seen = new Set<string>();
  const problems: FieldProblem[] = [];
  for (const issue of error.issues) {
    const path = issue.path.map(String).join(".");
    const field = [prefix, path].filter(Boolean).join(".") || "body";
    if (seen.has(field)) continue;
    seen.add(field);
    let problem: FieldProblem["problem"] = "invalid";
    if (issue.code === "too_big") problem = "too_long";
    else if (issue.code === "too_small") problem = "too_short";
    else if (issue.code === "unrecognized_keys") problem = "not_allowed";
    else if (issue.code === "invalid_type" && /received undefined/.test(issue.message)) problem = "required";
    problems.push({ field, problem });
  }
  return problems;
}
