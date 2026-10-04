// Screen 12 — Models & budgets (/api/model-config GET 단일 fetch + 명시 Save PUT).
// Layout: header sync token → page verdict → model ledger | per-call budget cap ledger (side by side at xl).
// DB(saved target) = UI SoT · actual = 소비 지점 실측 — 차이는 drift 배지로 공시 (spec doc 36166 D2).
// 예산 = per-call HARD CAP (claude -p --max-budget-usd) — OAuth 구독이라 월 청구 상한이 아님 (단일 폭주 호출 차단).
// Hooks MC-suffix aliased — window-scope 충돌 방지.
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
// free-text escape hatch — 소문자 alnum + dot/hyphen/bracket ≤128 (PUT 검증 계약).
const FREE_TEXT_MODEL_RE_MC = /^[a-z0-9.\-[\]]{1,128}$/;
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

const CUSTOM_OPTION_MC = "__custom__";

// 모델별 1줄 역량 설명 — radio-card 옵션 보조 라벨 (T-MDL-3). GET 응답에 없는 표시 파생값이라 UI 상수.
const MODEL_CAP_MC = {
	"claude-opus-5-5": "Latest Opus — agentic coding, long-horizon work",
	"claude-opus-5": "Prior Opus — agentic coding, superseded by 5.5",
	"claude-fable-5-1": "Highest capability — deep reasoning, long-horizon agents",
	"claude-fable-5": "Prior Fable — deep reasoning, superseded by 5.1",
	"claude-opus-4-8": "Strong default — implementation, review, design",
	"claude-sonnet-5-5": "Latest Sonnet — balanced speed/cost",
	"claude-sonnet-5": "Prior Sonnet — balanced speed/cost, superseded by 5.5",
	"claude-sonnet-4-6": "Balanced — fast turnaround on mid-complexity work",
	"claude-haiku-4-5": "Fastest / cheapest — simple, repetitive file ops",
	inherit: "Follows the session model — the agent file carries no model line",
};
// 도메인 표시 메타 — 라벨/1줄 힌트/전문 설명/옵션 구성
// (GET 응답에 없는 파생 표시값이라 UI 상수로 유지).
const DOMAIN_META_MC = {
	"model.dev": {
		label: "Dev agents",
		hint: "Code implementation across the dev fleet",
		desc: "Every dev agent file — React, NestJS, Python, DB, shell and the rest of the fleet",
		editable: true,
		inherit: true,
	},
	"model.research": {
		label: "Research agent",
		hint: "Web and codebase research",
		desc: "Source collection, verification and synthesis",
		source: "glass-atrium-intel-researcher",
		editable: true,
		inherit: true,
	},
	"model.meta": {
		label: "Meta agent",
		hint: "Rewrites agent instructions",
		desc: "The self-improvement loop's rewriter, so its model shapes how well every agent evolves",
		source: "glass-atrium-meta-agent",
		editable: true,
		inherit: true,
	},
	"model.wiki": {
		label: "Wiki curator",
		hint: "Wiki compilation and index writes",
		desc: "The sole wiki writer, also running health checks and raw-ingestion validation",
		source: "glass-atrium-wiki-curator",
		editable: true,
		inherit: true,
	},
	"model.review": {
		label: "Review",
		hint: "Code review and bug diagnosis",
		desc: "Also plan direction review — one save writes both agent files",
		editable: true,
		inherit: true,
	},
	"model.docs": {
		label: "Documents",
		hint: "Reports and plans",
		desc: "One save writes both agent files",
		editable: true,
		inherit: true,
	},
	"model.daemon_cycle_worker": {
		label: "Daemon cycle helper",
		hint: "Background daemon housekeeping steps",
		desc: "Drafts self-improve proposals, runs pre-verify and summarizes wiki notes",
		source: "daemon-config.json",
		editable: true,
		inherit: false,
	},
};

// 테이블 행 순서 — 미지의 도메인(서버가 먼저 확장된 경우)은 뒤에 그대로 덧붙임 (silent drop 금지).
const DOMAIN_ORDER_MC = [
	"model.dev",
	"model.research",
	"model.meta",
	"model.wiki",
	"model.review",
	"model.docs",
	"model.daemon_cycle_worker",
];

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
	ok: {
		label: "In sync",
		tone: "ok",
		desc: "daemon-config.json matches the saved settings",
	},
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
	empty: {
		label: "Nothing to sync",
		tone: "neutral",
		desc: "no model domains or budget caps were reported, so there is nothing to compare",
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

// 예산 도메인 표시 메타 — 라벨/평이 설명. key = GET budgets[].domain (BudgetDomainKey).
// 미지의 key(서버 먼저 확장)는 fallback 메타로 그대로 렌더 (silent drop 금지).
const BUDGET_META_MC = {
	"budget.worker_max_usd": {
		label: "Self-improve + wiki call cap",
		hint: "Caps one self-improve generation or wiki compile call",
		desc: "Shared cap: generation + wiki compile",
		source: "daemon-config.json",
	},
	"budget.pre_verify_max_usd": {
		label: "Self-improve pre-verify call cap",
		hint: "Caps one self-improve pre-verify call",
		desc: "Read by the pre-verify step only",
		source: "daemon-config.json",
	},
};

// Tier-knob display meta — key = GET tiers[].domain; kind picks the control and the client check.
// Labels name the self-improve calls only: wiki compile reads neither knob.
const TIER_META_MC = {
	"tier.worker_effort": {
		label: "Self-improve generation effort",
		hint: "--effort on one self-improve generation call",
		desc: "Default: no --effort flag",
		note: "With no flag, the settings or model default governs the call",
		kind: "effort",
		source: "daemon-config.json",
	},
	"tier.pre_verify_effort": {
		label: "Self-improve pre-verify effort",
		hint: "--effort on one self-improve pre-verify call",
		desc: "Default: no --effort flag",
		note: "Keep pre-verify at or above the generation level",
		kind: "effort",
		source: "daemon-config.json",
	},
	"tier.worker_max_output_tokens": {
		label: "Self-improve generation output cap",
		hint: "Max output tokens for one generation call",
		desc: "Sets CLAUDE_CODE_MAX_OUTPUT_TOKENS",
		note: "The CLI silently lowers a value above the model's own limit",
		kind: "output-cap",
		source: "daemon-config.json",
	},
	"tier.pre_verify_max_output_tokens": {
		label: "Self-improve pre-verify output cap",
		hint: "Max output tokens for one pre-verify call",
		desc: "Sets CLAUDE_CODE_MAX_OUTPUT_TOKENS for pre-verify",
		note: "Blank = the model default",
		kind: "output-cap",
		source: "daemon-config.json",
	},
};

// Settled ledger row height at 1440 — skeleton rows hold the table's height until the read lands.
const LEDGER_ROW_HEIGHT_MC = 60;
// PUT validation answers name the rejected field — kept longer than a GET error body for Details.
const SAVE_ERROR_BODY_MAX_MC = 300;

// 테이블 행 순서 — 미지의 도메인은 뒤에 그대로 덧붙임.
const BUDGET_ORDER_MC = ["budget.worker_max_usd", "budget.pre_verify_max_usd"];

// Verdict chips scroll to these ledger ids.
const MODELS_SECTION_ID_MC = "mc-models";
const BUDGETS_SECTION_ID_MC = "mc-budgets";

const MODEL_FAMILY_RE_MC = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?$/;

// What the "In effect" column reads back — the targets a saved value is written to.
const IN_EFFECT_TITLE_MC = {
	models: "Read back from the agent files and daemon-config.json",
	budgets: "Read back from daemon-config.json",
	tiers: "Read back from daemon-config.json",
};

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
		PageVerdict,
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
	const [surfaceResults, setSurfaceResults] = useStateMC(null);
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
	// SoT unreadable fail-open 시 [] (D3) — 옵션은 inherit/custom 만 남고 free-text 로 입력 가능.
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
		setSurfaceResults(null);
		// the PUT answer supersedes an in-flight read → that read must not land over it
		abortRef.current?.abort();
		try {
			// PUT 응답 = GET shape + per-surface 결과 → 응답으로 화면/버퍼 재초기화 (재fetch 불요).
			const data = await putJsonMC("/api/model-config", body);
			setConfigState((s) => putRegionData(putRegionRequest(s, "save", body), body, data));
			setForm(buildFormMC(data));
			setAsOfAt(Date.now());
			const problems = extractSurfaceResultsMC(data);
			setSurfaceResults(problems);
			// Only a clean save ends in a toast — a failed or skipped surface gets the card instead.
			if (!problems) showToast("ok", "Changes saved");
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

	const ready = configState.status === "ready" && form !== null;
	const data = configState.data;
	// Banner trigger = any row drift, not the file-sync state alone — the banner carries the remedy the rows no longer do.
	const showDrift =
		ready && (data.daemon_config_sync !== "ok" || hasRowDriftMC(data));
	// The banner's remedy must be pressable at the moment it fires: a drifted row is clean against
	// the form buffer, so the sticky Save bar is absent exactly then.
	const resyncPayload = ready ? resyncPayloadMC(data, payload) : null;
	const hasAlarm = Boolean(
		configState.error || saveError || showDrift || surfaceResults,
	);
	// state prop per section rather than a lifted header — both keep the headers in every state
	// → the smaller diff wins (plan Open Question: implementer's call).
	const sectionState = ready
		? "ready"
		: configState.status === "loading"
			? "loading"
			: "unavailable";
	const verdict = ready ? getPageVerdictMC(data) : null;
	const freshness = getFreshnessInputMC(asOfAt, configState);
	// a failed reload leaves held rows on screen → their match is as of the last good read, not now
	const isStale = configState.error != null;

	return (
		<div className="flex flex-col min-w-0">
			<TypeScaleStyle />
			<div className="flex-shrink-0">
				<PageHeader
					title="Models & budgets"
					right={
						<>
							<SyncTokenMC
								state={configState.status}
								sync={headerSyncMC(data)}
								freshness={freshness}
							/>
							<FreshnessStamp {...freshness} />
							<RefreshButton
								isBusy={configState.busy}
								hasRead={asOfAt !== null}
								onRefresh={triggerRefresh}
								label="Reload model config"
							/>
						</>
					}
				/>
			</div>

			{/* mounted in every state → a screen reader hears the Refresh/Retry outcome when the text lands */}
			<div className="sr-only" role="status" aria-live="polite">
				{getReadAnnouncementMC(configState, asOfAt, refreshTick)}
			</div>

			{verdict && (
				<PageVerdict
					{...getVerdictFreshnessMC(verdict.tone, asOfAt, configState)}
					chips={verdict.chips}
					className="mb-4">
					{verdict.text}
				</PageVerdict>
			)}

			{hasAlarm && (
				<div
					className="mb-4 flex flex-col gap-3"
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
								<p className="fs-meta text-dim mt-1">
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
					{surfaceResults && (
						<SurfaceResultsCardMC
							results={surfaceResults}
							onDismiss={() => setSurfaceResults(null)}
						/>
					)}
				</div>
			)}

			{/* 1:1 over 2:1 — a third-width column overflows the cap and tier fields at 1280 */}
			<SplitRow ratio="1:1" layout="equal">
				<DomainsSectionMC
					state={sectionState}
					domains={data?.domains}
					knownModels={knownModels}
					form={form}
					baseline={baseline}
					errors={errors}
					isStale={isStale}
					onModelChange={setModel}
				/>
				<SplitColumn>
					<BudgetsSectionMC
						state={sectionState}
						budgets={data?.budgets}
						form={form}
						baseline={baseline}
						errors={errors}
						isStale={isStale}
						onBudgetChange={setBudget}
					/>
					<TiersSectionMC
						state={sectionState}
						tiers={data?.tiers}
						isFileRead={data?.daemon_config_sync !== "file-missing"}
						form={form}
						baseline={baseline}
						errors={errors}
						isStale={isStale}
						onTierChange={setTier}
					/>
				</SplitColumn>
			</SplitRow>

			{ready && isDirty && (
				<div className="save-banner" role="region" aria-label="Unsaved changes">
					<div className="flex items-center gap-2 min-w-0">
						<span className="fs-body font-medium text-ink">
							{changeCount} unsaved change
							{changeCount === 1 ? "" : "s"}
						</span>
						{hasErrors && (
							<span className="fs-meta text-crit">
								<span aria-hidden="true">✕ </span>
								fix the highlighted fields before saving
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

	// the freshness stamp beside it already reads '… loading' → one ellipsis, not two
	if (state === "loading") return null;
	if (state !== "ready") {
		return <span className="fs-meta text-faint">Sync state unavailable</span>;
	}

	const meta = SYNC_META_MC[sync] || {
		label: sync || "—",
		desc: "",
		tone: "neutral",
	};

	// a read the stamp calls stale takes the shared 'Last known' wording, never a settled 'In sync'
	const label = freshness
		? getFreshnessVerdict({ ...freshness, tone: meta.tone, label: meta.label }).label
		: meta.label;
	// the freshness stamp owns the one tick → only a state needing action spends a glyph
	const glyph = sync === "ok" || sync === "empty" ? null : "warn";

	return (
		<span
			className="fs-meta text-dim flex items-center gap-1.5"
			title={meta.desc}>
			{glyph && (
				<Icon
					name={glyph}
					size={12}
					className={glyph === "warn" ? "text-warn" : "text-dim"}
				/>
			)}
			<span>{label}</span>
		</span>
	);
}

function getFreshnessInputMC(asOfAt, state) {
	return { at: asOfAt, regions: [state] };
}

// A warm error's alert already dates the last good read → the verdict settles to 'Last known' without its own age note.
function getVerdictFreshnessMC(tone, asOfAt, state) {
	const freshness = getFreshnessInputMC(asOfAt, state);
	if (state.error == null) return { tone, freshness };

	const verdict = window.UI.getFreshnessVerdict({ ...freshness, tone });
	return { tone: verdict.tone, label: verdict.label };
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
	return (
		<div className="flex flex-col gap-3 fs-body">
			{caveat && <p>{caveat}</p>}
			{lead && <p>{lead}</p>}
			<TierNotesMC title={title} rows={rows} />
		</div>
	);
}

// One column grid for both ledgers — content-sized cells let the Live columns drift apart.
const LEDGER_COL_WIDTHS_MC = ["36%", "32%", "32%"];
// Skeleton columns + empty-row colSpan for both ledgers.
const LEDGER_COL_COUNT_MC = LEDGER_COL_WIDTHS_MC.length;
const LEDGER_TABLE_STYLE_MC = { tableLayout: "fixed" };
// One line of fs-meta — the saved/reset slot holds this height while empty.
const SAVED_LINE_STYLE_MC = { minHeight: "1.5em" };
// The page's one link token — section link and inline reset read alike.
const LINK_CLASS_MC = "text-dim underline underline-offset-2";

function LedgerColsMC() {
	return (
		<colgroup>
			{LEDGER_COL_WIDTHS_MC.map((width, i) => (
				<col key={i} style={{ width }} />
			))}
		</colgroup>
	);
}

// 모델 도메인 섹션 — 편집값(Model) vs 실측(Live) + 반영 시점.
function DomainsSectionMC({
	state,
	domains,
	knownModels,
	form,
	baseline,
	errors,
	isStale,
	onModelChange,
}) {
	const { Card, SkeletonRows, TableHead } = window.UI;
	const rows = sortDomainsMC(domains || []);
	const mix = form ? getModelMixMC(rows.map((d) => form.models[d.domain] || d.desired)) : "";
	const timing = getApplyTimingMC(rows);

	return (
		<div id={MODELS_SECTION_ID_MC}>
			<Card
				size="L"
				title="Model assignment"
				sub={timing.meta}
				info={
					<SettingsInfoMC
						caveat={timing.caveat}
						title="Who each tier covers"
						rows={rows.map((d) => DOMAIN_META_MC[d.domain])}
					/>
				}
				infoLabel={SETTINGS_INFO_LABEL_MC}
				right={
					<a href="#cost" className={`fs-meta ${LINK_CLASS_MC}`}>
						Cost & usage
					</a>
				}
				foot={mix ? <span className="truncate min-w-0" title={mix}>{mix}</span> : null}
				isFlush={state !== "unavailable"}>
				{state === "unavailable" ? (
					<SectionUnavailableMC />
				) : (
					<table className="tbl" style={LEDGER_TABLE_STYLE_MC}>
						<caption className="sr-only">Model assignment per agent tier</caption>
						<LedgerColsMC />
						<thead>
							<tr>
								<TableHead>Agent tier</TableHead>
								<TableHead>Model</TableHead>
								<TableHead>
									<span title={IN_EFFECT_TITLE_MC.models}>In effect</span>
								</TableHead>
							</tr>
						</thead>
						<tbody aria-busy={state === "loading" ? "true" : undefined}>
							{state === "loading" ? (
								<SkeletonRows
									rows={DOMAIN_ORDER_MC.length}
									columns={LEDGER_COL_COUNT_MC}
									rowHeight={LEDGER_ROW_HEIGHT_MC}
								/>
							) : rows.length === 0 ? (
								<EmptyRowMC
									colSpan={LEDGER_COL_COUNT_MC}
									message="No model domains reported."
								/>
							) : (
								rows.map((d) => (
									<DomainRowMC
										key={d.domain}
										domain={d}
										departure={timing.departures.get(d.domain)}
										knownModels={knownModels}
										value={form.models[d.domain] ?? ""}
										defaultValue={baseline?.models[d.domain] ?? ""}
										error={errors[d.domain]}
										isStale={isStale}
										onChange={(v) => onModelChange(d.domain, v)}
									/>
								))
							)}
						</tbody>
					</table>
				)}
			</Card>
		</div>
	);
}

// Empty roster — states zero rows explicitly, so it never reads as a failed load.
function EmptyRowMC({ colSpan, message }) {
	return (
		<tr>
			<td colSpan={colSpan}>
				<div className="fs-meta text-faint">{message}</div>
			</td>
		</tr>
	);
}

function RowHintMC({ hint }) {
	if (!hint) return null;

	return <div className="fs-meta text-faint is-wrap">{hint}</div>;
}

// Full descriptions in one labelled list per section — a note per row repeats one affordance N times.
function TierNotesMC({ title, rows }) {
	const { SectionLabel } = window.UI;
	const notes = rows.filter((meta) => meta?.desc && meta.desc !== meta.hint);
	if (notes.length === 0) return null;

	return (
		<section className="text-dim" aria-label={title}>
			<SectionLabel level={3}>{title}</SectionLabel>
			<dl className="mt-1 flex flex-col gap-2">
				{notes.map((meta) => (
					<div key={meta.label}>
						<dt className="text-ink">{meta.label}</dt>
						<dd className="is-wrap">{meta.desc}</dd>
						{meta.note && <dd className="is-wrap">{meta.note}</dd>}
					</div>
				))}
			</dl>
		</section>
	);
}

// payload carries no resolved session model → name the source an inherit value follows
const INHERIT_LIVE_LABEL_MC = {
	inherit: "session model (inherit)",
	"inherit (settings.json)": "settings.json model (inherit)",
};

function liveLabelMC(value) {
	return INHERIT_LIVE_LABEL_MC[value] ?? value;
}

// [model label, files[]] in first-seen order — the model is the parity proof, so it is shown whole once.
function groupFilesByModelMC(fileRows) {
	const groups = new Map();
	for (const f of fileRows) {
		const model = liveLabelMC(f.model ?? "inherit");
		groups.set(model, [...(groups.get(model) ?? []), f.file]);
	}
	return [...groups];
}

// Files toggle at the control radius every other pill uses, not the 12px card fold.
const FILES_PILL_STYLE_MC = { borderRadius: "var(--radius-control)" };

// source = an agent name or a config file name — kept a flat string so the meta tables stay one level deep.
function isConfigFileMC(source) {
	return /\.json$/.test(source);
}

// Agent file ("agents/glass-atrium-dev-react.md") → its agent name, for the shared name atom.
function getFileAgentNameMC(file) {
	const base = String(file ?? "").split("/").pop();
	return base.replace(/\.md$/, "");
}

/**
 * In effect = measured at the consumption point.
 * Matching the saved target → ✓ 'Matches saved' (tooltip 'In effect: …') · differing → the value + one warn badge · absent → nothing.
 * A failed reload dates the match to the last good read · no file list → names the source, or that it yielded no value.
 */
function LiveValueMC({ value, drift, files, source, isStale, driftTitle }) {
	const { AgentName, Badge, Icon } = window.UI;
	const fileRows = Array.isArray(files) ? files : [];
	const isSteady = !drift && value != null;
	const label = liveLabelMC(value);
	const fileGroups = groupFilesByModelMC(fileRows);
	// files lagging the saved model or disagreeing among themselves → the fold opens itself
	const isFoldAlerting = drift || fileGroups.length > 1;

	return (
		<div className="flex flex-col gap-1 min-w-0">
			<div className="flex items-center gap-2 min-w-0">
				{isSteady && isStale ? (
					<span className="fs-meta text-faint" title={`At the last good read: ${label}`}>
						Matched at last read
					</span>
				) : isSteady ? (
					<span className="fs-meta text-faint flex items-center gap-1" title={`In effect: ${label}`}>
						<Icon name="check" size={12} className="text-ok" />
						Matches saved
					</span>
				) : (
					value != null && (
						<span className="font-mono fs-meta truncate text-ink" title={label}>
							{label}
						</span>
					)
				)}
				{drift && (
					<span title={driftTitle}>
						<Badge role="status" tone="warn" icon={true} className="pill--ctl-h">
							drift
						</Badge>
					</span>
				)}
			</div>
			{fileRows.length > 0 && (
				<details className="fs-meta" open={isFoldAlerting || undefined}>
					<summary
						className="inline-flex items-center gap-1 px-2 border border-line text-dim hover:text-ink cursor-pointer"
						style={FILES_PILL_STYLE_MC}>
						{isFoldAlerting && <Icon name="warn" size={12} className="text-warn" />}
						{`${fileRows.length} ${fileRows.length === 1 ? "file" : "files"}`}
						<Icon name="chevron-down" size={12} className="chevron" />
					</summary>
					<div
						className="text-faint flex flex-col gap-1 mt-1"
						role="region"
						aria-label={`${fileRows.length} agent files`}>
						{fileGroups.map(([model, files]) => (
							<div key={model}>
								<div className="font-mono text-dim is-wrap">{model}</div>
								<div className="font-mono flex flex-wrap gap-x-3 pl-3">
									{files.map((file) => (
										<AgentName key={file} name={getFileAgentNameMC(file)} />
									))}
								</div>
							</div>
						))}
					</div>
				</details>
			)}
			{fileRows.length === 0 && source && (
				<div className="fs-meta text-faint">
					{/* null live value = source unreadable or key missing → never claim a read */}
					{value != null ? "Read from" : "No value read from"}{" "}
					{isConfigFileMC(source) ? <span className="font-mono">{source}</span> : <AgentName name={source} />}
				</div>
			)}
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
	domain: d,
	departure,
	knownModels,
	value,
	defaultValue,
	error,
	isStale,
	onChange,
}) {
	const { Badge } = window.UI;
	const meta = DOMAIN_META_MC[d.domain] || {
		label: d.domain,
		hint: "",
		desc: "",
		editable: d.editable !== false,
	};
	// 서버 editable=false 가 우선 — UI 메타와 어긋나면 보수적으로 read-only.
	const editable = d.editable !== false && meta.editable !== false;

	// 행 간격 10px(상하 5px) — 라벨/컨트롤 묶음이 개별 행으로 읽히게.
	const cellPad = { paddingTop: 5, paddingBottom: 5 };

	return (
		<tr className="is-grouped" style={{ verticalAlign: "top" }}>
			<td style={cellPad}>
				<div className="fs-body font-medium text-ink">{meta.label}</div>
				<RowHintMC hint={meta.hint} />
				<RowHintMC hint={departure} />
			</td>
			<td style={cellPad}>
				{editable ? (
					<ModelSelectMC
						domain={d.domain}
						knownModels={knownModels}
						value={value}
						defaultValue={defaultValue}
						error={error}
						onChange={onChange}
					/>
				) : (
					// read-only fallback 배지 — <select> 자리를 그대로 차지하므로 같은 높이라야 컬럼 리듬이 유지된다.
					(value || d.desired) && (
						<Badge role="metadata" className="pill--ctl-h">
							{value || d.desired}
						</Badge>
					)
				)}
				<PricingNoteMC pricingKnown={d.pricing_known} />
			</td>
			<td style={cellPad}>
				<LiveValueMC
					value={d.actual}
					drift={d.drift}
					files={d.files}
					source={meta.source}
					isStale={isStale}
					driftTitle="Live value differs from the saved target — press Save again"
				/>
			</td>
		</tr>
	);
}

// 모델 선택 = 컴팩트 native <select>(.field-select) + 선택 옵션의 capability descriptor 1줄 +
// custom free-text escape hatch. 목록 외 값(빈 문자열 포함) = custom 모드 → CUSTOM_OPTION_MC 표시값.
// 옵션 = GET known_models (+ inherit) 규모라 세로 카드 스택 대신 1행 콤보가 적합 (옵션 多 → dropdown 패턴).
// ghost default + reset (T-MDL-6): 저장된 baseline 과 다르면 ghost 라벨 + 되돌리기 링크.
function ModelSelectMC({
	domain,
	knownModels,
	value,
	defaultValue,
	error,
	onChange,
}) {
	const options = modelOptionsMC(domain, knownModels);
	const isListed = options.includes(value);
	const isCustom = !isListed;
	const meta = DOMAIN_META_MC[domain];
	const label = meta ? meta.label : domain;
	// overridden = 편집값이 저장된 baseline 과 다름 → ghost+reset 노출 게이트 (T-MDL-6).
	const overridden = defaultValue !== undefined && value !== defaultValue;

	const handleSelect = (e) => {
		const opt = e.target.value;
		// '__custom__' 진입 = 빈 문자열로 custom 모드 시작 (기존 custom 버튼과 동일 동작).
		if (opt === CUSTOM_OPTION_MC) {
			if (!isCustom) onChange("");
			return;
		}
		onChange(opt);
	};

	return (
		<div>
			{/* error ring 은 custom 모드에선 아래 input 이 소유 → select 는 !isCustom 일 때만 is-error
          (이중 --crit ring 회피, dual-encoding 텍스트 메시지는 양쪽 공통 유지). */}
			<select
				className={`field field-select field--mono${error && !isCustom ? " is-error" : ""}`}
				value={isCustom ? CUSTOM_OPTION_MC : value}
				onChange={handleSelect}
				aria-label={`${label} model`}
			>
				{options.map((opt) => (
					<option key={opt} value={opt} title={MODEL_CAP_MC[opt] || undefined}>
						{opt === "inherit" ? "session model (inherit)" : opt}
					</option>
				))}
				<option value={CUSTOM_OPTION_MC}>custom…</option>
			</select>
			{isCustom && (
				<input
					type="text"
					className={`field field--mono mt-1${error ? " is-error" : ""}`}
					value={value}
					placeholder="model id (lowercase)"
					onChange={(e) => onChange(e.target.value)}
					aria-label={`${label} custom model id`}
				/>
			)}
			<ModelFamilyTagMC model={value} />
			{error && (
				<div className="fs-meta text-crit mt-1" role="alert">
					<span aria-hidden="true">✕ </span>
					{error}
				</div>
			)}
			<GhostResetMC
				overridden={overridden}
				defaultValue={defaultValue}
				onReset={() => onChange(defaultValue)}
			/>
		</div>
	);
}

// Text tag, not colour alone — the family reads without parsing the id; inherit is already worded in the select.
function ModelFamilyTagMC({ model }) {
	if (model === "inherit") return null;

	const family = getModelFamilyMC(model);
	if (!family) return null;

	return (
		<div data-slot="family" className="fs-meta text-dim mt-1">
			{family}
		</div>
	);
}

// Unpriced tier only — the section header carries the one Cost & usage link.
function PricingNoteMC({ pricingKnown }) {
	const { TONE_GLYPH } = window.UI;
	if (pricingKnown !== false) return null;

	return (
		<div className="fs-meta mt-1 text-dim">
			<span className="text-warn" aria-hidden="true">
				{TONE_GLYPH.warn}
			</span>{" "}
			No price listed — billed at the conservative fallback rate
		</div>
	);
}

// Saved value + reset, model/budget 공용 — the slot renders even when empty so an edit never grows the row.
function GhostResetMC({ overridden, defaultValue, onReset }) {
	return (
		<div
			data-slot="saved-line"
			className="fs-meta text-faint mt-1 flex items-center gap-1.5 flex-wrap"
			style={SAVED_LINE_STYLE_MC}
		>
			{overridden && (
				<>
					{defaultValue && (
						<>
							<span>Saved:</span>
							<span className="font-mono text-dim">{defaultValue}</span>
						</>
					)}
					<button
						type="button"
						className={LINK_CLASS_MC}
						onClick={onReset}
						aria-label="Reset this field to the saved value"
					>
						Reset
					</button>
				</>
			)}
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
	isStale,
	onBudgetChange,
}) {
	const { Card, SkeletonRows, TableHead } = window.UI;
	const rows = sortBudgetsMC(budgets || []);
	const timing = getApplyTimingMC(rows);

	return (
		<div id={BUDGETS_SECTION_ID_MC}>
			<Card
				size="M"
				title="Per-call budget caps"
				sub={timing.meta}
				info={
					<SettingsInfoMC
						caveat={timing.caveat}
						lead="A cap that trips aborts the runaway call."
						title="When a cap trips"
						rows={rows.map((b) => BUDGET_META_MC[b.domain])}
					/>
				}
				infoLabel={SETTINGS_INFO_LABEL_MC}
				isFlush={state !== "unavailable"}>
				{state === "unavailable" ? (
					<SectionUnavailableMC />
				) : (
					<table className="tbl" style={LEDGER_TABLE_STYLE_MC}>
						<caption className="sr-only">Per-call budget cap per background call</caption>
						<LedgerColsMC />
						<thead>
							<tr>
								<TableHead>Background call</TableHead>
								<TableHead>Per-call cap</TableHead>
								<TableHead>
									<span title={IN_EFFECT_TITLE_MC.budgets}>In effect</span>
								</TableHead>
							</tr>
						</thead>
						<tbody aria-busy={state === "loading" ? "true" : undefined}>
							{state === "loading" ? (
								<SkeletonRows
									rows={2}
									columns={LEDGER_COL_COUNT_MC}
									rowHeight={LEDGER_ROW_HEIGHT_MC}
								/>
							) : rows.length === 0 ? (
								<EmptyRowMC
									colSpan={LEDGER_COL_COUNT_MC}
									message="No budget caps reported."
								/>
							) : (
								rows.map((b) => (
									<BudgetRowMC
										key={b.domain}
										budget={b}
										departure={timing.departures.get(b.domain)}
										value={form.budgets[b.domain] ?? ""}
										defaultValue={baseline?.budgets[b.domain] ?? ""}
										error={errors[b.domain]}
										isStale={isStale}
										onChange={(v) => onBudgetChange(b.domain, v)}
									/>
								))
							)}
						</tbody>
					</table>
				)}
			</Card>
		</div>
	);
}

// per-call 상한 입력의 placeholder — 미입력 상태에서 실제로 적용 중인 배포 기본값을 광고.
// top-level `const` 는 vm 샌드박스 테스트에서 도달 불가(모듈 렉시컬 스코프)지만 top-level
// function 은 도달 가능 — 미러가 서버 SoT 와 어긋나면 client unit test 가 잡는다.
function budgetPlaceholderMC() {
	return BUDGET_SEED_DEFAULT_MC;
}

// Mono digits → ch is one digit; 6ch holds the widest cap ("50.00") plus the caret, beside the affix padding.
const BUDGET_FIELD_STYLE_MC = { width: "calc(6ch + 4px + var(--ctl-pad-x))" };

/**
 * 예산 1행 — $ 입력(2-decimal 문자열) + invalid 즉시 field-adjacent role=alert (T-MDL-4)
 * + 실측 + ghost default/reset (T-MDL-6).
 */
function BudgetRowMC({ budget: b, departure, value, defaultValue, error, isStale, onChange }) {
	const meta = BUDGET_META_MC[b.domain] || { label: b.domain, hint: "", desc: "" };
	// Save banner points at "the highlighted fields" → the field is marked the moment it is invalid.
	const showError = Boolean(error);
	const overridden = defaultValue !== undefined && value !== defaultValue;

	return (
		<tr className="is-grouped" style={{ verticalAlign: "top" }}>
			<td>
				<div className="fs-body">{meta.label}</div>
				<RowHintMC hint={meta.hint} />
				<RowHintMC hint={departure} />
			</td>
			<td>
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span className={`field-affix flex-shrink-0${showError ? " is-error" : ""}`}>
						<span className="field-affix__sym">$</span>
						<input
							type="text"
							inputMode="decimal"
							className="field field--mono text-right"
							style={BUDGET_FIELD_STYLE_MC}
							value={value}
							placeholder={budgetPlaceholderMC()}
							onChange={(e) => onChange(e.target.value)}
							aria-label={`${meta.label} per-call cap in USD`}
							aria-invalid={showError ? "true" : undefined}
						/>
					</span>
					{/* cost/outcome payload carries no per-call maximum → Cost & usage is the reference point */}
					<a
						href="#cost"
						className={`fs-meta ${LINK_CLASS_MC}`}
						aria-label={`Recent ${meta.label} costs on Cost & usage`}>
						Recent costs
					</a>
				</div>
				{showError && (
					<div className="fs-meta text-crit mt-1" role="alert">
						<span aria-hidden="true">✕ </span>
						{error}
					</div>
				)}
				<GhostResetMC
					overridden={overridden}
					defaultValue={defaultValue}
					onReset={() => onChange(defaultValue)}
				/>
			</td>
			<td>
				<LiveValueMC
					value={b.actual ? `$${b.actual}` : null}
					drift={b.drift}
					source={meta.source}
					isStale={isStale}
					driftTitle="daemon-config.json differs from the saved cap — press Save again"
				/>
			</td>
		</tr>
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
	isStale,
	onTierChange,
}) {
	const { Card, SkeletonRows, TableHead } = window.UI;
	// server order = TIER_DOMAINS order; an unknown knob renders with fallback meta (never dropped)
	const rows = tiers || [];
	const timing = getApplyTimingMC(rows);

	// last card of the stretched caps column → takes the slack so the column ends with the model card
	return (
		<Card
			size="M"
			className="flex-auto"
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
				<table className="tbl" style={LEDGER_TABLE_STYLE_MC}>
					<caption className="sr-only">Effort level and output-token cap per background call</caption>
					<LedgerColsMC />
					<thead>
						<tr>
							<TableHead>Background call</TableHead>
							<TableHead>Setting</TableHead>
							<TableHead>
								<span title={IN_EFFECT_TITLE_MC.tiers}>In effect</span>
							</TableHead>
						</tr>
					</thead>
					<tbody aria-busy={state === "loading" ? "true" : undefined}>
						{state === "loading" ? (
							<SkeletonRows
								rows={Object.keys(TIER_META_MC).length}
								columns={LEDGER_COL_COUNT_MC}
								rowHeight={LEDGER_ROW_HEIGHT_MC}
							/>
						) : rows.length === 0 ? (
							<EmptyRowMC
								colSpan={LEDGER_COL_COUNT_MC}
								message="No call tiers reported."
							/>
						) : (
							rows.map((t) => (
								<TierRowMC
									key={t.domain}
									tier={t}
									departure={timing.departures.get(t.domain)}
									value={form.tiers?.[t.domain] ?? "inherit"}
									defaultValue={baseline?.tiers?.[t.domain] ?? "inherit"}
									error={errors[t.domain]}
									isFileRead={isFileRead}
									isStale={isStale}
									onChange={(v) => onTierChange(t.domain, v)}
								/>
							))
						)}
					</tbody>
				</table>
			)}
		</Card>
	);
}

// Mono digits → 11ch holds the "CLI default" placeholder and the widest cap (6 digits) plus the caret.
const TIER_CAP_FIELD_STYLE_MC = { width: "calc(11ch + 4px + var(--ctl-pad-x))" };

/**
 * One knob row — an effort select (CLI default + the five levels) or a token-count field where
 * blank = unset ('inherit'), plus In effect and the saved-value reset.
 */
function TierRowMC({ tier: t, departure, value, defaultValue, error, isFileRead, isStale, onChange }) {
	const meta = TIER_META_MC[t.domain] || { label: t.domain, hint: "", desc: "", kind: "", source: "daemon-config.json" };
	const showError = Boolean(error);
	const overridden = value !== defaultValue;
	// absent key = the unset state, not an unread one — unless the file itself was not read
	const live = t.actual ?? (isFileRead ? CLI_DEFAULT_LABEL_MC : null);
	const labelOf = (v) => (v === "inherit" ? CLI_DEFAULT_LABEL_MC : v);

	return (
		<tr className="is-grouped" style={{ verticalAlign: "top" }}>
			<td>
				<div className="fs-body">{meta.label}</div>
				<RowHintMC hint={meta.hint} />
				<RowHintMC hint={departure} />
			</td>
			<td>
				{meta.kind === "effort" ? (
					<select
						className={`field field-select field--mono${showError ? " is-error" : ""}`}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						aria-label={`${meta.label} level`}
						aria-invalid={showError ? "true" : undefined}>
						{["inherit", ...EFFORT_LEVELS_MC].map((level) => (
							<option key={level} value={level}>
								{level === "inherit" ? `${CLI_DEFAULT_LABEL_MC} — no --effort` : level}
							</option>
						))}
					</select>
				) : (
					<input
						type="text"
						inputMode="numeric"
						className={`field field--mono text-right${showError ? " is-error" : ""}`}
						style={TIER_CAP_FIELD_STYLE_MC}
						value={value === "inherit" ? "" : value}
						placeholder={CLI_DEFAULT_LABEL_MC}
						onChange={(e) => onChange(e.target.value === "" ? "inherit" : e.target.value)}
						aria-label={`${meta.label} in tokens`}
						aria-invalid={showError ? "true" : undefined}
					/>
				)}
				{showError && (
					<div className="fs-meta text-crit mt-1" role="alert">
						<span aria-hidden="true">✕ </span>
						{error}
					</div>
				)}
				<GhostResetMC
					overridden={overridden}
					defaultValue={labelOf(defaultValue)}
					onReset={() => onChange(defaultValue)}
				/>
			</td>
			<td>
				{/* a rejected file value is in effect nowhere — the daemon refuses the whole cycle */}
				{t.file_error ? (
					<div className="fs-meta text-crit" role="alert">
						<span aria-hidden="true">✕ </span>
						{`The daemon rejects the file value: ${t.file_error}`}
					</div>
				) : (
					<LiveValueMC
						value={live}
						drift={t.drift}
						source={meta.source}
						isStale={isStale}
						driftTitle="daemon-config.json differs from the saved setting — press Save again"
					/>
				)}
			</td>
		</tr>
	);
}

// Save 의 per-surface 결과 공시 — 문제 행(failed/skipped)만 펼쳐 두고 ok 행은 접힌 disclosure 뒤로
// (silent skip 금지, AC-5 — 접어도 목록에는 남는다).
function SurfaceResultsCardMC({ results, onDismiss }) {
	const { CardHead, Icon } = window.UI;

	const rows = Array.isArray(results) ? results : [];
	if (rows.length === 0) return null;

	const problems = rows.filter((r) => r.status !== "ok");
	const okRows = rows.filter((r) => r.status === "ok");

	return (
		<div className="card">
			<CardHead
				title={`Save touched ${rows.length} surface${rows.length === 1 ? "" : "s"}`}
				right={
					<button
						className="btn ghost sm"
						onClick={onDismiss}
						aria-label="Dismiss save results">
						<Icon name="x" size={14} />
					</button>
				}
			/>
			<div className="card-body">
				{problems.map((r, i) => (
					<SurfaceResultRowMC key={i} result={r} />
				))}
				{okRows.length > 0 && (
					<details className="fs-meta text-faint mt-1">
						<summary>{okRows.length} surfaces written without error</summary>
						<div className="mt-1">
							{okRows.map((r, i) => (
								<SurfaceResultRowMC key={i} result={r} />
							))}
						</div>
					</details>
				)}
			</div>
		</div>
	);
}

const SURFACE_STATUS_MC = {
	ok: { word: "Written", tone: "ok" },
	skipped: { word: "Skipped", tone: "warn" },
	failed: { word: "Failed", tone: "crit" },
};

// Words for the status, mono for the surface id alone — an empty field is left out, never dashed.
function SurfaceResultRowMC({ result: r }) {
	const { Badge } = window.UI;
	const status = r.status ? SURFACE_STATUS_MC[r.status] ?? { word: r.status, tone: "crit" } : null;
	const surface = r.surface ?? r.target ?? r.file ?? r.domain;

	return (
		<div className="flex items-center gap-2 fs-meta py-1 border-b border-line last:border-0">
			{status && (
				<Badge role="status" tone={status.tone} icon={true}>
					{status.word}
				</Badge>
			)}
			{surface && <span className="font-mono text-dim truncate">{surface}</span>}
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
	if (sync === "pending-migration") {
		return {
			title: "Config rows still carry their pre-rename names",
			body: (
				<>
					Values below are read from the old rows. Run{" "}
					<span className="font-mono">glass-atrium db-setup</span> to complete the
					rename.
				</>
			),
		};
	}
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

// Unavailable must read as 'not read', never as zero — the cause rides the alarm lane.
function SectionUnavailableMC() {
	return (
		<div className="fs-meta text-faint py-2">
			Not available — the saved config could not be loaded.
		</div>
	);
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
		if (modelOptionsMC(domain, knownModels).includes(value)) continue;
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
			errors[key] =
				`Amount with exactly 2 decimals (e.g. 0.50), between $${BUDGET_MIN_USD_MC.toFixed(2)} and $${BUDGET_MAX_USD_MC.toFixed(2)}`;
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
			errors[key] = "A whole number of tokens from 1 to 999999, no leading zero — or blank";
		}
	}

	return errors;
}

// 옵션 = GET known_models 그대로 (+ inherit 허용 도메인만) — bare alias 옵션 없음 (P7 AC).
function modelOptionsMC(domain, knownModels) {
	const meta = DOMAIN_META_MC[domain] || {};
	const opts = [];
	if (meta.inherit) opts.push("inherit");
	opts.push(...(knownModels || []));
	return opts;
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

// Page verdict — answers "does what I saved run?" once, before any row is read.
function getPageVerdictMC(data) {
	const domains = data?.domains || [];
	const budgets = data?.budgets || [];
	if (domains.length + budgets.length === 0) {
		return { tone: "neutral", text: "No model tiers or budget caps were reported.", chips: [] };
	}

	const issues = getVerdictIssuesMC(domains, budgets, data.daemon_config_sync);
	if (issues.length > 0) {
		return {
			tone: "warn",
			text: issues.map((issue) => issue.text).join(" · "),
			chips: issues.flatMap((issue) => (issue.chip ? [issue.chip] : [])),
		};
	}
	return {
		tone: "ok",
		text: `${domains.length}/${domains.length} tiers and ${budgets.length}/${budgets.length} caps match saved · config file in sync`,
		chips: [],
	};
}

// Each drifted or unread ledger names its rows + jumps to its section; a file state other than in-sync is named last.
function getVerdictIssuesMC(domains, budgets, sync) {
	const tierLedger = { meta: DOMAIN_META_MC, noun: "tier", chip: { label: "Model assignment", targetId: MODELS_SECTION_ID_MC } };
	const capLedger = { meta: BUDGET_META_MC, noun: "cap", chip: { label: "Budget caps", targetId: BUDGETS_SECTION_ID_MC } };
	const issues = [...getLedgerIssuesMC(domains, tierLedger), ...getLedgerIssuesMC(budgets, capLedger)];

	if (sync !== "ok") {
		issues.push({ text: sync ? `config file: ${SYNC_META_MC[sync]?.label ?? sync}` : "config file state not reported" });
	}
	return issues;
}

// A null actual (unreadable file, missing key) carries drift=false server-side, so it is named apart, never counted as a match.
function getLedgerIssuesMC(rows, ledger) {
	const labelOf = (row) => ledger.meta[row.domain]?.label ?? row.domain;
	const drifted = rows.filter((row) => row.drift).map(labelOf);
	const unread = rows.filter((row) => !row.drift && row.actual == null).map(labelOf);
	const texts = [];

	if (drifted.length > 0) texts.push(`${countNounMC(drifted.length, ledger.noun)} drifting: ${drifted.join(", ")}`);
	if (unread.length > 0) texts.push(`${countNounMC(unread.length, ledger.noun)} not read: ${unread.join(", ")}`);
	return texts.length > 0 ? [{ text: texts.join(" · "), chip: ledger.chip }] : [];
}

function countNounMC(n, noun) {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// Family + version from the id ("claude-opus-5-5" → "Opus 5.5"); an id outside the pattern has none.
function getModelFamilyMC(model) {
	if (model === "inherit") return "Session model";
	const match = MODEL_FAMILY_RE_MC.exec(model ?? "");
	if (!match) return null;

	const [, family, major, minor] = match;
	return `${family[0].toUpperCase()}${family.slice(1)} ${minor ? `${major}.${minor}` : major}`;
}

// "Opus 5.5 ×3 · Sonnet 5 ×4" in first-seen order — the mix without counting selects by eye.
function getModelMixMC(models) {
	const counts = new Map();
	for (const model of models) {
		const family = getModelFamilyMC(model) ?? "Custom";
		counts.set(family, (counts.get(family) ?? 0) + 1);
	}
	return [...counts].map(([family, n]) => `${family} ×${n}`).join(" · ");
}

// Header token = file sync ∪ any row drift — the same trigger as the banner, so the two never disagree.
function headerSyncMC(data) {
	const rows = [...(data?.domains || []), ...(data?.budgets || [])];
	if (rows.length === 0) return "empty";

	const sync = data?.daemon_config_sync;
	return sync === "ok" && hasRowDriftMC(data) ? "drift" : sync;
}

// Row drift present — banner trigger, true on one drifted model or budget row.
function hasRowDriftMC(data) {
	const rows = [...(data?.domains || []), ...(data?.budgets || [])];
	return rows.some((r) => r.drift);
}

function extractSurfaceResultsMC(data) {
	const results = data.results ?? data.surfaces ?? null;
	if (!Array.isArray(results) || results.length === 0) return null;
	// All ok → no card: a clean save is announced by the toast alone.
	return results.some((r) => r.status !== "ok") ? results : null;
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
