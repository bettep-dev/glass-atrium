// Unit tests for the needs_auth firing proxy + fs seam (Track A / A-D2).
// Pure seams — no DB and no live secrets file (throwaway tmp path only).
// Runner: npx tsx --test test/health-detail.needs-auth.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deriveNeedsAuth,
  isPathAbsent,
  NEEDS_AUTH_REMEDIATION,
} from "../src/server/routes/health-detail.js";

const RAN = new Date();

test("needs_auth: firing + non-ok status + secrets absent → true", () => {
  const result = deriveNeedsAuth({
    lastRunAt: RAN,
    isStale: false,
    lastStatus: "error",
    costGuardState: null,
    secretsAbsent: true,
  });
  assert.strictEqual(result, true);
});

test("needs_auth: firing + infra_fault cost-guard + secrets absent → true", () => {
  const result = deriveNeedsAuth({
    lastRunAt: RAN,
    isStale: false,
    lastStatus: "ok",
    costGuardState: "infra_fault",
    secretsAbsent: true,
  });
  assert.strictEqual(result, true);
});

test("needs_auth: never-run (lastRunAt null) + secrets absent → false (no idle remediation)", () => {
  const result = deriveNeedsAuth({
    lastRunAt: null,
    isStale: false,
    lastStatus: null,
    costGuardState: null,
    secretsAbsent: true,
  });
  assert.strictEqual(result, false);
});

test("needs_auth: stale (not firing) + failing + secrets absent → false", () => {
  const result = deriveNeedsAuth({
    lastRunAt: RAN,
    isStale: true,
    lastStatus: "error",
    costGuardState: null,
    secretsAbsent: true,
  });
  assert.strictEqual(result, false);
});

test("needs_auth: firing + failing + secrets present → false (corroborator gate)", () => {
  const result = deriveNeedsAuth({
    lastRunAt: RAN,
    isStale: false,
    lastStatus: "error",
    costGuardState: null,
    secretsAbsent: false,
  });
  assert.strictEqual(result, false);
});

test("needs_auth: firing + healthy (ok) + secrets absent → false (regression guard)", () => {
  const result = deriveNeedsAuth({
    lastRunAt: RAN,
    isStale: false,
    lastStatus: "ok",
    costGuardState: "ok",
    secretsAbsent: true,
  });
  assert.strictEqual(result, false);
});

test("isPathAbsent: absent path → true; present file → false (existence only, no read)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "needs-auth-"));
  try {
    const missing = path.join(dir, "claude-auth.env");
    assert.strictEqual(await isPathAbsent(missing), true);

    await writeFile(missing, "IGNORED_CONTENT", "utf8");
    assert.strictEqual(await isPathAbsent(missing), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("remediation string carries only the env-var NAME, never a token value", () => {
  assert.match(NEEDS_AUTH_REMEDIATION, /CLAUDE_CODE_OAUTH_TOKEN/);
  // Only the env-var name + instruction; no assignment/value pattern.
  assert.doesNotMatch(NEEDS_AUTH_REMEDIATION, /CLAUDE_CODE_OAUTH_TOKEN\s*=/);
  assert.doesNotMatch(NEEDS_AUTH_REMEDIATION, /sk-|Bearer\s|eyJ/);
});

test("remediation names the concrete launcher command + Token Setup menu item", () => {
  // Actionable: the real GA_ROOT-aware launcher path, not the abstract word "launcher".
  assert.match(NEEDS_AUTH_REMEDIATION, /\/glass-atrium and choose "Token Setup"/);
  assert.match(NEEDS_AUTH_REMEDIATION, /\(headless OAuth\)/);
  assert.doesNotMatch(NEEDS_AUTH_REMEDIATION, /Run: launcher/);
});
