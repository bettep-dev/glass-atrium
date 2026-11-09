// Queue failures the route layer maps onto an HTTP status itself; any other error is treated as a DB failure.

export type QueueRequestStatus = 400 | 404 | 409;

export class QueueRequestError extends Error {
  constructor(
    readonly statusCode: QueueRequestStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QueueRequestError";
  }
}

/** Host-side read failure (process table, filesystem) → 500, so an outage page never points at Postgres. */
export class QueueEnvironmentError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "QueueEnvironmentError";
  }
}
