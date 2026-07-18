// Mermaid flowchart → SystemFlowGraph edge extractor (parser.ts 가 v2 mermaid 블록을 flows[]/nodes[] 로 변환).
// 별도 모듈 분리 — regex 테이블(edge syntax, label heuristics)이 파서의 최대 튜닝 표면이라 parser.ts 의 doc-level 관심사와 격리 + heuristic 테이블 greppability.
// 의도적 서브셋(full parser 아님): 처리 = node defs(hyphen id 포함) · edge(solid/dashed/thick · compact/split-label/chained) · subgraph. 미처리(unmappedLabels surface + warn) = linkStyle/classDef · click · exotic edge op(--o, --x, ===).

import type {
  EdgeStyle,
  EdgeType,
  FlowEdge,
  FlowNodeType,
} from "../types/architecture.js";

export interface FlowExtractorLogger {
  warn(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
}

export interface ExtractedNode {
  id: string;                       // raw mermaid id (e.g. "EXT", "DAEMON")
  label: string;                    // human label, <br> stripped
  shape: "rect" | "round" | "diamond" | "cylinder" | "default";
  subgraphId: string | null;        // owning subgraph id, null if top-level
}

export interface ExtractedSubgraph {
  id: string;
  label: string;
  members: string[];                // child node ids
}

export interface ExtractedFlow {
  nodes: ExtractedNode[];
  subgraphs: ExtractedSubgraph[];
  edges: FlowEdge[];
  unmappedLabels: string[];
}

// Per-section caller-supplied context — extractor 는 순수 syntactic, mermaid id 키 raw nodes+edges 만 반환 · caller(parser.ts)가 최종 SystemFlowGraph 의 layer/node id 로 매핑.
export interface ExtractFlowsOptions {
  // FlowEdge.from/to 빌드 시 mermaid id 앞에 붙는 prefix — section 별 id 스코핑(예: "v2-overview.EXT")으로 단일 flows[] 충돌 방지.
  idPrefix: string;
  // synthesized FlowEdge.id prefix ("v2-hooks.e0", ...).
  edgeIdPrefix: string;
  logger: FlowExtractorLogger;
}

/**
 * Parses a single mermaid flowchart source string into structured nodes,
 * subgraphs, and edges. Defensive: malformed lines are skipped + counted in
 * unmappedLabels rather than thrown.
 */
export function extractFlows(
  mermaidSource: string,
  options: ExtractFlowsOptions,
): ExtractedFlow {
  const { idPrefix, edgeIdPrefix, logger } = options;
  const nodes = new Map<string, ExtractedNode>();
  const subgraphs: ExtractedSubgraph[] = [];
  const edges: FlowEdge[] = [];
  const unmappedLabels: string[] = [];

  // Subgraph stack — 1-level nesting 만 사용(deeper nest 도 parse 되나 innermost 가 membership owner).
  const subgraphStack: ExtractedSubgraph[] = [];
  let edgeOrdinal = 0;

  const lines = mermaidSource.split("\n");
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx] ?? "";
    const line = rawLine.trim();
    if (line === "" || line.startsWith("%%")) {
      // Blank or mermaid comment — skip.
      continue;
    }
    // flowchart / graph header lines.
    if (/^(flowchart|graph)\b/i.test(line)) {
      continue;
    }
    // Subgraph entry/exit.
    if (/^subgraph\b/i.test(line)) {
      const sg = parseSubgraphHeader(line);
      if (sg !== null) {
        subgraphs.push(sg);
        subgraphStack.push(sg);
      } else {
        logger.warn({ line }, "subgraph header parse failed; treating as no-op");
      }
      continue;
    }
    if (/^end\b/i.test(line)) {
      subgraphStack.pop();
      continue;
    }
    // Mermaid styling directives — ignored (no node/edge semantics).
    if (
      line.startsWith("classDef") ||
      line.startsWith("class ") ||
      line.startsWith("style ") ||
      line.startsWith("linkStyle") ||
      line.startsWith("click ")
    ) {
      continue;
    }

    // edge line 우선 — 모든 edge line 이 자신이 touch 하는 노드를 암묵 정의하므로.
    const containsEdge = EDGE_LINE_DETECT_RE.test(line);
    if (containsEdge) {
      const parsedEdges = parseEdgeLine(line, {
        idPrefix,
        edgeIdPrefix,
        edgeOrdinalSeed: edgeOrdinal,
        unmappedLabels,
      });
      for (const { edge, declaredNodes } of parsedEdges) {
        for (const node of declaredNodes) {
          registerNode(nodes, node, currentSubgraphId(subgraphStack));
        }
        edges.push(edge);
        edgeOrdinal++;
      }
      continue;
    }

    // Pure node def (no edge op on the line).
    const node = parseStandaloneNode(line);
    if (node !== null) {
      registerNode(nodes, node, currentSubgraphId(subgraphStack));
      continue;
    }

    // Unknown construct — unmappedLabels 로 surface(SoT 의 새 mermaid 문법이 log 가 아닌 UI unmapped modal 에서 보이게) + continue, no throw.
    unmappedLabels.push(`line-not-recognized: ${line}`);
    logger.warn({ line, lineIdx }, "mermaid line not recognized; skipped");
  }

  // Backfill subgraph membership from the node map.
  for (const sg of subgraphs) {
    sg.members = [];
  }
  for (const node of nodes.values()) {
    if (node.subgraphId === null) {
      continue;
    }
    const sg = subgraphs.find((candidate) => candidate.id === node.subgraphId);
    if (sg !== undefined) {
      sg.members.push(node.id);
    }
  }

  // Subgraph-container endpoint label backfill — cross-subgraph edge(예: `daemon --> orch`)는
  // subgraph id 를 직접 endpoint 로 참조하므로 bare-fallback node(label === id)로 등록된다.
  // 사람 라벨은 subgraph 헤더(sg.label)에만 있으므로 여기서 노드 라벨로 끌어와, downstream
  // connection row 가 bare "daemon" 대신 "Scheduled background jobs (daemons)"를 표시하게 한다.
  const subgraphLabelById = new Map(subgraphs.map((sg) => [sg.id, sg.label]));
  for (const node of nodes.values()) {
    if (node.label !== node.id) {
      continue;
    }
    const humanLabel = subgraphLabelById.get(node.id);
    if (humanLabel !== undefined && humanLabel !== node.id) {
      node.label = humanLabel;
    }
  }

  // Containment-edge guard — 실노드와 그 자신을 감싼 subgraph 컨테이너 사이의 edge 제거
  // (예: `autoagent_d --> daemon`, autoagent_d ∈ subgraph daemon). subgraph 박스와 중복 표현.
  // 관계 자체는 subgraph membership(사람 라벨 sg.label 보유)이 이미 표현 → 제거해도 정보 손실 없음.
  // 양방향(컨테이너가 source/target 어느 쪽이든) 처리.
  const subgraphIds = new Set(subgraphs.map((sg) => sg.id));
  const keptEdges = edges.filter(
    (edge) => !isContainmentEdge(edge, idPrefix, subgraphIds, nodes),
  );

  return {
    nodes: Array.from(nodes.values()),
    subgraphs,
    edges: keptEdges,
    unmappedLabels,
  };
}

// prefixed edge endpoint(`${idPrefix}.${mermaidId}`) → raw mermaid id. node id 는 dot 미포함이라
// 알려진 prefix 만 벗겨내면 안전.
function stripIdPrefix(prefixedId: string, idPrefix: string): string {
  const head = `${idPrefix}.`;
  return prefixedId.startsWith(head) ? prefixedId.slice(head.length) : prefixedId;
}

// containment edge = 실노드 ↔ 그 노드를 직접 감싼 subgraph 컨테이너. subgraph 간(daemon-->orch)
// 이나 top-level 노드 → 다른 subgraph(from_improvement-->agents) 는 의도된 flow 라 보존.
function isContainmentEdge(
  edge: FlowEdge,
  idPrefix: string,
  subgraphIds: Set<string>,
  nodes: Map<string, ExtractedNode>,
): boolean {
  const from = stripIdPrefix(edge.from, idPrefix);
  const to = stripIdPrefix(edge.to, idPrefix);
  if (subgraphIds.has(to) && nodes.get(from)?.subgraphId === to) {
    return true;
  }
  if (subgraphIds.has(from) && nodes.get(to)?.subgraphId === from) {
    return true;
  }
  return false;
}

// node parsing

// Mermaid node id 문자 클래스 단일 SoT — 내부 hyphen 허용(`glass-atrium-design-designer`), 단 trailing/연속 hyphen 불허:
// 무공백 `A-->B` 류에서 bare-id 가 edge op 의 `--` 를 침식하지 않게 hyphen 은 alnum 사이에서만 매칭.
const NODE_ID_PATTERN = "[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*";

const NODE_DEF_RE_LIST: ReadonlyArray<{ re: RegExp; shape: ExtractedNode["shape"] }> = [
  // 순서 의존 — 더 구체적인 shape 먼저(예: `[("...")]` 가 plain `[...]` 로 오매칭되지 않게).
  { re: new RegExp(`^(${NODE_ID_PATTERN})\\(\\("([^"]*)"\\)\\)`), shape: "round" },     // ID(("label"))
  { re: new RegExp(`^(${NODE_ID_PATTERN})\\(\\(([^)]*)\\)\\)`), shape: "round" },       // ID((label))
  { re: new RegExp(`^(${NODE_ID_PATTERN})\\[\\("([^"]*)"\\)\\]`), shape: "cylinder" },  // ID[("label")]
  { re: new RegExp(`^(${NODE_ID_PATTERN})\\[\\(([^)]*)\\)\\]`), shape: "cylinder" },    // ID[(label)]
  { re: new RegExp(`^(${NODE_ID_PATTERN})\\{"([^"]*)"\\}`), shape: "diamond" },         // ID{"label"}
  { re: new RegExp(`^(${NODE_ID_PATTERN})\\{([^}]*)\\}`), shape: "diamond" },           // ID{label}
  { re: new RegExp(`^(${NODE_ID_PATTERN})\\["([^"]*)"\\]`), shape: "rect" },            // ID["label"]
  { re: new RegExp(`^(${NODE_ID_PATTERN})\\[([^\\]]*)\\]`), shape: "rect" },            // ID[label]
  { re: new RegExp(`^(${NODE_ID_PATTERN})\\("([^"]*)"\\)`), shape: "rect" },            // ID("label") — pill
  { re: new RegExp(`^(${NODE_ID_PATTERN})\\(([^)]*)\\)`), shape: "rect" },              // ID(label)
];

const BARE_NODE_ID_RE = new RegExp(`^(${NODE_ID_PATTERN})`);

interface ParsedNodeRef {
  id: string;
  label: string;
  shape: ExtractedNode["shape"];
}

/**
 * Tries to parse an entire trimmed line as a single node definition.
 * Returns null if the line doesn't match any node pattern.
 */
function parseStandaloneNode(line: string): ParsedNodeRef | null {
  const match = matchNodeRef(line);
  if (match === null) {
    return null;
  }
  // Reject if there's trailing content beyond the node — likely an edge.
  if (match.consumed !== line.length) {
    return null;
  }
  return match.node;
}

interface NodeRefMatch {
  node: ParsedNodeRef;
  consumed: number;                 // chars from start of `text` consumed
}

/**
 * `text` START 에서 node ref peel — { node, consumed chars } 또는 node prefix 부재 시 null.
 * Bare-id fallback(`ABCD` 무괄호) → label === id, shape "default".
 */
function matchNodeRef(text: string): NodeRefMatch | null {
  for (const { re, shape } of NODE_DEF_RE_LIST) {
    const m = re.exec(text);
    if (m !== null && m.index === 0) {
      const id = m[1] ?? "";
      const rawLabel = (m[2] ?? "").trim();
      if (id === "") {
        continue;
      }
      const label = sanitizeLabel(rawLabel === "" ? id : rawLabel);
      return {
        node: { id, label, shape },
        consumed: m[0].length,
      };
    }
  }
  // Bare-id fallback. Mermaid permits `A --> B` with no label decl.
  const bare = BARE_NODE_ID_RE.exec(text);
  if (bare !== null && bare.index === 0) {
    const id = bare[1] ?? "";
    if (id === "") {
      return null;
    }
    return {
      node: { id, label: id, shape: "default" },
      consumed: bare[0].length,
    };
  }
  return null;
}

function sanitizeLabel(rawLabel: string): string {
  // Mermaid label 의 <br> soft-wrap → space-dot 구분자로 정규화(downstream UI/LLM 은 single-line label) · fragment trim 으로 `"foo  bar"` artifact 차단.
  return rawLabel
    .split(/<br\s*\/?>/i)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment !== "")
    .join(" · ");
}

// edge parsing

// Compact edge operator — cursor 위치 anchored. longest-first 로 `-->` 가 `-.->` 를 가리지 않게.
const COMPACT_EDGE_OP_RE = /^(==>|-\.->|-->|~~~|--o|--x)/;

// Split-label edge — `A -- "label" --> B` 계열(solid/dotted/thick). canonical compact op 로 정규화해
// downstream style/edge_type 파생을 compact 경로와 공유. quoted 변형 우선 — label 내 hyphen("2-tier")이
// unquoted lazy-stop 을 오염시키지 않게.
const SPLIT_EDGE_RE_LIST: ReadonlyArray<{ re: RegExp; op: string }> = [
  { re: /^--\s*"([^"]*)"\s*-->/, op: "-->" },
  { re: /^-\.\s*"([^"]*)"\s*\.->/, op: "-.->" },
  { re: /^==\s*"([^"]*)"\s*==>/, op: "==>" },
  { re: /^--\s+([^|]+?)\s+-->/, op: "-->" },
  { re: /^-\.\s+([^|]+?)\s+\.->/, op: "-.->" },
  { re: /^==\s+([^|]+?)\s+==>/, op: "==>" },
];

// containsEdge 게이트 — compact op + split-label closing token. `\.->` 는 dotted split 의 closing
// (compact `-.->` 와 별개 토큰), solid/thick split 의 closing 은 `-->`/`==>` alternation 이 커버.
const EDGE_LINE_DETECT_RE = /(==>|-\.->|-->|~~~|--o|--x|\.->)/;

// Captures the optional |"label"| (or |label|) between op and target.
// Used after a successful op match.
const EDGE_LABEL_RE = /^\s*\|\s*"?([^"|]+?)"?\s*\|\s*/;

interface EdgeParseContext {
  idPrefix: string;
  edgeIdPrefix: string;
  edgeOrdinalSeed: number;
  unmappedLabels: string[];
}

interface ParsedEdge {
  edge: FlowEdge;
  declaredNodes: ParsedNodeRef[];
}

/**
 * Parses an edge line into 1+ FlowEdges. Handles chained edges
 * (`A --> B --> C` -> 2 edges) by walking the line left-to-right.
 */
function parseEdgeLine(line: string, ctx: EdgeParseContext): ParsedEdge[] {
  const out: ParsedEdge[] = [];
  let cursor = 0;
  const declared: ParsedNodeRef[] = [];

  // Peel off the first node.
  const firstMatch = matchNodeRef(line.slice(cursor));
  if (firstMatch === null) {
    ctx.unmappedLabels.push(`edge-line-no-source: ${line}`);
    return out;
  }
  let prevNode = firstMatch.node;
  declared.push(prevNode);
  cursor += firstMatch.consumed;

  let localOrdinal = ctx.edgeOrdinalSeed;

  while (cursor < line.length) {
    // Skip whitespace.
    while (cursor < line.length && line[cursor] === " ") {
      cursor++;
    }
    if (cursor >= line.length) {
      break;
    }
    // Match operator — compact 우선, 실패 시 split-label 형.
    const opMatch = matchEdgeOpAt(line.slice(cursor));
    if (opMatch === null) {
      // Trailing junk after a node — log + bail.
      ctx.unmappedLabels.push(`edge-line-trailing: ${line.slice(cursor)}`);
      break;
    }
    const op = opMatch.op;
    cursor += opMatch.consumed;

    // Skip styling-only operators (no semantic edge).
    if (op === "~~~" || op === "--o" || op === "--x") {
      ctx.unmappedLabels.push(`edge-op-skipped: ${op}`);
      // Advance past the next node ref so we don't loop forever.
      while (cursor < line.length && line[cursor] === " ") {
        cursor++;
      }
      const skipMatch = matchNodeRef(line.slice(cursor));
      if (skipMatch !== null) {
        cursor += skipMatch.consumed;
        prevNode = skipMatch.node;
      } else {
        break;
      }
      continue;
    }

    // Label — split 형은 op 매치에 내장, compact 형은 후행 |label| 시도.
    let label: string | null = opMatch.label;
    if (label === null) {
      const labelMatch = EDGE_LABEL_RE.exec(line.slice(cursor));
      if (labelMatch !== null) {
        label = (labelMatch[1] ?? "").trim();
        cursor += labelMatch[0].length;
      }
    }

    // Skip whitespace before target.
    while (cursor < line.length && line[cursor] === " ") {
      cursor++;
    }
    const targetMatch = matchNodeRef(line.slice(cursor));
    if (targetMatch === null) {
      ctx.unmappedLabels.push(`edge-line-no-target: ${line}`);
      break;
    }
    const targetNode = targetMatch.node;
    declared.push(targetNode);
    cursor += targetMatch.consumed;

    // Style + edge_type derivation.
    const style: EdgeStyle = op === "-.->" ? "dashed" : "solid";
    const edgeType = deriveEdgeType(op, label, ctx.unmappedLabels);

    const edge: FlowEdge = {
      id: `${ctx.edgeIdPrefix}.e${localOrdinal}`,
      from: `${ctx.idPrefix}.${prevNode.id}`,
      to: `${ctx.idPrefix}.${targetNode.id}`,
      edge_type: edgeType,
    };
    if (label !== null && label !== "") {
      edge.label = label;
    }
    if (style !== "solid") {
      edge.style = style;
    }
    if (style === "dashed" && label !== null && label !== "") {
      // dashed + label = source doc 의 condition 관용 → downstream UI tooltip 용 condition 으로 surface.
      edge.condition = label;
    }

    out.push({ edge, declaredNodes: declared.slice() });
    declared.length = 0;
    declared.push(targetNode);
    prevNode = targetNode;
    localOrdinal++;
  }

  return out;
}

interface EdgeOpMatch {
  op: string;                       // canonical compact op ("-->", "-.->", "==>", skip ops)
  label: string | null;             // split-label 형 내장 label — compact 는 null(|label| 별도 parse)
  consumed: number;
}

/** `text` START 에서 edge operator 매치 — compact 우선, split-label 형 fallback. */
function matchEdgeOpAt(text: string): EdgeOpMatch | null {
  const compact = COMPACT_EDGE_OP_RE.exec(text);
  if (compact !== null) {
    return { op: compact[1] ?? "", label: null, consumed: compact[0].length };
  }
  for (const { re, op } of SPLIT_EDGE_RE_LIST) {
    const m = re.exec(text);
    if (m !== null) {
      return { op, label: (m[1] ?? "").trim(), consumed: m[0].length };
    }
  }
  return null;
}

// edge_type heuristic mapping
// Mermaid 은 semantic edge_type 가 없음 → (1) operator style + (2) label keyword 로 파생.
// operator 기본값: `==>` thick → data_flow · `-->` solid / `-.->` dashed → control_flow(dashed label 은 condition) · `~~~`/`--o`/`--x` → skip.
// label keyword override 는 LABEL_RULES 가 SoT.

interface LabelRule {
  // Korean + English keywords. Substring match (case-insensitive).
  keywords: string[];
  edgeType: EdgeType;
}

const LABEL_RULES: ReadonlyArray<LabelRule> = [
  // Order matters — earlier rules win on ambiguous labels. "writes" beats "data"
  // because "writes" implies a directional store action while "data" is generic.
  {
    // "instruction update" — 좁은 구문 키워드: 단독 "update" 는 "doc_status UPDATE" 류 operator-default 라벨을 재분류함.
    keywords: ["writes", "write_to", "writes_to", "instruction update", "적재", "저장", "기록", "갱신", "반영"],
    edgeType: "writes_to",
  },
  {
    keywords: ["reads", "reads_from", "read", "읽기", "조회"],
    edgeType: "reads_from",
  },
  {
    keywords: ["fires", "fire", "이벤트", "발사", "발송"],
    edgeType: "fires_event",
  },
  {
    // "failure" (not bare "fail") — "fail-CLOSED"/"blocked/fail" 류 state 라벨은 operator-default 유지.
    keywords: ["escalates", "escalate", "failure", "에스컬레이션", "실패"],
    edgeType: "escalates_to",
  },
  {
    keywords: ["monitors", "monitor", "감시", "추적", "상태"],
    edgeType: "monitors",
  },
  {
    keywords: ["triggers", "trigger", "트리거", "기동", "수신", "정지", "되돌림"],
    edgeType: "triggers",
  },
  {
    // "plan document" — 좁은 구문 키워드: 단독 "plan" 은 "complex plan" 류 operator-default 라벨을 재분류함.
    keywords: ["data", "code", "results", "content", "plan document", "데이터", "결과", "콘텐츠", "보고", "조사 결과", "코드", "계획서"],
    edgeType: "data_flow",
  },
];

function deriveEdgeType(op: string, label: string | null, unmapped: string[]): EdgeType {
  // Operator-driven defaults.
  let baseType: EdgeType = "control_flow";
  if (op === "==>") {
    baseType = "data_flow";
  }
  if (label === null || label === "") {
    return baseType;
  }
  const lc = label.toLowerCase();
  for (const rule of LABEL_RULES) {
    for (const kw of rule.keywords) {
      if (lc.includes(kw.toLowerCase())) {
        return rule.edgeType;
      }
    }
  }
  // No rule matched — keep operator default but log so the heuristic table can
  // grow over time. This is a tuning signal, not a parse failure.
  unmapped.push(label);
  return baseType;
}

// subgraph parsing

const SUBGRAPH_HEADER_RE = new RegExp(
  `^subgraph\\s+(${NODE_ID_PATTERN})(?:\\s*\\["?([^"\\]]*)"?\\])?\\s*$`,
  "i",
);

function parseSubgraphHeader(line: string): ExtractedSubgraph | null {
  const m = SUBGRAPH_HEADER_RE.exec(line);
  if (m === null) {
    return null;
  }
  const id = m[1] ?? "";
  const rawLabel = (m[2] ?? "").trim();
  if (id === "") {
    return null;
  }
  return { id, label: rawLabel === "" ? id : sanitizeLabel(rawLabel), members: [] };
}

function currentSubgraphId(stack: ExtractedSubgraph[]): string | null {
  if (stack.length === 0) {
    return null;
  }
  return stack[stack.length - 1]?.id ?? null;
}

// node registry merge

function registerNode(
  registry: Map<string, ExtractedNode>,
  parsed: ParsedNodeRef,
  subgraphId: string | null,
): void {
  const existing = registry.get(parsed.id);
  if (existing === undefined) {
    registry.set(parsed.id, {
      id: parsed.id,
      label: parsed.label,
      shape: parsed.shape,
      subgraphId,
    });
    return;
  }
  // Merge — prefer the richer label (one with brackets) and the first
  // observed subgraph ownership.
  if (existing.label === existing.id && parsed.label !== parsed.id) {
    existing.label = parsed.label;
  }
  if (existing.shape === "default" && parsed.shape !== "default") {
    existing.shape = parsed.shape;
  }
  if (existing.subgraphId === null && subgraphId !== null) {
    existing.subgraphId = subgraphId;
  }
}

// node-type inference
// parser.ts 가 ExtractedNode → FlowNodeType 매핑에 사용. heuristic 테이블을 edge 테이블 옆에 colocate.

interface NodeTypeRule {
  keywords: string[];
  type: FlowNodeType;
}

// Order matters — earlier rules win on substring overlap. Agent rules MUST
// precede hook rules so "glass-atrium-sec-guard" (compound word containing "guard")
// resolves to agent, not hook. Daemon precedes both for the same reason.
const NODE_TYPE_RULES: ReadonlyArray<NodeTypeRule> = [
  { keywords: ["daemon", "데몬"], type: "daemon" },
  {
    keywords: [
      "agent",
      "에이전트",
      "glass-atrium-intel-researcher",
      "glass-atrium-intel-planner",
      "glass-atrium-intel-reporter",
      "glass-atrium-qa-code-reviewer",
      "glass-atrium-qa-debugger",
      "glass-atrium-design-designer",
      "glass-atrium-sec-guard",
      "오케스트레이터",
    ],
    type: "agent",
  },
  { keywords: ["hook", "훅", "scanner", "guard", "validator"], type: "hook" },
  { keywords: [".sh", "script", "스크립트", "cycle.sh", "apply.sh"], type: "script" },
  // Store keywords — "git pr" matches "Git PR" while "vault" catches Obsidian.
  // "repository" (not bare "repo") — "repo" 는 "glass-atrium-intel-reporter" 의 substring.
  { keywords: ["store", "vault", "obsidian", "DB", "저장소", "repository", "git pr", "queue"], type: "store" },
  { keywords: ["external", "외부", "프로젝트"], type: "external" },
  // "blocked" (not bare "block") — "COMPLETION block output" 류 라벨이 gateway 로 재분류되지 않게.
  { keywords: ["gate", "게이트", "차단", "blocked"], type: "gateway" },
];

/**
 * Infers a FlowNodeType from a node's label + raw mermaid id, using the
 * keyword table above. Falls back to a shape-based default:
 *   round    -> agent       (Mermaid convention for entry circles)
 *   cylinder -> store       (DB/queue convention)
 *   diamond  -> gateway     (decision diamond)
 *   rect / default -> agent (most v2 nodes are agent-shaped boxes)
 */
export function inferFlowNodeType(node: ExtractedNode): FlowNodeType {
  const haystack = `${node.id} ${node.label}`.toLowerCase();
  for (const rule of NODE_TYPE_RULES) {
    for (const kw of rule.keywords) {
      if (haystack.includes(kw.toLowerCase())) {
        return rule.type;
      }
    }
  }
  switch (node.shape) {
    case "round":
      return "agent";
    case "cylinder":
      return "store";
    case "diamond":
      return "gateway";
    default:
      return "agent";
  }
}
