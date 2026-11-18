import type { FastifyReply, FastifyRequest } from "fastify";

// a meta CSP cannot carry frame-ancestors → a framed page would send same-origin owner actions a neighbour page could click into
export const FRAME_DENY_HEADERS = { "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" } as const;

// RFC 5987 attr-char excludes the sub-delims encodeURIComponent leaves raw → escaped too, so the ext-value stays token-safe
const RFC5987_EXTRA_ESCAPE: ReadonlyMap<string, string> = new Map([
  ["!", "%21"],
  ["*", "%2A"],
  ["'", "%27"],
  ["(", "%28"],
  [")", "%29"],
]);

/**
 * RFC 6266 attachment header: `filename*` (RFC 5987, UTF-8) keeps a non-ASCII name, `filename` is the quoted ASCII fallback.
 * @param name - the file name as saved
 * @param asciiName - the fallback for clients without `filename*`; must hold no quote, backslash or byte outside 0x20-0x7E
 */
export function getAttachmentDisposition(name: string, asciiName = name): string {
  const encoded = encodeURIComponent(name).replace(/[!*'()]/g, (char) => RFC5987_EXTRA_ESCAPE.get(char) ?? char);
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`;
}

/** onSend hook → every reply of the scope it is added to is never stored. */
export async function setNoStoreHeader(_request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  reply.header("cache-control", "no-store");
  return payload;
}
