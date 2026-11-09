// The one env builder for every `claude` child the monitor spawns: main.ts loads dotenv/config, so an inherited env
// would hand DATABASE_URL and the rest of the monitor env to a Claude session.

const ALLOWED_KEYS = ["HOME", "PATH", "USER", "LANG", "TMPDIR"] as const;

/**
 * Explicit allowlist env for a `claude` child.
 * @param configDir - the row's recorded CLAUDE_CONFIG_DIR; null → the default profile, so the variable is omitted
 */
export function buildClaudeChildEnv(configDir: string | null, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  if (configDir !== null) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}
