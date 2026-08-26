// Unit tests for DAEMON_NODE_BINDINGS (F32) — every live-overlay daemon must
// resolve to >= 1 mermaid node id that actually exists in DIAGRAMS sources,
// so the FE live rings never bind to dead/renamed nodes. AC-T4 pins the other end of that
// binding: the map and the health board must render one verdict per daemon, and a move of
// the one server threshold must carry both or neither.
// Runner: npx tsx --test test/architecture.daemon-binding.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  DAEMON_NODE_BINDINGS,
  DIAGRAMS,
} from "../src/server/architecture/diagrams-source.js";
import {
  resolveDaemonStatuses,
  type DaemonAggRow,
} from "../src/server/architecture/live-overlay.js";
import { buildDaemonStatusCards } from "../src/server/routes/health-detail.js";
import {
  DAEMON_CRON_SCHEDULE,
  STALE_MULTIPLIER,
  expectedIntervalMinutes,
} from "../src/server/schedule-next-fire.js";
import type { DaemonLiveStatus } from "../src/server/types/architecture.js";
import type { DaemonStatusCard } from "../src/server/types/health-detail.js";
import { buildScreenSandbox } from "./client-sandbox.js";

// live-overlay.ts DAEMON_NAMES mirror — the overlay surface this binding serves.
const EXPECTED_DAEMONS = [
  "autoagent",
  "wiki",
  "daily-restart-autoagent",
  "daily-restart-wiki",
] as const;

// Node-definition matcher: id immediately followed by a shape opener
// ([, (, {, [/ …) at a token boundary — mermaid node declaration form.
function nodeIsDefined(nodeId: string): boolean {
  const pattern = new RegExp(`(^|[\\s;])${nodeId}[\\[\\({]`, "m");
  return DIAGRAMS.some((d) => pattern.test(d.mermaid_source));
}

test("every overlay daemon has >= 1 bound node id", () => {
  for (const daemon of EXPECTED_DAEMONS) {
    const nodeIds = DAEMON_NODE_BINDINGS[daemon];
    assert.ok(
      nodeIds !== undefined && nodeIds.length >= 1,
      `daemon '${daemon}' must bind to at least one node id`,
    );
  }
});

test("every bound node id exists as a node definition in some diagram source", () => {
  for (const [daemon, nodeIds] of Object.entries(DAEMON_NODE_BINDINGS)) {
    for (const nodeId of nodeIds) {
      assert.ok(
        nodeIsDefined(nodeId),
        `daemon '${daemon}' binds node id '${nodeId}' which is not defined in any mermaid source`,
      );
    }
  }
});

test("binding map keys are exactly the overlay daemon set (no orphan bindings)", () => {
  assert.deepStrictEqual(
    Object.keys(DAEMON_NODE_BINDINGS).sort(),
    [...EXPECTED_DAEMONS].sort(),
    "DAEMON_NODE_BINDINGS keys must mirror live-overlay DAEMON_NAMES",
  );
});

// --- AC-T4: one server verdict, two screens ---
// Each screen is driven through its OWN route payload — the map through the live overlay, the
// health board through the daemon status cards — and both map that verdict through the real
// ui.jsx table rather than a per-test mirror of it, so a disagreement below can only come from
// screen logic.

const ARCH_SRC = fileURLToPath(new URL("../public/src/screens/architecture.jsx", import.meta.url));
const UI_SRC = fileURLToPath(new URL("../public/src/ui.jsx", import.meta.url));

interface DisplayMeta {
  tone: string;
  label: string;
}
interface LiveDaemonRow {
  name: string;
  tone: string;
  statusLabel: string;
}
interface UiSandbox {
  window: { UI: Record<string, unknown> };
}
interface ArchSandbox {
  window: { UI: Record<string, unknown> };
  getLiveDaemonRows: (daemons: DaemonLiveStatus[]) => LiveDaemonRow[];
}
interface HealthModelApi {
  resolveDaemonDisplayMeta: (daemon: unknown) => DisplayMeta;
}

const ui = await buildScreenSandbox<UiSandbox>(UI_SRC);
const arch = await buildScreenSandbox<ArchSandbox>(ARCH_SRC);
Object.assign(arch.window.UI, {
  daemonStatusTone: ui.window.UI.daemonStatusTone,
  daemonStatusLabel: ui.window.UI.daemonStatusLabel,
});

// health-model.js reads window.UI at call time and registers itself on window — stub first.
(globalThis as { window?: unknown }).window = { UI: ui.window.UI };
await import("../public/src/data/health-model.js");
const HealthModel = (globalThis as { window?: { HealthModel?: HealthModelApi } }).window
  ?.HealthModel;
assert.ok(HealthModel, "health-model.js must register window.HealthModel");

const DAEMON = "wiki";
const NOW = Date.parse("2026-07-12T12:00:00Z");
const CADENCE_MIN = expectedIntervalMinutes(DAEMON_CRON_SCHEDULE[DAEMON]);
// A wider server threshold, and a run that sits between the two: overdue at the shipped
// multiplier, inside the wider one.
const WIDER_MULTIPLIER = 2;
const BAND_MIN = Math.round(CADENCE_MIN * ((STALE_MULTIPLIER + WIDER_MULTIPLIER) / 2));

function minutesAgo(minutes: number): Date {
  return new Date(NOW - minutes * 60_000);
}

function ranAt(minutes: number, lastStatus: string | null): DaemonAggRow[] {
  return [{ daemon_name: DAEMON, last_run_at: minutesAgo(minutes), last_status: lastStatus }];
}

// The card row carries one column the live aggregate does not.
function healthCards(rows: DaemonAggRow[], anchor: Date | null): DaemonStatusCard[] {
  return buildDaemonStatusCards(
    rows.map((row) => ({ ...row, cost_guard_state: null })),
    new Date(NOW),
    anchor,
    false,
  );
}

// What each screen actually renders per daemon — the comparable both sides reduce to.
function getMapVerdicts(daemons: DaemonLiveStatus[]): string[][] {
  return Array.from(arch.getLiveDaemonRows(daemons), (row) => [row.name, row.tone, row.statusLabel]);
}

function getBoardVerdicts(cards: DaemonStatusCard[]): string[][] {
  return cards.map((card) => {
    const meta = HealthModel.resolveDaemonDisplayMeta(card);
    return [card.daemon_name, meta.tone, meta.label];
  });
}

// The input classes that can pull the two screens apart — the route-level table of
// test/daemon-verdict-field-parity.test.ts, carried one layer up to the screens.
const VERDICT_CASES: ReadonlyArray<readonly [string, DaemonAggRow[], Date | null]> = [
  ["within cadence", ranAt(60, "partial"), null],
  ["ran, status unreported", ranAt(60, null), null],
  ["the flip point itself", ranAt(CADENCE_MIN * STALE_MULTIPLIER, "ok"), null],
  ["overdue run", ranAt(CADENCE_MIN * STALE_MULTIPLIER + 1, "ok"), null],
  ["never fired, fresh install", [], null],
  ["never fired past a full cadence window", [], minutesAgo(CADENCE_MIN + 1)],
];

test("AC-T4 map and health board render one verdict per daemon, in every input class", () => {
  for (const [label, rows, anchor] of VERDICT_CASES) {
    assert.deepStrictEqual(
      getMapVerdicts(resolveDaemonStatuses(rows, NOW, anchor)),
      getBoardVerdicts(healthCards(rows, anchor)),
      `${label}: the two screens disagree about the same daemon`,
    );
  }
});

// The threshold is a module constant no test can rebind, so the wider world is the payload the
// server WOULD emit at that multiplier: its own rule re-applied to real output, moving every
// field the threshold decides — the one verdict field each payload carries — and
// nothing else. staleness_minutes and last_run_at stay exactly as reported, which is the point:
// a screen re-deriving the verdict from those cannot move, and that is the failure to catch.
function getVerdictAt(
  stalenessMinutes: number,
  lastStatus: string | null,
  multiplier: number,
): string {
  return stalenessMinutes > CADENCE_MIN * multiplier ? "stale" : (lastStatus ?? "missing");
}

function getLiveAt(rows: DaemonAggRow[], multiplier: number): DaemonLiveStatus[] {
  return resolveDaemonStatuses(rows, NOW, null).map((daemon) => {
    // A daemon that never ran is judged by the install anchor, not by the threshold.
    if (daemon.staleness_minutes === null) return daemon;
    const lastStatus = rows.find((row) => row.daemon_name === daemon.daemon_name)?.last_status;
    const verdict = getVerdictAt(daemon.staleness_minutes, lastStatus ?? null, multiplier);
    return { ...daemon, status: verdict, effective_status: verdict };
  });
}

function getCardsAt(rows: DaemonAggRow[], multiplier: number): DaemonStatusCard[] {
  return healthCards(rows, null).map((card) => {
    if (card.staleness_minutes === null) return card;
    const verdict = getVerdictAt(card.staleness_minutes, card.last_status, multiplier);
    return { ...card, effective_status: verdict };
  });
}

test("AC-T4 fixture is the server's own rule: at the shipped threshold it rebuilds the payload", () => {
  const rows = ranAt(BAND_MIN, "ok");
  assert.deepStrictEqual(
    getLiveAt(rows, STALE_MULTIPLIER),
    resolveDaemonStatuses(rows, NOW, null),
    "a rewrite that does not reproduce the shipped payload is measuring its own arithmetic",
  );
  assert.deepStrictEqual(getCardsAt(rows, STALE_MULTIPLIER), healthCards(rows, null));
});

test("AC-T4 moving only the server threshold moves both screens, or neither is reading it", () => {
  const rows = ranAt(BAND_MIN, "ok");
  const shipped = { live: getLiveAt(rows, STALE_MULTIPLIER), cards: getCardsAt(rows, STALE_MULTIPLIER) };
  const wider = { live: getLiveAt(rows, WIDER_MULTIPLIER), cards: getCardsAt(rows, WIDER_MULTIPLIER) };

  const verdictOf = (daemons: DaemonLiveStatus[]) =>
    daemons.find((daemon) => daemon.daemon_name === DAEMON)?.effective_status;
  assert.strictEqual(verdictOf(shipped.live), "stale", "the fixture must be overdue at 1.5");
  assert.strictEqual(verdictOf(wider.live), "ok", "and inside the threshold at 2.0");

  assert.deepStrictEqual(getMapVerdicts(shipped.live), getBoardVerdicts(shipped.cards));
  assert.deepStrictEqual(getMapVerdicts(wider.live), getBoardVerdicts(wider.cards));

  const shippedRow = [DAEMON, "crit", "Overdue"];
  const widerRow = [DAEMON, "ok", "Healthy"];
  assert.deepStrictEqual(
    [
      getMapVerdicts(shipped.live).find(([name]) => name === DAEMON),
      getBoardVerdicts(shipped.cards).find(([name]) => name === DAEMON),
      getMapVerdicts(wider.live).find(([name]) => name === DAEMON),
      getBoardVerdicts(wider.cards).find(([name]) => name === DAEMON),
    ],
    [shippedRow, shippedRow, widerRow, widerRow],
    "one screen moving alone is a screen holding a threshold of its own",
  );
});
