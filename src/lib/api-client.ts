// Browser-side client for /api/v1. It sends the development user (see src/lib/session.ts)
// and turns every response into either data or the one error shape. It runs in the browser:
// it must not import the database, the logger or the session module.
import type { ErrorCode, ErrorDetails } from "@/lib/errors";

const DEV_USER_HEADER = "x-dev-user-id";
const STORAGE_KEY = "medibook.devUser";
const CHANGE_EVENT = "medibook:dev-user";

/** DEVELOPMENT STAND-IN. The user the browser acts as, chosen on the home page. */
export interface DevUser {
  userId: string;
  role: "patient" | "doctor" | "staff" | "admin";
  label: string;
}

/** The stored value as text, so it can be used as a stable snapshot. */
export function readDevUserSnapshot(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function parseDevUser(snapshot: string | null): DevUser | null {
  if (!snapshot) return null;
  try {
    const value = JSON.parse(snapshot) as Partial<DevUser>;
    if (typeof value.userId === "string" && typeof value.role === "string" && typeof value.label === "string") {
      return value as DevUser;
    }
  } catch {
    // Fall through: an unreadable value means nobody is chosen.
  }
  return null;
}

export function getDevUser(): DevUser | null {
  return parseDevUser(readDevUserSnapshot());
}

export function setDevUser(user: DevUser | null): void {
  if (typeof window === "undefined") return;
  if (user) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  else window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Calls back when the chosen user changes, in this tab or another. Returns the unsubscribe. */
export function subscribeDevUser(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export interface ApiError extends ErrorDetails {
  code: ErrorCode;
  /** Plain words: what happened and what to do next. Safe to show. */
  message: string;
  /** Reference id to quote to the clinic. */
  requestId: string | null;
}

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: ApiError };

export interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Sent as JSON. Personal data goes here, never in the URL (R80). */
  body?: unknown;
  /** Send the same key when repeating a submission, so it is applied once (R27). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const OFFLINE: ApiError = {
  code: "INTERNAL",
  message: "We could not reach MediBook. Check your connection and try again.",
  requestId: null,
};

/** A key for one submission. Keep it while the form is open and reuse it on retry. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Calls an /api/v1 path, for example api("/appointments", { method: "POST", body }). */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<ApiResult<T>> {
  const headers = new Headers({ accept: "application/json" });
  const user = getDevUser();
  if (user) headers.set(DEV_USER_HEADER, user.userId);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);

  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0, error: OFFLINE };
  }

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // Not JSON: handled below as a server error.
  }

  if (response.ok) return { ok: true, status: response.status, data: json as T };

  const error = (json as { error?: ApiError } | null)?.error;
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    return { ok: false, status: response.status, error };
  }
  return {
    ok: false,
    status: response.status,
    error: { ...OFFLINE, message: "Something went wrong on our side. Try again.", requestId: response.headers.get("x-request-id") },
  };
}
