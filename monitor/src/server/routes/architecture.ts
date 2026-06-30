// Architecture API: 2 read-only endpoints feeding the architecture screen —
// /live (PG 5-source overlay) + /diagrams (SystemDiagrams, split one entry per
// v2 mermaid block so the frontend tabs each instead of fitting all layers).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { getPrisma } from "../db.js";
import { getArchitecture } from "../architecture/parser.js";
import { getLiveOverlay } from "../architecture/live-overlay.js";
import { computeArchDrift } from "../architecture/compute-arch-drift.js";
import type {
	ArchitectureErrorBody,
	ArchitectureLiveResponse,
	SystemDiagrams,
} from "../types/architecture.js";

export async function registerArchitectureRoutes(
	app: FastifyInstance,
): Promise<void> {
	app.get("/api/architecture/live", handleLive);
	app.get("/api/architecture/diagrams", handleDiagrams);
}

async function handleLive(
	request: FastifyRequest,
	reply: FastifyReply,
): Promise<ArchitectureLiveResponse | ArchitectureErrorBody> {
	const start = Date.now();
	const prisma = getPrisma();
	try {
		// computeArchDrift memoizes its FS scan behind a 30s TTL cache, collapsing the
		// per-request full filesystem scan on this high-volume route. The badge still
		// warns on un-audited counts — bounded ≤30s staleness is acceptable, since a
		// file add/remove or a fresh audit surfaces within the TTL window. Runs in
		// parallel with the PG/fs overlay (no data dependency).
		const [overlay, drift] = await Promise.all([
			getLiveOverlay(prisma, request.log),
			computeArchDrift(request.log),
		]);
		request.log.info(
			{
				route: "/api/architecture/live",
				durationMs: Date.now() - start,
				daemonCount: overlay.daemons.length,
				writerCount: overlay.writers.length,
				stale: drift.stale,
				diffCount: drift.diffs.length,
			},
			"architecture live query complete",
		);
		return { ...overlay, stale: drift.stale, diffs: drift.diffs };
	} catch (error) {
		// getLiveOverlay swallows per-signal failures via Promise.allSettled, so
		// reaching this catch implies a synchronous wiring error — surface 503 so
		// ops sees it as an availability incident, not a partial-data degrade.
		request.log.error(
			{ err: error, route: "/api/architecture/live" },
			"architecture live query failed",
		);
		reply.code(503);
		return { error: "database_unavailable" };
	}
}

// Split-per-mermaid-block shape (one diagram per v2 block → one frontend tab).
// Short browser cache + must-revalidate — the TS module is the SoT (doc changes
// need a restart); the header stands by in case a dynamic doc source returns.
async function handleDiagrams(
	request: FastifyRequest,
	reply: FastifyReply,
): Promise<SystemDiagrams | ArchitectureErrorBody> {
	const start = Date.now();
	try {
		const { doc, stats } = await getArchitecture(request.log);
		reply.header("Cache-Control", "private, max-age=5, must-revalidate");
		request.log.info(
			{
				route: "/api/architecture/diagrams",
				cacheHit: stats.cacheHit,
				durationMs: Date.now() - start,
				diagramCount: doc.diagrams.diagrams.length,
				perDiagram: doc.diagrams.diagrams.map((d) => ({
					id: d.id,
					layers: d.layers.length,
					flows: d.flows.length,
				})),
				unmappedAggCount: doc.diagrams.unmapped_labels.length,
				parseDurationMs: doc.parseDurationMs,
			},
			"architecture diagrams query complete",
		);
		return doc.diagrams;
	} catch (error) {
		request.log.error(
			{ err: error, route: "/api/architecture/diagrams" },
			"architecture diagrams query failed",
		);
		reply.code(500);
		return { error: "doc_unreadable", path: "" };
	}
}
