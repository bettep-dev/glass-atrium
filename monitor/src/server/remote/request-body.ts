import type { FastifyRequest } from "fastify";

/** Routes that take no input beyond the path or the admitted device → any body is refused before the handler. */
export const EMPTY_BODY_LIMIT_BYTES = 64;

export function hasBody(request: FastifyRequest): boolean {
  const length = request.headers["content-length"];
  return request.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
}
