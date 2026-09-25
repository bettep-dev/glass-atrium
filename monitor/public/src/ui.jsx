// 공용 UI atoms — window.UI 로 export, screens/*.jsx 가 destructure 임포트
const { useEffect, useRef, useState } = React;

// 포커스 가능 요소 셀렉터 SoT — focus-trap 진입/순환 공용 (DetailSurface).
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea, input, select, summary, iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

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

// 공용 빈-상태 atom (canonical) — 화면별 EmptyState* 복제 + 보드 dashed-col idiom 의 단일 SoT.
//   .placeholder(base.css) dashed 관용구 재사용 → repo 전역 단일 빈-상태 표기.
//   message = 핵심 원인 한 줄 · hint = 다음 단계/부연(선택) · action = 슬롯(재시도 버튼 등, 선택).
//   타입은 6단 스케일 토큰(fs-meta/fs-micro)로 고정 — 화면별 off-scale px 리터럴 제거.
function EmptyState({ message, hint, action, className='' }) {
  return (
    <div className={`placeholder ${className}`.trim()}>
      <div className="fs-meta">{message}</div>
      {hint && <div className="fs-micro text-faint mt-1">{hint}</div>}
      {action && <div className="mt-2 flex justify-center">{action}</div>}
    </div>
  );
}

// 공용 sub-card primitive — 중첩 섹션/메트릭 타일용 작은 면. ring-1 + rounded-lg + 일정 padding.
//   발산하던 idiom(드로어 1px-hairline · DetailMetric ring 타일 · .i-card-shadow)이 후속 wave 에서 여기로 수렴.
//   sunken=true → bg-sunken(더 들어간 면) · 기본 bg-elev(떠오른 면). label 지정 시 uppercase --dim 섹션 라벨.
// label sits under a card/dialog h2 → h3 by default
function SubCard({ children, sunken=false, label, labelLevel=3, className='' }) {
  const surface = sunken ? 'bg-sunken' : 'bg-elev';
  return (
    <div className={`sub-card ${surface} ${className}`.trim()}>
      {label && <SectionLabel level={labelLevel} className="sub-card-label">{label}</SectionLabel>}
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

// label → named image · no label → decorative, hidden from assistive tech
function getTrendSvgA11y(label) {
  return label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' };
}

function Sparkline({ data, w=60, h=22, color='currentColor', fill=true, label }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v,i) => [i/(data.length-1) * w, h - ((v-min)/range)*h*0.85 - 1]);
  const path = pts.map(([x,y],i) => `${i===0?'M':'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${path} L${w},${h} L0,${h} Z`;
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} {...getTrendSvgA11y(label)}>
    {fill && <path d={area} fill={color} opacity="0.12"/>}
    <path d={path} fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}

function MiniBars({ data, w=60, h=22, color='currentColor', label }) {
  const max = Math.max(...data) || 1;
  const bw = w / data.length - 1;
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} {...getTrendSvgA11y(label)}>
    {data.map((v,i) => {
      const bh = (v/max) * h * 0.9;
      return <rect key={i} x={i*(bw+1)} y={h-bh} width={bw} height={bh} fill={color} opacity="0.85" rx="0.5"/>;
    })}
  </svg>;
}

// Panel-width day chart: viewBox x runs 0..CHART_VIEW_W and stretches to the panel (preserveAspectRatio none).
const CHART_VIEW_W = 100;
const CHART_MAX_TICKS = 7;

// Evenly spaced day-tick indices, always the first and last day, at most maxTicks.
function getChartTicks(count, maxTicks = CHART_MAX_TICKS) {
  if (count <= 0) return [];
  const cap = Math.max(2, maxTicks);
  if (count <= cap) return Array.from({ length: count }, (_, i) => i);
  const step = (count - 1) / (cap - 1);
  return Array.from({ length: cap }, (_, i) => Math.round(i * step));
}

// Pointer x ratio (0..1 of the plot width) → nearest point (line) or the bar under it; null when empty.
function getChartIndexAtRatio(ratio, count, kind = 'line') {
  if (count <= 0) return null;
  const clamped = Math.min(1, Math.max(0, ratio));
  const index = kind === 'bars' ? Math.floor(clamped * count) : Math.round(clamped * (count - 1));
  return Math.min(count - 1, index);
}

/**
 * Next readout day for a key press; undefined = key not handled, left to the page.
 * The first arrow press with no active day starts on the latest day.
 */
function getChartKeyIndex(key, index, count) {
  if (count <= 0) return undefined;
  const last = count - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined;
  if (index === null || index === undefined) return last;
  return key === 'ArrowLeft' ? Math.max(0, index - 1) : Math.min(last, index + 1);
}

function getChartReadout(point, formatValue = String) {
  if (!point) return '';
  return Number.isFinite(point.value) ? `${point.label}: ${formatValue(point.value)}` : `${point.label}: no data`;
}

// Accessible name for the chart image — range plus latest/low/high, since the plot itself is aria-hidden.
function getChartSummary(name, points, formatValue = String) {
  const values = points.map((point) => point.value).filter(Number.isFinite);
  if (values.length === 0) return `${name}: no data`;
  const latest = values[values.length - 1];
  const range = `${points.length} days from ${points[0].label} to ${points[points.length - 1].label}`;
  return `${name}, ${range}: latest ${formatValue(latest)}, low ${formatValue(Math.min(...values))}, high ${formatValue(Math.max(...values))}`;
}

function getChartX(index, count, kind) {
  if (kind === 'bars') return ((index + 0.5) / count) * CHART_VIEW_W;
  return count > 1 ? (index / (count - 1)) * CHART_VIEW_W : CHART_VIEW_W / 2;
}

// null values lift the pen → a gap, never a line drawn through a missing day
function getChartLinePath(values, getY) {
  let isPenDown = false;
  return values.map((value, i) => {
    if (value === null) { isPenDown = false; return ''; }
    const command = isPenDown ? 'L' : 'M';
    isPenDown = true;
    return `${command}${getChartX(i, values.length, 'line').toFixed(2)},${getY(value).toFixed(2)}`;
  }).join(' ');
}

function ChartPlot({ points, kind, h, color, activeIndex }) {
  const values = points.map((point) => (Number.isFinite(point.value) ? point.value : null));
  const finite = values.filter((value) => value !== null);
  const min = kind === 'bars' || finite.length === 0 ? 0 : Math.min(...finite);
  const range = (finite.length ? Math.max(...finite) : 1) - min || 1;
  const getY = (value) => h - ((value - min) / range) * h * 0.85 - 1;
  const crossX = activeIndex === null ? null : getChartX(activeIndex, points.length, kind);
  return <svg width="100%" height={h} viewBox={`0 0 ${CHART_VIEW_W} ${h}`} preserveAspectRatio="none" aria-hidden="true" style={{ display: 'block' }}>
    {kind === 'bars'
      ? <ChartBars values={values} h={h} getY={getY} color={color} activeIndex={activeIndex}/>
      : <path d={getChartLinePath(values, getY)} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round"/>}
    {crossX !== null && <line x1={crossX} x2={crossX} y1={0} y2={h} stroke={toneVarColor('neutral')} strokeDasharray="3 3" vectorEffect="non-scaling-stroke"/>}
  </svg>;
}

function ChartBars({ values, h, getY, color, activeIndex }) {
  const slot = CHART_VIEW_W / values.length;
  return values.map((value, i) => {
    if (value === null) return null;
    const y = getY(value);
    const opacity = activeIndex === null || activeIndex === i ? 0.85 : 0.45;
    return <rect key={i} x={i * slot + slot * 0.1} y={y} width={slot * 0.8} height={h - y} fill={color} opacity={opacity}/>;
  });
}

function ChartTicks({ points, kind, maxTicks }) {
  const count = points.length;
  return <div aria-hidden="true" className="text-faint" style={{ position: 'relative', height: 18, fontSize: 'var(--fs-meta)' }}>
    {getChartTicks(count, maxTicks).map((i) => {
      const left = getChartX(i, count, kind);
      const shift = left <= 0 ? '0' : left >= CHART_VIEW_W ? '-100%' : '-50%';
      return <span key={i} data-chart-tick="" style={{ position: 'absolute', left: `${left}%`, transform: `translateX(${shift})`, whiteSpace: 'nowrap' }}>{points[i].label}</span>;
    })}
  </div>;
}

// Active-day state + the pointer/keyboard handlers that move it; the pure index helpers carry the rules.
function useChartReadout(count, kind) {
  const [activeIndex, setActiveIndex] = useState(null);
  const onKeyDown = (event) => {
    const next = getChartKeyIndex(event.key, activeIndex, count);
    if (next === undefined) return;
    event.preventDefault();
    setActiveIndex(next);
  };
  const onPointerMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0) setActiveIndex(getChartIndexAtRatio((event.clientX - rect.left) / rect.width, count, kind));
  };
  const onFocus = () => setActiveIndex((index) => (index === null ? count - 1 : index));
  const onClear = () => setActiveIndex(null);
  return { activeIndex, handlers: { onKeyDown, onPointerMove, onFocus, onPointerLeave: onClear, onBlur: onClear } };
}

/**
 * Day-series chart that fills its panel: named image, day ticks, crosshair + polite live readout on hover and focus.
 * @param points - `{ label, value }` per day, oldest first; a null value renders as a gap
 * @param formatValue - formats values in the readout and the accessible summary
 */
function TrendChart({ label, points, kind = 'line', h = 64, tone = 'info', formatValue = String, maxTicks = CHART_MAX_TICKS }) {
  const count = points ? points.length : 0;
  const { activeIndex, handlers } = useChartReadout(count, kind);
  if (count === 0) return <p className="text-faint" style={{ fontSize: 'var(--fs-meta)', margin: 0 }}>No data in range</p>;
  const readout = activeIndex === null ? '' : getChartReadout(points[activeIndex], formatValue);
  return <figure className="trend-chart" style={{ margin: 0, minWidth: 0 }}>
    <div role="img" aria-label={getChartSummary(label, points, formatValue)} tabIndex={0} style={{ cursor: 'crosshair' }} {...handlers}>
      <ChartPlot points={points} kind={kind} h={h} color={toneVarColor(tone)} activeIndex={activeIndex}/>
    </div>
    <ChartTicks points={points} kind={kind} maxTicks={maxTicks}/>
    <div aria-live="polite" style={{ minHeight: 18, fontSize: 'var(--fs-meta)', fontVariantNumeric: 'tabular-nums' }}>{readout}</div>
  </figure>;
}

// tone KEY → 색상 토큰 var 명. neutral 은 비측정/중립 막대용 muted line(--faint).
// rgb(var(--token) / opacity) 소비 — 하우스 비례막대 관용구(cost.jsx TurnStopReasonTable) 그대로.
const BAR_TONE_VAR = { ok:'--ok', warn:'--warn', crit:'--crit', info:'--info', neutral:'--faint' };

// tone KEY → 인라인 CSS 색 문자열 `rgb(var(--tone))` — SVG fill/stroke 등 하드코딩 rgb 리터럴 대체.
//   테마/토큰 변경 시 자동 리페인트 (색 SoT = tokens.css). 미정의 tone → neutral(--faint).
function toneVarColor(tone) {
  return `rgb(var(${BAR_TONE_VAR[tone] || BAR_TONE_VAR.neutral}))`;
}

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

// tone = TONE_GLYPH shape + colour + a word for AT → state survives without colour. Unknown status gets its own mark, not info's.
const STATUS_DOT_WORD = { ok: 'OK', warn: 'Warning', crit: 'Critical', info: 'Info' };

function StatusDot({ status }) {
  const isKnown = Object.hasOwn(STATUS_DOT_WORD, status);
  const glyph = isKnown ? TONE_GLYPH[status] : '–';
  const word = isKnown ? STATUS_DOT_WORD[status] : 'Unknown';
  const toneClass = isKnown ? `text-${status}` : 'text-faint';

  return (
    <span className={`inline-block fs-micro leading-none mr-1.5 align-middle ${toneClass}`} title={word}>
      <span aria-hidden="true">{glyph}</span>
      <span className="sr-only">{word}</span>
    </span>
  );
}

// 22px 원형 컬러 배지 + 이니셜. 색 = categorical agent 팔레트 토큰(tokens.css --agent-N, 테마 불변) —
//   하드코딩 hex 제거. named agent 는 고정 슬롯, 그 외 id 해시로 안정 배정.
const AGENT_NAMED_VAR = {
  'glass-atrium-intel-planner':    '--agent-1',
  'glass-atrium-intel-researcher': '--agent-2',
  writer:   '--agent-3',
  reviewer: '--agent-4',
  coder:    '--agent-5',
  analyst:  '--agent-6',
};
const AGENT_PALETTE_VARS = ['--agent-1', '--agent-2', '--agent-3', '--agent-4', '--agent-5', '--agent-6', '--agent-7', '--agent-8'];

function AgentBadge({ a, size=22 }) {
  const id = a?.id || a?.agent_id || '';
  const name = a?.name || a?.agent_name || id || '?';
  const initial = name[0] ? name[0].toUpperCase() : '?';
  const colorVar = AGENT_NAMED_VAR[id] || AGENT_PALETTE_VARS[(strHash(id) >>> 0) % AGENT_PALETTE_VARS.length];
  // 이니셜 전경 = 고정 dark ink(--agent-ink) → 밝은 amber/cyan fill 에서도 ≥3:1 대비 (기존 white ~2:1 회귀 해소).
  //   팔레트 8색 전부 dark ink 로 ≥3.9:1 검증 완료 (fill 은 테마 불변 categorical).
  return <span className="agent-badge inline-grid place-items-center font-mono font-semibold shrink-0"
    style={{width:size, height:size, fontSize: size*0.5, borderRadius: size*0.3,
      background: `rgb(var(${colorVar}))`, color: 'rgb(var(--agent-ink))', letterSpacing:'-0.02em'}}>
    {initial}
  </span>;
}

const AGENT_NAME_PREFIX = 'glass-atrium-';

/** Display form of an agent name — the shared install prefix dropped; a missing name → '—'. */
function getAgentDisplayName(name) {
  const full = typeof name === 'string' ? name.trim() : '';

  if (!full) return '—';
  if (!full.startsWith(AGENT_NAME_PREFIX) || full.length === AGENT_NAME_PREFIX.length) return full;
  return full.slice(AGENT_NAME_PREFIX.length);
}

// generic span takes no aria-label → full name travels as sr-only text, the short form stays visual only
function AgentName({ name, className = '' }) {
  const full = typeof name === 'string' ? name.trim() : '';
  const short = getAgentDisplayName(name);

  if (short === full || !full) return <span className={className}>{short}</span>;
  return (
    <span className={className} title={full}>
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">{full}</span>
    </span>
  );
}

// djb2-lite — 시각 팔레트용 결정적 해시 (crypto 불필요)
function strHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) + str.charCodeAt(i);
  }
  return h;
}

// Headline figure on the .kpi-value scale — tone rides a decorative glyph, the figure stays neutral ink.
function KpiValue({ children, unit, tone }) {
  return <div className="kpi-value">
    {tone && <span className={`text-${tone}`} aria-hidden="true">{TONE_GLYPH[tone]} </span>}
    {children}{unit && <span className="unit">{unit}</span>}
  </div>;
}

// label + 26px mono value + delta + 68×26 inline sparkline
function KPI({ label, value, unit, delta, deltaInverse=false, sparkData, sparkColor='currentColor', onClick, hint }) {
  return <button onClick={onClick} className="kpi text-left">
    <div className="kpi-label">{label}</div>
    {hint && <div className="fs-micro text-faint font-mono kpi-hint">{hint}</div>}
    <KpiValue unit={unit}>{value}</KpiValue>
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
// id sequence for element-title aria-labelledby targets — works without useId (render-harness React stub).
let detailTitleSeq = 0;

function DetailSurface({ open, onClose, variant = 'drawer', title, sub, footer, children, labelledBy, suppressOutsideClose, nav, bare = false, panelClassName = '', bodyClassName = '' }) {
  const overlayRef = useRef(null);
  const panelRef = useRef(null);
  const titleIdRef = useRef(null);
  if (titleIdRef.current === null) titleIdRef.current = `detail-title-${++detailTitleSeq}`;
  // 열리기 직전 포커스 트리거 — 닫힘 시 복원 (a11y 포커스 반환).
  const triggerRef = useRef(null);

  // 마운트 전용 — 포커스 캡처/복원 + scroll-lock 은 surface 생애주기(열림→닫힘)에만 묶임.
  // onClose/nav 의존 금지 — 부모 re-render(인라인 onClose 신규 생성)에 캡처/복원이 재실행돼
  // triggerRef 가 상호작용 중 덮어쓰이고 포커스가 트리거로 튀는 회귀 차단. surface 는 open 시에만 마운트.
  useEffect(() => {
    triggerRef.current = document.activeElement;

    const panel = panelRef.current;
    const focusables = panel ? Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR)) : [];
    const initialTarget = panel ? getTrapFocusTarget({ focusables, active: null, panel, shiftKey: false }) : null;
    if (initialTarget) initialTarget.focus();

    const inertTargets = overlayRef.current ? getInertTargets(overlayRef.current) : [];
    for (const node of inertTargets) node.inert = true;

    // body scroll-lock — 언마운트/닫힘 시 복원 (현 오버레이엔 부재 → 여기서 단일 추가).
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = prevOverflow;
      // background revived before the trigger refocus — an inert trigger rejects focus.
      for (const node of inertTargets) node.inert = false;
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
        if (!panel) return;
        const focusables = Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR));
        const target = getTrapFocusTarget({ focusables, active: document.activeElement, panel, shiftKey: e.shiftKey });
        if (target) {
          e.preventDefault();
          target.focus();
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
  // non-string title never becomes aria-label → labelledby the rendered title node (bare → hidden node).
  const isElementTitle = title != null && typeof title !== 'string';
  const titleId = labelledBy || (isElementTitle ? titleIdRef.current : undefined);
  const dialogProps = titleId ? { 'aria-labelledby': titleId } : { 'aria-label': title };
  const bareTitle = bare && isElementTitle && !labelledBy ? <div id={titleId} hidden>{title}</div> : null;

  const closeBtn = <button className="btn ghost sm" onClick={onClose} aria-label="Close details"><Icon name="x" size={14}/></button>;
  const head = <div className="detail-head">
    <div className="flex-1 min-w-0">
      <div id={titleId} className="detail-title">{title}</div>
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

  return <div ref={overlayRef} className={`detail-overlay detail-${variant}`} onClick={onBackdrop}>
    <div ref={panelRef} role="dialog" aria-modal="true" tabIndex={-1} {...dialogProps}
         className={panelCls} onClick={(e) => e.stopPropagation()}>
      {bare ? bareTitle : head}
      <div className={bodyCls}>{children}</div>
      {foot}
    </div>
  </div>;
}

/**
 * Focus target that keeps Tab inside a modal panel; null leaves the move to the browser.
 * @param active - focused element, or null on open (initial focus)
 * @param panel - dialog node, the fallback target when it holds no control
 */
function getTrapFocusTarget({ focusables, active, panel, shiftKey }) {
  if (focusables.length === 0) return panel;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const isInsideControl = active != null && active !== panel && panel.contains(active);

  if (!isInsideControl) return shiftKey ? last : first;
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  return null;
}

// modal background = every sibling along the overlay's ancestor path up to <body>; already-inert nodes excluded → restore never revives them.
function getInertTargets(overlay) {
  const targets = [];
  let node = overlay;
  while (node.parentElement && node.tagName !== 'BODY') {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling !== node && !sibling.inert) targets.push(sibling);
    }
    node = node.parentElement;
  }
  return targets;
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
      <h2 className="card-title">{title}</h2>
      {sub && <div className="card-sub mt-0.5" title={window.UI.titleOf(sub)}>{sub}</div>}
    </div>
    {right && <div className="ml-auto flex items-center gap-2 shrink-0">{right}</div>}
  </div>;
}

// Section title as a real outline heading, wearing the uppercase section-label style.
function SectionLabel({ children, level = 2, id, className = '' }) {
  const Tag = level === 3 ? 'h3' : 'h2';
  return <Tag id={id} className={`section-label ${className}`.trim()}>{children}</Tag>;
}

// The one column-header idiom → every table's headers read alike and carry scope="col".
function TableHead({ children, isNumeric = false, isSticky = false, className = '' }) {
  return <th scope="col" className={`${isNumeric ? 'num' : ''} ${className}`.trim() || undefined}
    style={isSticky ? STICKY_TH_STYLE : undefined}>{children}</th>;
}

/**
 * Data table named by its caption (visually hidden unless isCaptionShown) with scoped column headers.
 * @param columns - `{ key, label, isNumeric }` per column; omit to compose the thead yourself.
 * @param children - tbody rows.
 */
function Table({ caption, isCaptionShown = false, isHeadSticky = false, columns, children, className = '' }) {
  return <table className={`tbl ${className}`.trim()}>
    <caption className={isCaptionShown ? 'section-label text-left pb-2' : 'sr-only'}>{caption}</caption>
    {columns && <thead><tr>
      {columns.map((c) => <TableHead key={c.key} isNumeric={c.isNumeric} isSticky={isHeadSticky}>{c.label}</TableHead>)}
    </tr></thead>}
    <tbody>{children}</tbody>
  </table>;
}

const DISCLOSURE_CHEVRON_PX = 14;

// Brightens with its `group` ancestor's hover; a 90° turn marks the open state.
function DisclosureChevron({ isOpen }) {
  return <Icon name="chevR" size={DISCLOSURE_CHEVRON_PX}
    className={`text-dim group-hover:text-ink ${isOpen ? 'rotate-90' : ''}`.trim()} />;
}

// Expand/collapse control: state rides aria-expanded, the visible label names it.
function DisclosureButton({ isOpen, onToggle, label, controls, className = '' }) {
  return <button type="button" onClick={onToggle} aria-expanded={isOpen} aria-controls={controls}
    className={`group inline-flex items-center gap-1 min-h-[32px] text-dim hover:text-ink ${className}`.trim()}>
    <DisclosureChevron isOpen={isOpen} />
    <span>{label}</span>
  </button>;
}

const ROVING_KEY_STEP = {
  horizontal: { ArrowLeft: -1, ArrowRight: 1 },
  vertical: { ArrowUp: -1, ArrowDown: 1 },
};

/**
 * Next item of a roving-focus set for a key press; undefined = key not handled, left to the page.
 * Stops at the ends rather than wrapping, like the chart readout keys.
 */
function getRovingIndex(key, index, count, orientation = 'horizontal') {
  if (count <= 0) return undefined;
  const last = count - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  const step = ROVING_KEY_STEP[orientation]?.[key];
  if (step === undefined) return undefined;
  if (index === null || index === undefined) return 0;
  return Math.min(last, Math.max(0, index + step));
}

// an active index outside the set falls back to the first item → the set never loses its Tab stop
function getRovingTabIndex(index, activeIndex, count) {
  const isActiveInSet = Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < count;
  return index === (isActiveInSet ? activeIndex : 0) ? 0 : -1;
}

// spread onto every in-row control → out of the Tab order, reached by ArrowRight from its row
const ROW_CONTROL_PROPS = Object.freeze({ tabIndex: -1, 'data-row-control': '' });

/**
 * Grid-row keys: Up/Down/Home/End move between rows, ArrowRight enters the row's controls,
 * ArrowLeft past the first control or Escape returns to the row, Enter on the row activates it.
 * undefined = left to the browser (Tab, and Enter on a control, which clicks it natively).
 */
function getRowKeyAction({ key, rowIndex, rowCount, controlIndex, controlCount }) {
  const nextRow = getRovingIndex(key, rowIndex, rowCount, 'vertical');
  if (nextRow !== undefined) return { focus: 'row', index: nextRow };
  if (controlIndex === null || controlIndex === undefined) return getRowOwnKeyAction(key, controlCount);
  if (key === 'Escape' || (key === 'ArrowLeft' && controlIndex === 0)) return { focus: 'row', index: rowIndex };
  const nextControl = getRovingIndex(key, controlIndex, controlCount, 'horizontal');
  return nextControl === undefined ? undefined : { focus: 'control', index: nextControl };
}

function getRowOwnKeyAction(key, controlCount) {
  if (key === 'Enter') return { activate: true };
  if (key === 'ArrowRight' && controlCount > 0) return { focus: 'control', index: 0 };
  return undefined;
}

/**
 * Props for one row of a roving set, spread onto its `tr` so table semantics stay intact.
 * The page owns activeIndex; onActiveChange follows focus into any row, onActivate runs on Enter.
 */
function getRowFocusProps({ index, activeIndex, count, onActivate, onActiveChange }) {
  return {
    tabIndex: getRovingTabIndex(index, activeIndex, count),
    'data-roving-row': index,
    onFocus: () => onActiveChange?.(index),
    onKeyDown: (event) => putRowKeyFocus(event, { index, count, onActivate, onActiveChange }),
  };
}

function putRowKeyFocus(event, { index, count, onActivate, onActiveChange }) {
  const row = event.currentTarget;
  const controls = [...row.querySelectorAll('[data-row-control]')];
  const controlIndex = controls.indexOf(event.target);
  const action = getRowKeyAction({ key: event.key, rowIndex: index, rowCount: count, controlIndex: controlIndex < 0 ? null : controlIndex, controlCount: controls.length });

  if (!action) return;
  event.preventDefault();
  if (action.activate) {
    onActivate?.(index);
    return;
  }
  const target = action.focus === 'row' ? row.parentElement.querySelectorAll('[data-roving-row]')[action.index] : controls[action.index];
  target?.focus();
  onActiveChange?.(action.focus === 'row' ? action.index : index);
}

// Filter chips: one Tab stop for the group, arrows move between chips, state rides aria-pressed.
function ChipGroup({ label, chips, onToggle, className = '' }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const onKeyDown = (event) => {
    const buttons = [...event.currentTarget.querySelectorAll('button')];
    const index = buttons.indexOf(event.target);
    const next = getRovingIndex(event.key, index < 0 ? null : index, buttons.length);

    if (next === undefined) return;
    event.preventDefault();
    buttons[next].focus();
    setActiveIndex(next);
  };
  return <div role="toolbar" aria-label={label} onKeyDown={onKeyDown} className={`flex flex-wrap items-center gap-1 ${className}`.trim()}>
    {chips.map((chip, i) => <button key={chip.key} type="button" className="pill pill--interactive" aria-pressed={chip.isPressed}
      tabIndex={getRovingTabIndex(i, activeIndex, chips.length)} onFocus={() => setActiveIndex(i)} onClick={() => onToggle(chip.key)}>
      {chip.label}
    </button>)}
  </div>;
}

const BLANK_FIELD_TEXT = new Set(['', '—', '-', 'unknown', 'n/a', 'null', 'undefined']);

// placeholder text counts as empty → the field is hidden instead of printing "unknown"
function hasFieldValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value !== 'string') return true;
  return !BLANK_FIELD_TEXT.has(value.trim().toLowerCase());
}

const MODEL_FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'fable', 'mythos']);
// minor is 1-2 digits, a trailing date segment 3+ → a dated id never reads its date as the minor
const MODEL_ID_PATTERN = /^(?:claude-)?([a-z]+)(?:-(\d+)(?:[-.](\d{1,2}))?)?(?:-\d{3,})?$/i;

function getModelDisplayName(id) {
  const match = id.match(MODEL_ID_PATTERN);
  if (!match || !MODEL_FAMILIES.has(match[1].toLowerCase())) return id;
  const [, family, major, minor] = match;
  const version = major ? ` ${major}${minor ? `.${minor}` : ''}` : '';
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()}${version}`;
}

// snake/kebab machine key → sentence-case words; casing inside the key is kept (acronyms survive)
function getKeyWords(key) {
  const words = key.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DISPLAY_NAME_FORMATTERS = { model: getModelDisplayName, pattern: getKeyWords, edge: getKeyWords };

/**
 * One display-name map for machine labels shown on screen (model id, pattern key, edge type).
 * null for an empty or placeholder value → the caller hides the field; an unknown kind passes the value through.
 */
function getDisplayName(kind, value) {
  if (!hasFieldValue(value)) return null;
  const text = String(value).trim();
  const format = DISPLAY_NAME_FORMATTERS[kind];
  return format ? format(text) : text;
}

// Label + value pair that renders nothing for an empty or placeholder value.
function DetailField({ label, value, mono = false }) {
  if (!hasFieldValue(value)) return null;
  return <div>
    <div className="fs-micro font-mono text-faint uppercase tracking-wider mb-1">{label}</div>
    <div className={`fs-body ${mono ? 'font-mono text-dim' : 'text-ink'} break-words`}>{value}</div>
  </div>;
}

// title = the page h1 (callers pass the nav label); a sub-line echoing the title is dropped.
function PageHeader({ title, sub, right }) {
  const hasSub = sub && sub !== title;
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-4">
    <div className="min-w-0">
      <h1 className="fs-display font-semibold leading-tight">{title}</h1>
      {hasSub && <div className="text-[11px] font-mono text-faint tracking-wider uppercase">{sub}</div>}
    </div>
    {right && <div className="ml-auto flex flex-wrap items-center justify-end gap-2 min-w-0">{right}</div>}
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

// ISO timestamp → "5m ago" / "in 5m" 상대시각 — falsy/파싱불가 입력은 '—' (NaN 라벨 차단)
function formatRelativeTime(iso) {
  if (!iso) return '—';
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return '—';
  const now = Date.now();
  const diffSec = Math.round((target - now) / 1000);
  const abs = Math.abs(diffSec);
  const past = diffSec <= 0; // sub-second past rounds to -0 → must still read "ago"
  let label;
  if (abs < 60)         label = `${abs}s`;
  else if (abs < 3600)  label = `${Math.round(abs / 60)}m`;
  else if (abs < 86400) label = `${Math.round(abs / 3600)}h`;
  else                  label = `${Math.round(abs / 86400)}d`;
  return past ? `${label} ago` : `in ${label}`;
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

/**
 * Per-region fetch state, stale-while-revalidate. `status` says what is showable
 * ('loading' | 'ready' | 'error'), `busy` says a request is in flight, `error` may sit beside held data.
 * `pendingKey` names the request whose answer may land; answers for any other key are dropped.
 */
const INITIAL_REGION_STATE = Object.freeze({
  status: 'loading', data: null, error: null, busy: true, key: null, pendingKey: null,
});

/** Starts a request for `key`; held data stays on screen until the answer settles. */
function putRegionRequest(state, key) {
  const hasData = state.data != null;
  return { ...state, status: hasData ? 'ready' : 'loading', busy: true, pendingKey: key };
}

/**
 * Lands the answer for `key` unless a newer request superseded it.
 * @param merge - optional (prevData, nextData) → data, e.g. load-more append or keeping a dirty edit buffer
 */
function putRegionData(state, key, data, merge) {
  if (!Object.is(key, state.pendingKey)) return state;
  const nextData = merge ? merge(state.data, data) : data;
  return { status: 'ready', data: nextData, error: null, busy: false, key, pendingKey: null };
}

/** Records a failure for `key` without discarding held data; an abort only ends the busy state. */
function putRegionFailure(state, key, err) {
  if (!Object.is(key, state.pendingKey)) return state;
  const settled = { ...state, busy: false, pendingKey: null };
  if (err && err.name === 'AbortError') return settled;

  const error = err && err.message ? err.message : String(err);
  return { ...settled, status: state.data != null ? 'ready' : 'error', error };
}

const FRESHNESS_STALE_MS = 5 * 60_000;
const FRESHNESS_TICK_MS = 30_000;

// glyph carries the tone, text stays neutral → state survives without colour
const FRESHNESS_META = {
  loading:    { tone: null, word: 'Loading' },
  refreshing: { tone: null, word: 'Refreshing' },
  'not-read': { tone: 'crit', word: 'Not read' },
  partial:    { tone: 'warn', word: 'Partial' },
  stale:      { tone: 'warn', word: 'Stale' },
  fresh:      { tone: 'ok', word: 'Fresh' },
};

/** Busy and failed tallies over region states (INITIAL_REGION_STATE shape) — one input for the stamp and the Refresh atom. */
function getRegionSummary(regions) {
  const list = Array.isArray(regions) ? regions.filter(Boolean) : [];
  return {
    isBusy: list.some((region) => region.busy === true),
    failedCount: list.filter((region) => region.error != null).length,
    regionCount: list.length,
  };
}

/**
 * Freshness of the last successful read — Fresh only when nothing is in flight or failed.
 * Callers pass only successful-read times as `at`, so a failed read never advances the stamp.
 * @param regions - optional region states; any busy region → refreshing, some failed → partial, all failed → stale
 */
function getFreshnessState({ at, loading = false, failed = false, regions, staleAfterMs = FRESHNESS_STALE_MS, now = Date.now() }) {
  const { isBusy, failedCount, regionCount } = getRegionSummary(regions);
  const readMs = at ? new Date(at).getTime() : NaN;
  const isInFlight = loading || isBusy;

  if (!Number.isFinite(readMs)) return isInFlight ? 'loading' : 'not-read';
  if (isInFlight) return 'refreshing';
  if (failedCount > 0 && failedCount < regionCount) return 'partial';
  if (failed || failedCount > 0 || now - readMs > staleAfterMs) return 'stale';
  return 'fresh';
}

/**
 * Shared "as of HH:MM" stamp — a refresh in flight keeps the last stamp and sets aria-busy.
 * A read stamp re-renders on its own tick, so age-based staleness holds on screens that never poll.
 */
function FreshnessStamp({ at, loading = false, failed = false, regions, staleAfterMs, now }) {
  const [, setTick] = useState(0);
  const state = getFreshnessState({ at, loading, failed, regions, staleAfterMs, now });
  const meta = FRESHNESS_META[state];
  const glyph = meta.tone ? TONE_GLYPH[meta.tone] : '…';
  const toneClass = meta.tone ? `text-${meta.tone}` : 'text-faint';
  const isRead = state !== 'loading' && state !== 'not-read';
  const isBusy = state === 'loading' || state === 'refreshing';
  const { failedCount, regionCount } = getRegionSummary(regions);
  const failedNote = state === 'partial' ? `${failedCount} of ${regionCount} failed` : '';
  const word = failedNote ? `${meta.word}, ${failedNote}` : meta.word;
  const shouldTick = isRead && now === undefined;

  useEffect(() => {
    if (!shouldTick) return undefined;
    const intervalId = setInterval(() => setTick((t) => t + 1), FRESHNESS_TICK_MS);
    return () => clearInterval(intervalId);
  }, [shouldTick]);

  const readText = isRead ? `as of ${formatKstTime(at)}` : meta.word.toLowerCase();
  const text = failedNote ? `${readText} · ${failedNote}` : readText;
  const title = isRead ? `${word} — read ${formatKstFull(at)} (${formatRelativeTime(at)})` : word;

  return (
    <span className="fs-meta font-mono text-faint whitespace-nowrap" title={title} aria-busy={isBusy ? 'true' : undefined}>
      <span aria-hidden="true" className={`mr-1 ${toneClass}`}>{glyph}</span>
      <span className="sr-only">{word}</span>
      <span data-stamp-text="true">{text}</span>
    </span>
  );
}

/**
 * Shared PageHeader Refresh control — one box width across labels, disabled + aria-busy while a request is in flight.
 * @param hasRead - a prior read exists; the in-flight label reads "Refreshing…" over held data, "Loading…" on the first wave
 * @param label - accessible name, stable across states (e.g. "Refresh cost data")
 */
function RefreshButton({ isBusy = false, hasRead = false, onRefresh, label = 'Refresh' }) {
  const busyText = hasRead ? 'Refreshing…' : 'Loading…';
  // motion-safe → the icon stays static under prefers-reduced-motion; the label still carries the busy cue
  const iconClass = isBusy ? 'motion-safe:animate-spin' : '';

  return (
    <button type="button" className="btn ghost sm w-28 justify-center" onClick={onRefresh} disabled={isBusy}
      aria-busy={isBusy ? 'true' : undefined} aria-label={label}>
      <Icon name="refresh" size={14} className={iconClass}/>
      {isBusy ? busyText : 'Refresh'}
    </button>
  );
}

const FETCH_ERROR_BODY_MAX = 120;

/**
 * Error for a non-OK response; the message keeps the status plus a tag-free body slice for the Details toggle.
 * Region state stores this message, and getErrorCopy turns it into operator copy.
 * @param bodyMax - body characters kept in the message
 */
async function getFetchError(res, bodyMax = FETCH_ERROR_BODY_MAX) {
  const statusLine = `HTTP ${res.status} ${res.statusText || ''}`.trim();
  const body = await getErrorBody(res);
  return new Error(body ? `${statusLine} — ${body.slice(0, bodyMax)}` : statusLine);
}

async function getErrorBody(res) {
  try {
    return stripHtmlTags(await res.text());
  } catch (_err) {
    return ''; // unreadable body → status line alone
  }
}

const FETCH_ERROR_NEXT_STEP = {
  network: 'The monitor server did not answer. Check that it is running, then retry.',
  server: 'The server hit an error. Retry in a moment.',
  client: 'The server refused this request. Open Details for its answer.',
  unknown: 'Retry in a moment, or open Details for more.',
};

// browser fetch rejections: Chromium "Failed to fetch" · Firefox "NetworkError…" · WebKit "Load failed"
const NETWORK_FAILURE_PATTERN = /failed to fetch|networkerror|load failed/i;

function getErrorCause(error) {
  const detail = typeof error?.message === 'string' ? error.message : String(error ?? '');
  const status = Number(/^HTTP (\d{3})\b/.exec(detail)?.[1]) || null;

  if (status >= 500) return { kind: 'server', status, detail };
  if (status >= 400) return { kind: 'client', status, detail };
  if (NETWORK_FAILURE_PATTERN.test(detail)) return { kind: 'network', status, detail };
  return { kind: 'unknown', status, detail };
}

/** Operator copy for a failed read: one plain sentence naming the source, a next step, and the raw answer for Details only. */
function getErrorCopy(error, source) {
  const { kind, detail } = getErrorCause(error);
  return { sentence: `Couldn't load ${source}.`, next: FETCH_ERROR_NEXT_STEP[kind], detail, kind };
}

/**
 * The outage ≥2 failed regions share, or null — a non-null answer means one page banner and one Retry.
 * @param entries - `{ source, error }` per region; a null error is a healthy region
 */
function getSharedFailure(entries) {
  const failed = (entries || []).filter((entry) => entry && entry.error != null);
  if (failed.length < 2) return null;

  const causeKeys = new Set(failed.map((entry) => {
    const { kind, status } = getErrorCause(entry.error);
    return `${kind}:${status}`;
  }));
  if (causeKeys.size !== 1) return null;
  return { sources: failed.map((entry) => entry.source), error: failed[0].error };
}

function ErrorDetails({ detail }) {
  if (!detail) return null;
  return (
    <details className="fs-meta text-faint">
      <summary className="cursor-pointer">Details</summary>
      <code className="block mt-1 font-mono break-all">{detail}</code>
    </details>
  );
}

/**
 * Quiet per-region failure on a neutral surface; keeps the grid slot and shows the raw answer behind Details.
 * @param onRetry - omit when a PageErrorBanner already carries the one Retry for this outage
 * @param minHeight - reserved slot height so the grid keeps its shape
 */
function RegionUnavailable({ source, error, onRetry, minHeight, className = '' }) {
  const copy = getErrorCopy(error, source);
  return (
    <div className={`sub-card bg-sunken flex flex-col gap-1.5 ${className}`.trim()} style={minHeight ? { minHeight } : undefined}>
      <div className="fs-body flex items-center gap-1.5">
        <Icon name={TONE_ICON.crit} size={14} className="text-crit"/>
        <span>{copy.sentence}</span>
      </div>
      <div className="fs-meta text-dim">{copy.next}</div>
      <ErrorDetails detail={copy.detail}/>
      {onRetry && <button type="button" className="btn sm self-start" onClick={onRetry}>Retry</button>}
    </div>
  );
}

/** One announced banner with one Retry for an outage shared by ≥2 regions (see getSharedFailure). */
function PageErrorBanner({ sources, error, onRetry }) {
  const sourceList = new Intl.ListFormat('en', { type: 'conjunction' }).format(sources || []);
  const copy = getErrorCopy(error, sourceList);
  return (
    <div role="alert" className="card p-3 flex items-start gap-2">
      <Icon name={TONE_ICON.crit} size={16} className="text-crit mt-0.5"/>
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <span className="fs-body font-medium">{copy.sentence}</span>
        <span className="fs-meta text-dim">{copy.next}</span>
        <ErrorDetails detail={copy.detail}/>
      </div>
      <button type="button" className="btn sm" onClick={onRetry}>Retry</button>
    </div>
  );
}

/** Visible loading slot under a status role; minHeight reserves the settled height so nothing shifts on arrival. */
function LoadingPlaceholder({ label, minHeight, className = '' }) {
  return (
    <div role="status" className={`fs-meta text-dim flex items-center justify-center gap-1.5 ${className}`.trim()}
      style={minHeight ? { minHeight } : undefined}>
      <Icon name="refresh" size={14} className="motion-safe:animate-spin"/>
      <span>{label ? `Loading ${label}…` : 'Loading…'}</span>
    </div>
  );
}

const SKELETON_BAR_STYLE = {
  display: 'block', height: 10, width: '70%', borderRadius: 'var(--radius-inline)', background: 'rgb(var(--faint) / 0.3)',
};

/** Placeholder rows at the real row height — render inside the real tbody, under the real header. */
function SkeletonRows({ rows = 5, columns, rowHeight }) {
  const cellIndexes = Array.from({ length: columns }, (_, index) => index);
  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <tr key={rowIndex} aria-hidden="true" style={{ height: rowHeight }}>
          {cellIndexes.map((cellIndex) => <td key={cellIndex}><span style={SKELETON_BAR_STYLE}/></td>)}
        </tr>
      ))}
    </>
  );
}

// 배지 5-tier canonical taxonomy SoT (T1) — 톤별 pill 토큰 + 기본 라벨 단일 출처.
//   drift 근절: health 카드 인라인 "WARN"↔"Warning" 케이싱 발산 + 중복 "Healthy" 를 여기서 단일화.
//   status 톤(ok/warn/crit/info)만 pill 토큰 보유 · neutral = non-status 서술자 → pill 토큰 없음(글리프리스 neutral shell).
//   Rule 2 — status 라벨은 풀워드 title-case ("Warning" canonical · 약어 "WARN" 폐기).
const BADGE_TONE_META = {
  ok:      { pill: 'OK',      label: 'Healthy'    },
  warn:    { pill: 'Warning', label: 'Warning'    },
  crit:    { pill: 'FAIL',    label: 'Down'       },
  info:    { pill: 'INFO',    label: 'No data'    },
  neutral: { pill: null,      label: 'Needs info' },
};

// 카드별 pill 토큰/라벨 오버라이드 열거 (Rule 1 — health 카드 인라인 리터럴 금지, 여기서만 정의).
//   각 항목 tone 은 위 5 톤 중 하나 → neutral-shell/글리프/severity 계약 상속.
const BADGE_OVERRIDES = {
  pg_open:        { tone: 'ok',   pill: 'OPEN',       label: 'Connected'    },
  pg_closed:      { tone: 'crit', pill: 'CLOSED',     label: 'Disconnected' },
  hook_active:    { tone: 'ok',   pill: 'ACTIVE',     label: 'Active'       },
  hook_warn:      { tone: 'warn', pill: 'Warning',    label: 'Failed in 24 h (retried)'     },
  hook_failed:    { tone: 'crit', pill: 'FAILED',     label: 'Failed in 24 h (not retried)' },
  hook_unset:     { tone: 'info', pill: 'NOT SET UP', label: 'Not set up'   },
  daemon_no_data: { tone: 'info', pill: 'NO DATA',    label: 'No data'      },
  // browser(Chromium export) launch enum(ok/failed/unprobed) 중 비-ok 2종. ok 는 톤 기본값
  // resolveBadge('ok') 재사용('Healthy' 단일 정의) → 여기 미열거. tone 은 facts.tone 과 정합.
  browser_failed:   { tone: 'crit', pill: 'FAILED',   label: 'Failed to start' },
  browser_unprobed: { tone: 'info', pill: 'UNPROBED', label: 'Unverified'      },
  // budget_overages(core.budget_overages) — 최근 tool_use 예산 한도 도달 이벤트 존재.
  // 행 존재 자체가 실제 크로싱(100%+) → warn (P95 지연 옆 near-cap 신호).
  budget_near_cap:  { tone: 'warn', pill: 'NEAR CAP', label: 'Hit tool-use budget' },
};

// tone KEY 또는 override KEY → { tone, pill, label } 해석. 미정의 → info 폴백 (가짜 ok 금지).
function resolveBadge(key) {
  const override = BADGE_OVERRIDES[key];
  if (override) return override;

  const meta = BADGE_TONE_META[key];
  if (meta) return { tone: key, pill: meta.pill, label: meta.label };
  return { tone: 'info', pill: BADGE_TONE_META.info.pill, label: String(key) };
}

// 데몬 status enum → tone/라벨 SoT (A2) — dashboard·health·architecture 공용 단일 테이블.
// 서버 emit 가능 enum 만 보유 (ok/partial/error/quota_exceeded/apply_failed/apply_unavailable + 합성 missing/stale) — 미발행 키 보유 금지.
// apply_failed = patch 는 생성됐으나 apply stage 중단 → crit 'Apply failed'. 미등록 시 fallback info 로
// 떨어져 raw enum 토큰을 그대로 노출하므로, enum 추가와 이 항목은 항상 같은 변경에 포함.
// apply_unavailable = apply script 부재/실행권한 상실로 stage 실행 자체가 불가 → warn 'Apply unavailable'
// (실패가 아닌 불가용 · script 없이 정상 운영되는 설치가 영구 crit 로 남지 않도록 crit 아닌 warn).
// quota_exceeded = 외부 한도 도달 → warn 'Usage limit' (health/map/sidebar 전반 일관된 주의 톤 · 이전 neutral 유지 대체).
// missing = 실행 행 0개 → info (신규 설치 안전 기본값). '설치됐으나 한 번도 안 뜀' 은
// 서버(resolveDaemonStatuses)가 설치 앵커(min(started_at)) 기준 시스템이 1 cadence 초과로
// 떠 있으면 stale(crit)로 승격 — 진짜 신규 설치(cadence 미만)만 info 유지.
const DAEMON_STATUS_TONE = {
  // 'Healthy' 는 BADGE_TONE_META.ok.label 과 의도적 동일 리터럴 — daemon-nodata-consistency.test.ts 의
  // 소스 정규식 파서가 `label: '...'` 문자열 리터럴을 요구(참조식 불가)하므로 여기서 단일화 불가.
  // 드리프트는 ui.badge-registry.unit.test.ts 의 동치 단언(=== BADGE_TONE_META.ok.label)이 차단.
  ok:                { tone: 'ok',      label: 'Healthy' },
  partial:           { tone: 'warn',    label: 'Warning' },
  error:             { tone: 'crit',    label: 'Down' },
  missing:           { tone: 'info',    label: 'No data' },
  stale:             { tone: 'crit',    label: 'Overdue' },
  quota_exceeded:    { tone: 'warn',    label: 'Usage limit' },
  apply_failed:      { tone: 'crit',    label: 'Apply failed' },
  apply_unavailable: { tone: 'warn',    label: 'Apply unavailable' },
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

// 콤마 정수 (1,234,567) — 비숫자/NaN/음수 → '—' (가짜 0 금지, wiki 가드 승격)
function formatInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '—';
  return n.toLocaleString('en-US');
}

// duration → human-readable 단일 버킷 SoT (agents p95 · wiki 소요 공용). unit: 'sec'(기본) | 'ms'.
// 비숫자/NaN/음수 → '—' · ms<1s = "NNNms" · <60s = "NNs" · ≥60s = "Mm Ss" 인간화 · ≥1h = "Hh Mm".
function formatDuration(value, unit = 'sec') {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 0) return '—';
  let sec;
  if (unit === 'ms') {
    if (raw < 1000) return `${Math.round(raw)}ms`;
    sec = Math.round(raw / 1000);
  } else {
    sec = Math.round(raw);
  }
  if (sec < 60)   return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

// byte 크기 → human-readable; 비숫자/NaN/음수 → '—'. <1KB = "N B" · 그 외 "N.N KB" (페이로드 ≤수십 KB 도메인)
function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
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

// 종결(closed) 표시 메타 — RESULT_META 키는 5-value result enum SoT 이므로 6번째 키를 더하지 않는다.
// closed 는 result 와 직교하는 별도 차원(closed_at 유무)이라 sibling 상수로 둔다.
// tone=neutral(탈강조) + 캐논 셋(A7) 글리프 ✓ + 텍스트 라벨 → 색 단독 인코딩 회피.
const CLOSED_META = { tone: 'neutral', glyph: '✓', icon: 'check', label: 'Closed' };

// result + closed_at → 표시 메타 (RESULT_META 소비부 단일 진입점).
// amber = '지금 열려 있음' 이므로 done_with_concerns + closed_at 만 종결 표시로 접는다 —
// 다른 result 는 closed_at 과 무관하게 RESULT_META 그대로 (taxonomy 불변).
function resolveResultMeta(result, closedAt) {
  const base = RESULT_META[result] || { tone: 'neutral', glyph: 'ℹ', icon: 'info', label: result };
  if (result === 'done_with_concerns' && closedAt) return { ...CLOSED_META, closed: true };
  return { ...base, closed: false };
}

// 비율 표본 임계 (A5) — n < 30 이면 muted/italic + '(n=N)' 표기 대상.
const LOW_N_MIN = 30;

// Outcome quality thresholds — the share a fact must reach before it carries a tone.
const OUTCOME_BREAKAGE_CRIT_SHARE = 0.05;
const OUTCOME_OPEN_CAVEAT_WARN_SHARE = 0.1;
// Recorder-reconstructed share — a reporting-pipeline fact, tuned independently of the caveat rule.
const OUTCOME_MISSING_REPORT_WARN_SHARE = 0.1;

// Per-fact tone SoT — every screen reads one fact's share against one population here,
// so a bare "greater than zero" never becomes a second rule. Population <= 0 → null
// (an absent denominator is not a risk); below the share → null; at or above it → tone.
// The low-N guard stays at the call site: the rollup applies it and the card hint does
// not, and that split is a contract, not an accident.
function outcomeShareTone(count, population, minShare, tone) {
  const den = Number(population);
  if (!Number.isFinite(den) || den <= 0) return null;
  return (Number(count) || 0) / den >= minShare ? tone : null;
}

// by_result / by_agent row → 총 건수. row 부재(응답 누락 키)·비수치 모두 0.
function getOutcomeCount(row) {
  return Number(row?.count) || 0;
}

// by_result row → 미종결 건수. closed_count 부재(구 응답)는 0 종결 · 계약 어긋난 초과 종결도 음수 금지.
function getOutcomeOpenCount(row) {
  const closed = Number(row?.closed_count) || 0;
  return Math.max(0, getOutcomeCount(row) - closed);
}

// 품질 신호 모집단 — 합성행 제외. 합성행의 result 는 recorder 가 고른 값이라 품질 정보가 없다.
// reconstructed_total 부재(구 응답) → 종전 total 유지(하위호환).
//
// 이중 모집단 계약(여기가 그 seam) — 이 값은 임계 hint · severity rollup 전용이고, 분포
// 막대·범례는 total(전수)을 쓴다. 불일치는 버그가 아니라 계약이므로 어느 한쪽으로 통일하지
// 말 것: 막대를 writer 기준으로 바꾸면 합성 기록이 화면에서 사라지고, hint 를 전수로
// 되돌리면 기록 누락이 품질 저하로 읽힌다.
function getWriterTotal(data) {
  const total = Number(data?.total) || 0;
  const reconstructed = Number(data?.reconstructed_total) || 0;
  return Math.max(0, total - reconstructed);
}

// row → writer 발신 미종결 건수(품질 분자). writer_open_count 부재(구 응답) → 종전 미종결 건수.
function getWriterOpenCount(row) {
  const writerOpen = Number(row?.writer_open_count);
  return Number.isFinite(writerOpen) ? Math.max(0, writerOpen) : getOutcomeOpenCount(row);
}

// row → writer 발신 건수(종결 무관 — 실패/차단 임계는 종결에 반응하지 않는 계약 유지).
function getWriterCount(row) {
  const reconstructed = Number(row?.reconstructed_count) || 0;
  return Math.max(0, getOutcomeCount(row) - reconstructed);
}

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

/**
 * Attention tone for a value against stated thresholds — no threshold, no tone; a count warns via `{ warnAbove: 0 }`.
 * @returns 'crit' past critAbove, 'warn' past warnAbove, otherwise null (missing or non-numeric values included).
 */
function getSeverityTone(value, { warnAbove, critAbove } = {}) {
  const n = typeof value === 'number' ? value : Number.NaN;

  if (!Number.isFinite(n)) return null;
  if (critAbove != null && n > critAbove) return 'crit';
  if (warnAbove != null && n > warnAbove) return 'warn';
  return null;
}

const SEVERITY_RANK = { ok: 1, info: 2, warn: 3, crit: 4 };

// Worst tone of a rollup (a badge follows the worst on its screen); neutral/unknown tones carry none → null.
function getWorstTone(tones) {
  let worst = null;

  for (const tone of tones) {
    if (SEVERITY_RANK[tone] > (SEVERITY_RANK[worst] || 0)) worst = tone;
  }
  return worst;
}

// tone → Icon 이름 lookup (신규) — Badge/보드의 Icon 렌더 경로 전용. TONE_GLYPH(문자열 SoT)와 병존:
// 문자열 직접 소비부는 TONE_GLYPH 를 그대로 쓰고, Icon 렌더 경로만 여기서 아이콘명을 얻는다(FIX-A 분리).
// crit 은 DESIGN.md §4.2 severity 표준(✕)에 맞춰 'x' — ⛔(ban)이 아님(ban 은 별도 semantic).
const TONE_ICON = { ok: 'check', warn: 'warn', crit: 'x', info: 'info', neutral: 'info' };

// 불투명 sticky thead 스타일 SoT (S1) — 다수 화면(.tbl)이 미러하므로 단일 출처화.
// 불투명 --elev fill 유지(§7.5 row blur 금지) — 스크롤 시 헤더가 본문 위에 떠도 가려지지 않음.
const STICKY_TH_STYLE = { position: 'sticky', top: 0, background: 'rgb(var(--elev))', zIndex: 1 };

// review_flag 사유 라벨 SoT (F12) — recorder 가 행에 기록한 어휘(hooks/lib/review-flag-reasons.sh
// REVIEW_FLAG_REASON_TOKENS)의 상위집합. 읽기 시점 재파생은 금지 — 레지스트리 미등록·귀속 채널 등
// 행 밖 신호는 브라우저가 판단할 수 없어 예외 없이 catch-all 로 뭉개진다.
const REVIEW_FLAG_REASON_META = {
  'overconfidence': { label: 'Overconfident', title: 'Said sure, but the check failed' },
  'underconfidence': { label: 'Underconfident', title: 'Doubted itself, but the check passed' },
  'empty-metric': { label: 'No self-check', title: 'No self-check reported' },
  'degraded-attribution-derived': { label: 'Derived record', title: 'Record derived from a structured output — the writer emitted no completion block' },
  'degraded-attribution-synthesized': { label: 'Synthesized record', title: 'Record synthesized from the transcript — the writer emitted no completion block' },
  'grader-contradiction': { label: 'Check mismatch', title: 'Claimed success, but the automatic check disagreed' },
  'correction-gap': { label: 'Correction gap', title: 'A user correction was signalled without the distilled directive' },
  'correction-disagreement': { label: 'Correction mismatch', title: 'The agent reported a user correction the transcript detector did not corroborate' },
  'non-registry-agent-at-write': { label: 'Unknown agent', title: 'The recorded agent name was absent from the registry when the row was written' },
  'probe-omission': { label: 'No convention probe', title: 'Code change recorded with no convention reference' },
  'unregistered-agent-probe-exempt': { label: 'Probe-exempt agent', title: 'The recorded agent never received the convention-probe instruction' },
  'scope-excess': { label: 'Outside declared scope', title: 'An edited path fell outside the file list the delegation declared' },
};

// carrier 가 빈 구행(사유 기록 이전) — 사유를 지어내지 않고 명시적 미분류 상태로 렌더.
const REVIEW_FLAG_REASON_UNCLASSIFIED = { key: 'unclassified', label: 'Unclassified', title: 'Flagged before reasons were recorded — open the row' };

// 세그먼트/배지 표시 순서 = 기록 어휘 순서. 미분류·미상 버킷은 항상 말미.
const REVIEW_FLAG_REASON_ORDER = [...Object.keys(REVIEW_FLAG_REASON_META), 'unclassified', 'unknown'];

// 반환 순서 = ORDER 고정 — [0]이 세그먼트 partition 기준이라 recorder append 순서에 흔들리면 안 된다.
function reviewFlagReasons(row) {
  if (!row || row.review_flag !== true) return [];

  const carrier = Array.isArray(row.review_flag_reasons) ? row.review_flag_reasons : [];
  const codes = carrier.filter((code) => typeof code === 'string' && code !== '');
  if (codes.length === 0) return [{ ...REVIEW_FLAG_REASON_UNCLASSIFIED }];

  const seen = new Set();
  const reasons = [];
  for (const code of codes) {
    const meta = REVIEW_FLAG_REASON_META[code];
    const dedupKey = meta ? code : `unknown/${code}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    reasons.push(meta
      ? { key: code, label: meta.label, title: meta.title }
      : { key: 'unknown', label: 'Unknown reason', title: `Reason not recognized by this build: ${code}` });
  }
  reasons.sort((a, b) => REVIEW_FLAG_REASON_ORDER.indexOf(a.key) - REVIEW_FLAG_REASON_ORDER.indexOf(b.key));
  return reasons;
}

// Outcome 품질 판정 — Dashboard 와 Task results 가 공유하는 단일 규칙.
// 임계 리터럴·분모 helper 는 위 outcomeShareTone 블록이 SoT — 여기서는 조합만.
// cross-analysis 응답 → 단일 판정. status 는 톤이 아니라 상태다 —
//   'unavailable' 미수신/전량 합성 · 'empty' 기간 내 0건 · 'low-n' 표본 부족(가짜 경보 차단) ·
//   'ok' | 'warn' | 'crit'. 색은 tone 으로만 나가고 문구에는 싣지 않는다.
function resolveOutcomeRate(data) {
  const total = Number(data?.total) || 0;
  const rows = new Map((data?.by_result || []).map((r) => [r.result, r]));
  const writerTotal = getWriterTotal(data);
  const breakage = getWriterCount(rows.get('fail')) + getWriterCount(rows.get('blocked'));
  const openCaveats = getWriterOpenCount(rows.get('done_with_concerns'));
  const base = { total, writerTotal, breakage, openCaveats, tone: 'neutral' };

  if (!data) return { ...base, status: 'unavailable' };
  if (total <= 0) return { ...base, status: 'empty' };
  if (writerTotal <= 0) return { ...base, status: 'unavailable' };
  if (writerTotal < LOW_N_MIN) return { ...base, status: 'low-n' };
  const tone = outcomeShareTone(breakage, writerTotal, OUTCOME_BREAKAGE_CRIT_SHARE, 'crit')
    || outcomeShareTone(openCaveats, writerTotal, OUTCOME_OPEN_CAVEAT_WARN_SHARE, 'warn')
    || 'ok';
  return { ...base, status: tone, tone };
}

window.UI = {
  Icon, Pill, Badge, EmptyState, SubCard, Sparkline, MiniBars, Bar, BulletBar, StatusDot, AgentBadge, AgentName, getAgentDisplayName, KPI, KpiValue, DetailSurface, getTrapFocusTarget, getInertTargets, Modal, Tabs, CardHead, PageHeader,
  SectionLabel, Table, TableHead, DisclosureChevron, DisclosureButton, getSeverityTone, getWorstTone,
  getRovingIndex, getRovingTabIndex, ROW_CONTROL_PROPS, getRowKeyAction, getRowFocusProps, ChipGroup,
  getDisplayName, hasFieldValue, DetailField,
  TrendChart, getChartTicks, getChartIndexAtRatio, getChartKeyIndex, getChartReadout, getChartSummary,
  TypeScaleStyle, toneVarColor,
  titleOf, stripHtmlTags, formatRelativeTime,
  FreshnessStamp, getFreshnessState, getRegionSummary, RefreshButton,
  getFetchError, getErrorCopy, getSharedFailure, RegionUnavailable, PageErrorBanner, LoadingPlaceholder, SkeletonRows,
  INITIAL_REGION_STATE, putRegionRequest, putRegionData, putRegionFailure,
  setDisplayTimezone, getDisplayTimezone, tzShortLabel,
  formatKstDateTime, formatKstTime, formatKstDate, formatKstFull,
  formatUsd, formatUsdCompact, formatInt, formatTokenCompact, formatDuration, formatBytes,
  BADGE_TONE_META, BADGE_OVERRIDES, resolveBadge,
  DAEMON_STATUS_TONE, daemonStatusTone, daemonStatusLabel,
  RESULT_META, CLOSED_META, resolveResultMeta, LOW_N_MIN, formatPctWithDenominator,
  TONE_GLYPH, TONE_ICON, STICKY_TH_STYLE, reviewFlagReasons, REVIEW_FLAG_REASON_ORDER, REVIEW_FLAG_REASON_META,
  outcomeShareTone, resolveOutcomeRate, OUTCOME_BREAKAGE_CRIT_SHARE, OUTCOME_OPEN_CAVEAT_WARN_SHARE,
  OUTCOME_MISSING_REPORT_WARN_SHARE,
  getOutcomeCount, getOutcomeOpenCount, getWriterTotal, getWriterOpenCount, getWriterCount,
};
