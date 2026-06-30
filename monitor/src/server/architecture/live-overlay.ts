// Live overlay computation for /api/architecture/live — combines PG aggregates
// + filesystem PHASE-marker probes into ArchitectureLiveResponse.
//
// Filesystem + Prisma only, no TCP.
// Resilience: any single signal failure degrades that signal (count=0 / status=missing)
// without aborting the response — partial-data > no-data for the dashboard.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import type {
	ArchitectureLiveResponse,
	DaemonLiveStatus,
	RecentActivity,
	WriterLiveStatus,
} from "../types/architecture.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { DAEMON_NODE_BINDINGS } from "./diagrams-source.js";
import { createTtlCache } from "./ttl-cache.js";

export interface OverlayLogger {
	warn(obj: object, msg?: string): void;
	info(obj: object, msg?: string): void;
}

// Daemons surfaced in the live overlay (autoagent + wiki + role-qualified
// daily-restart runs). Legacy merged 'daily-restart' rows are history-only.
const DAEMON_NAMES = [
	"autoagent",
	"wiki",
	"daily-restart-autoagent",
	"daily-restart-wiki",
] as const;

// Expected run cadence per daemon (minutes) — all four are daily launchd jobs.
// Server-declared so the FE never hardcodes cadence assumptions (F35/F39).
const EXPECTED_CADENCE_MINUTES: Record<(typeof DAEMON_NAMES)[number], number> = {
	autoagent: 1440,
	wiki: 1440,
	"daily-restart-autoagent": 1440,
	"daily-restart-wiki": 1440,
};

// Soft-deprecated daemon types — enum value kept in core.DaemonType for the
// audit trail but no longer surfaced in the live overlay. Rows accidentally
// re-introduced into core.daemon_runs are filtered out here rather than relying
// on the DAEMON_NAMES whitelist alone — defense in depth.
const DEPRECATED_DAEMONS = new Set<string>(["health-check"]);

// Writer registry — paths + canonical name. PHASE markers are searched once at
// module load; rerunning the scan would cost file reads per request for data
// that effectively never changes between server boots.
interface WriterDescriptor {
	name: string;
	path: string;
	// Marker prefix the writer script uses to delimit its dual-write block.
	marker: string;
}

// 설치 사용자 홈 디렉터리 런타임 파생 → 개발자 식별자 비포함.
const HOME = homedir();

const WRITERS: ReadonlyArray<WriterDescriptor> = [
	{
		name: "cost-tracker",
		path: `${HOME}/.claude/hooks/cost-tracker.sh`,
		marker: "PHASE1-DUALWRITE-BEGIN",
	},
	{
		name: "agent-tracker",
		path: `${HOME}/.claude/hooks/agent-tracker.sh`,
		marker: "PHASE1-DUALWRITE-BEGIN",
	},
	{
		name: "outcome-record",
		path: `${HOME}/.claude/hooks/track-outcome.sh`,
		marker: "PHASE3-OUTCOME-DUALWRITE-BEGIN",
	},
	{
		name: "learning-aggregator",
		// import token, not an inline PHASE marker (dual-write block moved to _pg_learning_dualwrite)
		path: `${HOME}/.claude/hooks/learning-aggregator.py`,
		marker: "_pg_learning_dualwrite",
	},
	{
		name: "wiki-sync",
		// import token, not a strippable PHASE comment — survives comment-hygiene edits
		path: `${HOME}/.claude/scripts/wiki-sync.sh`,
		marker: "_pg_dual_write_daemon",
	},
	{
		name: "autoagent",
		path: `${HOME}/.claude/autoagent/daemon-cycle.sh`,
		marker: "PHASE2-AUTOAGENT-DUALWRITE-BEGIN",
	},
];

// Process-local cache for marker scan results — populated lazily on first call.
let markerCache: Map<string, boolean> | null = null;

interface DaemonAggRow {
	daemon_name: string;
	last_run_at: Date | null;
	last_status: string | null;
}

interface SimpleCountRow {
	cnt: bigint;
}

interface OutcomeMaxRow {
	max_ts: Date | null;
}

interface WriterFailureRow {
	hook_name: string;
	cnt: bigint;
}

// Overlay = PG/fs runtime signals only. Drift (stale/diffs) is a separate concern
// composed at the route from computeArchDrift() — keep this return drift-free.
type LiveOverlay = Omit<ArchitectureLiveResponse, "stale" | "diffs">;

// The overlay reruns a full PG fan-out + fs marker scan on every /api/architecture/live
// call (high-volume), yet its inputs are quasi-static (daemon runs / hourly counters move
// on the minute, the client refreshes manually). Cache behind a short TTL — shares the
// createTtlCache helper with the computeArchDrift() drift cache. 30s bounds staleness so a
// fresh daemon run / activity burst surfaces within the window while collapsing the cost.
const OVERLAY_CACHE_TTL_MS = 30_000;

const overlayCache = createTtlCache(OVERLAY_CACHE_TTL_MS, getLiveOverlayUncached);

/** TTL-cached overlay — collapses repeated full PG/fs fan-outs on the high-volume live route. */
export function getLiveOverlay(
	prisma: PrismaClient,
	logger: OverlayLogger,
): Promise<LiveOverlay> {
	return overlayCache.get(prisma, logger);
}

/** Test seam — clears the overlay cache so the next call re-runs the full fan-out. */
export function resetOverlayCache(): void {
	overlayCache.reset();
}

/** Parallel signal fan-out — any single PG/fs failure degrades to its fallback, never aborts. */
async function getLiveOverlayUncached(
	prisma: PrismaClient,
	logger: OverlayLogger,
): Promise<LiveOverlay> {
	const [
		daemonsResult,
		costEventsResult,
		agentEventsResult,
		lastOutcomeResult,
		writerFailuresResult,
	] = await Promise.allSettled([
		queryDaemons(prisma),
		queryCostEventsLastHour(prisma),
		queryAgentEventsLastHour(prisma),
		queryLastOutcome(prisma),
		queryWriterFailures24h(prisma),
	]);

	const daemons = unwrap(daemonsResult, logger, "daemons", () =>
		emptyDaemons(),
	);
	const costEventsLastHour = unwrap(
		costEventsResult,
		logger,
		"cost-events",
		() => 0,
	);
	const agentEventsLastHour = unwrap(
		agentEventsResult,
		logger,
		"agent-events",
		() => 0,
	);
	const lastOutcomeAt = unwrap(
		lastOutcomeResult,
		logger,
		"last-outcome",
		() => null,
	);
	const writerFailureMap = unwrap(
		writerFailuresResult,
		logger,
		"writer-failures",
		() => new Map<string, number>(),
	);

	const writers = await composeWriters(writerFailureMap, logger);

	const recentActivity: RecentActivity = {
		cost_events_last_hour: costEventsLastHour,
		agent_events_last_hour: agentEventsLastHour,
		last_outcome_at:
			lastOutcomeAt === null ? null : lastOutcomeAt.toISOString(),
	};

	return {
		computed_at: new Date().toISOString(),
		daemons,
		writers,
		recent_activity: recentActivity,
	};
}

// ----- queries --------------------------------------------------------------

async function queryDaemons(prisma: PrismaClient): Promise<DaemonLiveStatus[]> {
	// Latest row per daemon within the past 24h (DISTINCT ON pattern, index-friendly
	// against daemon_runs_name_date_idx). Daemons with no row in the window appear
	// as 'missing' with null timestamps.
	const rows = await prisma.$queryRaw<DaemonAggRow[]>`
    SELECT DISTINCT ON (daemon_name)
      daemon_name::text AS daemon_name,
      started_at AS last_run_at,
      status::text AS last_status
    FROM core.daemon_runs
    WHERE run_date >= CURRENT_DATE - 1
    ORDER BY daemon_name, started_at DESC
  `;
	const byName = new Map<string, DaemonAggRow>();
	for (const row of rows) {
		// Drop soft-deprecated enum values (e.g., health-check) — defense in depth
		// alongside the DAEMON_NAMES whitelist.
		if (DEPRECATED_DAEMONS.has(row.daemon_name)) {
			continue;
		}
		byName.set(row.daemon_name, row);
	}
	const now = Date.now();
	return DAEMON_NAMES.map((name): DaemonLiveStatus => {
		const row = byName.get(name);
		if (row === undefined || row.last_run_at === null) {
			return {
				daemon_name: name,
				status: "missing",
				last_run_at: null,
				staleness_minutes: null,
				node_ids: [...(DAEMON_NODE_BINDINGS[name] ?? [])],
				expected_cadence_minutes: EXPECTED_CADENCE_MINUTES[name],
			};
		}
		const stalenessMinutes = Math.floor(
			(now - row.last_run_at.getTime()) / 60_000,
		);
		return {
			daemon_name: name,
			status: row.last_status ?? "missing",
			last_run_at: row.last_run_at.toISOString(),
			staleness_minutes: stalenessMinutes,
			node_ids: [...(DAEMON_NODE_BINDINGS[name] ?? [])],
			expected_cadence_minutes: EXPECTED_CADENCE_MINUTES[name],
		};
	});
}

async function queryCostEventsLastHour(prisma: PrismaClient): Promise<number> {
	const rows = await prisma.$queryRaw<SimpleCountRow[]>`
    SELECT COUNT(*)::bigint AS cnt
    FROM core.cost_events
    WHERE (event_date + event_time) > NOW() - INTERVAL '1 hour'
  `;
	return bigintToNumber(rows[0]?.cnt ?? 0n);
}

async function queryAgentEventsLastHour(prisma: PrismaClient): Promise<number> {
	const rows = await prisma.$queryRaw<SimpleCountRow[]>`
    SELECT COUNT(*)::bigint AS cnt
    FROM core.agent_events
    WHERE event_ts > NOW() - INTERVAL '1 hour'
  `;
	return bigintToNumber(rows[0]?.cnt ?? 0n);
}

async function queryLastOutcome(prisma: PrismaClient): Promise<Date | null> {
	const rows = await prisma.$queryRaw<OutcomeMaxRow[]>`
    SELECT MAX(inserted_at) AS max_ts
    FROM core.outcomes
  `;
	return rows[0]?.max_ts ?? null;
}

async function queryWriterFailures24h(
	prisma: PrismaClient,
): Promise<Map<string, number>> {
	const rows = await prisma.$queryRaw<WriterFailureRow[]>`
    SELECT hook_name, COUNT(*)::bigint AS cnt
    FROM core.hook_failures
    WHERE failure_ts > NOW() - INTERVAL '24 hours'
    GROUP BY hook_name
  `;
	const map = new Map<string, number>();
	for (const row of rows) {
		map.set(row.hook_name, bigintToNumber(row.cnt));
	}
	return map;
}

// ----- writer marker scan + composition -------------------------------------

async function composeWriters(
	failureMap: Map<string, number>,
	logger: OverlayLogger,
): Promise<WriterLiveStatus[]> {
	const markers = await loadMarkerCache(logger);
	return WRITERS.map((descriptor) => ({
		writer_name: descriptor.name,
		dual_write_active: markers.get(descriptor.name) ?? false,
		recent_failures_24h: failureMap.get(descriptor.name) ?? 0,
	}));
}

async function loadMarkerCache(
	logger: OverlayLogger,
): Promise<Map<string, boolean>> {
	if (markerCache !== null) {
		return markerCache;
	}
	const fresh = new Map<string, boolean>();
	await Promise.all(
		WRITERS.map(async (descriptor) => {
			try {
				const content = await readFile(descriptor.path, "utf8");
				fresh.set(descriptor.name, content.includes(descriptor.marker));
			} catch (error) {
				logger.warn(
					{ err: error, writer: descriptor.name, path: descriptor.path },
					"writer marker scan failed; treating dual_write_active as false",
				);
				fresh.set(descriptor.name, false);
			}
		}),
	);
	markerCache = fresh;
	return markerCache;
}

/** Test seam — clears marker cache so the next overlay re-scans the writer files. */
export function resetMarkerCache(): void {
	markerCache = null;
}

// ----- helpers --------------------------------------------------------------

function emptyDaemons(): DaemonLiveStatus[] {
	return DAEMON_NAMES.map(
		(name): DaemonLiveStatus => ({
			daemon_name: name,
			status: "missing",
			last_run_at: null,
			staleness_minutes: null,
			node_ids: [...(DAEMON_NODE_BINDINGS[name] ?? [])],
			expected_cadence_minutes: EXPECTED_CADENCE_MINUTES[name],
		}),
	);
}

function unwrap<T>(
	result: PromiseSettledResult<T>,
	logger: OverlayLogger,
	signal: string,
	fallback: () => T,
): T {
	if (result.status === "fulfilled") {
		return result.value;
	}
	logger.warn({ err: result.reason, signal }, "live overlay signal degraded");
	return fallback();
}

function bigintToNumber(value: bigint): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(`bigint ${value} exceeds Number.MAX_SAFE_INTEGER`);
	}
	return Number(value);
}
