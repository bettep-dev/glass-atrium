import type { FastifyReply, FastifyRequest } from "fastify";

// a meta CSP cannot carry frame-ancestors → a framed page would send same-origin owner actions a neighbour page could click into
export const FRAME_DENY_HEADERS = { "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" } as const;

/** onSend hook → every reply of the scope it is added to is never stored. */
export async function setNoStoreHeader(_request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  reply.header("cache-control", "no-store");
  return payload;
}
