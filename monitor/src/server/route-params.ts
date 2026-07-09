// Shared numeric route-param parsers (:id / offset / folder_id) — single SoT; null = caller emits 400.
// Number.isSafeInteger caps two holes: 2^53..2^63 float-rounds to a DIFFERENT integer (wrong-row lookup).
// >2^63 overflows pg bigint (22003 → false 503).

/** Path/query id (pg bigint, positive). null = invalid → 400. */
export function parseIdParam(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/** Pagination offset (0-based). Absent/empty → 0. null = invalid → 400. */
export function parseOffsetParam(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return 0;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}
