// Standard error object for every non-2xx response: { code, message, request_id, details }.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new ApiError(400, code, message, details);
export const unauthorized = (message = "Authentication required") => new ApiError(401, "unauthorized", message);
export const forbidden = (message = "Not permitted for this role") => new ApiError(403, "forbidden", message);
export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details);
export const preconditionFailed = (message: string, details?: unknown) => new ApiError(412, "version_mismatch", message, details);
export const unavailable = (code: string, message: string, details?: unknown) => new ApiError(503, code, message, details);
