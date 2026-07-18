// 앱 셸 — sidebar + screen routing + Tweaks panel
const { useState: useS, useEffect: useE } = React;

// NAV 메뉴 — id=해시 라우팅 키 · badge=폴링 주입
const NAV = [
	{ id: "dashboard", label: "Dashboard", icon: "dashboard" },
	{ id: "cost", label: "Cost & usage", icon: "coin" },
	{ id: "model-config", label: "Models & budgets", icon: "cog" },
	{ id: "agents", label: "Agents", icon: "bot" },
	{ id: "outcomes", label: "Task results", icon: "target" },
	{ id: "improvement", label: "Learning", icon: "spark" },
	{ id: "health", label: "System health", icon: "pulse" },
	{ id: "wiki", label: "Wiki", icon: "brain" },
	{ id: "architecture", label: "System map", icon: "git" },
	{ id: "clauded-docs", label: "Documents", icon: "target" },
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
	health: window.ScreenHealth,
	wiki: window.ScreenWiki,
	architecture: window.ScreenArchitecture,
	"clauded-docs": window.ScreenClaudedDocs,
};

const NAV_BADGE_POLL_MS = 60_000;

// hash 형식 `#screen?per-screen-query` — '?' 앞부분만 screen id
function parseHashScreen() {
	const raw = window.location.hash.replace(/^#/, "").split("?")[0];
	return NAV.some((n) => n.id === raw) ? raw : "dashboard";
}

function Sidebar({ active, onNav, dynamicBadges }) {
	const { Icon } = window.UI;
	return (
		<aside className="w-[220px] flex-shrink-0 border-r border-line h-screen sticky top-0 flex flex-col bg-elev">
			<div className="px-4 py-4 border-b border-line">
				<div className="flex items-center gap-2.5">
					<div className="w-7 h-7 rounded-md overflow-hidden bg-ink">
						<img src="/assets/favicon/icon-192.png" alt="Atrium Monitor" className="w-full h-full object-cover" />
					</div>
					<div>
						<div className="text-[13px] font-semibold leading-none">
							Atrium Monitor
						</div>
					</div>
				</div>
			</div>
			<nav className="flex-1 p-2.5 overflow-y-auto">
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
							>
								<Icon name={n.icon} size={14} />
								{/* min-w-0 + truncate — 영문 라벨 + "Update needed" 류 와이드 배지 동시 표시 시 220px 초과분은 라벨 말줄임 (배지는 shrink-0 보존). */}
								<span className="flex-1 min-w-0 truncate">{n.label}</span>
								{badges.map((b, i) => (
									<span
										key={i}
										className={`nav-badge shrink-0 ${b.badgeTone || ""}`}
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
						<span className="w-1.5 h-1.5 rounded-full bg-ok live-dot"></span>
						<span className="font-mono text-dim">ALL SYSTEMS</span>
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

function kpiToBadges(kpi) {
	const fails = Number(kpi.last_1h_fail_count) || 0;
	// cost 키는 항상 반환(null 이라도) — 정적 fallback 배지 차단 계약 유지. 예산은 per-call HARD CAP
	// (월 누적 한도 아님)이라 cost-slot 에 매핑할 소진율 신호가 없으므로 항상 null.
	return {
		health: fails > 0 ? { badge: String(fails), badgeTone: "warn" } : null,
		cost: null,
	};
}

// live 신호 두 개를 독립 슬롯으로 분리:
//   · 구조 드리프트(stale)        → architecture(System map) info "Update needed" (설계도 카운트 mismatch)
//   · 데몬 다운(daemon status≠ok) → health(System health) warn 카운트 (런타임 헬스)
// 슬롯이 분리돼 서로 덮지 않음. health 슬롯은 KPI 배지와 mergeHealthBadge 로 병치.
function liveToBadge(live) {
	const architecture =
		live?.stale === true
			? { badge: "Update needed", badgeTone: "info" }
			: null;

	const badDaemons = (live?.daemons || []).filter(
		(d) => d.status !== "ok",
	).length;
	const daemonHealth =
		badDaemons > 0 ? { badge: String(badDaemons), badgeTone: "warn" } : null;

	return { architecture, daemonHealth };
}

// health nav 배지 병합 — 독립 두 소스(KPI 실패 카운트 · 데몬 다운 카운트)가 한 슬롯에 병치.
// 소스 태그로 자기 기여분만 교체 → 한 소스 재폴링이 다른 소스 배지를 덮지 않음.
// badges-array-coexistence 관용(Sidebar 가 배열/단일 양쪽 호환) 재사용.
function mergeHealthBadge(prevHealth, source, badge) {
	const kept = (prevHealth?.badges || []).filter((b) => b.source !== source);
	const next = badge ? [...kept, { ...badge, source }] : kept;
	return next.length > 0 ? { badges: next } : null;
}

function App() {
	// tweaks → data-theme / --accent / data-density 동기화
	const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);

	const [active, setActive] = useS(parseHashScreen);

	// id → badge 오버라이드. 키 존재 = polled (count=0 도 정적 fallback 차단)
	const [navBadges, setNavBadges] = useS({});

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
			if (kpiR[0].status !== "fulfilled") return; // 실패 시 직전 동기화 시각 보존
			setNavBadges((prev) => {
				const kpi = kpiToBadges(kpiR[0].value);
				// health 는 데몬 다운 소스와 병치되므로 스프레드로 덮지 않고 merge.
				return {
					...prev,
					cost: kpi.cost,
					health: mergeHealthBadge(prev.health, "kpi", kpi.health),
				};
			});
		};
		fetchBadges();
		const id = setInterval(fetchBadges, NAV_BADGE_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, []);

	// architecture/live 배지 — 마운트 시 1회. 데이터가 서비스 부팅 간 준정적이라 폴링 불요
	useE(() => {
		let cancelled = false;
		fetchJson("/api/architecture/live")
			.then((live) => {
				if (cancelled) return;
				const { architecture, daemonHealth } = liveToBadge(live);
				setNavBadges((prev) => ({
					...prev,
					architecture,
					health: mergeHealthBadge(prev.health, "daemon", daemonHealth),
				}));
			})
			.catch(() => {
				// 무시 — 직전 navBadges/동기화 시각 보존
			});
		return () => {
			cancelled = true;
		};
	}, []);

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

	const Screen = Screens[active];
	const activeNav = NAV.find((n) => n.id === active);

	// min-h-[100dvh] — architecture (h-full) 가 부모 높이를 배로 끌어올리는 것 차단
	// dvh — iOS Safari 주소창 가변 영역 안전 (vh 흔들림 회피)
	return (
		<div
			className="flex min-h-[100dvh]"
			style={{ minWidth: 1280 }}
			data-screen-label={activeNav ? `${activeNav.label}` : ""}
		>
			<Sidebar
				active={active}
				onNav={onNavClick}
				dynamicBadges={navBadges}
			/>
			<div className="flex-1 min-w-0 flex flex-col">
				<main className="flex-1 p-6 flex flex-col min-h-0">
					{Screen ? (
						<Screen onNav={onNavClick} />
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
