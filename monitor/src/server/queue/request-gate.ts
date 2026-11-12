// Queue request gate: the Host allowlist (DNS-rebinding block) on every queue route, the page-origin leg on owner mutations.

import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from "fastify";

import { MUTATION_METHODS, type PageOriginSignal, getPageOriginSignal } from "../request-guards.js";

const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"] as const;

/** Stamped by the page-origin hook on every owner mutation it admits → the handler records it with the answer. */
export interface PageOriginCarrier {
  pageOriginSignal?: PageOriginSignal;
}

export function buildHostAllowlistHook(port: number): onRequestAsyncHookHandler {
  const allowedHosts = new Set(LOOPBACK_HOSTNAMES.map((hostname) => `${hostname}:${port}`));
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!allowedHosts.has((request.headers.host ?? "").toLowerCase())) {
      return reply.code(403).send({ error: "host_not_allowed" });
    }
  };
}

/**
 * Owner-mutation hook: 403 unless the request carries the monitor page's own origin signal.
 * Safe only behind the Host allowlist — a DNS-rebound page sends same-origin fetch metadata and is stopped by the Host check.
 */
export function buildPageOriginHook(pageOrigins: ReadonlySet<string>): onRequestAsyncHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!MUTATION_METHODS.has(request.method)) return;
    const signal = getPageOriginSignal(request.headers, pageOrigins);
    if (signal === null) {
      request.log.warn({ route: request.routeOptions?.url ?? request.url, method: request.method }, "owner mutation refused: not from the monitor page");
      return reply.code(403).send({ error: "not_page_origin" });
    }
    // carrier field, not a Fastify decoration → same shape as AuditChangeCarrier; read only by the owner handlers
    (request as FastifyRequest & PageOriginCarrier).pageOriginSignal = signal;
  };
}

/** Origins the monitor page is served from: every allowlisted loopback name at the monitor port, plain http. */
export function getPageOrigins(port: number): ReadonlySet<string> {
  return new Set(LOOPBACK_HOSTNAMES.map((hostname) => `http://${hostname}:${port}`));
}
