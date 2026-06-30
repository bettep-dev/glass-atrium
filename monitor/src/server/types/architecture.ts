// Response shapes for /api/architecture/{live,diagrams} endpoints. Only
// /diagrams + /live are consumed by architecture.jsx → minimal exposed surface.

export type DaemonLiveStatus = {
	daemon_name: string;
	status: string;
	last_run_at: string | null;
	staleness_minutes: number | null;
	// Mermaid node ids bound to this daemon (DAEMON_NODE_BINDINGS) — ring overlay target.
	node_ids: string[];
	// Expected run cadence (minutes) — staleness_minutes > cadence ⇒ warn-tone signal.
	expected_cadence_minutes: number;
};

export interface WriterLiveStatus {
	writer_name: string;
	dual_write_active: boolean;
	recent_failures_24h: number;
}

export interface RecentActivity {
	cost_events_last_hour: number;
	agent_events_last_hour: number;
	last_outcome_at: string | null;
}

// Single claimed-vs-actual count mismatch from computeArchDrift().
export interface ArchDriftDiff {
	key: string;
	claimed: number;
	actual: number;
}

export interface ArchitectureLiveResponse {
	computed_at: string;
	daemons: DaemonLiveStatus[];
	writers: WriterLiveStatus[];
	recent_activity: RecentActivity;
	// Drift signal — diagram-claimed counts (ARCH_INVARIANTS) vs live filesystem.
	// Computed LIVE per /live call (never cached) → badge warns on un-audited drift.
	stale: boolean;
	diffs: ArchDriftDiff[];
}

// Base layer/node/edge types composing the /api/architecture/diagrams response.

export type LayerRole =
	| "entry"
	| "orchestration"
	| "execution"
	| "data"
	| "feedback"
	| "monitoring"
	| "gateway";

export type FlowNodeType =
	| "agent"
	| "hook"
	| "script"
	| "daemon"
	| "store"
	| "external"
	| "gateway";

export type EdgeType =
	| "data_flow"
	| "control_flow"
	| "fires_event"
	| "writes_to"
	| "reads_from"
	| "monitors"
	| "escalates_to"
	| "triggers";

export type EdgeStyle = "solid" | "dashed";

export interface FlowNode {
	id: string; // layer.id.node-name
	label: string;
	type: FlowNodeType;
	description?: string;
	path?: string; // filesystem path if applicable
}

export interface FlowLayer {
	id: string; // kebab-case
	label: string; // human-readable
	role: LayerRole;
	description?: string; // 1-line LLM context
	nodes?: FlowNode[];
}

export interface FlowEdge {
	id: string;
	from: string; // layer.id OR node.id
	to: string; // layer.id OR node.id
	edge_type: EdgeType;
	label?: string;
	condition?: string;
	style?: EdgeStyle; // default solid
}

// /api/architecture/diagrams response — split per DIAGRAMS mermaid block, each
// rendering as its own FE tab to avoid single-screen density. Nodes stay slim:
// file paths + long descriptions belong on a click-through detail panel, so the
// optional FlowNode.description / FlowNode.path are emitted for deferred display.

export interface SystemDiagram {
	// Stable kebab-case id for routing/anchoring (e.g. tab URLs, deep links).
	// Matches the DIAGRAMS slug 1:1 — guarantees frontend TAB_ORDER stability.
	id: string;
	title: string; // human-readable, may contain Korean
	description?: string; // 1-line summary harvested from the commentary paragraph
	layers: FlowLayer[]; // scoped to THIS diagram only — no cross-diagram bleed
	flows: FlowEdge[]; // scoped to THIS diagram only
	// 1-indexed source line range in the design doc — ops/QA jump to source on parse anomaly.
	source_line_start: number;
	source_line_end: number;
	// Raw Mermaid source from the FIRST ```mermaid fence in this H3 (FE renders via mermaid.js).
	// Optional — malformed/missing fences must not break the response (/diagrams skips
	// diagrams with no extractable flows).
	mermaid_source?: string;
	// Labels the heuristic could not map to a layer/node. Empty array on a clean parse.
	unmapped_labels: string[];
}

export interface SystemDiagrams {
	schema_version: "2.0.0";
	doc_path: string;
	doc_mtime: string; // ISO8601
	parsed_at: string; // ISO8601
	diagrams: SystemDiagram[];
	// Union of each diagram's unmapped_labels — heuristic-tuning signal.
	unmapped_labels: string[];
}

export type ArchitectureErrorBody =
	| { error: "internal" }
	| { error: "database_unavailable" }
	| { error: "doc_unreadable"; path: string };
