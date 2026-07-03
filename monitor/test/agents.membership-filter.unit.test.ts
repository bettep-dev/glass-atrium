// Unit tests for the shared canonical-membership gate SoT — BOTH shapes over one
// fail-open + parameter-binding core (agents/registry.ts):
//   - buildAgentMembershipFilter   → AND-prefixed `AND <col> IN (?..)`, for
//     append-after-a-complete-WHERE sites (success-rate, improvement-signals…)
//   - buildAgentMembershipFragment → BARE `<col> IN (?..)` (no leading AND), for
//     fragments-array builders + no-WHERE sites
// Both bind exactly the registry keys (LLM05 — parameter binding, never inlined)
// and fail-open to Prisma.empty on an empty registry (Prisma.join([]) would emit
// a syntactically broken `IN ()`).
//
// buildAgentMembershipFilter is imported from routes/agents.js to prove the
// re-export surface survives the relocation into agents/registry.ts (the symbol
// physically moved but the route module still re-exports it). The bare-fragment
// companion is imported from its canonical home, agents/registry.js.
//
// DB-free.
//
// Runner: npx tsx --test test/agents.membership-filter.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { Prisma } from "../src/generated/prisma/client.js";
import {
  buildAgentMembershipFragment,
  buildAgentMembershipFilter as buildFilterFromRegistry,
} from "../src/server/agents/registry.js";
import { buildAgentMembershipFilter } from "../src/server/routes/agents.js";

test("buildAgentMembershipFilter: empty registry → Prisma.empty (fail-open, predicate skipped)", () => {
  const frag = buildAgentMembershipFilter([]);
  // The length===0 guard skips the predicate rather than emitting `IN ()`.
  assert.strictEqual(frag, Prisma.empty, "must return the Prisma.empty singleton");
  assert.strictEqual(frag.sql, "", "empty fragment emits no SQL text");
  assert.deepStrictEqual(frag.values, [], "empty fragment binds no values");
});

test("buildAgentMembershipFilter: non-empty → `AND agent IN (?..)` binding every registry key", () => {
  const agents = ["dev-nestjs", "qa-code-reviewer", "intel-planner"];
  const frag = buildAgentMembershipFilter(agents);
  // Placeholder-only SQL — one `?` per canonical agent (LLM05: bound, not inlined).
  assert.match(frag.sql, /^AND agent IN \((?:\?,)*\?\)$/);
  assert.strictEqual(
    (frag.sql.match(/\?/g) ?? []).length,
    agents.length,
    "one placeholder per canonical agent",
  );
  // Every registry key is a bound value — the exclusion mechanism: only these
  // tokens survive the IN-list; non-registry noise is dropped by omission.
  assert.deepStrictEqual(frag.values, agents);
  // Defense-in-depth — no agent name inlined into the SQL text.
  for (const agent of agents) {
    assert.ok(!frag.sql.includes(agent), `agent '${agent}' must be bound, not inlined`);
  }
});

test("buildAgentMembershipFilter: column-ref override → aliased `o.agent` (LEFT JOIN ON-clause case)", () => {
  // The timeseries LEFT JOIN aliases core.outcomes AS o; the predicate must
  // reference o.agent so it can live inside the ON clause. A top-level WHERE on
  // o.agent would collapse the LEFT JOIN into an inner join and drop the
  // generate_series gap-fill days.
  const frag = buildAgentMembershipFilter(["dev-nestjs"], Prisma.sql`o.agent`);
  assert.match(frag.sql, /^AND o\.agent IN \(\?\)$/);
  assert.deepStrictEqual(frag.values, ["dev-nestjs"]);
});

test("buildAgentMembershipFilter: single-agent registry → single-placeholder IN-list", () => {
  const frag = buildAgentMembershipFilter(["solo-agent"]);
  assert.strictEqual(frag.sql, "AND agent IN (?)");
  assert.deepStrictEqual(frag.values, ["solo-agent"]);
});

test("re-export identity: routes/agents.js buildAgentMembershipFilter === agents/registry.js one", () => {
  // The route module re-exports the moved symbol; both import paths MUST resolve
  // to the exact same function (relocation preserved the live export surface).
  assert.strictEqual(buildAgentMembershipFilter, buildFilterFromRegistry);
});

test("buildAgentMembershipFragment: empty registry → Prisma.empty (omitted, fail-open)", () => {
  const frag = buildAgentMembershipFragment([]);
  assert.strictEqual(frag, Prisma.empty, "must return the Prisma.empty singleton");
  assert.strictEqual(frag.sql, "", "empty fragment emits no SQL text");
  assert.deepStrictEqual(frag.values, [], "empty fragment binds no values");
});

test("buildAgentMembershipFragment: non-empty → bare `agent IN (?..)` with NO leading AND", () => {
  const agents = ["dev-nestjs", "qa-code-reviewer", "intel-planner"];
  const frag = buildAgentMembershipFragment(agents);
  // Bare IN-list — the leading `AND` MUST be absent (fragments-array builders add
  // their own " AND " join separator; a stray AND would break the join).
  assert.match(frag.sql, /^agent IN \((?:\?,)*\?\)$/);
  assert.ok(!frag.sql.startsWith("AND "), "bare fragment must NOT carry a leading AND");
  assert.strictEqual(
    (frag.sql.match(/\?/g) ?? []).length,
    agents.length,
    "one placeholder per canonical agent",
  );
  assert.deepStrictEqual(frag.values, agents);
  for (const agent of agents) {
    assert.ok(!frag.sql.includes(agent), `agent '${agent}' must be bound, not inlined`);
  }
});

test("buildAgentMembershipFragment: column-ref override → bare `target_agent IN (?)`", () => {
  // proposal feeds (T8) push this bare fragment into a fragments-array over the
  // target_agent column.
  const frag = buildAgentMembershipFragment(["dev-nestjs"], Prisma.sql`target_agent`);
  assert.match(frag.sql, /^target_agent IN \(\?\)$/);
  assert.ok(!frag.sql.startsWith("AND "), "bare fragment must NOT carry a leading AND");
  assert.deepStrictEqual(frag.values, ["dev-nestjs"]);
});

test("shape divergence: filter is AND-prefixed, fragment is bare (same keys + column)", () => {
  const keys = ["dev-nestjs", "dev-node"];
  const filter = buildAgentMembershipFilter(keys);
  const fragment = buildAgentMembershipFragment(keys);
  assert.ok(filter.sql.startsWith("AND "), "filter carries the leading AND");
  assert.ok(!fragment.sql.startsWith("AND "), "fragment omits the leading AND");
  // Identical binding — the only difference is the AND prefix over one shared core.
  assert.strictEqual(filter.sql, `AND ${fragment.sql}`);
  assert.deepStrictEqual(filter.values, fragment.values);
});
