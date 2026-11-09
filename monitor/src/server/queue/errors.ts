// Queue request failures the route layer maps 1:1 onto an HTTP status; anything else is a DB failure.

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
