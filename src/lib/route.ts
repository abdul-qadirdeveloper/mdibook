// The wrapper every route handler is built with. It runs the four steps in order:
// authenticate, authorize, validate, act. It adds the request reference id, maps errors to the
// one error shape, and logs ids only. Request bodies and query values are never logged (R79).
import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import type { Role } from "@/domain/transitions";
import {
  AppError,
  type ErrorCode,
  type ErrorDetails,
  type FieldProblem,
  type MessageVariant,
  errorBody,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { fieldProblems, idempotencyKeySchema } from "@/lib/schemas";
import { requireRole } from "@/lib/scope";
import { type Session, getSession } from "@/lib/session";

export const REQUEST_ID_HEADER = "x-request-id";
export const IDEMPOTENCY_HEADER = "idempotency-key";

export interface RouteContext<B, Q, P> {
  request: Request;
  /** Reference id for this request. Returned in the response and in every error. */
  requestId: string;
  /** One clock reading for the whole request. */
  now: Date;
  session: Session;
  params: P;
  query: Q;
  body: B;
  /** The validated Idempotency-Key header, or null. */
  idempotencyKey: string | null;
}

export interface RouteResult {
  status?: number;
  body: unknown;
}

export interface RouteConfig<B, Q, P> {
  /** Roles that may ever perform this kind of action. Anyone else gets FORBIDDEN. */
  roles: readonly Role[];
  params?: ZodType<P>;
  query?: ZodType<Q>;
  body?: ZodType<B>;
  handler: (context: RouteContext<B, Q, P>) => Promise<RouteResult>;
}

type NextRouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

function respond(status: number, body: unknown, requestId: string): Response {
  return Response.json(body, {
    status,
    headers: { [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" },
  });
}

function fail(code: ErrorCode, requestId: string, details?: ErrorDetails, messageVariant?: MessageVariant): Response {
  return respond(new AppError(code).status, errorBody(code, requestId, details, messageVariant), requestId);
}

// The class of an unexpected error and its database error code, as an event suffix. The
// error's message is never logged: it can quote the values that caused it.
function unexpectedEvent(error: unknown): string {
  const kind = error instanceof Error ? error.constructor.name : "unknown";
  const code = (error as { code?: unknown } | null)?.code;
  const parts = ["request.failed.INTERNAL", kind, typeof code === "string" ? code : ""];
  return parts
    .filter(Boolean)
    .map((part) => part.replace(/[^A-Za-z0-9_.]/g, "_"))
    .join(".")
    .slice(0, 120);
}

export function route<B = undefined, Q = undefined, P = undefined>(config: RouteConfig<B, Q, P>) {
  return async function handle(request: Request, context: NextRouteContext): Promise<Response> {
    const requestId = randomUUID();
    let actorId: string | undefined;
    try {
      // 1. Authenticate.
      const session = await getSession(request);
      if (!session) throw new AppError("UNAUTHENTICATED");
      actorId = session.userId;

      // 2. Authorize by role and clinic. Record-level scope is applied by src/lib/scope.ts
      //    inside the action, where out of scope is reported as NOT_FOUND.
      requireRole(session, config.roles);

      // 3. Validate input against the schemas.
      const problems: FieldProblem[] = [];

      let params = undefined as P;
      if (config.params) {
        const parsed = config.params.safeParse(await context.params);
        // A malformed id in the path cannot name a record.
        if (!parsed.success) throw new AppError("NOT_FOUND");
        params = parsed.data;
      }

      let query = undefined as Q;
      if (config.query) {
        const raw = Object.fromEntries(new URL(request.url).searchParams);
        const parsed = config.query.safeParse(raw);
        if (parsed.success) query = parsed.data;
        else problems.push(...fieldProblems(parsed.error));
      }

      let body = undefined as B;
      if (config.body) {
        let raw: unknown;
        let readable = true;
        try {
          // An empty body is an empty object, so a route whose fields are all optional
          // can be called without one.
          const text = await request.text();
          raw = text.trim() === "" ? {} : JSON.parse(text);
        } catch {
          readable = false;
          problems.push({ field: "body", problem: "invalid" });
        }
        if (readable) {
          const parsed = config.body.safeParse(raw);
          if (parsed.success) body = parsed.data;
          else problems.push(...fieldProblems(parsed.error));
        }
      }

      let idempotencyKey: string | null = null;
      const sentKey = request.headers.get(IDEMPOTENCY_HEADER);
      if (sentKey !== null) {
        const parsed = idempotencyKeySchema.safeParse(sentKey);
        if (parsed.success) idempotencyKey = parsed.data;
        else problems.push({ field: "Idempotency-Key", problem: "invalid" });
      }

      if (problems.length > 0) throw new AppError("VALIDATION_FAILED", { fields: problems });

      // 4. Act.
      const result = await config.handler({
        request,
        requestId,
        now: new Date(),
        session,
        params,
        query,
        body,
        idempotencyKey,
      });
      logger.info("request.completed", { requestId, actorId });
      return respond(result.status ?? 200, result.body, requestId);
    } catch (error) {
      if (error instanceof AppError) {
        logger.info(`request.failed.${error.code}`, { requestId, actorId });
        return fail(error.code, requestId, error.details, error.messageVariant);
      }
      const event = unexpectedEvent(error);
      logger.error(event, { requestId, actorId });
      return fail("INTERNAL", requestId);
    }
  };
}
