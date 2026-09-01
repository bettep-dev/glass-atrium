// 클로드 시스템 설계도 SoT — 7 v2 mermaid 다이어그램 source + description.
// TS 모듈 채택 이유(rejected: 옵시디언 md 의존) — md 의존 제거로 fs.stat ENOENT 회귀 차단 · Node loader 의 import 영구 캐시로 mtime 폴링 불요 · as const 로 7 카운트를 컴파일 타임 검증.
// 편집 후 반영: npm run build → launchctl kickstart 재기동.

import { fileURLToPath } from "node:url";

import type { DetailGrade } from "./content-budget.js";

// 7 v2 mermaid 다이어그램. slug 는 frontend TAB_ORDER 와 1:1 매칭.
export interface DiagramSource {
	id: number;
	slug: string;
	title: string;
	description: string;
	mermaid_source: string;
}

// slug 는 parser.ts slugifySection 의 v2-* 매핑과 일치 — frontend TAB_ORDER 의존.
// 가독성 분할: overview/loops/team 각각 2개로 split (≈15-20 노드/그래프) + 경계 노드로 cross-graph 링크 보존.
// 노드 라벨 1줄 압축 — 상세는 클릭 모달 (description / 연결 flow) 에서 표현.
// 라벨/제목/설명은 영문 (배포 가시 표면) · edge/node 라벨 어휘는 flow-extractor LABEL_RULES / NODE_TYPE_RULES 키워드와 결합 — 라벨 수정 시 분류 parity 테스트 (architecture.flow-extractor) 필수.

export const DIAGRAMS = [
	{
		id: 1,
		slug: "v2-overview-entry",
		title: "How work enters and gets assigned",
		description:
			"Three kinds of input — a code repository, a user's message, or a scheduled background job — wake the main orchestrator, which runs its four-step routine and hands the work to the right specialist agents. Agent tool calls pass through safety checks before any result is saved. Saved results flow onward into the data layer (the second overview diagram), from which finished documents are rendered for export by a headless Chromium.",
		mermaid_source: `flowchart LR
    subgraph entry["External inputs"]
        repo[Project repository]
        user[User utterance]
    end

    subgraph daemon["Scheduled background jobs (daemons)"]
        autoagent_d[Self-improvement daemon]
        wiki_d[Wiki daemon]
        cron["Scheduled background jobs"]
    end

    subgraph orch["Orchestrator (main session)"]
        main_session["Plans the work, then assigns it"]
    end

    subgraph agents["Specialist agents"]
        agent_layer["Specialist agents (23)"]
    end

    subgraph hooks["Safety checks & tracking"]
        hook_pipeline["Hook pipeline (safety checks + tracking)"]
    end

    subgraph data["Data layer (PostgreSQL glass_atrium DB)"]
        pg_db[("PostgreSQL database")]
    end

    subgraph export["Document export"]
        doc_export["Document export (headless Chromium)"]
    end

    from_improvement[/"← Data · documents · improvement layer<br/>(boundary: instruction updates)"/]
    to_html_gate[/"→ Data · documents · improvement layer<br/>(boundary: document POST)"/]

    repo --> orch
    user --> orch
    daemon --> orch
    orch -- "assigns work" --> agents
    agents -- "tool calls" --> hooks
    agents -- "saves documents" --> to_html_gate
    hooks -- "saves results" --> data
    data -- "renders stored content" --> export
    from_improvement -- "instruction updates" --> agents`,
	},
	{
		id: 2,
		slug: "v2-overview-data",
		title: "Where results are stored and how the system learns",
		description:
			"Everything the hooks record lands in one PostgreSQL database; the monitor website reads that database to show dashboards. Finished documents are posted through a validation gate and stored once — as HTML if the user asked to share it, otherwise as a compact internal format. The learning loops read the same data to gradually improve the agents' instructions.",
		mermaid_source: `flowchart LR
    from_hooks[/"← Entry · orchestration layer<br/>(boundary: hook INSERT)"/]

    subgraph data["Data layer (PostgreSQL glass_atrium DB)"]
        pg_db[("PostgreSQL database")]
    end

    subgraph doc_storage["Document body storage (HTML only)"]
        html_root[/"Shareable HTML store"/]
    end

    subgraph improvement_loop["Learning loops"]
        learn_loop["Learning loop"]
        autoagent_loop["AutoAgent loop"]
    end

    subgraph ecc_fs["Learning-signal storage"]
        learning_files["Learning-signal files"]
    end

    subgraph monitor_web["Monitoring (route layer)"]
        monitor["Monitor website"]
        html_gate["Document validation gate"]
        monitor_api["Monitor web APIs"]
    end

    subgraph exposure_route["Share it or keep internal?"]
        request_branch{"Share it or keep internal?"}
        exposed_html["Shareable HTML"]
        hidden_token["Internal-only format"]
        request_branch -->|share| exposed_html
        request_branch -->|internal| hidden_token
    end

    to_agents[/"→ Entry · orchestration layer<br/>(boundary: 2-tier instruction update)"/]
    from_agents[/"← Entry · orchestration layer<br/>(boundary: document POST)"/]

    from_hooks -- "records" --> data
    data --> improvement_loop
    learning_files -- "confidence signals" --> autoagent_loop
    learning_files -. "feature-flag gate" .-> autoagent_loop
    data --> monitor_web
    data -- "learning data" --> monitor_api
    monitor_api -- "dashboard rows" --> monitor
    improvement_loop -. "improves agent instructions" .-> to_agents
    from_agents -- "posts finished document" --> html_gate
    html_gate -- "validated" --> monitor_api
    monitor_api -. "decide share vs internal" .-> request_branch
    exposed_html -- "HTML body" --> html_root
    hidden_token -- "internal body" --> pg_db
    monitor_api -- "stores document" --> html_root
    monitor_api -- "document row" --> pg_db
    monitor -- "mark done" --> monitor_api`,
	},
	{
		id: 3,
		slug: "v2-hooks",
		title: "The safety-check pipeline around each tool action",
		description:
			"When a session starts, every tool action passes through pre-execution safety gates; if a gate blocks, the action never runs. Actions that pass are executed, then post-action correctors clean up and lifecycle trackers record what happened into the database. A few advisory checks only warn and never block.",
		mermaid_source: `flowchart LR
    subgraph session_start["Session start"]
        s_orch[session-orchestrator]
    end

    subgraph pre_gate["Before the action runs"]
        safety_gates["Pre-execution safety gates"]
        advisories["Advisory checks (warnings only)"]
    end

    matrix["Rule-consistency check"]
    rule_loading["Rule loading"]
    telemetry["Agent telemetry hook"]

    tool_exec{tool execution}
    block_result[blocked]

    post_correct["Post-action correctors"]
    lifecycle["Lifecycle trackers"]
    eval_grader["Result grader"]
    pg_sink[("Database")]

    s_orch --> safety_gates
    s_orch --> matrix
    s_orch -- "on Agent call" --> telemetry
    matrix --> rule_loading
    rule_loading -. "supplies rules to" .-> safety_gates
    advisories -. "warn only" .-> safety_gates
    safety_gates -- "pass" --> tool_exec
    safety_gates -- "block" --> block_result
    telemetry --> pg_sink
    tool_exec --> post_correct
    post_correct --> lifecycle
    lifecycle --> pg_sink
    lifecycle -- "records outcome" --> eval_grader
    eval_grader -. "reads results" .-> pg_sink`,
	},
	{
		id: 4,
		slug: "v2-loops-learn",
		title: "How the system turns outcomes into lessons",
		description:
			"After each task an agent reports how it went; a collector gathers those signals plus correction and quality flags. An aggregator sorts the patterns into a 'what worked' bucket and a 'what failed' bucket, then a confidence gate decides which lessons are trustworthy enough to act on. The trusted lessons flow into the self-improvement loop (next diagram).",
		mermaid_source: `flowchart LR
    subgraph work["Task execution"]
        agent_work[agent task]
        outcome_block[COMPLETION report]
    end

    subgraph signal["Learning signal collection"]
        signal_collect["Collects learning signals"]
    end

    subgraph aggregate["Learning aggregation"]
        aggregator["Sorts patterns by outcome"]
        ctm["What worked"]
        epm["What failed"]
    end

    subgraph promotion["Confidence gate"]
        flag_gate{"Trustworthy enough to apply?"}
        ladder["Confidence scoring"]
        floor_node["Held back (not trusted yet)"]
    end

    measurement["Usage measurement"]

    to_autoagent[/"→ AutoAgent self-improvement loop<br/>(boundary: cycle input)"/]

    agent_work --> outcome_block
    outcome_block --> signal_collect
    signal_collect --> aggregator
    aggregator --> ctm
    aggregator --> epm

    agent_work --> measurement

    ctm --> flag_gate
    epm --> flag_gate
    flag_gate --> ladder
    flag_gate -. "not trusted yet" .-> floor_node
    ladder -- "trusted lessons" --> to_autoagent
    floor_node -. "held back, retried later" .-> to_autoagent
    measurement -. "evidence" .-> to_autoagent`,
	},
	{
		id: 5,
		slug: "v2-loops-autoagent",
		title: "How agent instructions get auto-improved",
		description:
			"A daily background job takes the trusted lessons, drafts one improvement per agent, and runs it through pre-checks, a cost cap, and a trial run. Safe changes apply automatically; risky ones wait for a person's approval. After a change is applied, the system watches whether results improve and feeds that back into the learning loop. A separate self-monitor keeps the background daemons alive.",
		mermaid_source: `flowchart LR
    from_learn[/"← Learning loop<br/>(boundary: trusted lessons)"/]

    subgraph autoagent["Drafting & checking an improvement"]
        cycle[claude-autoagent-daemon · daily run]
        vet["Pre-checks & trial run"]
        tier_classify{"Safe to auto-apply?"}
    end

    subgraph apply["Applying the change"]
        auto_apply["Apply automatically"]
        safety_queue["Wait for human approval"]
        user_decision["Person approves or rejects"]
        applied["Instruction updated"]
        regression["Watch whether results improve"]
    end

    subgraph defense["Keeping the background daemons alive"]
        autoagent_loop_self["AutoAgent self-health check"]
        wiki_loop_self["Wiki self-health check"]
        autoagent_ka["AutoAgent daemon restarter"]
        wiki_ka["Wiki daemon restarter"]
        autoagent_fc["AutoAgent heartbeat :8787"]
        wiki_fc["Wiki heartbeat :8788"]
    end

    subgraph improvement_view["Dashboard"]
        dashboard["#improvement dashboard"]
    end

    to_learn[/"→ Learning loop<br/>(boundary: outcomes fed back)"/]

    from_learn --> cycle
    cycle --> vet
    vet --> tier_classify
    tier_classify -- "yes" --> auto_apply
    tier_classify -- "no" --> safety_queue
    safety_queue --> user_decision
    auto_apply --> applied
    user_decision -- "approve" --> applied
    applied --> regression
    regression -. "outcomes fed back" .-> to_learn

    applied -. "applied changes" .-> dashboard

    autoagent_loop_self -. "self-probe (tmux + HTTP)" .-> autoagent_fc
    wiki_loop_self -. "self-probe (tmux + HTTP)" .-> wiki_fc
    autoagent_loop_self -. "on failure restart" .-> autoagent_ka
    wiki_loop_self -. "on failure restart" .-> wiki_ka
    autoagent_ka -- "restart whole daemon" --> autoagent_loop_self
    wiki_ka -- "restart whole daemon" --> wiki_loop_self
    autoagent_fc -. "heartbeat source" .-> cycle`,
	},
	{
		id: 6,
		slug: "v2-team-orchestration",
		title: "How the orchestrator runs and checks a build team",
		description:
			"The orchestrator plans the work, runs a series of safety probes, then assigns it to a coding team. For complex plans a direction-check team (a reviewer plus a developer) confirms the plan is feasible before any code is written. Code is reviewed before merge, and repeated failures escalate to a debugger; the document team is shown in the next diagram.",
		mermaid_source: `flowchart LR
    subgraph orchestrator["Orchestrator (main session)"]
        continuity_hook["Session start: reload open progress"]
        invest[Investigation]
        decision[Decision]
        delegate[Delegation + CID]
        monitor[Monitoring]
        continuity_hook --> invest
    end

    probes["Pre-delegation safety probes"]

    subgraph code_team["Coding team"]
        planner_c["glass-atrium-intel-planner (writes the plan)"]
        stage2_gate{"Plan feasible? (complex plans)"}
        cr_verdict["glass-atrium-qa-code-reviewer (plan check)"]
        dev_verdict["developer (plan check)"]
        dev_wave["DEV agents (write the code)"]
        reviewer["glass-atrium-qa-code-reviewer (reviews the code)"]
        glass-atrium-qa-debugger["glass-atrium-qa-debugger (handles repeat failures)"]
    end

    subgraph code_out["Coding team output"]
        git_pr[(Git PR merge)]
    end

    to_doc[document team → documents · storage graph]
    from_doc[← POST output · documents · storage graph]

    invest --> decision
    decision --> probes
    probes -- "all pass" --> delegate
    probes -. "any fails → halt + fix" .-> decision
    delegate --> to_doc
    delegate --> code_team

    %% [CONTINUITY] turn-0 parse — document team reached via boundary node
    continuity_hook -. "reads progress files at session start" .-> to_doc

    %% anti-slop skill binding
    reviewer -. "self-checks against anti-slop skill" .-> reviewer

    planner_c -- "complex plan" --> stage2_gate
    stage2_gate -- "both must approve" --> cr_verdict
    stage2_gate -- "both must approve" --> dev_verdict
    cr_verdict -- "approved → build" --> dev_wave
    dev_verdict -- "approved → build" --> dev_wave
    cr_verdict -. "needs changes → replan" .-> planner_c
    dev_verdict -. "not feasible → replan" .-> planner_c
    dev_wave -- "code" --> reviewer
    reviewer -- "approve" --> git_pr
    dev_wave -. "2nd failure" .-> glass-atrium-qa-debugger
    glass-atrium-qa-debugger -- "fix complete" --> reviewer

    from_doc --> monitor
    git_pr --> monitor
    monitor -- "blocked/fail" --> delegate`,
	},
	{
		id: 7,
		slug: "v2-team-docs",
		title: "How the document team produces and stores a document",
		description:
			"Research, planning, domain, and reporting agents work in sequence to produce a document, which is always saved through the document API into a single store (never written to disk directly). If the document needs strong visual quality, a designer joins to advise. Once posted, control returns to the orchestrator's monitoring step.",
		mermaid_source: `flowchart LR
    from_orch[← delegation · orchestration graph]
    to_monitor[Monitoring verification → orchestration graph]

    subgraph doc_team["Document team"]
        glass-atrium-intel-researcher["glass-atrium-intel-researcher (gathers sources)"]
        planner_d["glass-atrium-intel-planner (plans the doc)"]
        glass-atrium-design-designer["glass-atrium-design-designer (advises on visuals)"]
        domain["domain agents (fill in content)"]
        glass-atrium-intel-reporter["glass-atrium-intel-reporter (writes the doc)"]
    end

    subgraph clauded_routes["Document API"]
        post_api[/"Save document (POST)"/]
        put_api[/"Update document (PUT)"/]
        delete_api[/"Delete document (DELETE)"/]
        manage_api["Document management API"]
    end

    subgraph storage_html["Document store"]
        html_root[/"Saved documents (the single store)"/]
        docs_row[(Document database row)]
    end

    subgraph legacy_store["Old copies (read-only)"]
        md_root[/"Old document copies (read-only)"/]
    end

    from_orch --> glass-atrium-intel-researcher
    from_orch -. "reads progress files at session start" .-> glass-atrium-intel-researcher
    from_orch -. "reads progress files at session start" .-> planner_d
    from_orch -. "reads progress files at session start" .-> glass-atrium-intel-reporter

    glass-atrium-intel-researcher -- "research results" --> planner_d
    planner_d -- "plan document" --> domain
    domain -- "domain content" --> glass-atrium-intel-reporter
    glass-atrium-intel-reporter -- "save" --> post_api
    planner_d -- "save" --> post_api
    planner_d -. "if visually heavy" .-> glass-atrium-design-designer
    glass-atrium-design-designer -. "advice" .-> planner_d
    glass-atrium-design-designer -. "advice" .-> glass-atrium-intel-reporter

    post_api -- "stores file" --> html_root
    post_api -- "adds row" --> docs_row
    put_api -- "marks done/in-progress" --> docs_row
    delete_api -- "removes file" --> html_root
    delete_api -- "removes row" --> docs_row
    delete_api -. "old copies only" .-> md_root

    post_api --> to_monitor`,
	},
] as const satisfies readonly DiagramSource[];

// 컴파일 타임 카운트 검증 — parser.ts 가 의존하는 7 다이어그램 불변식 (v2-team 2분할).
type _AssertDiagramCount = (typeof DIAGRAMS)["length"] extends 7 ? true : never;
const _diagramCount: _AssertDiagramCount = true;
// 사용처 없음 → tsc unused-local 차단을 위한 void 참조.
void _diagramCount;

// 데몬 → mermaid 노드 id 명시 바인딩 — live overlay 노드 ring 점등의 유일 근거.
// 노드 id 는 위 DIAGRAMS mermaid_source 에 실재해야 함 (architecture.daemon-binding 테스트가 검증).
// daily-restart 2종은 전용 노드 부재 → launchd 작업 묶음 노드(cron)에 바인딩.
export const DAEMON_NODE_BINDINGS: Readonly<Record<string, readonly string[]>> = {
	autoagent: ["autoagent_d", "autoagent_loop_self", "autoagent_ka", "autoagent_fc"],
	wiki: ["wiki_d", "wiki_loop_self", "wiki_ka", "wiki_fc"],
	"daily-restart-autoagent": ["cron"],
	"daily-restart-wiki": ["cron"],
};

// 헬스 부품(health-model.js HEALTH_CARD_DEFS) → canonical drawn 노드 id (ADR-11).
// 링과 표가 같은 명부를 읽게 하는 자리 — 부품 일곱 전원이 그려지는 노드를 가져야 하고
// 빈 목록은 실패임 (ADR-14: 지배값은 예산이 아니라 부품 커버리지임).
// DAEMON_NODE_BINDINGS 와 겹치는 데몬 넷은 그 표의 drawn 투영임 — 나머지 여섯 다이어그램에만 있는
// 노드(`*_loop_self` · `*_ka` · `*_fc`)는 그려지지 않으므로 여기 실리지 않음 (ADR-19).
export const PART_NODE_BINDINGS: Readonly<Record<string, readonly string[]>> = {
	pg: ["pg_db"],
	browser: ["doc_export"],
	"daemon-cycle": ["autoagent_d"],
	"glass-atrium-wiki-curator": ["wiki_d"],
	"daily-restart-autoagent": ["cron"],
	"daily-restart-wiki": ["cron"],
	"hook-chain": ["hook_pipeline"],
};

// 그려지는 노드 → 상세 패널이 읽는 서술 (ADR-20). 스키마의 FlowNode.description 은 처음부터
// 클릭 상세용으로 선언돼 있었으나(types/architecture.ts) 채우는 자리가 없어 아홉 노드 전부 비어
// 있었음 — 표를 걷어내며 상세가 유일한 표면이 되므로 여기서 채움.
// 키는 unscoped mermaid id 임: 같은 id 를 쓰는 source 여섯 편의 노드에도 같은 서술이 붙는데,
// 그쪽은 그려지지 않는 문서이고 id 가 같으면 같은 부품이라 어긋나지 않음.
// 내용 규칙 — 라벨을 고쳐 쓰지 않음(패널이 라벨을 이미 이름으로 냄). 그린 엣지와 canonical
// 서술이 말하는 것만 적음: 여기 없는 사실을 적으면 지도가 아니라 이 표가 출처가 됨.
export const NODE_DESCRIPTIONS: Readonly<Record<string, string>> = {
	user: "Where a run starts when a person types. The utterance goes to the orchestrator, which decides what work it implies.",
	autoagent_d:
		"Scheduled job that reads the recorded outcomes and proposes instruction improvements. It wakes the orchestrator rather than editing anything itself.",
	wiki_d:
		"Scheduled job that compiles and indexes the wiki store, then wakes the orchestrator with what it found.",
	cron: "The schedule itself — the background jobs that start the daemons and restart them daily.",
	main_session:
		"The orchestrator. It plans the work and assigns it; carrying the work out is the specialist agents' job, not its own.",
	agent_layer:
		"The specialist agents the orchestrator assigns work to. Their tool calls are what the hook pipeline sees.",
	hook_pipeline:
		"Every tool call an agent makes passes through here first — the safety checks that can stop a call, and the tracking that records what happened.",
	pg_db:
		"The PostgreSQL database. Agent documents and hook records both land here, and it is the single store the export path reads from.",
	doc_export: "Renders the stored documents for export through a headless Chromium.",
};

// 본 모듈의 자기 식별자 — parser.ts 가 doc_path 응답 필드에 사용.
// import.meta.url 런타임 파생 → 설치 사용자 환경 절대경로 (개발자 식별자 비포함).
export const DIAGRAMS_SOURCE_PATH: string = fileURLToPath(import.meta.url);

export type DiagramSlug = (typeof DIAGRAMS)[number]["slug"];

// 화면에 실제로 그려지는 단일 canonical 맵. 예산(content-budget)은 이 drawn 문자열에만 걸리고 source 7편은 무수정으로 남음
// — daemon-binding · flow-extractor parity · verify-arch Stage-2 · 7-카운트 불변식이 계속 source 를 대상으로 함.
// 편집 규칙: 라벨/산문 수정은 언제나 mermaid_source 에 적용하고 drawn 은 감축을 다시 적용해 재생성함.
export interface CanonicalMap {
	slug: DiagramSlug;
	mermaid_drawn: string;
	detail: DetailGrade;
	// drawn 이 그리는 흐름을 말하는 자기 서술 (ADR-9). source 서술은 source 를 말해야 하므로 둘은 갈라짐 —
	// drawn 에 없는 `repo` 를 source 서술이 부르기 때문. 미설정이면 파서가 source 서술로 되돌아감.
	description?: string;
	// 그려지는 것을 말하는 제목 (ADR-16). SVG 의 aria-label 과 내장 <title> 이 이 문자열을 실으므로
	// source 제목이 남으면 스크린리더가 그리지 않는 그림을 먼저 읽음. 미설정이면 서술과 같은 자리에서 source 제목으로 되돌아감.
	title?: string;
	// drawn 에서 빠진 source 노드 id. 각 항목의 실재/부재는 예산 테스트가 검사하나 목록의 완전성은 기계가 보지 못함.
	omitted_node_ids: readonly string[];
}

export const CANONICAL_MAP: CanonicalMap = {
	slug: "v2-overview-entry",
	// `faithful` 재배정 (ADR-15) — 확정 흐름은 `balanced`(9/6) 아래에서 엣지 7/6 으로 fail 임.
	// 상한 행의 값은 건드리지 않고 이미 선언된 행으로 옮김 — 계기를 그림에 맞춰 고치는 것과 다른 행위임.
	// 정직하게: `faithful` 은 오늘까지 한 번도 집행된 적 없는 행이라 검증된 행이 아니라 처음 켜지는 행임.
	// 밴드가 느슨해진 만큼(9/14)은 예산이 아니라 회귀 잠금 ①②③ 과 커버리지 단언이 메움.
	detail: "faithful",
	// 그려지는 것을 말하는 제목 (ADR-16) — 그림이 배정에서 끝나지 않고 저장·내보내기까지 감.
	title: "How a command is carried out",
	// 그려지는 것을 말하는 서술 (ADR-9) — 흐름의 일곱 마디를 모두 이름으로 부르고 `repo` 는 부르지 않음.
	description:
		"A user utterance or a scheduled background job wakes the orchestrator; the orchestrator plans the work and assigns it to the specialist agents; every tool call the agents make passes through the hook pipeline's safety checks and tracking, and the resulting records are saved to the PostgreSQL database, from which finished documents are rendered for export by a headless Chromium.",
	/**
	 * 감축본 — 렌더 제약(폭·content-budget 계수기)을 통과하도록 손본 형태.
	 * 지도가 아니라 명령이 수행되는 흐름임 (ADR-6): 발화·예약 작업 → 오케스트레이터 → 에이전트 → 훅 →
	 * PostgreSQL → 문서 내보내기. 마지막 마디는 장식이 아니라 `/api/health` 의 `browser` 판정이 실제로 재는
	 * 대상임 — clauded-docs 내보내기용 공유 chromium 의 기동 결과이고, 저장된 것을 사람이 가져갈 형태로
	 * 만드는 것이 명령이 끝나는 자리임 (ADR-14: 지배값은 예산이 아니라 부품 커버리지임).
	 * 감축: 경계 노드 2종과 그 엣지 제거 — 나머지 여섯 편이 그려지지 않아 도착지 없는 표식임.
	 * source 의 문서 마디는 경계 노드(`to_html_gate`)로 나가나 drawn 은 그 경계를 지우므로 목적지를
	 * 데이터 존으로 당김 — 39546 ADR-7 이 `to_data` 에 대해 한 것과 같은 흡수임.
	 * `repo` 는 흐름에 마디가 없어 빠짐 (ADR-8) — source 에는 그대로 남고 원장에 오름.
	 * 자리가 없어서가 아님: `faithful` 아래에서 되돌려도 10노드·8엣지로 여전히 pass 임 (ADR-15 §8).
	 * 라벨 여유: `hook_pipeline` 의 `Hook pipeline (safety checks + tracking)` 이 최장 라벨로 정확히 40자이고
	 * faithful 라벨 상한은 50 임 — 40/50 = 0.8 로 pass 이며 warn(0.9)까지 다섯 글자 남음.
	 * 노드 9/14 · 엣지 7/18 도 같은 방향으로 느슨함 — 그래서 볼륨을 지키는 것은 밴드가 아니라
	 * `architecture.budget.test.ts` 의 회귀 잠금 ①(실측값 정확 고정)②(상한 두 행 고정)③(drawn ⊆ source)임.
	 * 이 주석을 mermaid 문자열 안으로 옮기지 말 것 — drawn 은 계수 대상이라 주석이 콘텐츠로 세어짐.
	 * 방향 LR — source 일곱 편과 같은 방향임. drawn 만 다른 방향을 쓰면 계수는 같아도(AC-10) 사람이 읽는 형태가 갈라짐.
	 * 캔버스는 초기 배율을 `max(min(contain, 1), 0.6)` 으로 깔아 하한 0.6 아래로 내려가지 않고 넘치는 만큼을 자름
	 * (architecture.jsx getLegibleFitScaleAR) — 그래서 잘림은 방향이 아니라 pane 대비 그래프 변의 길이가 정함.
	 * 라벨·존 제목·엣지 라벨 열다섯 자리의 `<br/>` 은 폭을 높이로 옮기는 장치임.
	 * 글자는 한 자도 빠지지 않음: `<br/>` 을 이미 있는 공백 옆에 넣었고 계수기가 태그를 지우므로
	 * (content-budget getLabelText) 라벨 40 자가 그대로 남고, 화면의 라벨→node id 각인도 textContent 를 읽어 맞음.
	 * 감축은 drawn 에만 넣음 — source 일곱 편은 그려지지 않는 문서인데 flow-extractor 테스트가 그 존 제목
	 * 문자열을 정확히 대조하므로, 같은 `<br/>` 을 source 에 넣으면 그리는 것은 그대로인 채 그 대조만 깨짐.
	 * 그래프 변 (mermaid 11.15.0 + ELK + public/mermaid-config.js, SVG 사용자 단위): LR 1774.6×471.
	 * 남은 폭의 3분의 1은 존이 아니라 엣지 라벨이 벌린 랭크 사이 간격임 — 더 줄이려면 세 줄짜리 엣지 라벨이
	 * 되는데 그렇게 얻는 값이 45 단위뿐이라(실측) 여기서 멈춤.
	 * pane 폭 = 뷰포트 폭 - 290px · 높이 ≈ 뷰포트의 0.68 배 (실측 1396×800→1106×540 · 1512×850→1222×575 ·
	 * 1920×1080→1630×736) — 지도가 pane 을 다 쓰는 배분임 (ADR-20).
	 * 세 폭 모두 폭이 먼저 걸리고 높이는 남으므로, 배율을 정하는 것은 폭 하나임.
	 * 실측 배율(라벨 렌더 크기): 1396 폭 0.6314(8.84px) · 1512 폭 0.6977(9.77px) · 1920 폭 0.9306(13.03px) — 셋 다 안 잘림.
	 * 안 잘리는 최소 뷰포트는 약 1331px (1340 은 8.7px 남고 1320 은 11.3px 넘침).
	 * 그 아래에서는 다시 하한 0.6 에 걸려 잘림. 방향을 되돌리거나 노드·라벨을 늘리면 같은 방법으로 다시 잴 것 —
	 * 계기는 test/architecture.map-fit.e2e 이고, 그 세 뷰포트에서 잘림을 배율이 아니라 상자 위치로 직접 잼.
	 * 레이아웃·테마는 public/mermaid-config.js 가 전역으로 준다 — 여기에 `%%{init}%%` 지시자를 두면 그 설정의 사본이 된다.
	 * 같은 설정을 YAML frontmatter 로 실으면 `---` 두 줄이 엣지로 세어져 계수가 정확히 2 늘어남
	 * (`faithful` 아래에서는 그래도 상한 안이므로 계기는 상한 위반이 아니라 그 증분을 잼).
	 * 소스에는 역할 색만 남음 — classDef 배정은 어느 노드가 초점인지를 말하는 콘텐츠라 설정이 대신할 수 없음.
	 */
	mermaid_drawn: `flowchart LR
    subgraph entry["External inputs"]
        user[User utterance]
    end

    subgraph daemon["Scheduled background jobs <br/>(daemons)"]
        autoagent_d["Self-improvement <br/>daemon"]
        wiki_d[Wiki daemon]
        cron["Scheduled <br/>background jobs"]
    end

    subgraph orch["Orchestrator <br/>(main session)"]
        main_session["Plans the work, <br/>then assigns it"]
    end

    subgraph agents["Specialist agents"]
        agent_layer["Specialist agents <br/>(23)"]
    end

    subgraph hooks["Safety checks <br/>& tracking"]
        hook_pipeline["Hook pipeline <br/>(safety checks + tracking)"]
    end

    subgraph data["Data layer <br/>(PostgreSQL <br/>glass_atrium DB)"]
        pg_db[("PostgreSQL database")]
    end

    subgraph export["Document export"]
        doc_export["Document export <br/>(headless Chromium)"]
    end

    user --> orch
    daemon --> orch
    orch -- "assigns <br/>work" --> agents
    agents -- "tool <br/>calls" --> hooks
    agents -- "saves <br/>documents" --> data
    hooks -- "saves <br/>results" --> data
    data -- "renders stored <br/>content" --> export

    classDef focal fill:#383c43,stroke:#60a5fa,stroke-width:2px,color:#fafaf9
    classDef external fill:#332e2a,stroke:#544c47,color:#a09a96
    classDef security fill:#332e2a,stroke:#fbbf2480,stroke-width:2px,stroke-dasharray:4 4,color:#fafaf9
    class main_session focal
    class user external
    class hook_pipeline security`,
	omitted_node_ids: ["repo", "from_improvement", "to_html_gate"],
};
