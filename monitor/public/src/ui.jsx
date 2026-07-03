// 공용 UI atoms — window.UI 로 export, screens/*.jsx 가 destructure 임포트
const { useEffect, useRef } = React;

// 포커스 가능 요소 셀렉터 SoT — focus-trap 진입/순환 공용 (DetailSurface).
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

// 짧은 별칭(레거시 call-site 이름) → Lucide UMD PascalCase 키. 손수 관리하던 36개 글리프의 모든
//   호출 이름을 Lucide 정식 이름으로 매핑 → 기존 <Icon name>/SymI/TONE_ICON 호출 전부 무회귀 +
//   전체 카탈로그를 이름만으로 개방. warn→TriangleAlert · crit→CircleAlert 은 Lucide 의
//   alert-triangle→triangle-alert / alert-circle→circle-alert 리네임 반영.
//   arrow-right 는 kebab call-site(getLucideKey 구분자-대문자화)로 해석 → 별도 별칭 불필요.
const LUCIDE_ALIAS = {
  dashboard: 'LayoutDashboard', coin: 'CircleDollarSign', bot: 'Bot', target: 'Target', brain: 'Brain',
  spark: 'Sparkles', terminal: 'Terminal', bell: 'Bell', pulse: 'Activity', chevR: 'ChevronRight',
  chevD: 'ChevronDown', arrowU: 'ArrowUp', arrowD: 'ArrowDown', minus: 'Minus',
  check: 'Check', x: 'X', play: 'Play', refresh: 'RefreshCw', download: 'Download', filter: 'Filter',
  search: 'Search', moon: 'Moon', sun: 'Sun', cog: 'Settings', info: 'Info', warn: 'TriangleAlert',
  crit: 'CircleAlert', user: 'User', db: 'Database', chip: 'Cpu', git: 'GitFork', flame: 'Flame',
  ban: 'Ban', pause: 'Pause', plus: 'Plus', circle: 'Circle',
};

// 임의 표기(별칭/kebab/snake/camel/Pascal)를 Lucide PascalCase 키로 정규화.
//   별칭 우선 → 없으면 맨앞/구분자(-,_) 뒤 소문자를 대문자화 (arrow-up·arrow_up·arrowUp → ArrowUp).
function getLucideKey(name) {
  if (LUCIDE_ALIAS[name]) return LUCIDE_ALIAS[name];
  return String(name).replace(/(^|[-_])([a-z])/g, (_, __, c) => c.toUpperCase());
}

// Lucide IconNode 자식 attrs → React attrs (kebab → camel). 현재 핀 버전 자식 데이터엔 kebab attr 이
//   없지만(kebab 은 부모 default attrs 에만 존재하고 여기선 자체 svg attrs 로 대체) 향후 버전 안전차원.
function getReactAttrs(attrs) {
  const out = {};
  for (const k in attrs) out[k.includes('-') ? k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) : k] = attrs[k];
  return out;
}

// 해결된 Lucide 키 → 사전 변환된 자식 React-element 배열 캐시. name 은 사실상 컴파일타임 상수라
//   정규화+카탈로그 조회+자식 attr 변환을 매 렌더 반복하던 것을 최초 1회로 축소(폴링 재렌더 누적 비용 제거).
//   성공 해석만 저장 — 미로드(Lucide CDN async) 케이스는 캐시 금지해 이후 로드가 정상 채워지게(무회귀).
//   자식 element 만 캐시(부모 svg props=size/stroke/className/aria 는 매번 새로 조립) → 거동 불변.
const ICON_CHILDREN_CACHE = new Map();

function getIconChildren(key, node) {
  let children = ICON_CHILDREN_CACHE.get(key);
  if (!children) {
    children = node[2].map(([tag, attrs], i) => React.createElement(tag, { ...getReactAttrs(attrs), key: i }));
    ICON_CHILDREN_CACHE.set(key, children);
  }
  return children;
}

// ariaHidden 기본 true — 아이콘은 장식(decorative)이고 의미는 인접 텍스트 라벨이 운반한다(색+기호+텍스트 3중 인코딩 유지).
// stroke='currentColor' 보존 → 자체(className=text-{tone}) 또는 상위 tone 컬러 클래스가 세팅한 color 를 그대로 상속(색 인코딩 무퇴행).
// 내부 구현: Lucide UMD 전역(window.lucide) 단일 소스에서 이름으로 IconNode 를 조회해 자식만 렌더 —
//   미해결/미로드 시 null-safe 빈 svg (손수 복사 path fallback 없음). 공개 API(name/size/className/stroke/ariaHidden)·수직정렬·currentColor 보존.
function Icon({ name, size=16, className='', stroke=1.6, ariaHidden=true }) {
  // 인라인(비-flex) 텍스트 옆 svg 를 텍스트와 수직 중앙 정렬하는 전역 additive 기본값.
  //   · className 에 명시 정렬(align-*/vertical-align)이 있으면 양보 — inline style 가 class 를 이기므로 조건부로만 적용(SymI 의 align-middle 무회귀).
  //   · inline-flex 컨테이너(.pill 등)에선 vertical-align 이 무시되므로 보드 배지에 무해.
  const alignStyle = /align-|vertical-align/.test(className) ? undefined : { verticalAlign: '-0.125em' };
  const props = { width:size, height:size, viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', strokeWidth:stroke, strokeLinecap:'round', strokeLinejoin:'round', className, style: alignStyle, 'aria-hidden': ariaHidden || undefined };
  // falsy name(예: HOOK_ERROR_KIND_MODEL 의 icon:null) → 빈 svg (기존 paths[null] 동작 보존, throw 금지).
  if (!name) return <svg {...props} />;
  // 1차: Lucide UMD 전역에서 조회 (전체 카탈로그). icons[key] 우선, top-level 키 폴백. IconNode = [tag, attrs, children].
  const lucide = typeof window !== 'undefined' ? window.lucide : undefined;
  const key = getLucideKey(name);
  const node = lucide && ((lucide.icons && lucide.icons[key]) || lucide[key]);
  if (Array.isArray(node) && Array.isArray(node[2])) {
    return <svg {...props}>{getIconChildren(key, node)}</svg>;
  }
  // Lucide 미해결/미로드 → null-safe 빈 svg (throw 금지). 손수 복사한 path fallback 제거 — Lucide UMD 가 유일 소스.
  return <svg {...props} />;
}

// 단일 배지 SoT (canonical) — 전 screen 이 window.UI.Badge 로만 배지를 렌더 (screen-local 배지 JSX/CSS 금지).
//   .pill CSS family = styling layer (neutral shell SoT). 3 role 로 의미 구분:
//   status   = 사용자가 반응해야 할 lifecycle/health 상태 → 선행 tone 심볼(Icon/glyph)이 톤 운반.
//   metadata = 상태 아닌 서술 속성(agent-only, md, model-id) → neutral, glyph 없음.
//   count    = 순수 수량(+1, 27 agents) → neutral, glyph 없음, 가장 작게.
// 하드 규칙 (DESIGN.md §4.2/§7.3 neutral-shell 진화):
//   · shell 은 모든 tone 에서 neutral(--sunken/--dim/--line) — tone-fill 을 .pill 껍데기에 칠하지 않는다.
//   · tone 은 내부 심볼(Icon/glyph)에 text-{tone} 으로만 적용 → dual-encode = shape(글리프)+color+인접 label(DESIGN.md §8).
//   · label 텍스트는 --dim 유지(AA-safe: --sunken 위 warn/ok/info tone 은 11px 3:1 sub-AA). 단 선행 심볼이 없으면(glyph=false status)
//     tone 을 label 이 운반(유일 carrier) — shell 은 여전히 neutral.
//   · metadata/count 는 톤을 받아도 항상 neutral (color≠metadata/count).
// 변형: absent=true → .pill--absent(dashed/faint) · interactive=true → <button>+.pill--interactive(WCAG 2.2 §2.5.8 타깃)
function Badge({ children, role='metadata', tone='neutral', absent=false, glyph=true, icon=false, interactive=false, title, onClick, className='' }) {
  const isStatus = role === 'status';
  const hasTone = isStatus && tone !== 'neutral';
  const toneTextClass = hasTone ? `text-${tone}` : '';   // tone → 내부 심볼/텍스트 color (shell 아님)
  const sizeClass = role === 'metadata' ? 'pill--meta' : role === 'count' ? 'pill--count' : '';
  const showLead = isStatus && glyph;
  // 선행 심볼이 tone 을 운반 — icon=true → <Icon>(TONE_ICON), 아니면 TONE_GLYPH 문자열. 둘 다 text-{tone} 으로 자기 color 명시
  //   (shell 이 --dim 이라 상속으론 tone 이 안 옴). aria-hidden 장식, 의미는 인접 label.
  const leadIcon = showLead && icon ? <Icon name={TONE_ICON[tone]} size={12} className={toneTextClass} /> : null;
  const leadGlyph = showLead && !icon ? <span className={toneTextClass}>{TONE_GLYPH[tone]} </span> : null;
  // 심볼이 없는 status(glyph=false) 는 label 이 유일 tone carrier → children 을 text-{tone} span 으로 감싼다(shell neutral 유지).
  //   심볼이 있으면 label 은 --dim 유지 (tone 은 심볼 담당, AA-safe).
  const body = hasTone && !showLead ? <span className={toneTextClass}>{children}</span> : children;
  // className passthrough — 호출부가 일회성 .pill 변형을 이 인스턴스에만 덧붙이게 (현재 상시 소비자 없음).
  const cls = ['pill', sizeClass, absent ? 'pill--absent' : '', interactive ? 'pill--interactive' : '', className].filter(Boolean).join(' ');
  const a11y = title ? { title } : {};
  const content = <>{leadIcon}{leadGlyph}{body}</>;
  return interactive
    ? <button type="button" className={cls} onClick={onClick} {...a11y}>{content}</button>
    : <span className={cls} {...a11y}>{content}</span>;
}

// 기존 Pill 호출부 호환 — Badge styling layer 로 routing (두 번째 status idiom 방지).
// neutral 톤은 metadata role, 그 외(ok/warn/crit/info)는 status role 로 자동 매핑 (color=status 규칙 정합).
function Pill({ children, tone='neutral' }) {
  return tone === 'neutral'
    ? <Badge role="metadata" glyph={false}>{children}</Badge>
    : <Badge role="status" tone={tone} glyph={false}>{children}</Badge>;
}

// 공용 sub-card primitive — 중첩 섹션/메트릭 타일용 작은 면. ring-1 + rounded-lg + 일정 padding.
//   발산하던 idiom(드로어 1px-hairline · DetailMetric ring 타일 · .i-card-shadow)이 후속 wave 에서 여기로 수렴.
//   sunken=true → bg-sunken(더 들어간 면) · 기본 bg-elev(떠오른 면). label 지정 시 uppercase --dim 섹션 라벨.
function SubCard({ children, sunken=false, label, className='' }) {
  const surface = sunken ? 'bg-sunken' : 'bg-elev';
  return (
    <div className={`sub-card ${surface} ${className}`.trim()}>
      {label && <div className="sub-card-label">{label}</div>}
      {children}
    </div>
  );
}

// Content-level 타입 스케일 토큰 SoT — 레벨당 1 토큰으로 ad-hoc font-size 규격화 (시각 일관성)
// 6단 — display 22(카드 지배 수치) · stat 18(일반 KPI) · title 14 · body 13 · meta 12 · micro 11
// CSS var = 토큰 SoT · .fs-* = 소비 layer (className 단독 적용 가능)
// .hero-stat = 패널당 단 하나의 지배 수치용 30px (display 22 보다 한 단 위) — 18px name 과 묶이지 않게 결정적 우위.
//   tabular-nums = 자릿수 고정 폭(드로어 hero 수치 정렬). negative tracking = 56px 미만 대형 수치 가독.
// SPA 단일 screen 마운트 — screen 별 <style> 무조건 렌더 → 가드 시 재진입에서 토큰 소실 회귀
function TypeScaleStyle() {
  return <style>{`
    :root {
      --fs-display: 22px;
      --fs-stat:  18px;
      --fs-title: 15px;
      --fs-body:  14px;
      --fs-meta:  12px;
      --fs-micro: 11px;
    }
    .fs-display { font-size: var(--fs-display); }
    .fs-stat  { font-size: var(--fs-stat); }
    .fs-title { font-size: var(--fs-title); line-height: 1.4; }
    .fs-body  { font-size: var(--fs-body); line-height: 1.45; }
    .fs-meta  { font-size: var(--fs-meta); line-height: 1.4; }
    .fs-micro { font-size: var(--fs-micro); line-height: 1.45; }
    .hero-stat {
      font-size: 30px;
      line-height: 1.1;
      letter-spacing: -0.02em;
    }
    .tnum { font-variant-numeric: tabular-nums; }
  `}</style>;
}

// 증감 표시 — inverse=true 면 down=좋음/up=나쁨 (비용 증가 등 inverse 지표용)
function Delta({ value, inverse=false }) {
  const sign = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  let tone;
  if (sign === 'flat') tone = 'flat';
  else if (inverse) tone = sign === 'up' ? 'down' : 'up';
  else tone = sign;
  const iconName = sign === 'up' ? 'arrowU' : sign === 'down' ? 'arrowD' : 'minus';
  return <span className={`kpi-delta ${tone}`}>
    <Icon name={iconName} size={11} stroke={2.2} />
    {Math.abs(value).toFixed(1)}%
  </span>;
}

function Sparkline({ data, w=60, h=22, color='currentColor', fill=true }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v,i) => [i/(data.length-1) * w, h - ((v-min)/range)*h*0.85 - 1]);
  const path = pts.map(([x,y],i) => `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${path} L${w},${h} L0,${h} Z`;
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
    {fill && <path d={area} fill={color} opacity="0.12"/>}
    <path d={path} fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}

function MiniBars({ data, w=60, h=22, color='currentColor' }) {
  const max = Math.max(...data) || 1;
  const bw = w / data.length - 1;
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
    {data.map((v,i) => {
      const bh = (v/max) * h * 0.9;
      return <rect key={i} x={i*(bw+1)} y={h-bh} width={bw} height={bh} fill={color} opacity="0.85" rx="0.5"/>;
    })}
  </svg>;
}

// tone KEY → 색상 토큰 var 명. neutral 은 비측정/중립 막대용 muted line(--faint).
// rgb(var(--token) / opacity) 소비 — 하우스 비례막대 관용구(cost.jsx TurnStopReasonTable) 그대로.
const BAR_TONE_VAR = { ok:'--ok', warn:'--warn', crit:'--crit', info:'--info', neutral:'--faint' };

// CSS width:% 가로 막대. tone 은 CSS class 가 아닌 KEY 를 받아 내부에서 토큰으로 매핑.
// 색은 단독 인코딩 금지 — 길이가 크기를, showValue/aria 가 수치를 전달(dual-encoding a11y).
function Bar({ value, tone='neutral', max=1, ariaLabel, showValue=false }) {
  const ratio = Math.min(Math.max((value ?? 0) / (max || 1), 0), 1);
  const pct = ratio * 100;
  const toneVar = BAR_TONE_VAR[tone] || BAR_TONE_VAR.neutral;
  const label = ariaLabel || `${pct.toFixed(0)}%`;
  // 최소-가시 폭: 0 초과인데 % 로는 sub-px 라 안 보이는 행(haiku 0.2% 등)도 sliver 로 렌더.
  // 0 값은 그대로 미렌더(빈 트랙) — "측정값 있음 vs 없음" 구분 보존.
  const fillStyle = ratio > 0
    ? { minWidth: '3px', width: `${pct}%`, background: `rgb(var(${toneVar}) / 0.7)` }
    : { width: '0%' };
  return (
    <div className="flex items-center gap-2" role="img" aria-label={label}>
      <div className="flex-1 h-1.5 bg-sunken rounded-sm overflow-hidden">
        <div className="h-full rounded-sm" style={fillStyle} />
      </div>
      {showValue && <span className="tnum fs-meta text-dim shrink-0">{(value ?? 0).toFixed(2)}</span>}
    </div>
  );
}

// Bar 합성 — 측정값 fill + 선택적 zone 밴드(배경) + 선택적 target 마커.
// zones 는 CONFIGURABLE — 동일 atom 이 0-1 건강지수와 rate-vs-target 둘 다 담당.
// fill tone = value 가 속한 zone(else tone prop). zone 밴드는 prev.upTo→upTo 구간을 저opacity 로.
function BulletBar({ value, target, zones, tone='neutral', ariaLabel, showValue=true }) {
  const v = Math.min(Math.max(value ?? 0, 0), 1);
  let prev = 0;
  const bands = (zones || []).map((z) => {
    const band = { from: prev, to: Math.min(Math.max(z.upTo, 0), 1), tone: z.tone };
    prev = band.to;
    return band;
  });
  // STRICT < cut-points to mirror agents.jsx qualityHealthVerdict (index 0.5→warn, 0.7→ok at exact boundaries).
  // No zone match (e.g. v=1.0 past the last upTo) → fall back to the LAST zone, not the neutral tone prop.
  const zoneList = zones || [];
  const hit = zoneList.find((z) => v < z.upTo) || zoneList[zoneList.length - 1];
  const fillTone = hit ? hit.tone : tone;
  const fillVar = BAR_TONE_VAR[fillTone] || BAR_TONE_VAR.neutral;
  const label = ariaLabel
    || (target != null ? `${(v*100).toFixed(0)}% (target ${(target*100).toFixed(0)}%)` : `${(v*100).toFixed(0)}%`);
  return (
    <div className="flex items-center gap-2" role="img" aria-label={label}>
      <div className="relative flex-1 h-2 bg-sunken rounded-sm overflow-hidden">
        {bands.map((b, i) => (
          <div
            key={i}
            className="absolute inset-y-0"
            style={{ left: `${b.from*100}%`, width: `${(b.to-b.from)*100}%`, background: `rgb(var(${BAR_TONE_VAR[b.tone] || BAR_TONE_VAR.neutral}) / 0.14)` }}
          />
        ))}
        <div
          className="absolute inset-y-0 left-0 rounded-sm"
          style={{ width: `${v*100}%`, background: `rgb(var(${fillVar}) / 0.75)` }}
        />
        {target != null && (
          <div
            className="absolute inset-y-0 w-px"
            style={{ left: `${Math.min(Math.max(target,0),1)*100}%`, background: 'rgb(var(--dim))' }}
          />
        )}
      </div>
      {showValue && <span className="tnum fs-meta text-dim shrink-0">{v.toFixed(2)}</span>}
    </div>
  );
}

function StatusDot({ status }) {
  const map = { ok:'bg-ok', warn:'bg-warn', crit:'bg-crit', info:'bg-info' };
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${map[status] || 'bg-faint'} mr-1.5 align-middle`}></span>;
}

// 22px 원형 컬러 배지 + 이니셜. named agent 외에는 id 해시로 안정 색상
const AGENT_NAMED_COLORS = {
  'intel-planner':    '#3b82f6',
  'intel-researcher': '#8b5cf6',
  writer:     '#06b6d4',
  reviewer:   '#10b981',
  coder:      '#f59e0b',
  analyst:    '#ec4899',
};
const AGENT_PALETTE = ['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#ef4444', '#0891b2'];

function AgentBadge({ a, size=22 }) {
  const id = a?.id || a?.agent_id || '';
  const name = a?.name || a?.agent_name || id || '?';
  const initial = name[0] ? name[0].toUpperCase() : '?';
  const color = AGENT_NAMED_COLORS[id] || AGENT_PALETTE[(strHash(id) >>> 0) % AGENT_PALETTE.length];
  return <span className="agent-badge inline-grid place-items-center font-mono font-semibold text-white shrink-0"
    style={{width:size, height:size, fontSize: size*0.5, borderRadius: size*0.3, background: color, letterSpacing:'-0.02em'}}>
    {initial}
  </span>;
}

// djb2-lite — 시각 팔레트용 결정적 해시 (crypto 불필요)
function strHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) + str.charCodeAt(i);
  }
  return h;
}

// label + 26px mono value + delta + 68×26 inline sparkline
function KPI({ label, value, unit, delta, deltaInverse=false, sparkData, sparkColor='currentColor', onClick, hint }) {
  return <button onClick={onClick} className="kpi text-left">
    <div className="kpi-label">{label}</div>
    {hint && <div className="fs-micro text-faint font-mono kpi-hint">{hint}</div>}
    <div className="kpi-value">{value}{unit && <span className="unit">{unit}</span>}</div>
    {typeof delta === 'number' && <Delta value={delta} inverse={deltaInverse} />}
    {sparkData && <div className="kpi-spark"><Sparkline data={sparkData} w={68} h={26} color={sparkColor}/></div>}
  </button>;
}

// 공용 오버레이 surface — variant 로 배치만 전환, 상호작용 계약은 단일 (presentation-only).
//   drawer     = 우측 슬라이드인 레코드 상세 (기본)
//   fullscreen = 불투명 장문 리딩 면 (페이드)
//   confirm    = 중앙 소형 다이얼로그 (Modal 별칭 위임 대상)
// 계약: 3 닫기(X·Esc·backdrop) · focus-trap(진입 포커스 + Tab 순환 + 트리거 복원) ·
//   body scroll-lock · nav 제공 시 footer Prev/Next + Arrow 바인딩.
// 토큰 재사용 — z-index/모션/면 색상은 tokens.css · base.css 단일 SoT (ad-hoc 금지).
function DetailSurface({ open, onClose, variant = 'drawer', title, sub, footer, children, labelledBy, suppressOutsideClose, nav, bare = false, panelClassName = '', bodyClassName = '' }) {
  const panelRef = useRef(null);
  // 열리기 직전 포커스 트리거 — 닫힘 시 복원 (a11y 포커스 반환).
  const triggerRef = useRef(null);

  // 마운트 전용 — 포커스 캡처/복원 + scroll-lock 은 surface 생애주기(열림→닫힘)에만 묶임.
  // onClose/nav 의존 금지 — 부모 re-render(인라인 onClose 신규 생성)에 캡처/복원이 재실행돼
  // triggerRef 가 상호작용 중 덮어쓰이고 포커스가 트리거로 튀는 회귀 차단. surface 는 open 시에만 마운트.
  useEffect(() => {
    triggerRef.current = document.activeElement;

    const panel = panelRef.current;
    const focusables = panel ? panel.querySelectorAll(FOCUSABLE_SELECTOR) : [];
    if (focusables.length > 0) focusables[0].focus();

    // body scroll-lock — 언마운트/닫힘 시 복원 (현 오버레이엔 부재 → 여기서 단일 추가).
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = prevOverflow;
      // 트리거 복원 — 닫힘 시 호출처 요소로 포커스 반환.
      const trigger = triggerRef.current;
      if (trigger && typeof trigger.focus === 'function') trigger.focus();
    };
  }, []);

  // keydown 핸들러 — Esc 닫기 · Tab 순환 · Arrow nav. onClose/nav 최신 클로저 필요 →
  // 재바인딩 무해 (리스너 add/remove 만 반복, 포커스/scroll 상태 무영향).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Tab') {
        const panel = panelRef.current;
        const list = panel ? panel.querySelectorAll(FOCUSABLE_SELECTOR) : [];
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      // 레코드 nav — ArrowUp=이전 · ArrowDown=다음 (제공 시에만 바인딩).
      if (nav && e.key === 'ArrowUp' && nav.hasPrev) { e.preventDefault(); nav.onPrev(); }
      else if (nav && e.key === 'ArrowDown' && nav.hasNext) { e.preventDefault(); nav.onNext(); }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, nav]);

  if (!open) return null;

  // confirm 만 click-outside 차단 옵션 — destructive 다이얼로그 오작동 방지.
  const onBackdrop = (variant === 'confirm' && suppressOutsideClose) ? undefined : onClose;
  const dialogProps = labelledBy ? { 'aria-labelledby': labelledBy } : { 'aria-label': title };

  const closeBtn = <button className="btn ghost sm" onClick={onClose} aria-label="Close details"><Icon name="x" size={14}/></button>;
  const head = <div className="detail-head">
    <div className="flex-1 min-w-0">
      <div id={labelledBy} className="detail-title">{title}</div>
      {sub && <div className="detail-sub">{sub}</div>}
    </div>
    {closeBtn}
  </div>;

  // nav 제공 시 footer 에 Prev/Next 승격 — 명시 footer 와 병존.
  const navFoot = nav ? <div className="detail-nav">
    <button className="btn ghost sm" onClick={nav.onPrev} disabled={!nav.hasPrev} aria-label="Previous record">
      <Icon name="arrowU" size={14}/> Prev
    </button>
    <button className="btn ghost sm" onClick={nav.onNext} disabled={!nav.hasNext} aria-label="Next record">
      Next <Icon name="arrowD" size={14}/>
    </button>
  </div> : null;
  const foot = (footer || navFoot) ? <div className="detail-foot">{navFoot}{footer}</div> : null;

  // bare — head/body-padding chrome 만 생략 (children 이 자체 header/close 소유). 오버레이·계약은 동일.
  //   body 는 .detail-body--bare 로 padding 만 0 화 → overflow/flex 등 스크롤 거동 유지.
  const panelCls = `detail-panel${panelClassName ? ` ${panelClassName}` : ''}`;
  const bodyCls = `detail-body${bare ? ' detail-body--bare' : ''}${bodyClassName ? ` ${bodyClassName}` : ''}`;

  return <div className={`detail-overlay detail-${variant}`} onClick={onBackdrop}>
    <div ref={panelRef} role="dialog" aria-modal="true" {...dialogProps}
         className={panelCls} onClick={(e) => e.stopPropagation()}>
      {bare ? null : head}
      <div className={bodyCls}>{children}</div>
      {foot}
    </div>
  </div>;
}

// 하위호환 별칭 — 기존 Modal API(title/onClose/children/footer) 유지, confirm variant 위임.
// cost.jsx SessionBinModal 등 현 호출처는 무수정으로 동작 (open 은 마운트 시 항상 true).
function Modal({ title, onClose, children, footer }) {
  return <DetailSurface open={true} onClose={onClose} variant="confirm"
    title={title} footer={footer}>{children}</DetailSurface>;
}

function Tabs({ items, value, onChange }) {
  return <div className="tabs">
    {items.map(it => <button key={it.value} className={`tab ${value===it.value?'active':''}`} onClick={() => onChange(it.value)}>{it.label}</button>)}
  </div>;
}

function CardHead({ title, sub, right }) {
  return <div className="card-head">
    <div className="flex-1 min-w-0">
      <div className="card-title">{title}</div>
      {sub && <div className="card-sub mt-0.5" title={window.UI.titleOf(sub)}>{sub}</div>}
    </div>
    {right && <div className="ml-auto flex items-center gap-2 shrink-0">{right}</div>}
  </div>;
}

// title prop 은 단일행 헤더 정책으로 의도적으로 무시 (sub 만 렌더)
function PageHeader({ title, sub, right }) {
  return <div className="flex items-center gap-3 mb-4">
    <div className="text-[11px] font-mono text-faint tracking-wider uppercase">{sub}</div>
    {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
  </div>;
}

// hover-tooltip title 가드 SoT — 문자열만 title 로 통과, 비문자열은 undefined (object/element 가 title 로 새는 것 방지).
const titleOf = (v) => (typeof v === 'string' ? v : undefined);

// cost.jsx 등 다른 screen 공용 텍스트 유틸
function stripHtmlTags(input) {
  if (!input) return '';
  return String(input)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// ISO timestamp → "5m ago" / "in 5m" 상대시각
function formatRelativeTime(iso) {
  try {
    const target = new Date(iso).getTime();
    const now = Date.now();
    const diffSec = Math.round((target - now) / 1000);
    const abs = Math.abs(diffSec);
    const past = diffSec < 0;
    let label;
    if (abs < 60)         label = `${abs}s`;
    else if (abs < 3600)  label = `${Math.round(abs / 60)}m`;
    else if (abs < 86400) label = `${Math.round(abs / 3600)}h`;
    else                  label = `${Math.round(abs / 86400)}d`;
    return past ? `${label} ago` : `in ${label}`;
  } catch (_e) {
    return iso;
  }
}

// API 는 UTC ISO(Z) 제공 → 표시 tz 는 서버 /api/health timezone(config [meta].timezone) 시드
// — 브라우저 로컬 tz 비의존. 기본값 Asia/Seoul = 시드 실패/부재 시 stock 동작 유지.
// formatKst* 명칭의 Kst 는 기본 tz(KST) 관례 유지 — 실제 변환 tz 는 DISPLAY_TIMEZONE.
let DISPLAY_TIMEZONE = 'Asia/Seoul';

// 부트 시 서버 응답 timezone 으로 시드. 유효하지 않은 IANA 명칭 → 기본 유지
// (Intl 생성자 throw 가 유효성 판정 — 잘못된 tz 로 전 화면 포매터가 깨지는 것 차단).
function setDisplayTimezone(tz) {
  if (!tz) return;
  try {
    new Intl.DateTimeFormat('ko-KR', { timeZone: tz });
    DISPLAY_TIMEZONE = tz;
  } catch (_e) {
    // 무시 — 기본 tz 유지가 의도된 폴백
  }
}

function getDisplayTimezone() { return DISPLAY_TIMEZONE; }

// tz 약칭 라벨 — Asia/Seoul 은 관례 'KST' 고정(Intl en-US 는 'GMT+9' 를 반환해 기존
// 표기 회귀), 그 외 Intl short 명칭(EDT/GMT+N 등). 인자 생략 → 표시 tz.
function tzShortLabel(tz) {
  const zone = tz || DISPLAY_TIMEZONE;
  if (zone === 'Asia/Seoul') return 'KST';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value || zone;
  } catch (_e) {
    return zone;
  }
}

// formatToParts 채택 — locale 문자열 quirk 무관하게 MM/DD HH:mm 레이아웃 직접 조립
function kstParts(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: DISPLAY_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value ?? '';
  // hour12:false 가 자정을 '24'로 주는 환경 보정 → '00'
  const hour = pick('hour') === '24' ? '00' : pick('hour');
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour, minute: pick('minute'), second: pick('second') };
}

// UTC ISO → "MM/DD HH:mm" (표시 tz)
function formatKstDateTime(iso) {
  const p = kstParts(iso);
  if (!p) return iso || '—';
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

// UTC ISO → "HH:mm" (표시 tz)
function formatKstTime(iso) {
  const p = kstParts(iso);
  if (!p) return iso || '—';
  return `${p.hour}:${p.minute}`;
}

// UTC ISO → "YYYY-MM-DD" (표시 tz)
function formatKstDate(iso) {
  const p = kstParts(iso);
  if (!p) return iso || '—';
  return `${p.year}-${p.month}-${p.day}`;
}

// UTC ISO → "YYYY-MM-DD HH:mm:ss <tz약칭>" — hover/title 상세용
function formatKstFull(iso) {
  const p = kstParts(iso);
  if (!p) return iso || '—';
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${tzShortLabel()}`;
}

// 데몬 status enum → tone/라벨 SoT (A2) — dashboard·health·architecture 공용 단일 테이블.
// 서버 emit 가능 enum 만 보유 (ok/partial/error/quota_exceeded + 합성 missing/stale) — 미발행 키 보유 금지.
// quota_exceeded = 외부 한도 원인 → neutral 'Usage limit' (장애 아님).
const DAEMON_STATUS_TONE = {
  ok:             { tone: 'ok',      label: 'Healthy' },
  partial:        { tone: 'warn',    label: 'Warning' },
  error:          { tone: 'crit',    label: 'Down' },
  missing:        { tone: 'crit',    label: 'No data' },
  stale:          { tone: 'crit',    label: 'Overdue' },
  quota_exceeded: { tone: 'neutral', label: 'Usage limit' },
};

function daemonStatusTone(status) {
  return (DAEMON_STATUS_TONE[status] || { tone: 'info', label: status || '—' }).tone;
}

function daemonStatusLabel(status) {
  return (DAEMON_STATUS_TONE[status] || { tone: 'info', label: status || '—' }).label;
}

// 숫자 포맷 SoT (cost/dashboard 공용) — 비숫자/NaN 입력은 Number(v)||0 으로 0 가드

// 고정 2 소수 · 천 단위 콤마 ($35,064.00)
function formatUsd(value) {
  const v = Number(value) || 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ≥$100 → 정수 자릿수 · <$100 → 2 소수 · 천 단위 콤마 · Math.abs 부호 무관 임계
// 차트 YAxis tick · 미니바 hover 캡션 공용
function formatUsdCompact(value) {
  const v = Number(value) || 0;
  const decimals = Math.abs(v) >= 100 ? 0 : 2;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// 콤마 정수 (1,234,567)
function formatInt(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('en-US');
}

// K=1소수 · M/B/T=2소수 압축 · 1e3 미만 = 원값 문자열 · Math.abs 부호 무관 임계
function formatTokenCompact(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6)  return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3)  return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// outcome result enum → tone/glyph SoT (A2) — 전 화면 동일 매핑 강제 (blocked 는 실패 아님 · info).
// needs_context 는 성공률 분모 제외 + 별도 카운트 노출 대상 (neutral).
// glyph = 문자열 SoT(deferred 소비부 유지) · icon = Icon 이름(신규, 중앙화 — 개별 사이트 편집 회피, FIX-D).
// icon 은 tone 별 severity 표준과 정합: done→check · caveats→warn · fail→x(DESIGN.md §4.2 crit=✕) · blocked/needs_context→info.
const RESULT_META = {
  done:               { tone: 'ok',      glyph: '✓', icon: 'check', label: 'Done'              },
  done_with_concerns: { tone: 'warn',    glyph: '⚠', icon: 'warn',  label: 'Done with caveats' },
  fail:               { tone: 'crit',    glyph: '✕', icon: 'x',     label: 'Failed'            },
  blocked:            { tone: 'info',    glyph: 'ℹ', icon: 'info',  label: 'Blocked'           },
  needs_context:      { tone: 'neutral', glyph: 'ℹ', icon: 'info',  label: 'Needs info'        },
};

// 비율 표본 임계 (A5) — n < 30 이면 muted/italic + '(n=N)' 표기 대상.
const LOW_N_MIN = 30;

// 비율 headline SoT (A5) — 'N.N% (x/y)'. 분모 0/음수 → '—' (fabricated 0% 차단).
function formatPctWithDenominator(numerator, denominator) {
  const den = Number(denominator);
  if (!Number.isFinite(den) || den <= 0) return '—';
  const num = Number(numerator) || 0;
  return `${((num / den) * 100).toFixed(1)}% (${formatInt(num)}/${formatInt(den)})`;
}

// tone → 표준 glyph (A2 듀얼인코딩 — 색상 단독 인코딩 금지) · 캐논 셋 ✓/⚠/✕/ℹ 한정 (A7).
// ⚠ 불변 SoT: Badge 기본(icon=false) 경로가 이 문자열을 그대로 소비하므로(예: health.jsx status Badge)
// 아이콘/객체로 바꾸지 않는다 — 바꾸면 런타임에 "[object Object]" 렌더(transpile-only build:jsx 미검출).
// (model-config.jsx · clauded-docs.jsx 는 <Icon name={TONE_ICON[tone]}/> 로 이관됨 — 더는 문자열 직접 소비부 아님.)
const TONE_GLYPH = { ok: '✓', warn: '⚠', crit: '✕', info: 'ℹ', neutral: 'ℹ' };

// tone → Icon 이름 lookup (신규) — Badge/보드의 Icon 렌더 경로 전용. TONE_GLYPH(문자열 SoT)와 병존:
// 문자열 직접 소비부는 TONE_GLYPH 를 그대로 쓰고, Icon 렌더 경로만 여기서 아이콘명을 얻는다(FIX-A 분리).
// crit 은 DESIGN.md §4.2 severity 표준(✕)에 맞춰 'x' — ⛔(ban)이 아님(ban 은 별도 semantic).
const TONE_ICON = { ok: 'check', warn: 'warn', crit: 'x', info: 'info', neutral: 'info' };

// 불투명 sticky thead 스타일 SoT (S1) — 다수 화면(.tbl)이 미러하므로 단일 출처화.
// 불투명 --elev fill 유지(§7.5 row blur 금지) — 스크롤 시 헤더가 본문 위에 떠도 가려지지 않음.
const STICKY_TH_STYLE = { position: 'sticky', top: 0, background: 'rgb(var(--elev))', zIndex: 1 };

// review_flag 사유 분류 SoT (F12) — core-outcome-record.md Mismatch Review Trigger 미러.
// outcomes 행 배지 + improvement KPI 세그먼트 공용 → 두 화면이 동일 사유 버킷 강제.
// search row 표시 필드만 사용하는 순수 함수 — 행 외 신호(style_ref 누락 등)는 'other' 폴백.
// 반환 순서 = 우선순위 — [0]이 세그먼트 partition 기준 (한 행이 복수 사유 보유 가능).
function reviewFlagReasons(row) {
  if (!row || row.review_flag !== true) return [];
  const reasons = [];
  if (row.confidence === 'high' && row.metric_pass === false) {
    reasons.push({ key: 'overconfident', label: 'Overconfident', title: 'Said sure, but the check failed' });
  }
  if (row.confidence === 'low' && row.metric_pass === true) {
    reasons.push({ key: 'underconfident', label: 'Underconfident', title: 'Doubted itself, but the check passed' });
  }
  if (row.metric_pass === null || row.metric_pass === undefined) {
    reasons.push({ key: 'empty', label: 'No self-check', title: "No self-check reported" });
  }
  if (row.metric_pass === true && row.grader_verdict === 'verified_fail') {
    reasons.push({ key: 'grader_mismatch', label: 'Check mismatch', title: 'Claimed success, but the auto-check disagreed' });
  }
  if (reasons.length === 0) {
    reasons.push({ key: 'other', label: 'Other', title: 'Flagged for another reason — open the row' });
  }
  return reasons;
}

// 세그먼트/배지 버킷 표시 순서 — reviewFlagReasons 의 push 순서(우선순위) 미러 (F12).
const REVIEW_FLAG_REASON_ORDER = ['overconfident', 'underconfident', 'empty', 'grader_mismatch', 'other'];

window.UI = {
  Icon, Pill, Badge, SubCard, Sparkline, MiniBars, Bar, BulletBar, StatusDot, AgentBadge, KPI, DetailSurface, Modal, Tabs, CardHead, PageHeader,
  TypeScaleStyle,
  titleOf, stripHtmlTags, formatRelativeTime,
  setDisplayTimezone, getDisplayTimezone, tzShortLabel,
  formatKstDateTime, formatKstTime, formatKstDate, formatKstFull,
  formatUsd, formatUsdCompact, formatInt, formatTokenCompact,
  DAEMON_STATUS_TONE, daemonStatusTone, daemonStatusLabel,
  RESULT_META, LOW_N_MIN, formatPctWithDenominator,
  TONE_GLYPH, TONE_ICON, STICKY_TH_STYLE, reviewFlagReasons, REVIEW_FLAG_REASON_ORDER,
};
