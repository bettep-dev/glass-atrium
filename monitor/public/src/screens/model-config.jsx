// Screen 12 — Models & budgets (/api/model-config GET 단일 fetch + 명시 Save PUT).
// 카드: config-sync KPI → 모델 도메인 테이블 → per-call 예산 상한 카드.
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

const CUSTOM_OPTION_MC = "__custom__";

// 모델별 1줄 역량 설명 — radio-card 옵션 보조 라벨 (T-MDL-3). GET 응답에 없는 표시 파생값이라 UI 상수.
const MODEL_CAP_MC = {
	"claude-opus-5": "Latest Opus — agentic coding, long-horizon work",
	"claude-fable-5-1": "Highest capability — deep reasoning, long-horizon agents",
	"claude-fable-5": "Prior Fable — deep reasoning, superseded by 5.1",
	"claude-opus-4-8": "Strong default — implementation, review, design",
	"claude-sonnet-5": "Sonnet tier — balanced speed/cost",
	"claude-sonnet-4-6": "Balanced — fast turnaround on mid-complexity work",
	"claude-haiku-4-5": "Fastest / cheapest — simple, repetitive file ops",
	inherit: "Falls back to whatever settings.json resolves to",
};
// 도메인 표시 메타 — 라벨/1줄 힌트/전문 설명/옵션 구성
// (GET 응답에 없는 파생 표시값이라 UI 상수로 유지).
const DOMAIN_META_MC = {
	"model.dev": {
		label: "Dev agents",
		hint: "Code implementation across the dev fleet",
		desc: "All development agents (React, NestJS, Python, DB, shell, and the rest of the dev fleet) — code implementation; written into every dev agent file",
		editable: true,
		inherit: true,
	},
	"model.research": {
		label: "Research agent",
		hint: "Web and codebase research",
		desc: "glass-atrium-intel-researcher — web and codebase research: source collection, verification, and synthesis",
		editable: true,
		inherit: true,
	},
	"model.meta": {
		label: "Meta agent",
		hint: "Rewrites agent instructions",
		desc: "glass-atrium-meta-agent — the AutoAgent self-improvement loop's instruction rewriter: regenerates agent instruction files from outcome signals, so its model quality shapes how well every agent evolves",
		editable: true,
		inherit: true,
	},
	"model.wiki": {
		label: "Wiki curator",
		hint: "Wiki compilation and index writes",
		desc: "glass-atrium-wiki-curator — sole owner of wiki writes: incremental compilation, index and topic-map updates, health checks, and raw-ingestion validation",
		editable: true,
		inherit: true,
	},
	"model.daemon_cycle_worker": {
		label: "Daemon cycle helper",
		hint: "Background daemon housekeeping steps",
		desc: "Lightweight helper for daemon housekeeping cycle steps — drafts self-improve proposals, runs pre-verify, and summarizes wiki notes in the background cycles",
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
	"model.daemon_cycle_worker",
];

// 반영 시점 — GET apply_mode 의 표기. 모든 편집이 "언제 적용되나" 를 묻게 만드는데 화면이 답한 적이 없어
// Enforcement(항상 applied, 정보량 0) 컬럼을 이걸로 교체.
const APPLY_MODE_META_MC = {
	"next-spawn": {
		label: "Next spawn",
		desc: "Saved now — a running agent keeps its current model until it next spawns",
	},
	"next-cycle": {
		label: "Next cycle",
		desc: "Saved now — the daemon picks it up on its next cycle",
	},
	"tmux-restart": {
		label: "After tmux restart",
		desc: "Saved now — the tmux session must restart before it is used",
	},
	immediate: {
		label: "Immediately",
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
	// 마이그레이션 미적용 DB — 이름이 바뀐 도메인의 값을 구 키 행에서 읽어온 상태.
	// 파일과 값이 우연히 맞아도 in sync 로 표시하지 않는다 (없는 행 위의 공허한 green 금지).
	"pending-migration": {
		label: "Pending migration",
		tone: "warn",
		desc: "these values are being read from the pre-rename config rows — run `glass-atrium db-setup` to complete the rename",
	},
};

// 예산 도메인 표시 메타 — 라벨/평이 설명. key = GET budgets[].domain (BudgetDomainKey).
// 미지의 key(서버 먼저 확장)는 fallback 메타로 그대로 렌더 (silent drop 금지).
const BUDGET_META_MC = {
	"budget.worker_max_usd": {
		label: "Self-improve + wiki call cap",
		hint: "Caps one self-improve generation or wiki compile call",
		desc: "Aborts a single runaway model call in the self-improve generation step and the wiki compile step (both share this cap)",
	},
	"budget.pre_verify_max_usd": {
		label: "Self-improve pre-verify call cap",
		hint: "Caps one self-improve pre-verify call",
		desc: "Aborts a single runaway model call in the self-improve pre-verify step",
	},
};

// 테이블 행 순서 — 미지의 도메인은 뒤에 그대로 덧붙임.
const BUDGET_ORDER_MC = ["budget.worker_max_usd", "budget.pre_verify_max_usd"];

function ScreenModelConfig() {
	const { PageHeader, Icon, TypeScaleStyle } = window.UI;

	const [configState, setConfigState] = useStateMC({
		status: "loading",
		data: null,
		error: null,
	});
	// form = 편집 버퍼 { models: {domain→value}, budgets: {budgetKey→value} } — GET 의 desired 미러.
	const [form, setForm] = useStateMC(null);
	const [saving, setSaving] = useStateMC(false);
	const [saveError, setSaveError] = useStateMC(null);
	const [surfaceResults, setSurfaceResults] = useStateMC(null);
	const [refreshTick, setRefreshTick] = useStateMC(0);
	const [toast, setToast] = useStateMC(null); // { tone, message }
	// discardConfirm = Discard 확인 다이얼로그 게이트 (T-MDL-5, destructive=편집분 소실).
	const [discardConfirm, setDiscardConfirm] = useStateMC(false);

	const abortRef = useRefMC(null);
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

		setConfigState({ status: "loading", data: null, error: null });
		setSaveError(null);
		fetchJsonMC("/api/model-config", ctrl.signal)
			.then((data) => {
				setConfigState({ status: "ready", data, error: null });
				setForm(buildFormMC(data));
			})
			.catch((err) => {
				if (err && err.name === "AbortError") return;
				setConfigState({
					status: "error",
					data: null,
					error: err && err.message ? err.message : String(err),
				});
			});

		return () => ctrl.abort();
	}, [refreshTick]);

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
	const save = async () => {
		if (!payload || hasErrors || saving) return;
		setSaving(true);
		setSaveError(null);
		setSurfaceResults(null);
		try {
			// PUT 응답 = GET shape + per-surface 결과 → 응답으로 화면/버퍼 재초기화 (재fetch 불요).
			const data = await putJsonMC("/api/model-config", payload);
			setConfigState({
				status: "ready",
				data,
				error: null,
				receivedAt: Date.now(),
			});
			setForm(buildFormMC(data));
			setSurfaceResults(extractSurfaceResultsMC(data));
			showToast("ok", "Changes saved");
		} catch (err) {
			setSaveError(err && err.message ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	// Discard — 편집 버퍼를 저장된 baseline 로 되돌림 (네트워크 호출 없음). confirm 게이트 통과 후 실행.
	const discard = () => {
		if (!isDirty || saving) return;
		setForm(
			baseline
				? { models: { ...baseline.models }, budgets: { ...baseline.budgets } }
				: form,
		);
		setSaveError(null);
		setDiscardConfirm(false);
	};

	const triggerRefresh = () => setRefreshTick((t) => t + 1);

	const ready = configState.status === "ready" && form !== null;
	const data = configState.data;
	// 배너 트리거는 파일 sync 상태 하나가 아니라 행 드리프트 전체 — 행에서 걷어낸 처방을 배너가 대신 싣는다.
	const showDrift =
		ready && (data.daemon_config_sync !== "ok" || anyDriftMC(data));
	const hasAlarm = Boolean(
		configState.status === "error" || saveError || showDrift || surfaceResults,
	);

	return (
		<div className="flex flex-col">
			<TypeScaleStyle />
			<style>
				{"@keyframes skelPulseMC { 0%,100%{opacity:.7} 50%{opacity:.35} }"}
			</style>
			<div className="flex-shrink-0">
				<PageHeader
					sub="Models & per-call budget caps"
					right={
						<>
							<SyncTokenMC
								state={configState.status}
								sync={data?.daemon_config_sync}
								receivedAt={configState.receivedAt}
							/>
							<button
								className="btn ghost sm"
								onClick={triggerRefresh}
								aria-label="Reload model config"
							>
								<Icon name="refresh" size={14} />
								Refresh
							</button>
						</>
					}
				/>
			</div>

			{hasAlarm && (
				<div
					className="mb-4 flex flex-col gap-3"
					role="region"
					aria-label="Alerts">
					{configState.status === "error" && (
						<ErrorBannerMC
							title="Couldn't load model config"
							detail={configState.error}
							onRetry={triggerRefresh}
						/>
					)}
					{saveError && (
						<ErrorBannerMC
							title="Couldn't save changes"
							detail={saveError}
							onRetry={save}
						/>
					)}
					{showDrift && <DriftBannerMC sync={data.daemon_config_sync} />}
					{surfaceResults && (
						<SurfaceResultsCardMC
							results={surfaceResults}
							onDismiss={() => setSurfaceResults(null)}
						/>
					)}
				</div>
			)}

			{configState.status === "loading" && <ModelConfigSkeletonMC />}
			{ready && (
				<>
					<DomainsSectionMC
						domains={data.domains}
						knownModels={knownModels}
						form={form}
						baseline={baseline}
						errors={errors}
						onModelChange={setModel}
					/>
					<BudgetsSectionMC
						budgets={data.budgets}
						form={form}
						baseline={baseline}
						errors={errors}
						onBudgetChange={setBudget}
					/>
				</>
			)}

			{ready && isDirty && (
				<div className="save-banner" role="region" aria-label="Unsaved changes">
					<div className="flex items-center gap-2 min-w-0">
						<span className="fs-body font-medium text-ink">
							Unsaved changes
						</span>
						{hasErrors && (
							<span className="fs-meta text-crit">
								— fix the highlighted fields before saving
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
					{toast.message}
				</div>
			)}
		</div>
	);
}

// 헤더 sync 토큰 — "저장한 값이 실제로 도는가" 를 화면당 한 번만 답한다(행마다 반복 금지).
// 톤은 glyph 가 싣고 텍스트는 평문 · as-of 는 클라이언트 수신 시각(루프백이라 payload 시각과 동치).
function SyncTokenMC({ state, sync, receivedAt }) {
	const { Icon } = window.UI;

	if (state === "loading") {
		return <span className="fs-meta text-faint">Checking sync…</span>;
	}
	if (state !== "ready") {
		return <span className="fs-meta text-faint">Sync state unavailable</span>;
	}

	const meta = SYNC_META_MC[sync] || {
		label: sync || "—",
		desc: "",
		tone: "neutral",
	};

	return (
		<span
			className="fs-meta text-dim flex items-center gap-1.5"
			title={meta.desc}>
			{sync !== "ok" && <Icon name="warn" size={12} className="text-warn" />}
			<span>{meta.label}</span>
			{receivedAt && (
				<span className="text-faint">· as of {formatClockMC(receivedAt)}</span>
			)}
		</span>
	);
}

// as-of 표기 — 초까지(분 단위면 방금 받은 응답이 오래돼 보인다).
function formatClockMC(ms) {
	return new Date(ms).toLocaleTimeString();
}

// 구획 헤더 — thin rule + .section-label (카드 박스 아님, T-MDL-2). title 좌측 라벨 + 우측 슬롯.
function SectionHeadMC({ label, sub, right }) {
	return (
		<div className="border-t border-line pt-4 mb-3">
			<div className="flex items-center justify-between gap-2">
				<span className="section-label">{label}</span>
				{right ?? null}
			</div>
			{sub && (
				<div className="card-sub mt-1" title={window.UI.titleOf(sub)}>
					{sub}
				</div>
			)}
		</div>
	);
}

// 총 컬럼 수 (빈 로스터 행 colSpan) — Agent tier·Model·Live·Takes effect = 4.
const DOMAIN_TABLE_COLSPAN_MC = 4;

// 모델 도메인 섹션 — 편집값(Model) vs 실측(Live) + 반영 시점.
function DomainsSectionMC({
	domains,
	knownModels,
	form,
	baseline,
	errors,
	onModelChange,
}) {
	const rows = sortDomainsMC(domains || []);

	return (
		<div className="mb-4">
			<SectionHeadMC label="Model assignment" />
			<table className="tbl">
				<thead>
					<tr>
						<th>Agent tier</th>
						<th>Model</th>
						<th>Live</th>
						<th>Takes effect</th>
					</tr>
				</thead>
				<tbody>
					{rows.length === 0 ? (
						<EmptyRowMC
							colSpan={DOMAIN_TABLE_COLSPAN_MC}
							message="No model domains reported."
						/>
					) : (
						rows.map((d) => (
							<DomainRowMC
								key={d.domain}
								domain={d}
								knownModels={knownModels}
								value={form.models[d.domain] ?? ""}
								defaultValue={baseline?.models[d.domain] ?? ""}
								error={errors[d.domain]}
								onChange={(v) => onModelChange(d.domain, v)}
							/>
						))
					)}
				</tbody>
			</table>
		</div>
	);
}

// 로스터가 빈 응답 — 행 0개를 "로드 안 됨" 과 구분해 명시 (빈 표 = 무언의 0 금지).
function EmptyRowMC({ colSpan, message }) {
	return (
		<tr>
			<td colSpan={colSpan}>
				<div className="fs-meta text-faint">{message}</div>
			</td>
		</tr>
	);
}

// 1줄 힌트 + 전문은 클릭 뒤 — 전 컬럼 폭 설명 행이 표 리듬을 깨던 자리를 대체.
function RowHintMC({ hint, detail }) {
	if (!hint && !detail) return null;
	if (!detail || detail === hint) {
		return <div className="fs-meta text-faint is-wrap">{hint}</div>;
	}

	return (
		<details className="fs-meta text-faint">
			<summary className="is-wrap">{hint}</summary>
			<div className="is-wrap mt-1">{detail}</div>
		</details>
	);
}

// 라이브 값 = 소비 지점 실측. 저장값과 같으면 dim 텍스트 하나(정상 상태에 상시 ok pill 금지),
// 다르면 warn 배지 1개 — 톤은 배지 glyph 가 싣는다. files 가 오면 mixed 내역을 클릭 뒤로 공시.
function LiveValueMC({ value, drift, files, driftTitle }) {
	const { Badge } = window.UI;
	const fileRows = Array.isArray(files) ? files : [];

	return (
		<div className="flex flex-col gap-1 min-w-0">
			<div className="flex items-center gap-2 min-w-0">
				<span
					className={`font-mono fs-meta truncate ${drift ? "text-ink" : "text-dim"}`}
				>
					{value ?? "—"}
				</span>
				{drift && (
					<span title={driftTitle}>
						<Badge role="status" tone="warn" icon={true} className="pill--ctl-h">
							drift
						</Badge>
					</span>
				)}
			</div>
			{fileRows.length > 0 && (
				<details className="fs-micro text-faint">
					<summary>{fileRows.length} files</summary>
					<div className="mt-1 flex flex-col gap-0.5">
						{fileRows.map((f) => (
							<div key={f.file} className="font-mono truncate">
								{f.file} — {f.model ?? "inherit"}
							</div>
						))}
					</div>
				</details>
			)}
		</div>
	);
}

// 반영 시점 — 무톤 텍스트. 알람이 아니라 리포트라 색을 쓰지 않는다.
function ApplyModeMC({ mode }) {
	const meta = APPLY_MODE_META_MC[mode] || { label: mode || "—", desc: "" };

	return (
		<span className="fs-meta text-dim" title={meta.desc}>
			{meta.label}
		</span>
	);
}

function DomainRowMC({
	domain: d,
	knownModels,
	value,
	defaultValue,
	error,
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
			<td style={{ ...cellPad, maxWidth: 260 }}>
				<div className="fs-body font-medium text-ink">{meta.label}</div>
				<RowHintMC hint={meta.hint} detail={meta.desc} />
			</td>
			<td style={{ ...cellPad, minWidth: 220 }}>
				{editable ? (
					<ModelSelectMC
						domain={d.domain}
						knownModels={knownModels}
						value={value}
						defaultValue={defaultValue}
						error={error}
						pricingKnown={d.pricing_known}
						onChange={onChange}
					/>
				) : (
					// read-only fallback 배지 — <select> 자리를 그대로 차지하므로 같은 높이라야 컬럼 리듬이 유지된다.
					<Badge role="metadata" className="pill--ctl-h">
						{value || d.desired || "—"}
					</Badge>
				)}
			</td>
			<td style={cellPad}>
				<LiveValueMC
					value={d.actual}
					drift={d.drift}
					files={d.files}
					driftTitle="Live value differs from the saved target — press Save again"
				/>
			</td>
			<td style={cellPad}>
				<ApplyModeMC mode={d.apply_mode} />
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
	pricingKnown,
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
						{opt === "inherit" ? "inherit (settings.json)" : opt}
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
			{error && (
				<div className="fs-meta text-crit mt-1" role="alert">
					{error}
				</div>
			)}
			{pricingKnown === false && (
				<div className="fs-meta text-warn mt-1">
					No price listed — billed at the conservative fallback rate
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

// 기본값 ghost + 되돌리기 (T-MDL-6) — 저장된 baseline 과 다를 때만 노출. model/budget 공용.
function GhostResetMC({ overridden, defaultValue, onReset }) {
	if (!overridden) return null;

	return (
		<div className="fs-micro text-faint mt-1 flex items-center gap-1.5 flex-wrap">
			<span>Saved:</span>
			<span className="font-mono text-dim">{defaultValue || "—"}</span>
			<button
				type="button"
				className="text-accent underline underline-offset-2"
				onClick={onReset}
				aria-label="Reset this field to the saved value"
			>
				reset
			</button>
		</div>
	);
}

// 총 컬럼 수 (빈 로스터 행 colSpan) — Background call·Per-call cap·Live·Takes effect = 4.
const BUDGET_TABLE_COLSPAN_MC = 4;

// per-call 예산 상한 섹션 — 입력 + 실측 + 반영 시점 (월 청구 캡이 아니라 단일 호출 캡).
function BudgetsSectionMC({ budgets, form, baseline, errors, onBudgetChange }) {
	const rows = sortBudgetsMC(budgets || []);

	return (
		<div className="mb-4">
			<SectionHeadMC label="Per-call budget caps" />
			<table className="tbl">
				<thead>
					<tr>
						<th>Background call</th>
						<th>Per-call cap</th>
						<th>Live</th>
						<th>Takes effect</th>
					</tr>
				</thead>
				<tbody>
					{rows.length === 0 ? (
						<EmptyRowMC
							colSpan={BUDGET_TABLE_COLSPAN_MC}
							message="No budget caps reported."
						/>
					) : (
						rows.map((b) => (
							<BudgetRowMC
								key={b.domain}
								budget={b}
								value={form.budgets[b.domain] ?? ""}
								defaultValue={baseline?.budgets[b.domain] ?? ""}
								error={errors[b.domain]}
								onChange={(v) => onBudgetChange(b.domain, v)}
							/>
						))
					)}
				</tbody>
			</table>
		</div>
	);
}

// per-call 상한 입력의 placeholder — 미입력 상태에서 실제로 적용 중인 배포 기본값을 광고.
// top-level `const` 는 vm 샌드박스 테스트에서 도달 불가(모듈 렉시컬 스코프)지만 top-level
// function 은 도달 가능 — 미러가 서버 SoT 와 어긋나면 client unit test 가 잡는다.
function budgetPlaceholderMC() {
	return BUDGET_SEED_DEFAULT_MC;
}

// 예산 1행 — $ 입력(2-decimal 문자열) + validate-on-blur + field-adjacent role=alert (T-MDL-4)
// + 실측/반영 시점 + ghost default/reset (T-MDL-6).
function BudgetRowMC({ budget: b, value, defaultValue, error, onChange }) {
	const meta = BUDGET_META_MC[b.domain] || { label: b.domain, hint: "", desc: "" };
	// touched = blur 1회 후에만 inline 에러 노출 (validate-on-blur — 타이핑 중 noise 억제).
	const [touched, setTouched] = useStateMC(false);
	const showError = error && touched;
	const overridden = defaultValue !== undefined && value !== defaultValue;

	return (
		<tr className="is-grouped" style={{ verticalAlign: "top" }}>
			<td style={{ maxWidth: 260 }}>
				<div className="fs-body">{meta.label}</div>
				<RowHintMC hint={meta.hint} detail={meta.desc} />
			</td>
			<td style={{ minWidth: 180 }}>
				<div className="flex items-center gap-2">
					<span
						className={`field-affix${showError ? " is-error" : ""}`}
						style={{ width: "6rem" }}
					>
						<span className="field-affix__sym">$</span>
						<input
							type="text"
							inputMode="decimal"
							className="field field--mono text-right"
							value={value}
							placeholder={budgetPlaceholderMC()}
							onChange={(e) => onChange(e.target.value)}
							onBlur={() => setTouched(true)}
							aria-label={`${meta.label} per-call cap in USD`}
							aria-invalid={showError ? "true" : undefined}
						/>
					</span>
				</div>
				{showError && (
					<div className="fs-meta text-crit mt-1" role="alert">
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
					driftTitle="daemon-config.json differs from the saved cap — press Save again"
				/>
			</td>
			<td>
				<ApplyModeMC mode={b.apply_mode} />
			</td>
		</tr>
	);
}

// Save 의 per-surface 결과 공시 — frontmatter per-file ok/skipped/failed 등 (silent skip 금지, AC-5).
function SurfaceResultsCardMC({ results, onDismiss }) {
	const { CardHead, Icon, Badge } = window.UI;

	const rows = Array.isArray(results) ? results : [];
	if (rows.length === 0) return null;

	const toneOf = (status) =>
		status === "ok" ? "ok" : status === "skipped" ? "warn" : "crit";

	return (
		<div className="card mb-4">
			<CardHead
				title="Save results"
				right={
					<button
						className="btn ghost sm"
						onClick={onDismiss}
						aria-label="Dismiss save results"
					>
						<Icon name="x" size={14} />
					</button>
				}
			/>
			<div className="card-body">
				{rows.map((r, i) => (
					<div
						key={i}
						className="flex items-center gap-2 fs-meta font-mono py-1 border-b border-line last:border-0"
					>
						<Badge role="status" tone={toneOf(r.status)} icon={true}>
							{r.status || "—"}
						</Badge>
						<span className="text-dim truncate">
							{r.surface ?? r.target ?? r.file ?? r.domain ?? "—"}
						</span>
						{r.reason && (
							<span className="text-faint truncate">— {r.reason}</span>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

// 설정 드리프트 배너 — 파일 불일치 또는 행 드리프트 존재 시 노출. 처방은 여기 한 번만 실린다.
// warn-tone: 구조 정합성 신호 (info-tone 은 architecture 화면 전용).
function DriftBannerMC({ sync }) {
	const { Icon } = window.UI;
	// 처방이 다르다 — drift/file-missing 은 Save 가, pending-migration 은 db-setup 이 고친다.
	const pendingMigration = sync === "pending-migration";

	return (
		<div
			role="alert"
			className="rounded-md border p-3 flex items-start gap-3"
			style={{
				background: "rgb(var(--warn) / 0.08)",
				borderColor: "rgb(var(--warn) / 0.4)",
			}}>
			<Icon name="git" size={16} className="text-warn mt-0.5" />
			<div className="flex-1 min-w-0">
				<div className="fs-body font-medium text-ink">
					{pendingMigration
						? "Config rows still carry their pre-rename names"
						: "Saved config not yet fully live"}
				</div>
				<div className="fs-meta text-dim mt-1">
					{pendingMigration ? (
						<>
							Values below are read from the old rows. Run{" "}
							<span className="font-mono">glass-atrium db-setup</span> to complete
							the rename.
						</>
					) : (
						"Save again to rewrite the surfaces that consume these values."
					)}
				</div>
			</div>
		</div>
	);
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
	const { Icon } = window.UI;
	return (
		<div
			role="alert"
			className="rounded-md border p-3 flex items-start gap-3"
			style={{
				background: "rgb(var(--crit) / 0.08)",
				borderColor: "rgb(var(--crit) / 0.4)",
			}}
		>
			<Icon name="warn" size={16} className="text-crit mt-0.5" />
			<div className="flex-1 min-w-0">
				<div className="fs-body font-medium text-ink">{title}</div>
				{detail && (
					<div
						className="fs-meta font-mono text-dim mt-1 truncate"
						title={window.UI.titleOf(detail)}
					>
						{detail}
					</div>
				)}
			</div>
			<button className="btn sm" onClick={onRetry} aria-label="Retry">
				Retry
			</button>
		</div>
	);
}

function ModelConfigSkeletonMC() {
	const block = (h) => (
		<div
			aria-busy="true"
			style={{
				width: "100%",
				height: h,
				borderRadius: 8,
				background: "rgb(var(--sunken))",
				opacity: 0.7,
				animation: "skelPulseMC 1.4s ease-in-out infinite",
			}}
		/>
	);
	return (
		<div className="space-y-4" aria-label="Loading model config">
			<div className="grid grid-cols-3 gap-3">
				{block(72)}
				{block(72)}
				{block(72)}
			</div>
			{block(280)}
			{block(200)}
		</div>
	);
}

// 순수 helper
function buildFormMC(data) {
	const models = {};
	for (const d of data.domains || []) {
		models[d.domain] = d.desired ?? "";
	}
	const budgets = {};
	for (const b of data.budgets || []) {
		budgets[b.domain] = b.desired ?? "";
	}
	return { models, budgets };
}

// 변경분만 PUT (partial 계약) — 변경 없음 = null (Save 비활성 근거).
function diffFormMC(baseline, form) {
	const models = {};
	for (const [domain, v] of Object.entries(form.models)) {
		if (baseline.models[domain] !== v) models[domain] = v;
	}
	const budgets = {};
	for (const [key, v] of Object.entries(form.budgets)) {
		if (baseline.budgets[key] !== v) budgets[key] = v;
	}

	const payload = {};
	if (Object.keys(models).length > 0) payload.models = models;
	if (Object.keys(budgets).length > 0) payload.budgets = budgets;
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

// 행 드리프트 존재 여부 — 배너 트리거 (모델/예산 어느 쪽이든 1건이면 참).
function anyDriftMC(data) {
	const rows = [...(data?.domains || []), ...(data?.budgets || [])];
	return rows.some((r) => r.drift);
}

function extractSurfaceResultsMC(data) {
	const results = data.results ?? data.surfaces ?? null;
	return Array.isArray(results) && results.length > 0 ? results : null;
}

async function fetchJsonMC(url, signal) {
	const res = await fetch(url, {
		signal,
		headers: { Accept: "application/json" },
	});
	if (!res.ok) {
		let body = "";
		try {
			body = await res.text();
		} catch (_e) {
			/* body parse 실패 무시 */
		}
		throw new Error(
			`HTTP ${res.status} ${res.statusText}${body ? " — " + body.slice(0, 120) : ""}`,
		);
	}
	return res.json();
}

async function putJsonMC(url, payload) {
	const res = await fetch(url, {
		method: "PUT",
		headers: { "content-type": "application/json", Accept: "application/json" },
		body: JSON.stringify(payload),
	});
	if (!res.ok) {
		let body = "";
		try {
			body = await res.text();
		} catch (_e) {
			/* body parse 실패 무시 */
		}
		throw new Error(
			`HTTP ${res.status} ${res.statusText}${body ? " — " + body.slice(0, 300) : ""}`,
		);
	}
	return res.json();
}

window.ScreenModelConfig = ScreenModelConfig;
