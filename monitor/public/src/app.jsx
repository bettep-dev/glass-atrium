// 앱 셸 — sidebar + screen routing + Tweaks panel
const { useState: useS, useEffect: useE, useRef: useR } = React;

// NAV 메뉴 — id=해시 라우팅 키 · badge=폴링 주입
const NAV = [
	{ id: "dashboard", label: "Dashboard", icon: "dashboard" },
	{ id: "cost", label: "Cost & usage", icon: "coin" },
	{ id: "model-config", label: "Models & budgets", icon: "cog" },
	{ id: "agents", label: "Agents", icon: "bot" },
	{ id: "outcomes", label: "Task results", icon: "target" },
	{ id: "improvement", label: "Learning", icon: "spark" },
	{ id: "wiki", label: "Wiki", icon: "brain" },
	{ id: "architecture", label: "System map", icon: "git" },
	{ id: "clauded-docs", label: "Documents", icon: "file-text" },
];

// EDITMODE 마커 — host 프로토콜이 디스크 위 JSON 블록 재기록
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/ {
	theme: "dark",
	density: "comfortable",
	accent: "#3b82f6",
} /*EDITMODE-END*/;

// id → screen 컴포넌트 매핑 — 각 screens/*.jsx 가 window 에 self-register
const Screens = {
	dashboard: window.ScreenDashboard,
	cost: window.ScreenCost,
	"model-config": window.ScreenModelConfig,
	agents: window.ScreenAgents,
	outcomes: window.ScreenOutcomes,
	improvement: window.ScreenImprovement,
	wiki: window.ScreenWiki,
	architecture: window.ScreenArchitecture,
	"clauded-docs": window.ScreenClaudedDocs,
};

const NAV_BADGE_POLL_MS = 60_000;
// no .nav-badge.crit rule in styles yet → local tone fill mirroring .nav-badge.warn
const NAV_BADGE_CRIT_STYLE = {
	background: "rgb(var(--crit) / 0.15)",
	color: "rgb(var(--crit))",
	borderColor: "transparent",
};
const MAIN_CONTENT_ID = "main-content";

// page h1 → focus target (tabindex -1 = programmatic only, authored value kept); no h1 → the region
function focusRouteHeading(region) {
	if (!region) return;
	const target = region.querySelector("h1") || region;
	if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
	target.focus();
}

// the hash is the route key → cancel the #main-content navigation, move focus instead
function onSkipToContent(event) {
	event.preventDefault();
	focusRouteHeading(document.getElementById(MAIN_CONTENT_ID));
}

// hash 형식 `#screen?per-screen-query` — '?' 앞부분만 screen id
function parseHashScreen() {
	const raw = window.location.hash.replace(/^#/, "").split("?")[0];
	return NAV.some((n) => n.id === raw) ? raw : "dashboard";
}

function Sidebar({ active, onNav, harness }) {
	const { Icon } = window.UI;
	const systems = systemsRollup(harness);
	const dynamicBadges = harnessToNavBadges(harness);
	return (
		<aside aria-label="Sidebar" className="shell-sidebar flex-shrink-0 border-r border-line h-screen sticky top-0 flex flex-col bg-elev">
			<div className="shell-brand px-4 py-4 border-b border-line">
				<div className="flex items-center gap-2.5">
					<div className="w-7 h-7 rounded-md overflow-hidden bg-ink">
						<img src="/assets/favicon/icon-192.png" alt="Atrium Monitor" className="w-full h-full object-cover" />
					</div>
					<div className="rail-hide">
						<div className="text-[13px] font-semibold leading-none">
							Atrium Monitor
						</div>
					</div>
				</div>
			</div>
			<nav aria-label="Primary" className="flex-1 p-2.5 overflow-y-auto">
				<div className="space-y-0.5">
					{NAV.map((n) => {
						// dynamicBadges 키 존재 = polled (null 이어도 정적 fallback 차단)
						const hasDyn =
							dynamicBadges &&
							Object.prototype.hasOwnProperty.call(dynamicBadges, n.id);
						const dyn = hasDyn ? dynamicBadges[n.id] : null;
						// 합성 신호는 `badges` 배열, 단일 신호는 `badge`/`badgeTone` — 둘 다 동일 슬롯 렌더.
						const badges =
							dyn?.badges ??
							(hasDyn
								? dyn?.badge
									? [{ badge: dyn.badge, badgeTone: dyn.badgeTone }]
									: []
								: n.badge
									? [{ badge: n.badge, badgeTone: n.badgeTone }]
									: []);
						return (
							<button
								key={n.id}
								className={`nav-item ${active === n.id ? "active" : ""}`}
								onClick={() => onNav(n.id)}
								title={n.label}
							>
								<Icon name={n.icon} size={14} />
								{/* min-w-0 + truncate — 영문 라벨 + 복수 배지 동시 표시 시 220px 초과분은 라벨 말줄임 (배지는 shrink-0 보존). */}
								<span className="rail-hide flex-1 min-w-0 truncate">{n.label}</span>
								{badges.map((b, i) => (
									<span
										key={i}
										className={`nav-badge shrink-0 ${b.badgeTone || ""}`}
										style={b.badgeTone === "crit" ? NAV_BADGE_CRIT_STYLE : undefined}
									>
										{b.badge}
									</span>
								))}
							</button>
						);
					})}
				</div>
			</nav>
			<div className="p-3 border-t border-line">
				<div className="bg-sunken rounded-md p-2.5 text-[11px]">
					<div className="flex items-center gap-1.5 mb-1">
						{/* 라이브 롤업 파생 — ok 상태만 pulse(live-dot), 그 외 정적 (가짜 상시-green 제거). */}
						<span className={`w-1.5 h-1.5 rounded-full ${systems.dotClass}${systems.tone === "ok" ? " live-dot" : ""}`}></span>
						<span className="rail-hide font-mono text-dim">{systems.label}</span>
					</div>
				</div>
			</div>
		</aside>
	);
}

// fetch 헬퍼 — non-2xx 를 reject 로 변환 (Promise.allSettled status='rejected')
function fetchJson(url) {
	return fetch(url, { headers: { Accept: "application/json" } }).then((r) =>
		r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
	);
}

// harness 스토어 초기값 — 'loading' 은 '아직 모름'이고 0 이 아니다(가짜 정상 차단).
const HARNESS_STORE_INITIAL = { status: "loading", data: null };

// allSettled 결과 → harness 스토어 상태. rejected 는 error 로 남겨 fold 가 미수신을 구분한다.
function toStoreState(settled) {
	return settled.status === "fulfilled"
		? { status: "ready", data: settled.value }
		: { status: "error", data: null };
}

// harness fold → architecture(System map) nav 슬롯. 두 기여분(KPI 실패 카운트 · 데몬 다운)이
// 한 fold 에서 같이 나오므로 소스별 병합이 필요 없다 — 재폴링이 서로를 덮을 수 없음.
// 키 존재 = polled 계약 유지: fold 가 아직 아무것도 관측 못 했으면 키 자체를 내지 않는다.
function harnessToNavBadges(harness) {
	if (!harness || harness.status !== "ready") return {};

	const badges = [];
	if (harness.failCount1h > 0) {
		badges.push({ badge: String(harness.failCount1h), badgeTone: "warn", source: "kpi" });
	}
	if (harness.daemonsDown > 0) {
		// a down daemon is crit on its Dashboard alarm → the badge follows the worst severity
		badges.push({ badge: String(harness.daemonsDown), badgeTone: "crit", source: "daemon" });
	}
	return { architecture: badges.length > 0 ? { badges } : null };
}

// ALL SYSTEMS 풋터 도트 = 레인/타일과 같은 harness fold 파생. 폴링이 실패한 순간에도
// 두 표면이 어긋나지 않는다 — 미관측은 직전 값 보존이 아니라 neutral 'CHECKING…'.
// 도트 클래스는 StatusDot(ui.jsx) 어휘 재사용 (미등록 클래스 금지).
function systemsRollup(harness) {
	if (!harness || harness.status !== "ready") {
		return { tone: "neutral", dotClass: "bg-faint", label: "CHECKING…" };
	}

	const issues =
		harness.downNames.length > 0 || harness.daemonsDown > 0 || harness.failCount1h > 0;
	if (!issues) return { tone: "ok", dotClass: "bg-ok", label: "ALL SYSTEMS" };
	return { tone: "warn", dotClass: "bg-warn", label: "ISSUES DETECTED" };
}

function App() {
	// tweaks → data-theme / --accent / data-density 동기화
	const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);

	const [active, setActive] = useS(parseHashScreen);

	// harness 원본 스토어 — 셸이 한 cadence 로 읽고 fold 가 단일 상태로 접는다.
	// 화면은 이 fold 만 받는다: 스크린이 같은 payload 를 다시 해석하면 풋터와 어긋난다.
	const [kpiState, setKpiState] = useS(HARNESS_STORE_INITIAL);
	const [liveState, setLiveState] = useS(HARNESS_STORE_INITIAL);
	const [healthState, setHealthState] = useS(HARNESS_STORE_INITIAL);
	const [hookState, setHookState] = useS(HARNESS_STORE_INITIAL);
	const [hookFailState, setHookFailState] = useS(HARNESS_STORE_INITIAL);

	// density 는 attribute 만 노출, CSS 매핑은 차후
	useE(() => {
		document.documentElement.setAttribute("data-theme", tweaks.theme);
		document.documentElement.setAttribute("data-density", tweaks.density);
		document.documentElement.style.setProperty(
			"--accent",
			hexToRgbTriplet(tweaks.accent),
		);
	}, [tweaks.theme, tweaks.density, tweaks.accent]);

	// hash → state (뒤로/앞으로, 수동 편집, 딥링크)
	useE(() => {
		const onHashChange = () => setActive(parseHashScreen());
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	// state → hash (per-screen query suffix 보존, replaceState 로 히스토리 누적 방지)
	useE(() => {
		const cur = window.location.hash.replace(/^#/, "");
		const qIdx = cur.indexOf("?");
		const suffix = qIdx >= 0 ? cur.slice(qIdx) : "";
		const desired = `#${active}${suffix}`;
		if (window.location.hash !== desired) {
			window.history.replaceState(null, "", desired);
		}
	}, [active]);

	// kpi 배지 폴링 (alerts+health) — 60s. 실패 시 직전 상태 유지
	useE(() => {
		let cancelled = false;
		const fetchBadges = async () => {
			const kpiR = await Promise.allSettled([fetchJson("/api/dashboard/kpi")]);
			if (cancelled) return;
			setKpiState(toStoreState(kpiR[0]));
		};
		fetchBadges();
		const id = setInterval(fetchBadges, NAV_BADGE_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, []);

	// harness wave — architecture/live + health 를 KPI 와 같은 cadence 로 폴링.
	// 레인/타일이 살아있는 판독을 받아야 하므로 마운트 1회로는 부족하다.
	useE(() => {
		let cancelled = false;
		const pollHarness = async () => {
			const [live, health, hook, hookFail] = await Promise.allSettled([
				fetchJson("/api/architecture/live"),
				fetchJson("/api/health"),
				fetchJson("/api/health/hook-chain"),
				fetchJson("/api/health/hook-failures?days=30&limit=50"),
			]);
			if (cancelled) return;
			setHealthState(toStoreState(health));
			setLiveState(toStoreState(live));
			setHookState(toStoreState(hook));
			setHookFailState(toStoreState(hookFail));
		};
		pollHarness();
		const id = setInterval(pollHarness, NAV_BADGE_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, []);

	// route change → page heading focus (drill + sidebar + back/forward); first mount excluded
	const focusedRoute = useR(active);
	useE(() => {
		if (focusedRoute.current === active) return;
		focusedRoute.current = active;
		focusRouteHeading(document.getElementById(MAIN_CONTENT_ID));
	}, [active]);

	// NAV 클릭 — state 변경 + screen 전환 시 stale query suffix 제거
	const onNavClick = (id) => {
		setActive(id);
		const cur = window.location.hash.replace(/^#/, "");
		const qIdx = cur.indexOf("?");
		const curScreen = qIdx >= 0 ? cur.slice(0, qIdx) : cur;
		if (curScreen !== id) {
			window.history.replaceState(null, "", `#${id}`);
		}
	};

	// 풋터 · nav 숫자 · Dashboard 레인이 읽는 단일 harness 사실.
	const harness = window.HealthModel.foldHarness({
		kpiState,
		liveState,
		healthState,
		hookState,
		hookFailState,
	});

	const Screen = Screens[active];
	const activeNav = NAV.find((n) => n.id === active);

	// min-h-[100dvh] — architecture (h-full) 가 부모 높이를 배로 끌어올리는 것 차단
	// dvh — iOS Safari 주소창 가변 영역 안전 (vh 흔들림 회피)
	return (
		<div
			lang="en"
			className="flex min-h-[100dvh]"
			data-screen-label={activeNav ? `${activeNav.label}` : ""}
		>
			<a href={`#${MAIN_CONTENT_ID}`} className="skip-link" onClick={onSkipToContent}>
				Skip to content
			</a>
			<Sidebar active={active} onNav={onNavClick} harness={harness} />
			<div className="flex-1 min-w-0 flex flex-col">
				<main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex-1 min-w-0 p-6 flex flex-col min-h-0">
					{Screen ? (
						<Screen onNav={onNavClick} harness={harness} />
					) : (
						<div className="placeholder">Coming soon — '{active}'</div>
					)}
				</main>
			</div>
			<TweaksUI tweaks={tweaks} setTweak={setTweak} />
		</div>
	);
}

// 테마(모드+강조색) + 레이아웃(밀도) 두 섹션. TweaksPanel 미로드 시 null
function TweaksUI({ tweaks, setTweak }) {
	const { TweaksPanel, TweakSection, TweakRadio, TweakColor } = window;
	if (!TweaksPanel) return null;
	return (
		<TweaksPanel title="Tweaks">
			<TweakSection label="Theme">
				<TweakRadio
					label="Mode"
					value={tweaks.theme}
					onChange={(v) => setTweak("theme", v)}
					options={[
						{ label: "Dark", value: "dark" },
						{ label: "Light", value: "light" },
					]}
				/>
				<TweakColor
					label="Accent color"
					value={tweaks.accent}
					onChange={(v) => setTweak("accent", v)}
				/>
			</TweakSection>
			<TweakSection label="Layout">
				<TweakRadio
					label="Density"
					value={tweaks.density}
					onChange={(v) => setTweak("density", v)}
					options={[
						{ label: "Comfortable", value: "comfortable" },
						{ label: "Compact", value: "compact" },
					]}
				/>
			</TweakSection>
		</TweaksPanel>
	);
}

// #RRGGBB / #RGB → "r g b" CSS 변수 포맷
function hexToRgbTriplet(hex) {
	const h = hex.replace("#", "");
	const n =
		h.length === 3
			? h
					.split("")
					.map((c) => c + c)
					.join("")
			: h;
	const r = parseInt(n.slice(0, 2), 16),
		g = parseInt(n.slice(2, 4), 16),
		b = parseInt(n.slice(4, 6), 16);
	return `${r} ${g} ${b}`;
}

// 표시 tz 시드 — /api/health 의 timezone(config [meta].timezone 렌더)을 1회 fetch 후
// 렌더 시작. localhost 단발 호출이라 부트 지연 무시 가능 · 실패 시 기본(KST) 유지.
// 렌더 후 시드 시 이미 그려진 시각 문자열이 stale 해지는 race 차단이 목적.
fetchJson("/api/health")
	.then((health) => window.UI.setDisplayTimezone(health && health.timezone))
	.catch(() => {
		// 무시 — setDisplayTimezone 미호출 = 기본 tz 폴백이 의도된 동작
	})
	.finally(() => {
		ReactDOM.createRoot(document.getElementById("root")).render(<App />);
	});
