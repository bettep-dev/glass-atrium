// Request-level guards for every mutation route: a Sec-Fetch/Origin gate (CSRF defence), a
// content-type restriction, and an explicit body limit. Registered once from buildApp before the
// routes, so a route added later is covered without touching it.
//
// The gate evaluates the Sec-Fetch rules BEFORE the Origin rules, and that order is load-bearing:
// modern browsers always send sec-fetch-site, so a page served from the same host on a different
// port is rejected as `same-site` and never reaches the port-agnostic loopback allowance below.
// A cross-origin request the loopback rule would have admitted is blocked — intended, not a bug.
//
// Header absence (neither sec-fetch-site nor origin) is ALLOWED: curl, hooks and every agent path
// in this system call the API that way, so rejecting absence would break the tooling the monitor
// exists to serve. Forging those headers requires local code execution, which is already outside
// the CSRF threat model.

import type { IncomingHttpHeaders } from "node:http";

import type { FastifyInstance } from "fastify";

import { isLoopbackHost } from "./host-guard.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// same-origin = the monitor UI itself · none = address-bar / bookmark entry.
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

/** Fastify 5 default, restated so the ceiling is a stated decision rather than an inherited one. */
export const BODY_LIMIT_BYTES = 1024 * 1024;

const HTTP_FORBIDDEN = 403;
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;

/**
 * Attaches the three request guards to `app`. MUST run before the routes are registered — the
 * body-limit leg rides an onRoute hook, which only sees routes added after it.
 */
export function registerRequestGuards(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    if (isAllowedRequest(request.method, request.headers)) {
      return;
    }
    request.log.warn(
      {
        route: request.routeOptions?.url ?? request.url,
        method: request.method,
        secFetchSite: getHeader(request.headers, "sec-fetch-site"),
        origin: getHeader(request.headers, "origin"),
      },
      "cross-origin mutation blocked by the request gate",
    );
    await reply.code(HTTP_FORBIDDEN).send({ error: "cross_origin_blocked" });
  });

  // Fastify 5 ships both a JSON and a text/plain parser. Dropping text/plain makes it an
  // unregistered media type (415) — which is what strips CORS simple-request status from a
  // cross-origin POST — while the hardened built-in JSON parser stays untouched.
  app.removeContentTypeParser("text/plain");

  app.addHook("onRoute", (routeOptions) => {
    routeOptions.bodyLimit ??= BODY_LIMIT_BYTES;
  });

  // The 415 comes from Fastify's own parser lookup, so surface it here rather than letting a
  // rejected request pass unlogged. Body is never logged.
  app.addHook("onError", async (request, _reply, error) => {
    if ((error as { statusCode?: number }).statusCode !== HTTP_UNSUPPORTED_MEDIA_TYPE) {
      return;
    }
    request.log.warn(
      {
        route: request.routeOptions?.url ?? request.url,
        method: request.method,
        contentType: getHeader(request.headers, "content-type"),
      },
      "unsupported content type rejected by the parser guard",
    );
  });
}

/** Decision table for the gate; non-mutation methods are never evaluated. */
export function isAllowedRequest(method: string, headers: IncomingHttpHeaders): boolean {
  if (!MUTATION_METHODS.has(method.toUpperCase())) {
    return true;
  }
  const site = getHeader(headers, "sec-fetch-site");
  if (site !== undefined) {
    return ALLOWED_FETCH_SITES.has(site.trim().toLowerCase());
  }
  const origin = getHeader(headers, "origin");
  if (origin === undefined) {
    return true;
  }
  return isLoopbackOrigin(origin);
}

/** A duplicated header arrives as an array — the first value decides, so a second copy cannot slip the check. */
function getHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Port-agnostic loopback check on the Origin host. `Origin: null` is the literal opaque-origin
 * string (sandboxed iframe, some redirect chains) and is unparseable, as is any malformed value —
 * both fall through to false so a URL parse error can never escape as a 500.
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}
