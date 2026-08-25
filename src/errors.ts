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
