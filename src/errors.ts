// The one error type the API layer renders as JSON. Anything else that escapes becomes a
// generic 500, so an unexpected failure cannot leak internals to the caller.
/** An error carrying the HTTP status and machine-readable code to return to the caller. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const accountNotFound = (id: string): ApiError =>
  new ApiError(404, 'ACCOUNT_NOT_FOUND', `No account exists with id ${id}.`);
