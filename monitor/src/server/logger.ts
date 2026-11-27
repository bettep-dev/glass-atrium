// Structured JSON logger (Pino) — Fastify's native backend; stdout only (launchd/console captures).

import pino, { type LoggerOptions } from "pino";
import type { FastifyBaseLogger } from "fastify";

import { CSRF_HEADER } from "./remote/session.js";

// device cookie, its CSRF echo and the registration code → bare, request-nested and response-nested shapes
const SESSION_REDACT_PATHS = ["headers", "req.headers", "res.headers"].flatMap((base) => [
  `${base}.cookie`,
  `${base}["set-cookie"]`,
  `${base}["${CSRF_HEADER}"]`,
]);

export const LOGGER_OPTIONS: LoggerOptions = {
  // SECURITY: never expose secrets; redact known sensitive keys at the logger layer.
  redact: {
    paths: ["password", "token", "authorization", "*.password", "*.token", ...SESSION_REDACT_PATHS, "body.code", "*.body.code"],
    censor: "[REDACTED]",
  },
  level: process.env.LOG_LEVEL ?? "info",
  // Why ISO 8601 ms-precision UTC: comment-logging.md log composition rule.
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: "claude-monitor" },
};

// FastifyBaseLogger 타입(not pino.Logger) → Fastify 기본 generic 유지 → route helper 가 비특화 FastifyInstance 사용 가능
export const logger: FastifyBaseLogger = pino(LOGGER_OPTIONS);
