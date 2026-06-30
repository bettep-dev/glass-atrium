// Screen 12 — Models & budgets (/api/model-config GET 단일 fetch + 명시 Save PUT).
// 카드: config-sync KPI → 모델 도메인 테이블 → per-call 예산 상한 카드.
// DB(saved target) = UI SoT · actual = 소비 지점 실측 — 차이는 drift 배지로 공시 (spec doc 36166 D2/D5).
// orchestrator 도메인은 read-only — settings.json 은 어떤 코드 경로도 쓰지 않음 (Harness Path Protection).
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
const KNOWN_MODEL_IDS_MC = [
	"claude-fable-5",
	"claude-opus-4-8",
	"claude-sonnet-4-6",
	"claude-haiku-4-5",
];
// alias 는 frontmatter 도메인(dev/research) 전용 — harness 가 frontmatter 의 축약 표기를 그대로 해석.
const FRONTMATTER_ALIASES_MC = ["opus", "sonnet", "haiku"];
// free-text escape hatch — 소문자 alnum + dot/hyphen/bracket ≤128 (PUT 검증 계약).
const FREE_TEXT_MODEL_RE_MC = /^[a-z0-9.\-[\]]{1,128}$/;
// per-call 예산 = 정확히 2-decimal 문자열 — daemon_config.py 가 --max-budget-usd 로 verbatim 전달,
// JSON number 0.5 는 trailing-zero 가 사라져 CLI 캡을 깨뜨림 (서버 BUDGET_VALUE_PATTERN 미러).
const BUDGET_RE_MC = /^\d+\.\d{2}$/;
const BUDGET_MIN_USD_MC = 0.05;
const BUDGET_MAX_USD_MC = 50.0;

const CUSTOM_OPTION_MC = "__custom__";

// 모델별 1줄 역량 설명 — radio-card 옵션 보조 라벨 (T-MDL-3). GET 응답에 없는 표시 파생값이라 UI 상수.
const MODEL_CAP_MC = {
	"claude-fable-5": "Highest capability — deep reasoning, long-horizon agents",
	"claude-opus-4-8": "Strong default — implementation, review, design",
	"claude-sonnet-4-6": "Balanced — fast turnaround on mid-complexity work",
	"claude-haiku-4-5": "Fastest / cheapest — simple, repetitive file ops",
	inherit: "Falls back to whatever settings.json resolves to",
	opus: "Frontmatter alias — resolves to the current Opus model",
	sonnet: "Frontmatter alias — resolves to the current Sonnet model",
	haiku: "Frontmatter alias — resolves to the current Haiku model",
};
// 도메인 표시 메타 — 라벨/평이 설명/옵션 구성. enforcement = spec D3 class 컬럼의 클라이언트 표기
// (GET 응답에 없는 파생 표시값이라 UI 상수로 유지).
const DOMAIN_META_MC = {
	"model.orchestrator": {
		label: "Main session",
		desc: "The model your interactive Claude Code session runs on",
		enforcement: "display-only",
		editable: false,
		inherit: false,
		aliases: false,
	},
	"model.dev": {
		label: "Dev agents",
		desc: "Written into the dev-*.md agent files; picked up when an agent next starts",
		enforcement: "applied",
		editable: true,
		inherit: true,
		aliases: true,
	},
	"model.research": {
		label: "Research agent",
		desc: "Written into intel-researcher.md; picked up when the agent next starts",
		enforcement: "applied",
		editable: true,
		inherit: true,
		aliases: true,
	},
	"model.daemon_cycle_haiku": {
		label: "Daemon cycle helper",
		desc: "Background LLM for both daemon cycles — drafts self-improve proposals + pre-verify, summarizes wiki notes",
		enforcement: "applied",
		editable: true,
		inherit: false,
		aliases: false,
		advanced: true,
	},
};

// 테이블 행 순서 — 미지의 도메인(서버가 먼저 확장된 경우)은 뒤에 그대로 덧붙임 (silent drop 금지).
const DOMAIN_ORDER_MC = [
	"model.orchestrator",
	"model.dev",
	"model.research",
	"model.daemon_cycle_haiku",
];

// enforcement class 칩 — 정직 공시: applied=저장이 실제 소비 지점에 반영 · display-only=표시만.
const ENFORCEMENT_META_MC = {
	applied: {
		label: "Applied",
		tone: "ok",
		desc: "Saving here changes the real consumed value",
	},
	"display-only": {
		label: "Display only",
		tone: "neutral",
		desc: "Shown for reference — saving never writes the real file",
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
};

// 예산 도메인 표시 메타 — 라벨/평이 설명. key = GET budgets[].domain (BudgetDomainKey).
// 미지의 key(서버 먼저 확장)는 fallback 메타로 그대로 렌더 (silent drop 금지).
const BUDGET_META_MC = {
	"budget.haiku_max_usd": {
		label: "Self-improve + wiki call cap",
		desc: "Aborts a single runaway model call in the self-improve generation step and the wiki compile step (both share this cap)",
	},
	"budget.pre_verify_max_usd": {
		label: "Self-improve pre-verify call cap",
		desc: "Aborts a single runaway model call in the self-improve pre-verify step",
	},
};

// 테이블 행 순서 — 미지의 도메인은 뒤에 그대로 덧붙임.
const BUDGET_ORDER_MC = ["budget.haiku_max_usd", "budget.pre_verify_max_usd"];

// 추천 preset — form 채움만 수행, 저장은 명시 Save 버튼 (spec P3).
const PRESET_MODELS_MC = {
	"model.orchestrator": "claude-fable-5",
	"model.dev": "claude-opus-4-8",
};

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

	const errors = useMemoMC(() => (form ? validateFormMC(form) : {}), [form]);
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
	const applyPreset = () => {
		setForm((f) =>
			f ? { ...f, models: { ...f.models, ...PRESET_MODELS_MC } } : f,
		);
	};

	const save = async () => {
		if (!payload || hasErrors || saving) return;
		setSaving(true);
		setSaveError(null);
		setSurfaceResults(null);
		try {
			// PUT 응답 = GET shape + per-surface 결과 → 응답으로 화면/버퍼 재초기화 (재fetch 불요).
			const data = await putJsonMC("/api/model-config", payload);
			setConfigState({ status: "ready", data, error: null });
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
							<button
								className="btn ghost sm"
								onClick={applyPreset}
								disabled={!ready || saving}
								title="Fills the recommended values into the form (main session claude-fable-5 · dev agents claude-opus-4-8). Nothing is saved until you press Save."
								aria-label="Fill recommended preset"
							>
								Fill preset
							</button>
							<button
								className="btn primary sm"
								onClick={save}
								disabled={!ready || hasErrors || saving}
								aria-label="Save model and budget changes"
							>
								{saving ? "Saving…" : "Save changes"}
							</button>
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

			{saveError && (
				<div className="mb-4">
					<ErrorBannerMC
						title="Couldn't save changes"
						detail={saveError}
						onRetry={save}
					/>
				</div>
			)}
			{surfaceResults && (
				<SurfaceResultsCardMC
					results={surfaceResults}
					onDismiss={() => setSurfaceResults(null)}
				/>
			)}

			{configState.status === "loading" && <ModelConfigSkeletonMC />}
			{configState.status === "error" && (
				<ErrorBannerMC
					title="Couldn't load model config"
					detail={configState.error}
					onRetry={triggerRefresh}
				/>
			)}
			{ready && (
				<>
					{/* 드리프트 배너는 전체 sync 가 ok 가 아닐 때만 — In-sync 와 동시 노출 금지(W3-T2 IA-4).
              per-domain drift 는 테이블 행 내 drift/in-sync 칩으로 이미 공시되므로 상단 배너는 top-level 신호 전용. */}
					{data.daemon_config_sync !== "ok" && (
						<DriftBannerMC
							sync={data.daemon_config_sync}
							domains={data.domains}
						/>
					)}
					<SyncStatusRowMC sync={data.daemon_config_sync} />
					<DomainsSectionMC
						domains={data.domains}
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
					<AdvancedSectionMC
						domains={data.domains}
						form={form}
						baseline={baseline}
						errors={errors}
						onModelChange={setModel}
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

// daemon-config.json 동기화 상태 — 표준 status Badge 1개로 공시 (W3-T2 (b): 26px KPI 값으로 띄우던
// 거대 "In sync" 헤딩을 표준 status pill 로 강등 — 색+TONE_GLYPH 듀얼 인코딩). 지출/청구 KPI 는 없음
// (OAuth 구독 = metered 청구 없음, GET 에 spend 데이터 없음 · per-call 캡이라 누적 소진 게이지 개념 없음).
function SyncStatusRowMC({ sync }) {
	const { Badge } = window.UI;

	const syncMeta = SYNC_META_MC[sync] || {
		label: sync || "—",
		desc: "",
		tone: "neutral",
	};

	return (
		<div className="flex items-center gap-2 mb-4">
			<span className="section-label">Config file sync</span>
			<span title={syncMeta.desc}>
				<Badge role="status" tone={syncMeta.tone}>
					{syncMeta.label}
				</Badge>
			</span>
		</div>
	);
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

// 모델 도메인 섹션 — Saved target(편집) vs Actual(실측) + apply/enforcement 칩.
// advanced 도메인(daemon helper)은 AdvancedSectionMC 로 분리 — 여기선 1차 도메인만.
function DomainsSectionMC({ domains, form, baseline, errors, onModelChange }) {
	const rows = sortDomainsMC(
		(domains || []).filter((d) => !DOMAIN_META_MC[d.domain]?.advanced),
	);

	return (
		<div className="mb-4">
			<SectionHeadMC label="Model assignment" />
			<table className="tbl">
				<thead>
					<tr>
						<th>Target</th>
						<th>Saved target</th>
						<th>Actual</th>
						<th>Sync</th>
						<th>Enforcement</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((d) => (
						<DomainRowMC
							key={d.domain}
							domain={d}
							value={form.models[d.domain] ?? ""}
							defaultValue={baseline?.models[d.domain] ?? ""}
							error={errors[d.domain]}
							onChange={(v) => onModelChange(d.domain, v)}
						/>
					))}
				</tbody>
			</table>
			<OrchestratorHowToMC />
		</div>
	);
}

// Advanced 섹션 — daemon helper 류 advanced 도메인을 기본 접힘 <details> 로 (T-MDL-2).
function AdvancedSectionMC({ domains, form, baseline, errors, onModelChange }) {
	const rows = sortDomainsMC(
		(domains || []).filter((d) => DOMAIN_META_MC[d.domain]?.advanced),
	);
	if (rows.length === 0) return null;

	return (
		<details className="mb-4 border-t border-line pt-4">
			<summary className="section-label cursor-pointer">Advanced</summary>
			{/* is-wrap: standalone warning paragraph meant to be read in full, not a clamped caption. */}
			<div className="card-sub is-wrap mt-1 mb-3">
				Background daemon model — only change this if you know how the
				self-improve and wiki cycles consume it
			</div>
			<table className="tbl">
				<thead>
					<tr>
						<th>Target</th>
						<th>Saved target</th>
						<th>Actual</th>
						<th>Sync</th>
						<th>Enforcement</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((d) => (
						<DomainRowMC
							key={d.domain}
							domain={d}
							value={form.models[d.domain] ?? ""}
							defaultValue={baseline?.models[d.domain] ?? ""}
							error={errors[d.domain]}
							onChange={(v) => onModelChange(d.domain, v)}
						/>
					))}
				</tbody>
			</table>
		</details>
	);
}

function DomainRowMC({ domain: d, value, defaultValue, error, onChange }) {
	const { Badge } = window.UI;
	const meta = DOMAIN_META_MC[d.domain] || {
		label: d.domain,
		desc: "",
		enforcement: "applied",
		editable: d.editable !== false,
	};
	// 서버 editable=false 가 우선 — UI 메타와 어긋나면 보수적으로 read-only.
	const editable = d.editable !== false && meta.editable !== false;
	const enforceMeta =
		ENFORCEMENT_META_MC[meta.enforcement] || ENFORCEMENT_META_MC.applied;

	// 행 간격 10px(상하 5px) — 모델+설명+칩 한 묶음이 개별 행으로 읽히게 (W3-T2 (a) ~4px→10px).
	const cellPad = { paddingTop: 5, paddingBottom: 5 };

	return (
		<tr style={{ verticalAlign: "top" }}>
			<td style={cellPad}>
				{/* label + desc 스택 블록 — 좁은 td 대신 라벨/설명을 세로로 쌓아 산문이 숨쉬게. */}
				<div className="flex items-center gap-2 min-w-0">
					<span className="shrink-0 fs-body font-medium text-ink">
						{meta.label}
					</span>
				</div>
				{meta.desc &&
					(meta.advanced ? (
						// 긴 advanced 설명은 기존 details 패턴으로 접어 행 높이 폭주 방지.
						<details className="mt-1">
							{/* is-wrap: interactive <details> toggle, not a clamped caption. */}
							<summary className="card-sub is-wrap cursor-pointer">
								What this controls
							</summary>
							{/* is-wrap: expanded details body — multi-line desc by design. */}
							<div className="card-sub is-wrap mt-1">{meta.desc}</div>
						</details>
					) : (
						// auto table-layout: card-sub clamp widens the cell unless capped — bound to the column so the ellipsis engages.
						<div
							className="card-sub mt-1"
							style={{ maxWidth: 280 }}
							title={window.UI.titleOf(meta.desc)}
						>
							{meta.desc}
						</div>
					))}
			</td>
			<td style={{ ...cellPad, minWidth: 220 }}>
				{editable ? (
					<ModelSelectMC
						domain={d.domain}
						value={value}
						defaultValue={defaultValue}
						error={error}
						pricingKnown={d.pricing_known}
						onChange={onChange}
					/>
				) : (
					// fallback 배지도 편집 행 <select> 와 같은 높이로 (content-width pill 유지, pill--ctl-h = HEIGHT 만 매치).
					<Badge role="metadata" className="pill--ctl-h">
						{value || d.desired || "—"}
					</Badge>
				)}
			</td>
			<td style={cellPad}>
				{/* ACTUAL 배지를 SAVED TARGET <select>(.field) 와 같은 HEIGHT 로만 정렬 — pill--ctl-h 가 --ctl-h 공유(lockstep), 너비/폰트/radius 는 배지 그대로(컬럼 미충전). */}
				<Badge role="metadata" className="pill--ctl-h">
					{d.actual ?? "—"}
				</Badge>
				{/* orchestrator 전용 effort 표시 — GET status.effort_level (model-config.ts) 파생값, 다른 도메인엔 없음. */}
				{d.effort_level && (
					<div className="fs-micro text-faint mt-0.5">
						effort: {d.effort_level}
					</div>
				)}
			</td>
			<td style={cellPad}>
				{d.drift ? (
					<span title="Actual differs from saved target">
						<PillGlyphMC tone="warn">drift</PillGlyphMC>
					</span>
				) : (
					<span title="Actual matches saved target">
						<PillGlyphMC tone="ok">in sync</PillGlyphMC>
					</span>
				)}
			</td>
			<td style={cellPad}>
				<span title={enforceMeta.desc}>
					<PillGlyphMC tone={enforceMeta.tone} noGlyph>
						{enforceMeta.label}
					</PillGlyphMC>
				</span>
			</td>
		</tr>
	);
}

// orchestrator read-only 안내 — settings.json 은 harness 보호 경로라 모니터가 절대 쓰지 않음.
// /glass-atrium-ops-model-config 스킬이 settings.json 쓰기 + 데몬 재시작을 대신 수행.
function OrchestratorHowToMC() {
	const { Icon } = window.UI;
	return (
		<div className="px-4 py-3 border-t border-line flex items-start gap-2">
			<Icon name="info" size={14} className="text-dim mt-0.5 shrink-0" />
			<div className="fs-meta text-dim">
				<span className="font-medium text-ink">
					How to change the main session model:
				</span>{" "}
				the monitor never writes{" "}
				<span className="font-mono">~/.claude/settings.json</span> (it is a
				protected harness file). Run{" "}
				<span className="font-mono">/glass-atrium-ops-model-config</span> in
				your Claude Code session — it writes settings.json for you and restarts
				the autoagent and wiki daemons.
			</div>
		</div>
	);
}

// 모델 선택 = 컴팩트 native <select>(.field-select) + 선택 옵션의 capability descriptor 1줄 +
// custom free-text escape hatch. 목록 외 값(빈 문자열 포함) = custom 모드 → CUSTOM_OPTION_MC 표시값.
// 9 preset 규모라 세로 카드 스택 대신 1행 콤보가 적합 (옵션 多 → dropdown 패턴).
// ghost default + reset (T-MDL-6): 저장된 baseline 과 다르면 ghost 라벨 + 되돌리기 링크.
function ModelSelectMC({
	domain,
	value,
	defaultValue,
	error,
	pricingKnown,
	onChange,
}) {
	const options = modelOptionsMC(domain);
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
					No price listed — billed at Opus fallback rate
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

// per-call 예산 상한 섹션 — 입력 + apply/drift 칩 + OAuth 맥락 정직 공시 (월 청구 캡이 아님).
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
						<th>Actual</th>
						<th>Sync</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((b) => (
						<BudgetRowMC
							key={b.domain}
							budget={b}
							value={form.budgets[b.domain] ?? ""}
							defaultValue={baseline?.budgets[b.domain] ?? ""}
							error={errors[b.domain]}
							onChange={(v) => onBudgetChange(b.domain, v)}
						/>
					))}
				</tbody>
			</table>
		</div>
	);
}

// 예산 1행 — $ 입력(2-decimal 문자열) + 단위/범위 힌트 + validate-on-blur + field-adjacent role=alert
// (T-MDL-4) + actual/drift + ghost default/reset (T-MDL-6).
function BudgetRowMC({ budget: b, value, defaultValue, error, onChange }) {
	const meta = BUDGET_META_MC[b.domain] || { label: b.domain, desc: "" };
	// touched = blur 1회 후에만 inline 에러 노출 (validate-on-blur — 타이핑 중 noise 억제).
	const [touched, setTouched] = useStateMC(false);
	const showError = error && touched;
	const overridden = defaultValue !== undefined && value !== defaultValue;

	return (
		<tr style={{ verticalAlign: "top" }}>
			<td>
				<div className="fs-body">{meta.label}</div>
				{/* auto table-layout: cap the desc so truncate engages instead of stretching the label column. */}
				<div
					className="fs-meta text-faint mt-0.5 truncate"
					style={{ maxWidth: 260 }}
					title={window.UI.titleOf(meta.desc)}
				>
					{meta.desc}
				</div>
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
							placeholder="0.50"
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
				<span className="font-mono fs-body">
					{b.actual ? `$${b.actual}` : "—"}
				</span>
			</td>
			<td>
				{b.drift ? (
					<span title="daemon-config.json differs from saved target — press Save">
						<PillGlyphMC tone="warn">drift</PillGlyphMC>
					</span>
				) : (
					<span title="daemon-config.json matches saved target">
						<PillGlyphMC tone="ok">in sync</PillGlyphMC>
					</span>
				)}
			</td>
		</tr>
	);
}

// Save 의 per-surface 결과 공시 — frontmatter per-file ok/skipped/failed 등 (silent skip 금지, AC-5).
function SurfaceResultsCardMC({ results, onDismiss }) {
	const { CardHead, Icon } = window.UI;

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
						<PillGlyphMC tone={toneOf(r.status)}>{r.status || "—"}</PillGlyphMC>
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

// 설정 드리프트 배너 — daemon_config_sync 불일치 또는 도메인 drift 존재 시 노출.
// warn-tone: 구조 정합성 신호 (info-tone 은 architecture 화면 전용).
function DriftBannerMC({ sync, domains }) {
	const { Icon } = window.UI;
	const driftedDomains = (domains || []).filter((d) => d.drift);
	return (
		<div
			role="alert"
			className="rounded-md border p-3 flex items-start gap-3 mb-4"
			style={{
				background: "rgb(var(--warn) / 0.08)",
				borderColor: "rgb(var(--warn) / 0.4)",
			}}
		>
			<Icon name="git" size={16} className="text-warn mt-0.5" />
			<div className="flex-1 min-w-0">
				<div className="fs-body font-medium text-ink">
					Saved config not yet fully live
				</div>
				<div className="fs-meta text-dim mt-1">
					Run <span className="font-mono">/glass-atrium-ops-model-config</span>{" "}
					to apply.
				</div>
				{driftedDomains.length > 0 && (
					<div className="fs-meta text-dim mt-2">
						{driftedDomains.length} domain
						{driftedDomains.length === 1 ? "" : "s"} out of sync.
					</div>
				)}
			</div>
		</div>
	);
}

// 톤 + 표준 glyph 듀얼 인코딩 Pill (A2 — 색상 단독 인코딩 금지). noGlyph = 텍스트가 이미 의미 전달.
function PillGlyphMC({ tone, noGlyph, children }) {
	const { Pill, TONE_GLYPH } = window.UI;
	return (
		<Pill tone={tone}>
			{!noGlyph && TONE_GLYPH[tone] ? `${TONE_GLYPH[tone]} ` : ""}
			{children}
		</Pill>
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
function validateFormMC(form) {
	const errors = {};

	for (const [domain, value] of Object.entries(form.models)) {
		if (modelOptionsMC(domain).includes(value)) continue;
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

function modelOptionsMC(domain) {
	const meta = DOMAIN_META_MC[domain] || {};
	const opts = [];
	if (meta.inherit) opts.push("inherit");
	opts.push(...KNOWN_MODEL_IDS_MC);
	if (meta.aliases) opts.push(...FRONTMATTER_ALIASES_MC);
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
