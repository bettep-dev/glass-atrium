// Screen 12 — Models & budgets (/api/model-config single GET fetch + explicit Save PUT).
// Layout: header sync token → model ledger | per-call budget cap ledger (side by side at xl).
// DB (saved target) = UI SoT · actual = measured at the consumption point — a gap shows as a drift warning glyph + word.
// Budget = per-call HARD CAP (claude -p --max-budget-usd), not a monthly billing cap under the OAuth subscription → stops a single runaway call.
// Hooks MC-suffix aliased → no window-scope collision.
const {
	useState: useStateMC,
	useEffect: useEffectMC,
	useRef: useRefMC,
	useMemo: useMemoMC,
	useCallback: useCallbackMC,
} = React;

// 성공 토스트 표시 시간 — S9 계약(2s top-right). clauded-docs TOAST_DURATION 와 동일 의도.
const TOAST_DURATION_MS_MC = 2000;

// 검증 상수 — 서버 SoT(routes/model-config.ts consts 모듈) 의 클라이언트 미러. 변경 시 동기화 필수.
// known-model 목록은 상수 미러가 아니라 GET known_models(서버가 pricing.json SoT 에서 파생)를
// 그대로 소비 — 하드코딩 미러 + bare alias(opus/sonnet/haiku) 옵션 제거 (P7).
// free-text escape hatch — 소문자 alnum 선두 + alnum/dot/hyphen/bracket ≤128 (PUT 검증 계약).
const FREE_TEXT_MODEL_RE_MC = /^[a-z0-9][a-z0-9.\-[\]]{0,127}$/;
// per-call 예산 = 정확히 2-decimal 문자열 — daemon_config.py 가 --max-budget-usd 로 verbatim 전달,
// JSON number 0.5 는 trailing-zero 가 사라져 CLI 캡을 깨뜨림 (서버 BUDGET_VALUE_PATTERN 미러).
const BUDGET_RE_MC = /^\d+\.\d{2}$/;
const BUDGET_MIN_USD_MC = 0.05;
const BUDGET_MAX_USD_MC = 50.0;
// 배포 기본 per-call 상한 미러 — 서버 BUDGET_SEED_DEFAULT_USD (DB seed 행 + daemon_config.py
// _FALLBACK 과 동일 값). 필드를 한 번도 건드리지 않은 운영자가 실제로 돌리고 있는 값이라
// 빈 입력의 placeholder 는 이 값을 광고해야 한다.
const BUDGET_SEED_DEFAULT_MC = "10.00";
// Tier-knob mirrors of the server SoT (model-config-consts EFFORT_LEVELS / OUTPUT_CAP_PATTERN) — keep in sync.
const EFFORT_LEVELS_MC = ["low", "medium", "high", "xhigh", "max"];
const OUTPUT_CAP_RE_MC = /^[1-9][0-9]{0,5}$/;
// What an unset knob ('inherit' → key removed) runs at: no --effort flag / no output-cap env.
const CLI_DEFAULT_LABEL_MC = "CLI default";
const EFFORT_FLAG_MC = "--effort";
const OUTPUT_CAP_ENV_MC = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";

const CUSTOM_OPTION_MC = "__custom__";

// 모델별 1줄 역량 설명 — radio-card 옵션 보조 라벨 (T-MDL-3). GET 응답에 없는 표시 파생값이라 UI 상수.
const MODEL_CAP_MC = {
	"claude-opus-5-5": "Latest Opus — agentic coding, long-horizon work",
	"claude-opus-5": "Prior Opus — agentic coding, superseded by 5.5",
	"claude-fable-5-2": "Latest Fable — highest capability, deep reasoning, long-horizon agents",
	"claude-fable-5-1": "Prior Fable — deep reasoning, superseded by 5.2",
	"claude-fable-5": "Prior Fable — deep reasoning, superseded by 5.1",
	"claude-opus-4-8": "Strong default — implementation, review, design",
	"claude-sonnet-5-5": "Latest Sonnet — balanced speed/cost",
	"claude-sonnet-5": "Prior Sonnet — balanced speed/cost, superseded by 5.5",
	"claude-sonnet-4-6": "Balanced — fast turnaround on mid-complexity work",
	"claude-haiku-4-5": "Fastest / cheapest — simple, repetitive file ops",
};
// 도메인 표시 메타 — 라벨/전문 설명
// (GET 응답에 없는 파생 표시값이라 UI 상수로 유지).
const DOMAIN_META_MC = {
	"model.daemon_cycle_worker": {
		label: "Self-improve and wiki compile",
		desc: "Drafts self-improve proposals, runs pre-verify and summarizes wiki notes",
		source: "daemon-config.json",
		editable: true,
	},
};

// 테이블 행 순서 — 미지의 도메인(서버가 먼저 확장된 경우)은 뒤에 그대로 덧붙임 (silent drop 금지).
const DOMAIN_ORDER_MC = ["model.daemon_cycle_worker"];

// Take-effect timing — GET apply_mode → "Applies <when>" header meta; desc = the caveat the drawer carries.
const APPLY_MODE_META_MC = {
	"next-spawn": {
		when: "at next spawn",
		desc: "Saved now — a running agent keeps its current model until it next spawns",
	},
	"next-cycle": {
		when: "at next cycle",
		desc: "Saved now — the daemon picks it up on its next cycle",
	},
	"tmux-restart": {
		when: "after tmux restart",
		desc: "Saved now — the tmux session must restart before it is used",
	},
	immediate: {
		when: "immediately",
		desc: "In force as soon as the save lands",
	},
};

const SYNC_META_MC = {
	drift: {
		label: "Drift",
		tone: "warn",
		desc: "daemon-config.json differs from the saved settings — press Save again to retry the write",
	},
	"file-missing": {
		label: "File missing",
		tone: "warn",
		desc: "daemon-config.json was not found — press Save to recreate it",
	},
	// 마이그레이션 미적용 DB — 이름이 바뀐 도메인의 값을 구 키 행에서 읽어온 상태.
	// 파일과 값이 우연히 맞아도 in sync 로 표시하지 않는다 (없는 행 위의 공허한 green 금지).
	"pending-migration": {
		label: "Pending migration",
		tone: "warn",
		desc: "these values are being read from the pre-rename config rows — run `glass-atrium db-setup` to complete the rename",
	},
	"file-invalid": {
		label: "Rejected value",
		tone: "warn",
		desc: "daemon-config.json holds a call-tier value the daemon rejects — every daemon cycle stops until Save rewrites it",
	},
};

// 예산 도메인 표시 메타 — 라벨/전문 설명. key = GET budgets[].domain (BudgetDomainKey).
// 미지의 key(서버 먼저 확장)는 fallback 메타로 그대로 렌더 (silent drop 금지).
const BUDGET_META_MC = {
	"budget.worker_max_usd": {
		label: "Generation and wiki compile",
		desc: "One cap for both calls",
		source: "daemon-config.json",
	},
	"budget.pre_verify_max_usd": {
		label: "Pre-verify",
		desc: "Read by the pre-verify step only",
		source: "daemon-config.json",
	},
};

// Tier-knob display meta — key = GET tiers[].domain; kind picks the control and the client check.
// Labels name the self-improve calls only: wiki compile reads neither knob.
const TIER_META_MC = {
	"tier.worker_effort": {
		label: "Generation effort",
		desc: `Default: no ${EFFORT_FLAG_MC} flag`,
		machine: EFFORT_FLAG_MC,
		note: "With no flag, the settings or model default governs the call",
		kind: "effort",
		source: "daemon-config.json",
	},
	"tier.pre_verify_effort": {
		label: "Pre-verify effort",
		desc: `Default: no ${EFFORT_FLAG_MC} flag`,
		machine: EFFORT_FLAG_MC,
		note: "Keep pre-verify at or above the generation level",
		kind: "effort",
		source: "daemon-config.json",
	},
	"tier.worker_max_output_tokens": {
		label: "Generation output tokens",
		desc: `Sets ${OUTPUT_CAP_ENV_MC}`,
		machine: OUTPUT_CAP_ENV_MC,
		note: "The CLI silently lowers a value above the model's own limit",
		kind: "output-cap",
		source: "daemon-config.json",
	},
	"tier.pre_verify_max_output_tokens": {
		label: "Pre-verify output tokens",
		desc: `Sets ${OUTPUT_CAP_ENV_MC} for pre-verify`,
		machine: OUTPUT_CAP_ENV_MC,
		note: `Blank = ${CLI_DEFAULT_LABEL_MC}`,
		kind: "output-cap",
		source: "daemon-config.json",
	},
};

// One daemon row: control cell 3.5 + 32 control + 4 + the 24 line slot + 3.5, plus the 1 rule → skeleton rows hold it until the read lands.
const LEDGER_ROW_HEIGHT_MC = 68;
// PUT validation answers name the rejected field — kept longer than a GET error body for Details.
const SAVE_ERROR_BODY_MAX_MC = 300;

// 테이블 행 순서 — 미지의 도메인은 뒤에 그대로 덧붙임.
const BUDGET_ORDER_MC = ["budget.worker_max_usd", "budget.pre_verify_max_usd"];

// Ledger anchors — a failed read's Retry hands focus to the model ledger.
const MODELS_SECTION_ID_MC = "mc-models";

// PUT group → the GET rows carrying its saved targets; one list drives every form helper.
const FORM_GROUP_ROWS_MC = { models: "domains", budgets: "budgets", tiers: "tiers" };
const FORM_GROUPS_MC = Object.keys(FORM_GROUP_ROWS_MC);

function ScreenModelConfig() {
	const {
		PageHeader,
		TypeScaleStyle,
		FreshnessStamp,
		RefreshButton,
		RegionUnavailable,
		INITIAL_REGION_STATE,
		putRegionRequest,
		putRegionData,
		putRegionFailure,
		SplitRow,
		SplitColumn,
		formatKstTime,
		TONE_GLYPH,
	} = window.UI;

	const [configState, setConfigState] = useStateMC(INITIAL_REGION_STATE);
	// form = edit buffer { models, budgets, tiers }, each keyed by GET domain → mirrors GET desired.
	const [form, setForm] = useStateMC(null);
	const [saving, setSaving] = useStateMC(false);
	const [saveError, setSaveError] = useStateMC(null);
	const [surfaceProblem, setSurfaceProblem] = useStateMC(null);
	const [refreshTick, setRefreshTick] = useStateMC(0);
	const [asOfAt, setAsOfAt] = useStateMC(null);
	const [toast, setToast] = useStateMC(null); // { tone, message }
	// discardConfirm = Discard 확인 다이얼로그 게이트 (T-MDL-5, destructive=편집분 소실).
	const [discardConfirm, setDiscardConfirm] = useStateMC(false);

	const abortRef = useRefMC(null);
	// committed read the form buffer was edited against → a landing refresh can tell edits from stale values
	const configDataRef = useRefMC(null);
	const toastTimerRef = useRefMC(null);

	const showToast = useCallbackMC((tone, message) => {
		setToast({ tone, message });
		if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		toastTimerRef.current = setTimeout(
			() => setToast(null),
			TOAST_DURATION_MS_MC,
		);
	}, []);

	useEffectMC(() => {
		const ctrl = new AbortController();
		abortRef.current?.abort();
		abortRef.current = ctrl;

		setConfigState((s) => putRegionRequest(s, "config", ctrl));
		setSaveError(null);
		fetchJsonMC("/api/model-config", ctrl.signal)
			.then((data) => {
				if (ctrl.signal.aborted) return;
				const prevData = configDataRef.current;
				setConfigState((s) => putRegionData(s, ctrl, data));
				setForm((f) => getRefreshedFormMC(f, prevData, data));
				setAsOfAt(Date.now());
			})
			.catch((err) => setConfigState((s) => putRegionFailure(s, ctrl, err)));

		return () => ctrl.abort();
	}, [refreshTick]);

	useEffectMC(() => {
		configDataRef.current = configState.data;
	}, [configState.data]);

	const baseline = useMemoMC(
		() =>
			configState.status === "ready" && configState.data
				? buildFormMC(configState.data)
				: null,
		[configState],
	);

	// GET known_models = 드롭다운/검증 옵션 SoT — 서버가 pricing.json 에서 파생 (P7).
	// SoT unreadable fail-open 시 [] (D3) — 옵션은 custom 만 남고 free-text 로 입력 가능.
	const knownModels = useMemoMC(
		() => configState.data?.known_models ?? [],
		[configState],
	);

	const errors = useMemoMC(
		() => (form ? validateFormMC(form, knownModels) : {}),
		[form, knownModels],
	);
	const payload = baseline && form ? diffFormMC(baseline, form) : null;
	const hasErrors = Object.keys(errors).length > 0;
	const changeCount = countChangesMC(payload);
	// dirty = 저장할 변경분 존재 — save-banner 노출 + beforeunload 경고 게이트.
	const isDirty = payload !== null;

	// 미저장 변경 보호 — dirty 상태에서 탭/창 이탈 시 브라우저 기본 확인 다이얼로그.
	useEffectMC(() => {
		if (!isDirty) return undefined;
		const warn = (e) => {
			e.preventDefault();
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [isDirty]);

	// 언마운트 시 토스트 타이머 해제 — leaked timer 방지.
	useEffectMC(
		() => () => {
			if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		},
		[],
	);

	const setModel = (domain, value) => {
		setForm((f) =>
			f ? { ...f, models: { ...f.models, [domain]: value } } : f,
		);
	};
	const setBudget = (key, value) => {
		setForm((f) => (f ? { ...f, budgets: { ...f.budgets, [key]: value } } : f));
	};
	const setTier = (key, value) => {
		setForm((f) => (f ? { ...f, tiers: { ...f.tiers, [key]: value } } : f));
	};
	// One transport for both Save controls — the sticky bar sends the edit diff, the drift banner
	// sends the saved targets of the rows that drifted.
	const submit = async (body) => {
		if (!body || hasErrors || saving) return;
		setSaving(true);
		setSaveError(null);
		setSurfaceProblem(null);
		// the PUT answer supersedes an in-flight read → that read must not land over it
		abortRef.current?.abort();
		try {
			// PUT 응답 = GET shape + per-surface 결과 → 응답으로 화면/버퍼 재초기화 (재fetch 불요).
			const data = await putJsonMC("/api/model-config", body);
			setConfigState((s) => putRegionData(putRegionRequest(s, "save", body), body, data));
			setForm(buildFormMC(data));
			setAsOfAt(Date.now());
			const problem = getSurfaceProblemMC(data);
			setSurfaceProblem(problem);
			// Only a clean save ends in a toast — a failed or skipped write gets the card instead.
			if (!problem) showToast("ok", "Changes saved");
		} catch (err) {
			setSaveError(err && err.message ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};
	const save = () => submit(payload);

	// Discard — 편집 버퍼를 저장된 baseline 로 되돌림 (네트워크 호출 없음). confirm 게이트 통과 후 실행.
	const discard = () => {
		if (!isDirty || saving) return;
		setForm(
			baseline
				? Object.fromEntries(FORM_GROUPS_MC.map((group) => [group, { ...baseline[group] }]))
				: form,
		);
		setSaveError(null);
		setDiscardConfirm(false);
	};

	const triggerRefresh = () => setRefreshTick((t) => t + 1);
	// an agent apply answers with the fresh agent list only → the daemon form buffer is never rebuilt by it
	const putAgentsRead = useCallbackMC(
		(read) => setConfigState((s) => (s.data ? { ...s, data: { ...s.data, agents: read.agents, unreadable: read.unreadable } } : s)),
		[],
	);

	const ready = configState.status === "ready" && form !== null;
	const data = configState.data;
	// Banner trigger = any row drift, not the file-sync state alone — the banner carries the remedy the rows no longer do.
	const showDrift =
		ready && (data.daemon_config_sync !== "ok" || hasRowDriftMC(data));
	// The banner's remedy must be pressable at the moment it fires: a drifted row is clean against
	// the form buffer, so the sticky Save bar is absent exactly then.
	const resyncPayload = ready ? resyncPayloadMC(data, payload) : null;
	const hasAlarm = Boolean(
		configState.error || saveError || showDrift || surfaceProblem,
	);
	// state prop per section rather than a lifted header — both keep the headers in every state
	// → the smaller diff wins (plan Open Question: implementer's call).
	const sectionState = ready
		? "ready"
		: configState.status === "loading"
			? "loading"
			: "unavailable";
	const freshness = getFreshnessInputMC(asOfAt, configState);

	return (
		<div className="flex flex-col min-w-0">
			<TypeScaleStyle />
			<div className="flex-shrink-0">
				<PageHeader
					title="Models & budgets"
					freshness={
						<>
							<SyncTokenMC
								state={configState.status}
								sync={headerSyncMC(data)}
								freshness={freshness}
							/>
							<FreshnessStamp {...freshness} />
						</>
					}
					refresh={
						<RefreshButton
							isBusy={configState.busy}
							hasRead={asOfAt !== null}
							onRefresh={triggerRefresh}
							label="Reload model config"
						/>
					}
				/>
			</div>

			{/* mounted in every state → a screen reader hears the Refresh/Retry outcome when the text lands */}
			<div className="sr-only" role="status" aria-live="polite">
				{getReadAnnouncementMC(configState, asOfAt, refreshTick)}
			</div>

			{hasAlarm && (
				<div
					className="mb-section flex flex-col gap-section"
					role="region"
					aria-label="Alerts">
					{configState.error && (
						<div role="alert">
							<RegionUnavailable
								source="model config"
								error={configState.error}
								onRetry={triggerRefresh}
								isBusy={configState.busy}
								focusTargetId={MODELS_SECTION_ID_MC}
							/>
							{data != null && asOfAt !== null && (
								<p className="fs-meta text-dim mt-stack">
									The figures below are the last good read, from{" "}
									{formatKstTime(asOfAt)}.
								</p>
							)}
						</div>
					)}
					{saveError && (
						<ErrorBannerMC
							title="Couldn't save changes"
							detail={saveError}
							onRetry={save}
						/>
					)}
					{showDrift && (
						<DriftBannerMC
							sync={data.daemon_config_sync}
							onResync={
								resyncPayload && !hasErrors
									? () => submit(resyncPayload)
									: null
							}
							saving={saving}
						/>
					)}
					{surfaceProblem && (
						<SurfaceResultCardMC
							result={surfaceProblem}
							onDismiss={() => setSurfaceProblem(null)}
						/>
					)}
				</div>
			)}

			{/* full width → the role column holds a whole role line from 1280 up */}
			<div className="mb-section">
				<AgentModelsSectionMC
					state={sectionState}
					agents={data?.agents}
					unreadable={data?.unreadable}
					knownModels={knownModels}
					onAgentsRead={putAgentsRead}
					showToast={showToast}
				/>
			</div>

			{/* 1:1 over 2:1 — a third-width column overflows the cap and tier fields at 1280; three rows left vs four right */}
			<SplitRow ratio="1:1" layout="content">
				<SplitColumn>
					<DomainsSectionMC
						state={sectionState}
						domains={data?.domains}
						knownModels={knownModels}
						form={form}
						baseline={baseline}
						errors={errors}
						onModelChange={setModel}
					/>
					<BudgetsSectionMC
						state={sectionState}
						budgets={data?.budgets}
						form={form}
						baseline={baseline}
						errors={errors}
						onBudgetChange={setBudget}
					/>
				</SplitColumn>
				<TiersSectionMC
					state={sectionState}
					tiers={data?.tiers}
					isFileRead={data?.daemon_config_sync !== "file-missing"}
					form={form}
					baseline={baseline}
					errors={errors}
					onTierChange={setTier}
				/>
			</SplitRow>

			{ready && isDirty && (
				<div className="save-banner" role="region" aria-label="Unsaved changes">
					<div className="flex items-center gap-control min-w-0">
						<span className="fs-body font-medium text-ink">
							{changeCount} unsaved change
							{changeCount === 1 ? "" : "s"}
						</span>
						{hasErrors && (
							<span className="fs-meta text-crit">
								<span aria-hidden="true">✕ </span>
								Fix the highlighted fields before saving
							</span>
						)}
					</div>
					<div className="save-banner__actions">
						<button
							className="btn ghost sm"
							onClick={() => setDiscardConfirm(true)}
							disabled={saving}
							aria-label="Discard unsaved changes"
						>
							Discard
						</button>
						<button
							className="btn primary sm"
							onClick={save}
							disabled={!ready || hasErrors || saving}
							aria-label="Save model and budget changes"
						>
							{saving ? "Saving…" : "Save changes"}
						</button>
					</div>
				</div>
			)}

			{/* Discard 확인 다이얼로그 (T-MDL-5) — destructive(편집분 소실)라 confirm variant +
          consequence text + red-OUTLINE 확인 버튼(.btn.danger 채움 아님) + secondary 취소. */}
			{discardConfirm && (
				<DiscardConfirmMC
					onConfirm={discard}
					onCancel={() => setDiscardConfirm(false)}
				/>
			)}

			{/* 성공 토스트 — S9 계약: 2s top-right. shared .doc-toast 는 bottom-right 기본이라
          transient 오버레이 위치만 inline 으로 top-right override (shared CSS 미수정). */}
			{toast && (
				<div
					className={`doc-toast ${toast.tone}`}
					role="status"
					aria-live="polite"
					style={{ top: 24, bottom: "auto" }}
				>
					<span className="doc-toast-glyph" aria-hidden="true">
						{TONE_GLYPH[toast.tone]}
					</span>
					{toast.message}
				</div>
			)}
		</div>
	);
}

// Header sync token — answers "is what I saved what runs?" once per screen, never per row.
// Tone rides the glyph, text stays plain.
function SyncTokenMC({ state, sync, freshness }) {
	const { Icon, getFreshnessVerdict } = window.UI;

	// the Refresh label already reads Loading… · agreement is silence · an empty roster → its cards say so
	if (state === "loading" || sync === "ok" || sync === "empty") return null;
	if (state !== "ready") {
		return <span className="fs-meta text-faint">Sync state unavailable</span>;
	}

	const meta = SYNC_META_MC[sync] || {
		label: sync || "—",
		desc: "",
		tone: "neutral",
	};

	// a read the stamp calls stale takes the shared 'Last known' prefix
	const label = freshness
		? getFreshnessVerdict({ ...freshness, tone: meta.tone, label: meta.label }).label
		: meta.label;

	return (
		<span
			className="fs-meta text-dim flex items-center gap-label-inline"
			title={meta.desc}>
			<Icon name="warn" size={12} className="text-warn" />
			<span>{label}</span>
		</span>
	);
}

function getFreshnessInputMC(asOfAt, state) {
	return { at: asOfAt, regions: [state] };
}

/**
 * What the live region says once a Refresh or Retry settles — silent on the first load, while busy,
 * and after a save (its toast speaks).
 * A warm failure mounts the role=alert card, which owns that announcement; a cold Retry failure lands
 * in an alert already mounted by the first failure, so only this region can say it.
 */
function getReadAnnouncementMC(state, asOfAt, refreshTick) {
	if (refreshTick === 0 || state.busy) return "";

	if (state.error != null) return state.data != null ? "" : "Couldn't read model config.";

	const time = asOfAt !== null ? window.UI.formatKstTime(asOfAt) : null;
	return state.key === "config" && time ? `Model config reloaded — as of ${time}.` : "";
}

const SETTINGS_INFO_LABEL_MC = "About settings";

// About settings drawer — the card's timing caveat, an optional lead line, then its glossary.
function SettingsInfoMC({ caveat, lead, title, rows }) {
	const { Stack } = window.UI;
	return (
		<Stack gap="block" className="fs-body">
			{caveat && <p>{caveat}</p>}
			{lead && <p>{lead}</p>}
			<TierNotesMC title={title} rows={rows} />
		</Stack>
	);
}

const AGENT_PIN_URL_MC = "/api/model-config/agents";
// the PUT's no-pin value (server INHERIT_VALUE) → the model line is removed
const AGENT_NO_PIN_VALUE_MC = "inherit";
const AGENT_NO_PIN_LABEL_MC = "No pin — session model";
const AGENT_SELECT_ID_MC = "mc-agent-model";
const AGENT_BAR_IDLE_MC = "Select agents to set one model for all of them";
const AGENT_MISSING_MODEL_MC = "Choose a model first";
const AGENT_FOOT_MC = "Fable and Opus: deepest, costliest. Haiku: fastest, cheapest.";
const NOT_REGISTERED_TITLE_MC = "No entry in agent-registry.json — the lifecycle CLI does not track this file";
// unverified whether the agent-file watcher sees a write through the agents-folder link → the restart wording, never "next spawn"
const AGENT_TIMING_MC = {
	sub: "Applies after a session restart",
	caveat: "Saved to the agent file at once — a session already running is sure to use it only after a restart",
};
const AGENT_SPAWN_ORDER_MC = [
	{ label: "1 · The spawn's own model", desc: "A model the spawn names for itself comes first" },
	{ label: "2 · The agent's pin", desc: "The model line of the agent's file" },
	{ label: "3 · No pin", desc: "The model of the conversation that starts it, unless CLAUDE_CODE_SUBAGENT_MODEL is set" },
];
const AGENT_PIN_HOME_MC = [
	{ label: "Model line", desc: "The model line of each file in ~/.glass-atrium/agents. Updates keep it." },
	{ label: "Not registered", desc: NOT_REGISTERED_TITLE_MC },
];
// tick 52 (16 edge + 24 target + 12) · agent · role takes the rest · model
const AGENT_COL_WIDTHS_MC = ["52px", "24%", "auto", "22%"];
// narrowest wrapper that still holds a 52-character role line in its column
const AGENT_STACK_BELOW_PX_MC = 900;
const AGENT_ROW_HEIGHT_MC = 40;
const AGENT_SKELETON_ROWS_MC = 12;
// one selection state (design.md §12.4) → the sunken fill, held under hover by the inline style
const TICKED_ROW_STYLE_MC = { background: "rgb(var(--sunken))" };
const TWIN_CELL_STYLE_MC = { gridArea: "1 / 1" };
const TWIN_HIDDEN_STYLE_MC = { ...TWIN_CELL_STYLE_MC, visibility: "hidden" };
const AGENT_DONE_STATUSES_MC = ["applied", "unchanged"];
const AGENT_REASON_WORDS_MC = {
	"File is outside the agents folder": "the file is outside the agents folder",
	"The file could not be written": "the file could not be written",
};
const AGENT_LINE_ONLY_WORDS_MC = "only the model line may change, and more would have";
// the read-back refusals: the write would change more than the model line, or would not read back as written
const AGENT_READ_BACK_RE_MC = /^The writ(?:e|ten) /;

/**
 * Agent models card — one model line per agent file, set for every ticked agent at once.
 * Apply is its own immediate PUT, apart from the buffered daemon Save; nothing on it is optimistic.
 */
function AgentModelsSectionMC({ state, agents, unreadable, knownModels, onAgentsRead, showToast }) {
	const { Card, Cluster, Link } = window.UI;
	const cardRef = useRefMC(null);
	const apply = useAgentApplyMC({ agents, onAgentsRead, showToast, cardRef });
	const items = getAgentListMC(agents || [], unreadable || []);
	const isEmpty = state === "ready" && items.length === 0;
	const isListed = state !== "unavailable" && !isEmpty;

	return (
		<div id={MODELS_SECTION_ID_MC} ref={cardRef}>
			<Card
				size="L"
				className="agent-card"
				title="Agent models"
				sub={AGENT_TIMING_MC.sub}
				info={<AgentInfoMC />}
				infoLabel={SETTINGS_INFO_LABEL_MC}
				right={
					<Cluster gap="control-group">
						{state === "ready" && unreadable?.length > 0 && <HeadMarkMC text={`${unreadable.length} ${unreadable.length === 1 ? "file" : "files"} not readable`} />}
						<Link href="#cost" className="fs-meta inline-target">
							Cost & usage
						</Link>
					</Cluster>
				}
				bar={isListed ? <AgentBarMC {...apply.bar} knownModels={knownModels} /> : null}
				foot={isEmpty ? null : AGENT_FOOT_MC}
				isFlush={isListed}>
				<AgentBodyMC state={state} items={items} isEmpty={isEmpty} knownModels={knownModels} apply={apply} />
			</Card>
		</div>
	);
}

/** Selection, model choice and the apply round trip of the agent card; `bar` = AgentBarMC props. */
function useAgentApplyMC({ agents, onAgentsRead, showToast, cardRef }) {
	const [ticked, setTicked] = useStateMC(() => new Set());
	const [model, setModel] = useStateMC("");
	const [isModelMissing, setIsModelMissing] = useStateMC(false);
	const [isApplying, setIsApplying] = useStateMC(false);
	const [outcome, setOutcome] = useStateMC(null);

	useEffectMC(() => {
		if (agents) setTicked((t) => getTicksAfterReadMC(t, agents));
	}, [agents]);

	const setTicks = (next) => {
		setTicked(next);
		setOutcome((o) => (o && o.alarm.tone === "warn" && !o.retry.some((name) => next.has(name)) ? null : o));
	};
	const toggle = (name) => {
		const next = new Set(ticked);
		if (!next.delete(name)) next.add(name);
		setTicks(next);
	};
	const clear = () => {
		setTicks(new Set());
		setModel("");
		setIsModelMissing(false);
		setOutcome(null);
		focusRovingRowMC(cardRef.current);
	};
	const send = () => putAgentApplyMC({ model, agents, ticked, setIsApplying, setOutcome, setTicked, onAgentsRead, showToast, clear });
	const submit = () => {
		if (isApplying || ticked.size === 0) return;
		if (model !== "") return send();
		setIsModelMissing(true);
		document.getElementById(AGENT_SELECT_ID_MC)?.focus();
	};
	const choose = (value) => {
		setModel(value);
		setIsModelMissing(false);
	};

	return {
		ticked,
		isApplying,
		outcome,
		toggle,
		setTicks,
		bar: { count: ticked.size, model, isModelMissing, isApplying, onModel: choose, onApply: submit, onClear: clear },
	};
}

// One PUT for every ticked agent; a clean answer ends in the toast, a failure keeps what can be retried ticked.
async function putAgentApplyMC({ model, agents, ticked, setIsApplying, setOutcome, setTicked, onAgentsRead, showToast, clear }) {
	setIsApplying(true);
	const answer = await putAgentPinsMC(getAgentApplyBodyMC(model, agents, ticked));
	setIsApplying(false);
	if (answer.status !== 200) {
		setOutcome({ alarm: getAgentApplyFailureMC(answer), retry: [], reasons: {} });
		return;
	}
	onAgentsRead(answer.data);
	const result = getAgentApplyOutcomeMC(answer.data.results, model);
	if (result.toast) {
		showToast("ok", result.toast);
		clear();
		return;
	}
	setOutcome(result);
	setTicked(new Set(result.retry));
}

function AgentBodyMC({ state, items, isEmpty, knownModels, apply }) {
	const { AlarmRow, EmptyState, MachineString } = window.UI;
	if (state === "unavailable") return <SectionUnavailableMC message="Not available — the agent list could not be read." />;
	if (isEmpty) {
		return (
			<EmptyState
				kind="first-use"
				message={<>No agent files in <MachineString>~/.glass-atrium/agents</MachineString></>}
				hint="An agent appears here once its file is in that folder — then press Refresh."
			/>
		);
	}
	const alarm = apply.outcome?.alarm;
	return (
		<>
			{alarm && <AlarmRow tone={alarm.tone} role={alarm.tone === "crit" ? "alert" : "status"} title={alarm.title} detail={alarm.detail} />}
			<AgentTableMC state={state} items={items} knownModels={knownModels} apply={apply} />
		</>
	);
}

function AgentTableMC({ state, items, knownModels, apply }) {
	const { Checkbox, SkeletonRows, Table, getRowFocusProps } = window.UI;
	const [activeIndex, setActiveIndex] = useStateMC(0);
	const names = items.filter((item) => item.agent).map((item) => item.agent.name);
	const tickedCount = names.filter((name) => apply.ticked.has(name)).length;
	const isAllTicked = names.length > 0 && tickedCount === names.length;
	const master = (
		<Checkbox
			isChecked={isAllTicked}
			isMixed={tickedCount > 0 && !isAllTicked}
			isDisabled={state !== "ready" || apply.isApplying || names.length === 0}
			onChange={() => apply.setTicks(new Set(isAllTicked ? [] : names))}
			ariaLabel="Select all agents"
		/>
	);
	const getFocusProps = (index) =>
		getRowFocusProps({ index, activeIndex, count: items.length, onActiveChange: setActiveIndex, onActivate: (i) => items[i].agent && !apply.isApplying && apply.toggle(items[i].agent.name) });

	return (
		<Table
			caption="Agent models. Up and Down move between rows, Right reaches a row's checkbox, Enter ticks the focused row."
			columns={getAgentColumnsMC(master)}
			widths={AGENT_COL_WIDTHS_MC}
			stackBelowPx={AGENT_STACK_BELOW_PX_MC}
			className={`${LEDGER_TABLE_CLASS_MC} agent-table`}
			bodies={[{ key: "agents", isBusy: state === "loading" || apply.isApplying, rows: state === "loading"
				? <SkeletonRows rows={items.length || AGENT_SKELETON_ROWS_MC} columns={AGENT_COL_WIDTHS_MC.length} rowHeight={AGENT_ROW_HEIGHT_MC} />
				: (view) => items.map((item, index) => (
					<AgentRowMC
						key={item.file}
						view={view}
						item={item}
						isTicked={Boolean(item.agent) && apply.ticked.has(item.agent.name)}
						isApplying={apply.isApplying}
						reason={item.agent && apply.outcome?.reasons[item.agent.name]}
						knownModels={knownModels}
						focusProps={getFocusProps(index)}
						onToggle={apply.toggle}
					/>
				)) }]}
		/>
	);
}

function getAgentColumnsMC(master) {
	return [
		{ key: "tick", label: master },
		{ key: "agent", label: "Agent" },
		{ key: "role", label: <span className="agent-head-role">Role</span> },
		{ key: "model", label: <span title="Read from each agent file's model line">Model</span> },
	];
}

/**
 * One agent file: a pointer press anywhere in the row toggles its box; the name is the box's label.
 * A failure reason rides a detail row under it, after the tick and agent columns, on the row's own fill.
 */
function AgentRowMC({ view, item, isTicked = false, isApplying = false, reason, knownModels, focusProps, onToggle }) {
	const { TableCell, TableRow } = window.UI;
	const isPressable = Boolean(item.agent) && !isApplying;

	return (
		<>
			<TableRow
				view={view}
				{...focusProps}
				className={reason ? "agent-row is-grouped is-top-aligned" : "agent-row is-top-aligned"}
				style={isTicked ? TICKED_ROW_STYLE_MC : undefined}
				onClick={isPressable ? () => onToggle(item.agent.name) : undefined}>
				{item.agent ? (
					<AgentCellsMC view={view} agent={item.agent} isTicked={isTicked} isApplying={isApplying} knownModels={knownModels} onToggle={onToggle} />
				) : (
					<UnreadableCellsMC view={view} file={item.unreadable} />
				)}
			</TableRow>
			{reason && (
				<TableRow view={view} className="agent-row agent-row-detail" style={isTicked ? TICKED_ROW_STYLE_MC : undefined}>
					<TableCell view={view} textRole="label" />
					{!view?.isStacked && <TableCell view={view} textRole="label" />}
					<TableCell view={view} kind="span" start={2} className={view?.isStacked ? "agent-row-sub" : undefined}>
						<div className="fs-meta text-dim">
							<span className="text-crit" aria-hidden="true">✕ </span>
							{reason}
						</div>
					</TableCell>
				</TableRow>
			)}
		</>
	);
}

// the box and the name label own their press → the row's own toggle never runs twice
function stopRowPressMC(event) {
	event.stopPropagation();
}

function AgentCellsMC({ view, agent, isTicked, isApplying, knownModels, onToggle }) {
	const { AgentName, Checkbox, TableCell } = window.UI;
	const id = `mc-agent-${agent.name}`;
	const role = <AgentRoleCellMC view={view} role={agent.role} />;

	return (
		<>
			<TableCell view={view} textRole="label" onClick={stopRowPressMC}>
				<Checkbox id={id} isRowControl isChecked={isTicked} isDisabled={isApplying} onChange={() => onToggle(agent.name)} />
			</TableCell>
			<TableCell view={view} textRole="label" className={view?.isStacked ? "min-w-0" : undefined}>
				<label htmlFor={id} className="block truncate fs-body font-medium text-ink tbl-first-line" onClick={stopRowPressMC}>
					<AgentName name={agent.name} />
				</label>
				{!agent.registered && (
					<div className="fs-meta text-dim" title={NOT_REGISTERED_TITLE_MC}>
						Not registered
					</div>
				)}
			</TableCell>
			{!view?.isStacked && role}
			<TableCell view={view} textRole="label">
				<AgentModelCellMC pin={agent.pin} knownModels={knownModels} />
			</TableCell>
			{view?.isStacked && role}
		</>
	);
}

// stacked → the role is the row's second line, from the name's x to the row end
function AgentRoleCellMC({ view, role }) {
	const { EMPTY_VALUE_TEXT, TableCell } = window.UI;
	const size = view?.isStacked ? "fs-meta" : "fs-body tbl-first-line";
	return (
		<TableCell view={view} textRole="label" className={view?.isStacked ? "agent-row-sub min-w-0" : "min-w-0"}>
			{role ? (
				<span className={`block truncate text-dim ${size}`} title={role}>
					{role}
				</span>
			) : (
				<span className={`text-faint ${size}`}>{EMPTY_VALUE_TEXT}</span>
			)}
		</TableCell>
	);
}

// pinned vs default is told by words: a model name, or "No pin"; a pin outside the roster shows its id and the fallback-rate note
function AgentModelCellMC({ pin, knownModels }) {
	const { MachineString } = window.UI;
	if (pin === null) return <span className="fs-body text-dim tbl-first-line">{AGENT_NO_PIN_LABEL_MC}</span>;
	if (knownModels.includes(pin)) {
		return (
			<span className="fs-body text-ink tbl-first-line" title={pin}>
				{getModelOptionLabelMC(pin)}
			</span>
		);
	}
	return (
		<>
			<span className="block truncate tbl-first-line" title={pin}>
				<MachineString>{pin}</MachineString>
			</span>
			<PricingNoteMC pricingKnown={false} />
		</>
	);
}

// a .md the list could not read: shown, never hidden — no box, the reason in the role column
function UnreadableCellsMC({ view, file }) {
	const { MachineString, NOT_LOADED_TEXT, TableCell } = window.UI;
	const reason = (
		<TableCell view={view} textRole="label" className={view?.isStacked ? "agent-row-sub" : undefined}>
			<span className={`text-dim ${view?.isStacked ? "fs-meta" : "fs-body tbl-first-line"}`}>{file.reason}</span>
		</TableCell>
	);
	return (
		<>
			<TableCell view={view} textRole="label" />
			<TableCell view={view} textRole="label" className="min-w-0">
				<span className="block truncate tbl-first-line" title={file.file}>
					<MachineString>{file.file}</MachineString>
				</span>
			</TableCell>
			{!view?.isStacked && reason}
			<TableCell view={view} textRole="label">
				<span className="fs-body text-faint tbl-first-line">{NOT_LOADED_TEXT}</span>
			</TableCell>
			{view?.isStacked && reason}
		</>
	);
}

/** The card's selection bar: always laid out; its controls appear only while a row is ticked. */
function AgentBarMC({ count, model, knownModels, isModelMissing, isApplying, onModel, onApply, onClear }) {
	const { QuietButton, Select } = window.UI;
	if (count === 0) {
		return (
			<div className="agent-bar">
				<div className="agent-bar-line">
					<span className="fs-meta text-dim">{AGENT_BAR_IDLE_MC}</span>
				</div>
			</div>
		);
	}

	return (
		<div className="agent-bar">
			<div className="agent-bar-line">
				<AgentCountCellMC count={count} isModelMissing={isModelMissing} />
				<div className="flex items-center gap-control">
					<Select
						id={AGENT_SELECT_ID_MC}
						label="Model for the selected agents"
						isLabelHidden
						isError={isModelMissing}
						value={model}
						options={getAgentModelOptionsMC(knownModels)}
						onChange={onModel}
						disabled={isApplying}
						title={knownModels.includes(model) ? model : undefined}
					/>
					<button type="button" className="btn primary sm" onClick={onApply} disabled={isApplying}>
						{isApplying ? "Applying…" : `Apply to ${getAgentCountTextMC(count)}`}
					</button>
				</div>
				<QuietButton className="ms-auto" onClick={onClear} disabled={isApplying}>
					Clear selection
				</QuietButton>
			</div>
		</div>
	);
}

// hidden twin: the count and the missing-model alert share one cell sized to the wider → the bar never shifts
function AgentCountCellMC({ count, isModelMissing }) {
	return (
		<span className="grid">
			<span className="fs-body font-medium text-ink tabular-nums" style={isModelMissing ? TWIN_HIDDEN_STYLE_MC : TWIN_CELL_STYLE_MC} aria-hidden={isModelMissing ? "true" : undefined}>
				{`${count} selected`}
			</span>
			<span role="alert" className="fs-meta text-crit" style={isModelMissing ? TWIN_CELL_STYLE_MC : TWIN_HIDDEN_STYLE_MC}>
				{isModelMissing ? (
					<>
						<span aria-hidden="true">✕ </span>
						{AGENT_MISSING_MODEL_MC}
					</>
				) : (
					<span aria-hidden="true">{`✕ ${AGENT_MISSING_MODEL_MC}`}</span>
				)}
			</span>
		</span>
	);
}

function getAgentModelOptionsMC(knownModels) {
	return [
		{ key: "", label: "Choose a model" },
		...knownModels.map((id) => ({ key: id, label: getModelOptionLabelMC(id), title: getModelOptionTitleMC(id) })),
		{ key: AGENT_NO_PIN_VALUE_MC, label: AGENT_NO_PIN_LABEL_MC },
	];
}

function AgentInfoMC() {
	const { Stack } = window.UI;
	return (
		<Stack gap="block" className="fs-body">
			<p>{AGENT_TIMING_MC.caveat}</p>
			<TierNotesMC title="How a spawn picks its model" rows={AGENT_SPAWN_ORDER_MC} />
			<TierNotesMC title="Where a pin lives" rows={AGENT_PIN_HOME_MC} />
		</Stack>
	);
}

// focus returns to the table's one roving stop once the bar's controls leave
function focusRovingRowMC(root) {
	root?.querySelector('[data-roving-row][tabindex="0"]')?.focus();
}

// Agents and unreadable files in one list, by file name → a file added a minute ago takes its alphabetical place.
function getAgentListMC(agents, unreadable) {
	return [
		...agents.map((agent) => ({ file: agent.file, agent })),
		...unreadable.map((file) => ({ file: file.file, unreadable: file })),
	].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

// One model for every ticked agent, each carrying the pin this page last showed for it.
function getAgentApplyBodyMC(model, agents, ticked) {
	return {
		model,
		agents: agents.filter((agent) => ticked.has(agent.name)).map((agent) => ({ name: agent.name, expected_pin: agent.pin })),
	};
}

// A fresh list keeps every tick whose agent is still listed.
function getTicksAfterReadMC(ticked, agents) {
	return new Set(agents.map((agent) => agent.name).filter((name) => ticked.has(name)));
}

/** A 200 answer: every file applied or unchanged → the toast; else the warn alarm, the files to retry and their row reasons. */
function getAgentApplyOutcomeMC(results, model) {
	const failed = results.filter((result) => !AGENT_DONE_STATUSES_MC.includes(result.status));
	if (failed.length === 0) return { toast: getAgentToastMC(results, model), alarm: null, retry: [], reasons: {} };

	const retry = failed.filter((result) => result.status !== "gone");
	const gone = failed.filter((result) => result.status === "gone");
	return {
		toast: null,
		alarm: { tone: "warn", title: getAgentFailedLineMC(failed.length, results.length, retry, gone) },
		retry: retry.map((result) => result.name),
		reasons: Object.fromEntries(retry.map((result) => [result.name, getAgentReasonMC(result)])),
	};
}

// one line: the count agrees in number; a retried file's row names its cause, a gone file has no row → named here
function getAgentFailedLineMC(failedCount, total, retry, gone) {
	const namesOf = (results) => results.map((result) => window.UI.getAgentDisplayName(result.name)).join(", ");
	const causes = [
		retry.length > 0 && (retry.length === 1 ? "reason on its row" : "reasons on their rows"),
		gone.length > 0 && `${namesOf(gone)} — ${gone.length === 1 ? "its file is" : "their files are"} no longer in the folder`,
	]
		.filter(Boolean)
		.join(" · ");
	return `${failedCount} of ${total} ${total === 1 ? "agent" : "agents"} not changed — ${causes}`;
}

function getAgentToastMC(results, model) {
	const agents = getAgentCountTextMC(results.length);
	const isNoPin = model === AGENT_NO_PIN_VALUE_MC;
	if (results.every((result) => result.status === "unchanged")) {
		return isNoPin ? `${agents} had no pin already` : `${agents} ${results.length === 1 ? "was" : "were"} already on ${getModelOptionLabelMC(model)}`;
	}
	return isNoPin ? `Pin removed from ${agents}` : `${getModelOptionLabelMC(model)} set on ${agents}`;
}

function getAgentCountTextMC(count) {
	return `${count} ${count === 1 ? "agent" : "agents"}`;
}

// A failed file's row line; a refusal the screen has no words for keeps the server's reason.
function getAgentReasonMC({ status, reason }) {
	if (status === "changed_since_load") return "Not changed — the file changed after this page loaded";
	const text = AGENT_REASON_WORDS_MC[reason] ?? (AGENT_READ_BACK_RE_MC.test(reason ?? "") ? AGENT_LINE_ONLY_WORDS_MC : null);
	if (text) return `Not changed — ${text}`;
	return reason ? `Not changed — ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : "Not changed";
}

/** An answer that wrote nothing (400 / 409 / 403 / 429 / 503 / no answer) → one crit alarm naming the next step. */
function getAgentApplyFailureMC({ status, data }) {
	const detail =
		status === null
			? "The monitor did not answer. Apply again."
			: status === 409
				? "Another process is writing agent files. Apply again when it finishes."
				: data?.reason ?? `The monitor answered HTTP ${status}. Apply again.`;
	return { tone: "crit", title: "No agent was changed", detail };
}

// status null = no answer; any answered status comes back with its body for the alarm
async function putAgentPinsMC(body) {
	try {
		const res = await fetch(AGENT_PIN_URL_MC, {
			method: "PUT",
			headers: { "content-type": "application/json", Accept: "application/json" },
			body: JSON.stringify(body),
		});
		return { status: res.status, data: await res.json().catch(() => null) };
	} catch (_err) {
		return { status: null, data: null }; // the network failure itself is the alarm the caller raises
	}
}

// One grid for the three daemon tables: the label takes the rest, the control column 12 interior + 160 control + 16 edge.
// 160 = the 32 step above the widest line the slot holds ("Saved: CLI default Reset") → every control shares both edges.
const LEDGER_COL_WIDTHS_MC = ["auto", "calc(5 * var(--space-8) + var(--space-3) + var(--card-pad))"];
// Skeleton columns for the daemon ledgers.
const LEDGER_COL_COUNT_MC = LEDGER_COL_WIDTHS_MC.length;
// fixed layout → the widths above hold whatever a cell holds
const LEDGER_TABLE_CLASS_MC = "table-fixed";
// the inline Reset's 24 target height (§7.15 C24) → the saved/reset slot holds it while empty, so a reset never moves the row
const SAVED_LINE_STYLE_MC = { minHeight: "24px" };
// The inline Reset's text-action look — navigation takes the Link atom instead.
const LINK_CLASS_MC = "text-dim underline underline-offset-2";
// a link beside a card's or a row's controls → the 24 target (§7.15)
const LINK_TARGET_CLASS_MC = `inline-target ${LINK_CLASS_MC}`;

// 모델 도메인 섹션 — 편집값(Model) vs 실측(Live) + 반영 시점.
function DomainsSectionMC({
	state,
	domains,
	knownModels,
	form,
	baseline,
	errors,
	onModelChange,
}) {
	const { Card, SkeletonRows, Table } = window.UI;
	const rows = sortDomainsMC(domains || []);
	const timing = getApplyTimingMC(rows);

	return (
			<Card
				size="M"
				title="Daemon model"
				sub={timing.meta}
				info={
					<SettingsInfoMC
						caveat={timing.caveat}
						title="What the helper runs"
						rows={rows.map((d) => DOMAIN_META_MC[d.domain] && { ...DOMAIN_META_MC[d.domain], savedId: d.desired })}
					/>
				}
				infoLabel={SETTINGS_INFO_LABEL_MC}
				right={state === "ready" ? <UnreadMarkMC rows={rows} metaOf={DOMAIN_META_MC} /> : null}
				isFlush={state !== "unavailable"}>
				{state === "unavailable" ? (
					<SectionUnavailableMC />
				) : (
					<Table
						caption="Daemon model per background call"
						widths={LEDGER_COL_WIDTHS_MC}
						className={LEDGER_TABLE_CLASS_MC}
						bodies={[{ key: "domains", isBusy: state === "loading", rows: (
							state === "loading" ? (
								<SkeletonRows
									rows={DOMAIN_ORDER_MC.length}
									columns={LEDGER_COL_COUNT_MC}
									rowHeight={LEDGER_ROW_HEIGHT_MC}
								/>
							) : rows.length === 0 ? (view) => (
								<EmptyRowMC
									view={view}
									message="No model domains reported."
								/>
							) : (view) => (
								rows.map((d) => (
									<DomainRowMC
										key={d.domain}
										view={view}
										domain={d}
										departure={timing.departures.get(d.domain)}
										knownModels={knownModels}
										value={form.models[d.domain] ?? ""}
										defaultValue={baseline?.models[d.domain] ?? ""}
										error={errors[d.domain]}
										onChange={(v) => onModelChange(d.domain, v)}
									/>
								))
							)
						) }]}
					/>
				)}
			</Card>
	);
}

// Empty roster — states zero rows explicitly, so it never reads as a failed load.
function EmptyRowMC({ view, message }) {
	const { TableCell, TableRow } = window.UI;
	return (
		<TableRow view={view}>
			<TableCell view={view} kind="span">
				<div className="fs-meta text-faint">{message}</div>
			</TableCell>
		</TableRow>
	);
}

function RowHintMC({ hint }) {
	if (!hint) return null;

	return <div className="fs-meta text-faint is-wrap">{hint}</div>;
}

// Full descriptions in one labelled list per section — a note per row repeats one affordance N times.
function TierNotesMC({ title, rows }) {
	const { MachineString, SectionLabel } = window.UI;
	const notes = rows.filter((meta) => meta && (meta.desc || meta.savedId));
	if (notes.length === 0) return null;

	return (
		<section className="text-dim" aria-label={title}>
			<SectionLabel level={3}>{title}</SectionLabel>
			<dl className="mt-label flex flex-col gap-list">
				{notes.map((meta) => (
					<div key={meta.label}>
						<dt className="text-ink">{meta.label}</dt>
						{meta.desc && <dd className="is-wrap">{getDescNodesMC(meta)}</dd>}
						{meta.note && <dd className="is-wrap">{meta.note}</dd>}
						{/* the select shows the friendly name → the saved id is read here, by keyboard and touch too */}
						{meta.savedId && <dd>Saved id <MachineString>{meta.savedId}</MachineString></dd>}
					</div>
				))}
			</dl>
		</section>
	);
}

// a flag or env name inside the sentence → mono through MachineString, the words around it stay sans
function getDescNodesMC({ desc, machine }) {
	const at = machine ? desc.indexOf(machine) : -1;
	if (at === -1) return desc;
	const { MachineString } = window.UI;

	return (
		<>
			{desc.slice(0, at)}
			<MachineString>{machine}</MachineString>
			{desc.slice(at + machine.length)}
		</>
	);
}

// payload carries no resolved settings.json model → name the source an inherit value follows
const INHERIT_LIVE_LABEL_MC = {
	"inherit (settings.json)": "settings.json model (inherit)",
};

function getLiveModelLabelMC(value) {
	return INHERIT_LIVE_LABEL_MC[value] ?? getModelOptionLabelMC(value);
}

// A read-only value stands where a control would → it takes the control height, so the row keeps its rhythm.
const CONTROL_LINE_STYLE_MC = { minHeight: "var(--ctl-min-h)" };

/**
 * The line slot under a daemon control — empty at rest; its first 24 is reserved, so no state moves the row until a second line.
 * Lines in order: invalid entry · rejected file value · a differing value in effect · no value read · the saved value + Reset.
 * In effect = the value read back from the file; agreeing with the saved target is silence.
 */
function LiveValueMC({ errorId, error, fileError, value, drift, driftTitle, source, overridden, savedValue, onReset }) {
	const isRead = value != null;
	return (
		<div data-slot="line-slot" className="fs-meta mt-stack flex flex-col" style={SAVED_LINE_STYLE_MC}>
			{error && <AlertLineMC id={errorId}>{error}</AlertLineMC>}
			{fileError && <AlertLineMC detail={fileError}>File value rejected</AlertLineMC>}
			{!fileError && drift && isRead && <InEffectLineMC value={value} title={driftTitle} />}
			{/* null live value = source unreadable or key missing → never claim a read */}
			{!fileError && !isRead && source && (
				<div className="text-faint flex items-center" style={SAVED_LINE_STYLE_MC} title={`No value read from ${source}`}>
					No value read
				</div>
			)}
			<GhostResetMC overridden={overridden} defaultValue={savedValue} onReset={onReset} />
		</div>
	);
}

// ✕ + words in crit, announced at once; a detail (the server's reason) wraps under it in dim
function AlertLineMC({ id, detail, children }) {
	return (
		<div id={id} role="alert">
			<div className="text-crit">
				<span aria-hidden="true">✕ </span>
				{children}
			</div>
			{detail && <div className="text-dim is-wrap">{detail}</div>}
		</div>
	);
}

// one line: the glyph and words name the state, the value is cut with its title; the line's title says what to do
function InEffectLineMC({ value, title }) {
	const { Icon } = window.UI;
	return (
		<div className="flex items-center gap-label-inline min-w-0" style={SAVED_LINE_STYLE_MC} title={title}>
			<Icon name="warn" size={12} className="text-warn flex-shrink-0" />
			<span className="text-dim flex-shrink-0">In effect:</span>
			<span className="text-ink truncate" title={value}>
				{value}
			</span>
		</div>
	);
}

function getApplyModeMetaMC(mode) {
	return APPLY_MODE_META_MC[mode] || { when: mode, desc: "" };
}

// Most rows share one apply_mode → the section states it once; rows that differ name their own.
function getSharedApplyModeMC(rows) {
	const counts = new Map();
	for (const r of rows) {
		if (r.apply_mode) counts.set(r.apply_mode, (counts.get(r.apply_mode) ?? 0) + 1);
	}
	let shared = null;
	for (const [mode, n] of counts) {
		if (shared === null || n > counts.get(shared)) shared = mode;
	}
	return shared;
}

/**
 * A card's take-effect timing: the shared mode as header meta, its caveat for the drawer,
 * and departures (domain → that row's own "Applies …" line, rendered in the row only).
 */
function getApplyTimingMC(rows) {
	const mode = getSharedApplyModeMC(rows);
	const departures = new Map();
	if (!mode) return { meta: null, caveat: null, departures };

	for (const r of rows) {
		if (r.apply_mode && r.apply_mode !== mode) departures.set(r.domain, getApplyLineMC(r.apply_mode));
	}
	return { meta: getApplyLineMC(mode), caveat: getApplyModeMetaMC(mode).desc || null, departures };
}

function getApplyLineMC(mode) {
	return `Applies ${getApplyModeMetaMC(mode).when}`;
}

function DomainRowMC({
	view,
	domain: d,
	departure,
	knownModels,
	value,
	defaultValue,
	error,
	onChange,
}) {
	const meta = DOMAIN_META_MC[d.domain] || {
		label: d.domain,
		editable: d.editable !== false,
	};
	// 서버 editable=false 가 우선 — UI 메타와 어긋나면 보수적으로 read-only.
	const editable = d.editable !== false && meta.editable !== false;
	const id = `mc-model-${d.domain}`;
	const { TableCell, TableRow } = window.UI;

	return (
		<TableRow view={view} className="is-top-aligned">
			<TableCell view={view} textRole="label">
				<div className="fs-body font-medium text-ink tbl-first-line">{meta.label}</div>
				<RowHintMC hint={departure} />
			</TableCell>
			<TableCell view={view} textRole="label">
				{editable ? (
					<ModelSelectMC id={id} domain={d.domain} knownModels={knownModels} value={value} error={error} onChange={onChange} />
				) : (
					// read-only value on the control line → the column rhythm holds without a field box
					(value || d.desired) && (
						<div className="flex items-center text-ink" style={CONTROL_LINE_STYLE_MC}>
							{getModelOptionLabelMC(value || d.desired)}
						</div>
					)
				)}
				<PricingNoteMC pricingKnown={d.pricing_known} />
				<LiveValueMC
					errorId={`${id}-error`}
					error={error}
					value={getLiveModelLabelMC(d.actual)}
					drift={d.drift}
					source={meta.source}
					driftTitle="Live value differs from the saved target — press Save again"
					overridden={editable && defaultValue !== undefined && value !== defaultValue}
					savedValue={defaultValue && getModelOptionLabelMC(defaultValue)}
					onReset={() => onChange(defaultValue)}
				/>
			</TableCell>
		</TableRow>
	);
}

// Model pick = the house Select (one-row combo: the options are known_models) + a custom-id entry slot.
// A value outside the list (empty included) = custom mode, shown as CUSTOM_OPTION_MC.
// Its error, saved value and reset sit in the row's line slot under it.
function ModelSelectMC({ id, domain, knownModels, value, error, onChange }) {
	const isListed = knownModels.includes(value);
	const isCustom = !isListed;
	const meta = DOMAIN_META_MC[domain];
	const label = meta ? meta.label : domain;

	const handleSelect = (opt) => {
		// '__custom__' 진입 = 빈 문자열로 custom 모드 시작 (기존 custom 버튼과 동일 동작).
		if (opt === CUSTOM_OPTION_MC) {
			if (!isCustom) onChange("");
			return;
		}
		onChange(opt);
	};

	const { Select } = window.UI;
	const selectOptions = [
		...knownModels.map((opt) => ({ key: opt, label: getModelOptionLabelMC(opt), title: getModelOptionTitleMC(opt) })),
		{ key: CUSTOM_OPTION_MC, label: "custom…" },
	];

	// custom mode → the entry field owns the crit edge, so the select drops it (one ring; the worded message serves both)
	return (
		<Select
			id={id}
			label={`${label} model`}
			isLabelHidden
			isError={Boolean(error) && !isCustom}
			value={isCustom ? CUSTOM_OPTION_MC : value}
			options={selectOptions}
			onChange={handleSelect}
			title={isListed ? value : undefined}
			aria-describedby={error && !isCustom ? `${id}-error` : undefined}
		>
			{isCustom && (
				<input
					type="text"
					className={`field field--mono${error ? " is-error" : ""}`}
					value={value}
					placeholder="model id (lowercase)"
					onChange={(e) => onChange(e.target.value)}
					aria-label={`${label} custom model id`}
					aria-invalid={error ? "true" : undefined}
					aria-describedby={error ? `${id}-error` : undefined}
				/>
			)}
		</Select>
	);
}

// The select shows the friendly name, so its column never clips an id mid-word; an id outside the naming pattern shows itself.
function getModelOptionLabelMC(model) {
	return window.UI.getDisplayName("model", model) ?? model;
}

// The full id leads the option tooltip, then the capability line.
function getModelOptionTitleMC(model) {
	return [model, MODEL_CAP_MC[model]].filter(Boolean).join(" — ");
}

// Unpriced tier only — the section header carries the one Cost & usage link.
function PricingNoteMC({ pricingKnown }) {
	const { TONE_GLYPH } = window.UI;
	if (pricingKnown !== false) return null;

	return (
		<div className="fs-meta mt-stack text-dim">
			<span className="text-warn" aria-hidden="true">
				{TONE_GLYPH.warn}
			</span>{" "}
			No price listed — billed at the conservative fallback rate
		</div>
	);
}

// Saved value + reset — drawn only for an edit away from the saved value, inside the line slot's reserved 24.
function GhostResetMC({ overridden, defaultValue, onReset }) {
	if (!overridden) return null;

	return (
		<div className="text-faint flex items-center gap-label-inline flex-wrap" style={SAVED_LINE_STYLE_MC}>
			{defaultValue && (
				<>
					<span>Saved:</span>
					<span className="text-dim">{defaultValue}</span>
				</>
			)}
			<button
				type="button"
				className={LINK_TARGET_CLASS_MC}
				onClick={onReset}
				aria-label="Reset this field to the saved value"
			>
				Reset
			</button>
		</div>
	);
}

// per-call 예산 상한 섹션 — 입력 + 실측 + 반영 시점 (월 청구 캡이 아니라 단일 호출 캡).
function BudgetsSectionMC({
	state,
	budgets,
	form,
	baseline,
	errors,
	onBudgetChange,
}) {
	const { Card, Cluster, Link, SkeletonRows, Table } = window.UI;
	const rows = sortBudgetsMC(budgets || []);
	const timing = getApplyTimingMC(rows);

	return (
		<Card
			size="M"
			title="Per-call budget caps"
			right={
				<Cluster gap="control-group">
					{state === "ready" && <UnreadMarkMC rows={rows} metaOf={BUDGET_META_MC} />}
					{/* cost/outcome payload carries no per-call maximum → Cost & usage is the reference point */}
					<Link href="#cost" className="fs-meta inline-target">
						Recent costs
					</Link>
				</Cluster>
			}
			sub={timing.meta}
			info={
				<SettingsInfoMC
					caveat={timing.caveat}
					lead="A cap that trips aborts the runaway call."
					title="What each cap covers"
					rows={rows.map((b) => BUDGET_META_MC[b.domain])}
				/>
			}
			infoLabel={SETTINGS_INFO_LABEL_MC}
			isFlush={state !== "unavailable"}>
			{state === "unavailable" ? (
				<SectionUnavailableMC />
			) : (
				<Table
					caption="Per-call budget cap per background call"
					widths={LEDGER_COL_WIDTHS_MC}
					className={LEDGER_TABLE_CLASS_MC}
					bodies={[{ key: "budgets", isBusy: state === "loading", rows: (
						state === "loading" ? (
							<SkeletonRows
								rows={2}
								columns={LEDGER_COL_COUNT_MC}
								rowHeight={LEDGER_ROW_HEIGHT_MC}
							/>
						) : rows.length === 0 ? (view) => (
							<EmptyRowMC
								view={view}
								message="No budget caps reported."
							/>
						) : (view) => (
							rows.map((b) => (
								<BudgetRowMC
									key={b.domain}
									view={view}
									budget={b}
									departure={timing.departures.get(b.domain)}
									value={form.budgets[b.domain] ?? ""}
									defaultValue={baseline?.budgets[b.domain] ?? ""}
									error={errors[b.domain]}
									onChange={(v) => onBudgetChange(b.domain, v)}
								/>
							))
						)
					) }]}
				/>
			)}
		</Card>
	);
}

// per-call 상한 입력의 placeholder — 미입력 상태에서 실제로 적용 중인 배포 기본값을 광고.
// top-level `const` 는 vm 샌드박스 테스트에서 도달 불가(모듈 렉시컬 스코프)지만 top-level
// function 은 도달 가능 — 미러가 서버 SoT 와 어긋나면 client unit test 가 잡는다.
function budgetPlaceholderMC() {
	return BUDGET_SEED_DEFAULT_MC;
}

/**
 * 예산 1행 — $ 입력(2-decimal 문자열) + invalid 즉시 field-adjacent role=alert (T-MDL-4)
 * + 실측 + ghost default/reset (T-MDL-6), all three in the line slot under the field.
 */
function BudgetRowMC({ view, budget: b, departure, value, defaultValue, error, onChange }) {
	const id = `mc-budget-${b.domain}`;
	const { TableCell, TableRow } = window.UI;
	const meta = BUDGET_META_MC[b.domain] || { label: b.domain };
	// Save banner points at "the highlighted fields" → the field is marked the moment it is invalid.
	const showError = Boolean(error);

	return (
		<TableRow view={view} className="is-top-aligned">
			<TableCell view={view} textRole="label">
				<div className="fs-body font-medium text-ink tbl-first-line">{meta.label}</div>
				<RowHintMC hint={departure} />
			</TableCell>
			<TableCell view={view} textRole="label">
				<span className={`field-affix${showError ? " is-error" : ""}`}>
					<span className="field-affix__sym">$</span>
					<input
						type="text"
						inputMode="decimal"
						className="field tabular-nums text-right"
						value={value}
						placeholder={budgetPlaceholderMC()}
						onChange={(e) => onChange(e.target.value)}
						aria-label={`${meta.label} per-call cap in USD`}
						aria-invalid={showError ? "true" : undefined}
						aria-describedby={showError ? `${id}-error` : undefined}
					/>
				</span>
				<LiveValueMC
					errorId={`${id}-error`}
					error={error}
					value={b.actual ? `$${b.actual}` : null}
					drift={b.drift}
					source={meta.source}
					driftTitle="daemon-config.json differs from the saved cap — press Save again"
					overridden={defaultValue !== undefined && value !== defaultValue}
					savedValue={defaultValue}
					onReset={() => onChange(defaultValue)}
				/>
			</TableCell>
		</TableRow>
	);
}

// Daemon call-tier section — the --effort level and output-token cap per self-improve call.
function TiersSectionMC({
	state,
	tiers,
	isFileRead,
	form,
	baseline,
	errors,
	onTierChange,
}) {
	const { Card, SkeletonRows, Table } = window.UI;
	// server order = TIER_DOMAINS order; an unknown knob renders with fallback meta (never dropped)
	const rows = tiers || [];
	const timing = getApplyTimingMC(rows);

	return (
		<Card
			size="M"
			title="Daemon call tiers"
			sub={timing.meta}
			info={
				<SettingsInfoMC
					caveat={timing.caveat}
					title="What each setting does"
					rows={rows.map((t) => TIER_META_MC[t.domain])}
				/>
			}
			infoLabel={SETTINGS_INFO_LABEL_MC}
			isFlush={state !== "unavailable"}>
			{state === "unavailable" ? (
				<SectionUnavailableMC />
			) : (
				<Table
					caption="Effort level and output-token cap per background call"
					widths={LEDGER_COL_WIDTHS_MC}
					className={LEDGER_TABLE_CLASS_MC}
					bodies={[{ key: "tiers", isBusy: state === "loading", rows: (
						state === "loading" ? (
							<SkeletonRows
								rows={Object.keys(TIER_META_MC).length}
								columns={LEDGER_COL_COUNT_MC}
								rowHeight={LEDGER_ROW_HEIGHT_MC}
							/>
						) : rows.length === 0 ? (view) => (
							<EmptyRowMC
								view={view}
								message="No call tiers reported."
							/>
						) : (view) => (
							rows.map((t) => (
								<TierRowMC
									key={t.domain}
									view={view}
									tier={t}
									departure={timing.departures.get(t.domain)}
									value={form.tiers?.[t.domain] ?? "inherit"}
									defaultValue={baseline?.tiers?.[t.domain] ?? "inherit"}
									error={errors[t.domain]}
									isFileRead={isFileRead}
									onChange={(v) => onTierChange(t.domain, v)}
								/>
							))
						)
					) }]}
				/>
			)}
		</Card>
	);
}

// The unset effort level: a short option label that fits the select, the whole meaning in its title.
const EFFORT_INHERIT_TITLE_MC = `${CLI_DEFAULT_LABEL_MC} — no ${EFFORT_FLAG_MC} flag`;
const EFFORT_OPTIONS_MC = ["inherit", ...EFFORT_LEVELS_MC].map((level) =>
	level === "inherit" ? { key: level, label: CLI_DEFAULT_LABEL_MC, title: EFFORT_INHERIT_TITLE_MC } : { key: level, label: level },
);

/**
 * One knob row — an effort select (CLI default + the five levels) or a token-count field where
 * blank = unset ('inherit'), plus In effect and the saved-value reset.
 */
function TierRowMC({ view, tier: t, departure, value, defaultValue, error, isFileRead, onChange }) {
	const meta = TIER_META_MC[t.domain] || { label: t.domain, kind: "", source: "daemon-config.json" };
	const showError = Boolean(error);
	// absent key = the unset state, not an unread one — unless the file itself was not read
	const live = t.actual ?? (isFileRead ? CLI_DEFAULT_LABEL_MC : null);
	const labelOf = (v) => (v === "inherit" ? CLI_DEFAULT_LABEL_MC : v);
	const { Select, TableCell, TableRow } = window.UI;
	const id = `mc-tier-${t.domain}`;

	return (
		<TableRow view={view} className="is-top-aligned">
			<TableCell view={view} textRole="label">
				<div className="fs-body font-medium text-ink tbl-first-line">{meta.label}</div>
				<RowHintMC hint={departure} />
			</TableCell>
			<TableCell view={view} textRole="label">
				{meta.kind === "effort" ? (
					<Select
						id={id}
						label={`${meta.label} level`}
						isLabelHidden
						isError={showError}
						value={value}
						options={EFFORT_OPTIONS_MC}
						onChange={onChange}
						title={value === "inherit" ? EFFORT_INHERIT_TITLE_MC : value}
						aria-describedby={showError ? `${id}-error` : undefined}
					/>
				) : (
					<input
						type="text"
						inputMode="numeric"
						className={`field tabular-nums${showError ? " is-error" : ""}`}
						value={value === "inherit" ? "" : value}
						placeholder={CLI_DEFAULT_LABEL_MC}
						onChange={(e) => onChange(e.target.value === "" ? "inherit" : e.target.value)}
						aria-label={meta.label}
						aria-invalid={showError ? "true" : undefined}
						aria-describedby={showError ? `${id}-error` : undefined}
					/>
				)}
				{/* a rejected file value is in effect nowhere — the daemon refuses the whole cycle */}
				<LiveValueMC
					errorId={`${id}-error`}
					error={error}
					fileError={t.file_error}
					value={labelOf(live)}
					drift={t.drift}
					source={meta.source}
					driftTitle="daemon-config.json differs from the saved setting — press Save again"
					overridden={value !== defaultValue}
					savedValue={labelOf(defaultValue)}
					onReset={() => onChange(defaultValue)}
				/>
			</TableCell>
		</TableRow>
	);
}

// Save 의 daemon-config.json 결과 공시 — 깨끗이 쓰이지 않은 저장만 (silent skip 금지).
function SurfaceResultCardMC({ result, onDismiss }) {
	const { Card, Icon } = window.UI;

	return (
		<Card
			title="Save touched 1 surface"
			right={
				<button
					className="btn ghost sm"
					onClick={onDismiss}
					aria-label="Dismiss save results">
					<Icon name="x" size={14} />
				</button>
			}>
			<SurfaceResultRowMC result={result} />
		</Card>
	);
}

const SURFACE_STATUS_MC = {
	ok: { word: "Written", tone: "ok" },
	skipped: { word: "Skipped", tone: "warn" },
	failed: { word: "Failed", tone: "crit" },
};

// Words for the status, mono for the surface id alone — a missing reason is left out, never dashed.
function SurfaceResultRowMC({ result: r }) {
	const { Badge, MachineString } = window.UI;
	const status = SURFACE_STATUS_MC[r.status];

	return (
		<div className="flex items-center gap-control fs-meta">
			<Badge role="status" tone={status.tone} icon={true}>
				{status.word}
			</Badge>
			<span className="text-dim truncate min-w-0">
				<MachineString>{r.surface}</MachineString>
			</span>
			{r.reason && <span className="text-faint truncate">{r.reason}</span>}
		</div>
	);
}

// Config drift banner — one remedy, carried here only: file mismatch or any drifted row raises it.
// warn-tone: 구조 정합성 신호 (info-tone 은 architecture 화면 전용).
function DriftBannerMC({ sync, onResync, saving }) {
	const { AlertCard } = window.UI;
	// Remedies differ — Save fixes drift/file-missing/file-invalid, db-setup fixes pending-migration.
	const pendingMigration = sync === "pending-migration";
	const { title, body } = getDriftCopyMC(sync);
	const resync =
		!pendingMigration && onResync ? (
			<button className="btn primary sm" onClick={onResync} disabled={saving}>
				Save again
			</button>
		) : null;

	return <AlertCard tone="warn" title={title} body={body} actions={resync} />;
}

function getDriftCopyMC(sync) {
	if (sync === "pending-migration") return getMigrationCopyMC();
	if (sync === "file-invalid") {
		return {
			title: "The daemon rejects a value in daemon-config.json",
			body: "Every daemon cycle stops until it is rewritten. Save again writes the saved setting over it.",
		};
	}
	return {
		title: "Saved config not yet fully live",
		body: "Save again to rewrite the surfaces that consume these values.",
	};
}

function getMigrationCopyMC() {
	const { MachineString } = window.UI;
	return {
		title: "Config rows still carry their pre-rename names",
		body: (
			<>
				Values below are read from the old rows. Run{" "}
				<MachineString>glass-atrium db-setup</MachineString> to complete the
				rename.
			</>
		),
	};
}

// Discard 확인 다이얼로그 (T-MDL-5) — DetailSurface confirm variant. consequence 문구 명시 +
// red-OUTLINE 확인 버튼(filled .btn.danger 아님 — 파괴 강조는 outline 으로) + secondary 취소.
function DiscardConfirmMC({ onConfirm, onCancel }) {
	const { DetailSurface } = window.UI;

	const footer = (
		<>
			<button
				type="button"
				className="btn ghost sm"
				onClick={onCancel}
				aria-label="Keep editing"
			>
				Keep editing
			</button>
			<button
				type="button"
				className="btn sm"
				onClick={onConfirm}
				style={{
					borderColor: "rgb(var(--crit))",
					color: "rgb(var(--crit))",
					background: "transparent",
				}}
				aria-label="Discard all unsaved changes"
			>
				Discard changes
			</button>
		</>
	);

	return (
		<DetailSurface
			open={true}
			variant="confirm"
			onClose={onCancel}
			suppressOutsideClose
			title="Discard unsaved changes?"
			footer={footer}
		>
			<p className="fs-body text-dim">
				This reverts every field back to the last saved values. Any edits you
				have not saved will be lost — this cannot be undone.
			</p>
		</DetailSurface>
	);
}

// 공통 chrome
function ErrorBannerMC({ title, detail, onRetry }) {
	const { AlertCard, getErrorCopy } = window.UI;
	const copy = getErrorCopy(detail, "");
	const retry = (
		<button className="btn sm" onClick={onRetry} aria-label="Retry">
			Retry
		</button>
	);

	return (
		<AlertCard
			tone="crit"
			title={title}
			body={copy.next}
			details={copy.detail}
			actions={retry}
		/>
	);
}

// Card-head count of unread rows that name no source → such a row renders nothing; a sourced row says it itself.
function UnreadMarkMC({ rows, metaOf }) {
	const count = rows.filter((row) => !row.drift && row.actual == null && !metaOf[row.domain]?.source).length;
	return count === 0 ? null : <HeadMarkMC text={`${count} not read`} />;
}

// One warn glyph + words in a card head — said once per card, never per row.
function HeadMarkMC({ text }) {
	const { Icon } = window.UI;
	return (
		<span className="fs-meta text-dim flex items-center gap-label-inline">
			<Icon name="warn" size={12} className="text-warn" />
			{text}
		</span>
	);
}

// Unavailable must read as 'not read', never as zero — the cause rides the alarm lane.
function SectionUnavailableMC({ message = "Not available — the saved config could not be loaded." }) {
	return <div className="fs-meta text-faint">{message}</div>;
}

// 순수 helper
function buildFormMC(data) {
	const form = {};
	for (const [group, rowsKey] of Object.entries(FORM_GROUP_ROWS_MC)) {
		form[group] = {};
		for (const row of data[rowsKey] || []) {
			// unset knob = the CLI default · unset model or cap = an empty field
			form[group][row.domain] = row.desired ?? (group === "tiers" ? "inherit" : "");
		}
	}
	return form;
}

// 변경분만 PUT (partial 계약) — 변경 없음 = null (Save 비활성 근거).
function diffFormMC(baseline, form) {
	const payload = {};
	for (const group of FORM_GROUPS_MC) {
		const changed = {};
		for (const [key, v] of Object.entries(form[group] || {})) {
			if ((baseline[group] || {})[key] !== v) changed[key] = v;
		}
		if (Object.keys(changed).length > 0) payload[group] = changed;
	}
	return Object.keys(payload).length > 0 ? payload : null;
}

// 클라이언트 측 사전 검증 — 서버 400 의 UX 미러일 뿐 권위는 서버 (validate-all-first 계약).
// bare alias(opus/sonnet/haiku) reject 는 클라 미러 없음 — 서버가 검증 권위 (plan Non-Goals).
function validateFormMC(form, knownModels) {
	const errors = {};

	for (const [domain, value] of Object.entries(form.models)) {
		if (knownModels.includes(value)) continue;
		if (value === "") {
			errors[domain] = "Enter a model id";
		} else if (!FREE_TEXT_MODEL_RE_MC.test(value)) {
			errors[domain] =
				"Lowercase letters, digits, dot, hyphen, brackets only — max 128 chars";
		}
	}

	// per-call 캡은 각각 독립 검증 — daily≤monthly 류의 cross-field 불변식 없음 (단일 호출 캡).
	for (const [key, v] of Object.entries(form.budgets)) {
		if (!BUDGET_RE_MC.test(v)) {
			errors[key] = `Two decimals, $${BUDGET_MIN_USD_MC.toFixed(2)} to $${BUDGET_MAX_USD_MC.toFixed(2)}`;
			continue;
		}
		const n = Number(v);
		if (n < BUDGET_MIN_USD_MC || n > BUDGET_MAX_USD_MC) {
			errors[key] =
				`Must be between $${BUDGET_MIN_USD_MC.toFixed(2)} and $${BUDGET_MAX_USD_MC.toFixed(2)}`;
		}
	}

	// 'inherit' = unset on every knob; a knob this screen has no meta for is left to the server.
	for (const [key, v] of Object.entries(form.tiers || {})) {
		if (v === "inherit") continue;
		const kind = TIER_META_MC[key]?.kind;
		if (kind === "effort" && !EFFORT_LEVELS_MC.includes(v)) {
			errors[key] = `Pick ${CLI_DEFAULT_LABEL_MC} or one of: ${EFFORT_LEVELS_MC.join(", ")}`;
		} else if (kind === "output-cap" && !OUTPUT_CAP_RE_MC.test(v)) {
			errors[key] = "Whole number, 1 to 999999, or blank";
		}
	}

	return errors;
}

function sortDomainsMC(domains) {
	const orderOf = (d) => {
		const i = DOMAIN_ORDER_MC.indexOf(d.domain);
		return i === -1 ? DOMAIN_ORDER_MC.length : i;
	};
	return domains.slice().sort((a, b) => orderOf(a) - orderOf(b));
}

function sortBudgetsMC(budgets) {
	const orderOf = (b) => {
		const i = BUDGET_ORDER_MC.indexOf(b.domain);
		return i === -1 ? BUDGET_ORDER_MC.length : i;
	};
	return budgets.slice().sort((a, b) => orderOf(a) - orderOf(b));
}

// Refresh landing — unsaved edits survive; every untouched field takes the new read.
function getRefreshedFormMC(form, prevData, data) {
	const next = buildFormMC(data);
	if (!form || !prevData) return next;

	const saved = buildFormMC(prevData);
	for (const group of FORM_GROUPS_MC) {
		for (const key of Object.keys(next[group])) {
			const edit = form[group][key];
			if (edit !== undefined && edit !== saved[group][key]) next[group][key] = edit;
		}
	}
	return next;
}

// Banner remedy payload — re-sends the saved target of every drifted row, so the PUT reaches the
// render side effects with nothing edited. Unsaved edits win: the response reinitializes the form
// buffer, so a value left out here would be discarded.
function resyncPayloadMC(data, edits) {
	const fileDrift = (data.daemon_config_sync ?? "ok") !== "ok";
	const payload = {};
	for (const [group, rowsKey] of Object.entries(FORM_GROUP_ROWS_MC)) {
		const targets = {};
		for (const row of data[rowsKey] || []) {
			// a rejected knob with no saved row is rewritten to the CLI default its row shows
			const target = row.desired ?? (row.file_error ? "inherit" : null);
			if ((row.drift || fileDrift) && target) targets[row.domain] = target;
		}
		Object.assign(targets, edits?.[group] || {});
		if (Object.keys(targets).length > 0) payload[group] = targets;
	}
	return Object.keys(payload).length > 0 ? payload : null;
}

// Header token = file sync ∪ any row drift — the same trigger as the banner, so the two never disagree.
function headerSyncMC(data) {
	const rows = [...(data?.domains || []), ...(data?.budgets || [])];
	if (rows.length === 0) return "empty";

	const sync = data?.daemon_config_sync;
	return sync === "ok" && hasRowDriftMC(data) ? "drift" : sync;
}

// Row drift present — banner trigger, true on one drifted row of any form group.
function hasRowDriftMC(data) {
	return Object.values(FORM_GROUP_ROWS_MC).some((rowsKey) => (data?.[rowsKey] || []).some((r) => r.drift));
}

// A clean write → null: a clean save is announced by the toast alone.
function getSurfaceProblemMC(data) {
	return data.surfaces.find((r) => r.status !== "ok") ?? null;
}

// Unsaved count = fields in the partial PUT payload, so the wording matches what is sent.
function countChangesMC(payload) {
	if (!payload) return 0;
	return FORM_GROUPS_MC.reduce((n, group) => n + Object.keys(payload[group] || {}).length, 0);
}

async function fetchJsonMC(url, signal) {
	const res = await fetch(url, {
		signal,
		headers: { Accept: "application/json" },
	});
	if (!res.ok) throw await window.UI.getFetchError(res);
	return res.json();
}

async function putJsonMC(url, payload) {
	const res = await fetch(url, {
		method: "PUT",
		headers: { "content-type": "application/json", Accept: "application/json" },
		body: JSON.stringify(payload),
	});
	if (!res.ok) throw await window.UI.getFetchError(res, SAVE_ERROR_BODY_MAX_MC);
	return res.json();
}

window.ScreenModelConfig = ScreenModelConfig;
