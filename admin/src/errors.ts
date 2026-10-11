/**
 * Error taxonomy of the Admin API (spec Appendix D).
 *
 * Every error the admin returns has one of these codes, and each code has
 * exactly one HTTP status. Handlers throw {@link ApiError}; the server turns
 * it into the response shape of spec §6.7.
 */

/** Admin API error codes and the HTTP status each one maps to. */
export const ERROR_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IN_USE: 409,
  RESYNC_REQUIRED: 410,
  REVISION_CONFLICT: 412,
  VALIDATION_FAILED: 422,
  HOST_NOT_OWNED: 422,
  LIMIT_EXCEEDED: 422,
  EGRESS_NOT_ALLOWED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const;

/** One of the codes in {@link ERROR_STATUS}. */
export type ErrorCode = keyof typeof ERROR_STATUS;

/** One validation fault, located by JSON pointer. */
export interface ErrorDetail {
  pointer: string;
  message: string;
}

/** The body of every error response. */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    request_id?: string;
    details?: ErrorDetail[];
  };
}

/** An error with a code from the taxonomy. Safe to show to the caller. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

/**
 * Builds the response for any thrown value.
 *
 * An {@link ApiError} is reported as-is. Anything else becomes
 * `INTERNAL_ERROR` with a fixed message, so internal detail never leaks.
 * Framework errors that carry a 4xx `statusCode` (malformed JSON, payload too
 * large) are reported as `BAD_REQUEST` with their own message.
 */
export function toErrorResponse(err: unknown, requestId?: string): { status: number; body: ErrorBody } {
  let code: ErrorCode = "INTERNAL_ERROR";
  let message = "internal error";
  let details: ErrorDetail[] | undefined;

  if (err instanceof ApiError) {
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (isClientError(err)) {
    code = "BAD_REQUEST";
    message = err.message;
  }

  const body: ErrorBody = { error: { code, message } };
  if (requestId !== undefined) body.error.request_id = requestId;
  if (details !== undefined && details.length > 0) body.error.details = details;
  return { status: ERROR_STATUS[code], body };
}

function isClientError(err: unknown): err is { statusCode: number; message: string } {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { statusCode?: unknown; message?: unknown };
  return typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500 && typeof e.message === "string";
}
