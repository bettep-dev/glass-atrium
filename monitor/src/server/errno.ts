// Path-free errno extraction — the errno token (ENOENT / EACCES / …) from a Node fs / spawn error,
// or undefined for a non-errno error. The raw error.message embeds absolute filesystem paths (info
// leak, red-team #21) and MUST NOT reach a client response body; the errno code carries no path.
// Callers always log the full error server-side. Neutral leaf (no imports) so both
// routes/clauded-docs.ts and clauded-docs/browser-pool.ts can share it without an import cycle.

export function errnoCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}
