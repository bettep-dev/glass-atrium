// Structured JSON logger (Pino) — Fastify's native log backend.
// stdout only; launchd/console captures.

import pino, { type LoggerOptions } from "pino";
import type { FastifyBaseLogger } from "fastify";

const LOGGER_OPTIONS: LoggerOptions = {
  // SECURITY: never expose secrets; redact known sensitive keys at the logger layer.
  redact: {
    paths: ["password", "token", "authorization", "*.password", "*.token"],
    censor: "[REDACTED]",
  },
  level: process.env.LOG_LEVEL ?? "info",
  // Why ISO 8601 ms-precision UTC: comment-logging.md log composition rule.
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: "claude-monitor" },
};

// FastifyBaseLogger 타입(not pino.Logger) → Fastify 기본 generic 유지 → route helper 가 비특화 FastifyInstance 사용 가능
export const logger: FastifyBaseLogger = pino(LOGGER_OPTIONS);
