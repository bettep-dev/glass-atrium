// Request-level guards for every mutation route: a Sec-Fetch/Origin gate (CSRF defence), a
// form content-type refusal, and an explicit body limit. Registered once from buildApp before the
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

/**
 * The methods the gate judges. Exported because the audit hook must observe exactly the set
 * judged here — two private copies would be free to drift apart.
 */
export const MUTATION_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// same-origin = the monitor UI itself · none = address-bar / bookmark entry.
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

/** Fastify 5 default, restated so the ceiling is a stated decision rather than an inherited one. */
export const BODY_LIMIT_BYTES = 1024 * 1024;

// the only types a document's form can send → a same-origin form, field-less included, never reaches a handler
const FORM_MEDIA_TYPES: ReadonlySet<string> = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);

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

  // after the gate → a cross-site form keeps its 403; runs before routing, so no handler and no parser sees the body
  app.addHook("onRequest", async (request, reply) => {
    if (!MUTATION_METHODS.has(request.method.toUpperCase()) || !isFormContentType(request.headers)) {
      return;
    }
    request.log.warn({ route: request.routeOptions?.url ?? request.url, method: request.method }, "form content type refused by the request guard");
    await reply.code(HTTP_UNSUPPORTED_MEDIA_TYPE).send({ error: "form_content_type" });
  });

  // Fastify 5 ships a text/plain parser → dropped, so a method the guards do not judge never gets a CORS-simple body parsed
  app.removeContentTypeParser("text/plain");

  app.addHook("onRoute", (routeOptions) => {
    routeOptions.bodyLimit ??= BODY_LIMIT_BYTES;
  });

  // The 415 comes from Fastify's own parser lookup, so surface it here rather than letting a
  // rejected request pass unlogged. Body is never logged.
  app.addHook("onError", async (request, _reply, error) => {
    if (error.statusCode !== HTTP_UNSUPPORTED_MEDIA_TYPE) {
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

/** Media type only: parameters and case never let a form type through. */
function isFormContentType(headers: IncomingHttpHeaders): boolean {
  const mediaType = getHeader(headers, "content-type")?.split(";")[0]?.trim().toLowerCase();
  return mediaType !== undefined && FORM_MEDIA_TYPES.has(mediaType);
}

/** Which page-origin signal admitted an owner mutation; the answer record stores it. */
export type PageOriginSignal = "fetch_metadata" | "origin";

/**
 * Stricter variant of the gate for owner mutations: the request must come from the monitor's own page.
 * Sec-Fetch-Site decides when present (same-origin only); otherwise the Origin must be one of `allowedOrigins`.
 * Neither header → null, so curl, hooks and a session's own scripts are refused.
 * @param allowedOrigins - serialized origins (`http://127.0.0.1:<port>`) the monitor page is served from
 * @returns the signal that admitted the request, or null when it is not from the monitor page
 */
export function getPageOriginSignal(headers: IncomingHttpHeaders, allowedOrigins: ReadonlySet<string>): PageOriginSignal | null {
  const site = getHeader(headers, "sec-fetch-site");
  if (site !== undefined) {
    return site.trim().toLowerCase() === "same-origin" ? "fetch_metadata" : null;
  }
  const origin = getHeader(headers, "origin");
  if (origin === undefined) {
    return null;
  }
  const parsed = getSerializedOrigin(origin);
  return parsed !== null && allowedOrigins.has(parsed) ? "origin" : null;
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

/** `new URL().origin` normalizes case and default ports; `null` and malformed values → null, never a throw. */
function getSerializedOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}
