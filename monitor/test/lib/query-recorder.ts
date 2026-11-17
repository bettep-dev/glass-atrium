// Records the SQL text of every database query a piece of work sends: every Prisma query crosses the pg driver's Client.query.
import pg from "pg";

export async function recordQueries<T>(work: () => Promise<T>): Promise<{ result: T; queries: string[] }> {
  const original = pg.Client.prototype.query;
  const queries: string[] = [];
  // the spy forwards every overload unchanged → the original's own type is the honest one
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    queries.push(getQueryText(args[0]));
    return Reflect.apply(original, this, args);
  } as typeof original;
  try {
    const result = await work();
    return { result, queries };
  } finally {
    pg.Client.prototype.query = original;
  }
}

function getQueryText(query: unknown): string {
  if (typeof query === "string") return query;
  if (typeof query === "object" && query !== null && "text" in query) return String(query.text);
  return String(query);
}
