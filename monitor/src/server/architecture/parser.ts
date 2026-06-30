// SoT assembler — converts the embedded TS module diagrams into the monitor response schema.
// Uses the Node module cache (no Obsidian md sink), so no fs.stat ENOENT or mtime polling.
//
// Input: ./diagrams-source — 7 v2 mermaid diagrams (DIAGRAMS).
// Output: SystemDiagrams (v2.0.0).
//
// Flow: each v2 mermaid → SystemDiagram → SystemDiagrams (split per diagram).
//
// Assembled once at module load and held as a singleton — input is static, so mtime caching is moot.

import type {
  FlowEdge,
  FlowLayer,
  FlowNode,
  LayerRole,
  SystemDiagram,
  SystemDiagrams,
} from "../types/architecture.js";
import {
  extractFlows,
  inferFlowNodeType,
  type ExtractedFlow,
  type ExtractedNode,
} from "./flow-extractor.js";
import {
  DIAGRAMS,
  DIAGRAMS_SOURCE_PATH,
} from "./diagrams-source.js";

// Minimal Pino-compatible logger — avoids Fastify dependency (same signature for test/standalone).
export interface ParserLogger {
  warn(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
}

interface ParsedDoc {
  diagrams: SystemDiagrams;
  // Compat — used by route handlers for logging (assemble ms at module-load, not real-time).
  parseDurationMs: number;
}

interface ParseStats {
  cacheHit: boolean;
  durationMs: number;
}

interface CachedResult {
  doc: ParsedDoc;
  stats: ParseStats;
}

// Module singleton — synchronously assembled on first getArchitecture(), then reused.
let singleton: ParsedDoc | null = null;

/** Assembles the response set from the module SoT and returns it as a cached result. */
export async function getArchitecture(
  logger: ParserLogger,
): Promise<CachedResult> {
  const start = Date.now();
  if (singleton === null) {
    // Only the first call assembles — later calls hit the cache.
    singleton = assembleFromSource(logger);
  }
  return {
    doc: singleton,
    stats: { cacheHit: true, durationMs: Date.now() - start },
  };
}

/** Test seed — next getArchitecture() re-assembles (same result, but seedable). */
export function resetArchitectureCache(): void {
  singleton = null;
}

// ----- assembly body -------------------------------------------------------

function assembleFromSource(logger: ParserLogger): ParsedDoc {
  const start = Date.now();
  // doc_mtime is the module-load time — semantic replacement for Obsidian mtime.
  const docMtimeIso = new Date().toISOString();
  const parsedAt = docMtimeIso;

  // SystemDiagrams — split per diagram (frontend tab/screen unit).
  const diagrams = buildSystemDiagrams({
    docMtimeIso,
    parsedAt,
    logger,
  });

  return {
    diagrams,
    parseDurationMs: Date.now() - start,
  };
}

// ----- v1 layer role mapping (for extras layer role inference) --------------
// buildSingleDiagram's extras layer uses a v1 slug-based role fallback.
const LAYER_ROLES: Record<string, LayerRole> = {
  "system-overview": "entry",
  "agents": "execution",
  "skills": "execution",
  "rules": "execution",
  "hooks": "gateway",
  "data-layer": "data",
  "learning-loop": "feedback",
  "autoagent-loop": "feedback",
  "daemons": "orchestration",
  "wiki": "data",
  "monitoring": "monitoring",
  "external-integration": "entry",
  "team-pipeline": "orchestration",
};

function roleForLayer(layerId: string): LayerRole {
  return LAYER_ROLES[layerId] ?? "execution";
}

// ----- mermaid extras → FlowNode -----------------------------------------

function buildFlowNodeFromMermaid(
  extracted: ExtractedNode,
  layerScopeId: string,
): FlowNode {
  return {
    id: `${layerScopeId}.${extracted.id}`,
    label: extracted.label,
    type: inferFlowNodeType(extracted),
  };
}

function appendNode(layer: FlowLayer, node: FlowNode): void {
  if (layer.nodes === undefined) {
    layer.nodes = [];
  }
  // Duplicate id → skip (first registration wins on label collision).
  if (layer.nodes.some((existing) => existing.id === node.id)) {
    return;
  }
  layer.nodes.push(node);
}

// mermaid id (alnum + underscore) → kebab-case layer-id fragment.
function slugifyMermaidId(mermaidId: string): string {
  return mermaidId.toLowerCase().replace(/_+/g, "-");
}

// Heuristic role for a mermaid subgraph unmapped by the v1 layer table.
function roleForSyntheticSubgraph(label: string): LayerRole {
  const lc = label.toLowerCase();
  if (lc.includes("게이트") || lc.includes("gate")) {
    return "gateway";
  }
  if (lc.includes("팀") || lc.includes("team") || lc.includes("orchestrat")) {
    return "orchestration";
  }
  if (lc.includes("학습") || lc.includes("learning") || lc.includes("loop")) {
    return "feedback";
  }
  if (lc.includes("daemon") || lc.includes("데몬")) {
    return "orchestration";
  }
  if (lc.includes("훅") || lc.includes("hook") || lc.includes("life") || lc.includes("수명")) {
    return "execution";
  }
  // "data" required alongside "store"/"queue" — "store" is NOT a substring of "storage",
  // so an English "Data layer" title would otherwise silently fall through to execution.
  if (lc.includes("데이터") || lc.includes("data") || lc.includes("store") || lc.includes("queue")) {
    return "data";
  }
  if (lc.includes("monitor") || lc.includes("health") || lc.includes("감시")) {
    return "monitoring";
  }
  return "execution";
}

// ----- SystemDiagrams (v2.0.0) builder ---------------------------------------
// DIAGRAMS module data → per-diagram SystemDiagram. No Obsidian raw scan.

interface BuildDiagramsOptions {
  docMtimeIso: string;
  parsedAt: string;
  logger: ParserLogger;
}

function buildSystemDiagrams(options: BuildDiagramsOptions): SystemDiagrams {
  const { docMtimeIso, parsedAt, logger } = options;

  const diagrams: SystemDiagram[] = [];
  const aggregatedUnmapped = new Set<string>();

  for (const src of DIAGRAMS) {
    const built = buildSingleDiagram(src.slug, src.title, src.description, src.mermaid_source, logger);
    if (built === null) {
      logger.warn(
        { title: src.title, id: src.id },
        "diagram produced no flows; skipped from /diagrams output",
      );
      continue;
    }
    diagrams.push(built);
    for (const lbl of built.unmapped_labels) {
      aggregatedUnmapped.add(lbl);
    }
  }

  logger.info(
    {
      diagramCount: diagrams.length,
      perDiagram: diagrams.map((d) => ({
        id: d.id,
        layers: d.layers.length,
        flows: d.flows.length,
      })),
      unmappedAgg: aggregatedUnmapped.size,
    },
    "SystemDiagrams built",
  );

  return {
    schema_version: "2.0.0",
    doc_path: DIAGRAMS_SOURCE_PATH,
    doc_mtime: docMtimeIso,
    parsed_at: parsedAt,
    diagrams,
    unmapped_labels: Array.from(aggregatedUnmapped),
  };
}

// Per-diagram builder — extracts a single mermaid block into a SystemDiagram.
// slug arg ensures DIAGRAMS slug matches frontend TAB_ORDER 1:1.
function buildSingleDiagram(
  diagramId: string,
  title: string,
  description: string,
  mermaidSource: string,
  logger: ParserLogger,
): SystemDiagram | null {
  const extracted: ExtractedFlow = extractFlows(mermaidSource, {
    idPrefix: diagramId,
    edgeIdPrefix: diagramId,
    logger,
  });

  if (extracted.nodes.length === 0 && extracted.edges.length === 0) {
    return null;
  }

  const layers: FlowLayer[] = [];
  const layerByMermaidSubgraphId = new Map<string, FlowLayer>();

  for (const sg of extracted.subgraphs) {
    const layerId = `${diagramId}.${slugifyMermaidId(sg.id)}`;
    const layer: FlowLayer = {
      id: layerId,
      label: sg.label,
      role: roleForSyntheticSubgraph(sg.label),
      nodes: [],
    };
    layers.push(layer);
    layerByMermaidSubgraphId.set(sg.id, layer);
  }

  let extrasLayer: FlowLayer | null = null;
  const extrasLayerId = `${diagramId}.extras`;

  for (const node of extracted.nodes) {
    const flowNode = buildFlowNodeFromMermaid(node, diagramId);
    const owningLayer =
      node.subgraphId !== null
        ? layerByMermaidSubgraphId.get(node.subgraphId) ?? null
        : null;
    if (owningLayer !== null) {
      appendNode(owningLayer, flowNode);
      continue;
    }
    if (extrasLayer === null) {
      extrasLayer = {
        id: extrasLayerId,
        label: `${title} — outer nodes`,
        role: roleForLayer(diagramId),
        nodes: [],
      };
      layers.push(extrasLayer);
    }
    appendNode(extrasLayer, flowNode);
  }

  const flows: FlowEdge[] = [];
  let ordinal = 0;
  for (const edge of extracted.edges) {
    const rewritten: FlowEdge = {
      id: `${edge.id}.${ordinal++}`,
      from: edge.from,
      to: edge.to,
      edge_type: edge.edge_type,
    };
    if (edge.label !== undefined) {
      rewritten.label = edge.label;
    }
    if (edge.condition !== undefined) {
      rewritten.condition = edge.condition;
    }
    if (edge.style !== undefined) {
      rewritten.style = edge.style;
    }
    flows.push(rewritten);
  }

  // source_line_* — line numbers meaningless under the TS module SoT; unified to 0.
  // If frontend uses them for ops jumps, line mapping vs DIAGRAMS_SOURCE_PATH is possible later.
  const diagram: SystemDiagram = {
    id: diagramId,
    title,
    layers,
    flows,
    source_line_start: 0,
    source_line_end: 0,
    unmapped_labels: extracted.unmappedLabels.slice(),
  };
  if (description !== "") {
    diagram.description = description;
  }
  if (mermaidSource !== "") {
    diagram.mermaid_source = mermaidSource;
  } else {
    logger.warn(
      { title, id: diagramId },
      "diagram has empty mermaid source; mermaid_source field omitted",
    );
  }
  return diagram;
}
