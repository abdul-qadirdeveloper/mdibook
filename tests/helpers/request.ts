// Builds requests for route handlers and calls them directly, without a server. The
// development session stand-in reads the user from the x-dev-user-id header.
import { DEV_USER_HEADER } from "@/lib/session";

export interface RequestOptions {
  /** The user to act as. Omit for a request with no session. */
  userId?: string;
  body?: unknown;
  /** Sent as the raw body, for malformed input. */
  rawBody?: string;
  headers?: Record<string, string>;
}

export function apiRequest(method: string, path: string, options: RequestOptions = {}): Request {
  const headers = new Headers(options.headers);
  if (options.userId) headers.set(DEV_USER_HEADER, options.userId);
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("content-type", "application/json");
  }
  return new Request(`http://localhost${path}`, { method, headers, body });
}

type Handler = (
  request: Request,
  context: { params: Promise<Record<string, string | string[] | undefined>> },
) => Promise<Response>;

export interface ApiResult<T = Record<string, unknown>> {
  status: number;
  headers: Headers;
  json: T;
}

/** Calls a route handler the way Next.js does, and parses the JSON response. */
export async function call<T = Record<string, unknown>>(
  handler: Handler,
  request: Request,
  params: Record<string, string> = {},
): Promise<ApiResult<T>> {
  const response = await handler(request, { params: Promise.resolve(params) });
  return { status: response.status, headers: response.headers, json: (await response.json()) as T };
}
