// 클로드 시스템 설계도 SoT — 7 v2 mermaid 다이어그램 source + description.
// TS 모듈 채택 이유(rejected: 옵시디언 md 의존) — md 의존 제거로 fs.stat ENOENT 회귀 차단 · Node loader 의 import 영구 캐시로 mtime 폴링 불요 · as const 로 7 카운트를 컴파일 타임 검증.
// 편집 후 반영: npm run build → launchctl kickstart 재기동.

import { fileURLToPath } from "node:url";

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
			"Three kinds of input — a code repository, a user's message, or a scheduled background job — wake the main orchestrator, which runs its four-step routine and hands the work to the right specialist agents. Agent tool calls pass through safety checks before any result is saved. Saved results flow onward into the data layer (the second overview diagram).",
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

    to_data[/"→ Data · documents · improvement layer<br/>(boundary: saved results)"/]
    from_improvement[/"← Data · documents · improvement layer<br/>(boundary: instruction updates)"/]
    to_html_gate[/"→ Data · documents · improvement layer<br/>(boundary: document POST)"/]

    repo --> orch
    user --> orch
    daemon --> orch
    orch -- "assigns work" --> agents
    agents -- "tool calls" --> hooks
    agents -- "saves documents" --> to_html_gate
    hooks -- "saves results" --> to_data
    from_improvement -- "instruction updates" --> agents
    autoagent_d --> daemon
    wiki_d --> daemon`,
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
        advisories["Budget advisories (warnings only)"]
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
        planner_c["intel-planner (writes the plan)"]
        stage2_gate{"Plan feasible? (complex plans)"}
        cr_verdict["qa-code-reviewer (plan check)"]
        dev_verdict["developer (plan check)"]
        dev_wave["DEV agents (write the code)"]
        reviewer["qa-code-reviewer (reviews the code)"]
        qa-debugger["qa-debugger (handles repeat failures)"]
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
    dev_wave -. "2nd failure" .-> qa-debugger
    qa-debugger -- "fix complete" --> reviewer

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
        intel-researcher["intel-researcher (gathers sources)"]
        planner_d["intel-planner (plans the doc)"]
        design-designer["design-designer (advises on visuals)"]
        domain["domain agents (fill in content)"]
        intel-reporter["intel-reporter (writes the doc)"]
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

    from_orch --> intel-researcher
    from_orch -. "reads progress files at session start" .-> intel-researcher
    from_orch -. "reads progress files at session start" .-> planner_d
    from_orch -. "reads progress files at session start" .-> intel-reporter

    intel-researcher -- "research results" --> planner_d
    planner_d -- "plan document" --> domain
    domain -- "domain content" --> intel-reporter
    intel-reporter -- "save" --> post_api
    planner_d -- "save" --> post_api
    planner_d -. "if visually heavy" .-> design-designer
    design-designer -. "advice" .-> planner_d
    design-designer -. "advice" .-> intel-reporter

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

// 본 모듈의 자기 식별자 — parser.ts 가 doc_path 응답 필드에 사용.
// import.meta.url 런타임 파생 → 설치 사용자 환경 절대경로 (개발자 식별자 비포함).
export const DIAGRAMS_SOURCE_PATH: string = fileURLToPath(import.meta.url);
