# Atrium Monitor — Design System SoT

- **범위**: Atrium Monitor(`monitor/public`) 시각 언어의 규칙 SoT — 출하된 토큰 · component class · `window.UI` atom 이 따르는 규칙.
- **값의 출처**: `public/styles/tokens.css`(토큰) · `public/styles/base.css`(component class) · `public/src/ui.jsx`(atom).
  - 본 문서의 값 블록은 그 미러다. 코드와 어긋나면 같은 변경에서 둘 다 고친다.
  - 코드 주석과 테스트가 `design.md §N` 으로 이 문서를 인용한다 → 11개 섹션 번호와 `§3.2`·`§3.3`·`§3.5`·`§4.2`·`§6.3`·`§7.1`·`§7.3`·`§7.5`·`§7.8`·`§8.2`·`§8.4`·`§9.2`·`§9.3` 소절 번호는 고정.
- **스택**:
  - React 18 + JSX → esbuild precompile(`npm run build:jsx` → `public/dist/*.js`). 로드 순서 tweaks-panel → ui → screens → app (window-global 의존).
  - Tailwind CDN(JIT) + 런타임 `tailwind.config` 객체 · CSS custom-property `rgb(var(--ink) / <alpha>)` 규약.
  - 아이콘: Lucide 0.469 카탈로그를 `Icon` atom 으로만 소비 (기본 size 16 · stroke 1.6). 손수 복사한 SVG path 금지.
  - 기본 테마 dark (`<html data-theme="dark">` + `app.jsx` → `TWEAK_DEFAULTS.theme`). Tweaks 패널이 light 로 전환.
  - System map: mermaid 11 + svg-pan-zoom.
- 용어는 영어 토큰/CSS 원형, 설명은 한국어.

**Movement name — "Daylight Atrium"**

- 건물 아트리움: 유리 지붕이 중앙 보이드를 가장 밝고 명료한 면으로 만들고, 주변 갤러리는 보이드를 가리지 않고 층층이 물러난다 → 데이터 밀집 대시보드의 시각 원칙으로 번역.
- "Glass" = 표면마다 blur 를 바르는 장식이 아니라 **빛 · 개방감 · 구조적 명료성의 에토스**.
- 투명도는 transient 표면에만, 가독성 · 성능 · 명암비 근거를 동반할 때만.

**Concrete referent — "Quiet Ledger"**

- Payload 3 admin list view · Strapi 5 content manager: 14–16px body, 한 줄 panel header, 얇은 border, resting shadow 없음.
- 가장 가까운 5-Direction = `tech-utility` (dense table · hairline border · tabular numerics). palette · Pretendard/JetBrains Mono · radius role 은 monitor 고유값 유지.
- Signature move 1개: 한 단계 큰 type scale + 짧은 copy. 나머지는 정렬.

---

## 1. 디자인 철학 (Design Philosophy)

- Atrium Monitor = self-improving 멀티에이전트 하니스를 실시간으로 읽는 **운영 계기판(operator instrument)**.
  - 사용자 목적 = "지금 무엇이 위험한가" 를 1초 안에 판독. 최우선 가치 = **판독 속도(legibility-at-a-glance)**, 미감은 그에 종속.

**1) 중심 명료 영역 (Central Clarity Zone)**

- 각 화면의 본문 데이터 면(카드 그리드 · 차트 · 테이블)이 아트리움의 보이드 = 뷰포트에서 가장 밝고 선명한 plane.
- 사이드바 · 페이지 헤더 같은 chrome 은 `--dim`/`--faint` 톤으로 물러난다. `aside`(`bg-elev` · `border-r`)가 물러난 chrome 자리.

**2) 가리지 않는 레이어드 깊이 (Layered Depth Without Occlusion)**

- 깊이 = **휘도 차(luminance delta) + 경계(border)**. 아래 레이어를 뭉개는 blur 로 표현하지 않는다.
- 사이드바 = 같은 평면 · 카드 = raised · drawer/dialog/popover = overlay. 어떤 레이어도 그 아래 정보를 흐려 가리지 않는다.

**3) 위에서 오는 확산광 (Diffuse Top-Light)**

- 채널은 테마에 따라 다르다:
  - dark: 카드 상단 1px inset 하이라이트 + base 보다 밝은 fill (가시).
  - light: 순백 카드(`--elev` 255)는 이미 천장 → 하이라이트 비가시. **1px `--line` border 만으로 떠오름**(border-first elevation).
- 구체 규칙: §6.2 · §7.1.

**4) 숨 쉴 공간 (Airy Breathing Room)**

- 하나의 간격 세트: `--card-pad` 16 (card body · head 좌우) · 한 줄 48px card head · card gap 16 · section gap 24 · main padding 24.
  - 글자가 커지면 padding 은 **더 좁게**, 넓히지 않는다.
- 한 뷰포트 zone 당 1차 초점 요소 ≤ 5.
- 밀도는 여백을 죽여서가 아니라 sparkline · sub-card · 점진적 공개로 달성한다. 공개 수단 4가지:
  - `Disclosure` fold: `kind="status"` 는 열린 채 시작, `kind="detail"` 은 접힌 채 시작 · warn/crit 이 되면 스스로 열리고, 회복해도 강제로 닫지 않는다 (`getDisclosureOpen`).
  - `CardInfo` ⓘ → `DetailSurface` drawer: cap 을 넘는 설명 (§5.3).
  - `Popover`: card-head 트리거 아래 non-modal 패널 (§6.5).
  - 행 drawer: 행 클릭 → 레코드 상세 `DetailSurface`.

**5) 구조적 투명성 (Structural, not Visual, Transparency)**

- 유리 건축의 투명성 = 안에서 건물 조직을 추론할 수 있음. UI 등가물 = **배치 · 타이포 위계 · 색 코딩으로 정보 위계가 첫눈에 읽힘**.
- 좌상단 = 가장 중요 · 타이포 weight 등급 · severity 기호+색 코딩. 어떤 glass 효과보다 먼저 충족.

**6) 빈 공간이 아니라 내용의 크기를 맞춘다 (Size the content, not the empty space)**

- 한 행의 peer 카드는 높이를 맞춘다(`SplitRow layout="equal"`).
- **stretch 는 짧은 카드의 natural body 가 긴 카드의 ≥ 75% 일 때만 유효**하다 (`improvement.instrumentation-rows.e2e` → `STRETCH_FLOOR`).
- 미만이면 이 순서로 고친다:
  - (a) row budget — 두 목록을 같은 visible row 수로 cap + `Show all N` foot.
  - (b) condensed — 짧은 카드를 S 크기로 내려 다른 짧은 카드와 한 `SplitColumn` 에 쌓는다.
  - (c) re-pair — 비슷한 높이의 카드 옆으로 옮긴다.
- 발명한 내용(filler)으로 채우지 않는다. 메커니즘: §7.11.

- **데이터 밀도와의 화해**: 투명도/blur 는 "유리 지붕 순간"(drawer · dialog backdrop · 떠 있는 chrome)에만 정당. 상시 정보 표면(테이블 · KPI · 알림 행 · 차트)은 불투명 면 위.

---

## 2. 디자인 원칙 (Design Principles)

각 원칙은 검증 가능한 기준을 동반한다. 연구 출처는 문서 말미.

1. **Data-density first.** 화면의 존재 이유는 데이터. 장식이 데이터 표면의 명료성을 떨어뜨리면 제거한다 (Smashing: zone 당 1차 초점 ≤ ~5).
2. **Legibility is non-negotiable.**
   - 모든 텍스트는 렌더된 실제 배경 대비 WCAG AA (본문 4.5:1 · large-text 3:1). 측정표: §4.1.
   - 렌더 텍스트 13px 미만 금지 (§5.2).
   - 투명 표면 위 텍스트는 scrim 필수 (§6.4 · §9).
3. **Restraint — 절제된 투명도.** glass/blur 는 transient · light-dismiss 표면에만. 상시 표면은 불투명. "모든 카드에 backdrop-blur" 금지 (Fluent: Acrylic = transient, Mica/Solid = 상시).
4. **Elevation through border and luminance, not blur.**
   - light: raised = 1px `--line` border 만. shadow 는 raised-2(hover/focus)와 overlay 부터.
   - dark: 휘도 step + `--shadow-raised` + 상단 inset 하이라이트.
5. **정확히 4단계 elevation.** `sunken → base → raised → overlay`. raised-2 는 raised 의 hover/focus 상태이지 별도 단계가 아니다. 테마별 채널: §6.1.
6. **Semantic 토큰은 테마별로 값이 갈리는 곳을 매개한다.**
   - Tier 2 alias 가 있고 그 alias 가 테마마다 다른 primitive 를 가리키면(예: `--surface-raised-2`) component 는 alias 를 쓴다.
   - 그 외 component 는 primitive(`--elev` · `--overlay-surface` · `--line`)를 직접 참조해도 된다. 새 **색** 은 primitive 로만 추가 (§3.2a).
7. **Motion clarifies change, never decorates.**
   - 상시 ambient 루프는 `.live-dot` 하나.
   - 로딩 표시(skeleton pulse · spinner)는 로딩 중에만 도는 별도 범주이며, 반드시 `prefers-reduced-motion` 게이트를 갖는다 (§8).
8. **색맹 안전(dual-encoding).**
   - severity = 기호 + 색 + 단어. 색 단독 인코딩 금지 (`TONE_GLYPH` ✓/⚠/✕/ℹ).
   - tone 은 선행 glyph 에만 — shell · stripe · 카드 fill · tone border 에 칠하지 않는다 (§4.2).
   - `ui.jsx` → `Badge` 주석의 "DESIGN.md §8" 은 이 원칙 8 을 가리킨다.
9. **Backdrop-filter 성능 예산.** 뷰포트당 동시 backdrop-filter ≤ 2 (drawer 위 confirm 스택 포함), blur ≤ 12px, 스크롤 리스트 아이템엔 금지 (§9.2).

---

## 3. 토큰 시스템 (Token Architecture — 3-Tier)

### 3.0 구조

- **Tier 1 — primitive**: `tokens.css` `:root` / `[data-theme="dark"]`. 색은 raw `R G B` triplet (kind A), 길이·스칼라·그림자·z 는 완결 리터럴 (kind B).
- **Tier 2 — semantic / material**: 표면 elevation alias · glass · shadow 합성 토큰.
- **Tier 3 — component**: `base.css` class + `window.UI` atom (§3.3).

### 3.1 Tier 1 — PRIMITIVE (kind A 색 · 전체)

- 규약: 모든 색 값은 `R G B` (콤마 아님) space-separated triplet. alpha 는 저장하지 않고 사용처에서 `rgb(var(--ink) / α)` 로 합성.

```css
:root {
  /* neutral (warm-stone) */
  --surface: 250 250 249;  --elev: 255 255 255;  --sunken: 245 245 244;  --line: 231 229 228;
  --ink: 28 25 23;  --dim: 87 83 78;  --faint: 112 106 101;
  /* interaction */
  --accent: 37 99 235;        /* fallback — 런타임 값은 Tweaks accent (§4.4) */
  --focus-ring: 37 99 235;    /* theme-owned, accent 와 분리 */
  --selected-fill: 28 25 23;  --selected-ink: 250 250 249;
  --pip-empty: 138 132 127;
  /* severity */
  --crit: 220 38 38;  --warn: 217 119 6;  --ok: 5 150 105;  --info: 8 145 178;
  /* categorical — chart fill only */
  --cat-1: 124 58 237;  --cat-2: 13 148 136;  --cat-3: 37 99 235;  --cat-4: 219 39 119;
  /* agent identity — 테마 불변 */
  --agent-1: 59 130 246;  --agent-2: 139 92 246;  --agent-3: 6 182 212;  --agent-4: 16 185 129;
  --agent-5: 245 158 11;  --agent-6: 236 72 153;  --agent-7: 239 68 68;  --agent-8: 8 145 178;
  --agent-ink: 28 25 23;
  /* elevation · glass primitives */
  --elev-2: 252 252 251;  --overlay-surface: 255 255 255;
  --glass-tint: 255 255 255;  --glass-border: 255 255 255;
}
[data-theme="dark"] {
  --surface: 12 10 9;  --elev: 28 25 23;  --sunken: 24 20 17;  --line: 41 37 36;
  --ink: 250 250 249;  --dim: 214 211 209;  --faint: 160 154 150;
  --accent: 96 165 250;  --focus-ring: 96 165 250;
  --selected-fill: 214 211 209;  --selected-ink: 12 10 9;
  --pip-empty: 120 113 108;
  --crit: 248 113 113;  --warn: 251 191 36;  --ok: 52 211 153;  --info: 34 211 238;
  --cat-1: 167 139 250;  --cat-2: 45 212 191;  --cat-3: 96 165 250;  --cat-4: 244 114 182;
  --elev-2: 36 32 30;  --overlay-surface: 28 25 23;
  --glass-tint: 28 25 23;  --glass-border: 255 255 255;
}
```

### 3.2 Tier 2 — SEMANTIC / MATERIAL

```css
:root {
  /* surface elevation aliases */
  --surface-sunken:   var(--sunken);
  --surface-base:     var(--surface);
  --surface-raised:   var(--elev);
  --surface-raised-2: var(--elev);            /* light: 순백 유지, 떠오름은 shadow */
  --surface-overlay:  var(--overlay-surface);
  /* glass / material (kind B) */
  --glass-blur: 12px;  --material-glass-alpha: 0.75;
  /* shadow (kind B box-shadow list) */
  --shadow-raised:   0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-raised-2: 0 2px 6px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.05);
  --shadow-overlay:  0 10px 40px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
}
[data-theme="dark"] {
  --surface-raised-2: var(--elev-2);          /* dark: 휘도 step (36 > 28) */
  --material-glass-alpha: 0.82;
  --shadow-raised:   0 1px 4px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2);
  --shadow-raised-2: 0 3px 10px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25);
  --shadow-overlay:  0 10px 40px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3);
}
```

- **dark 휘도 서열**: `base(--surface 12) < sunken(24) < raised(--elev 28) < raised-2(--elev-2 36)` → z 가 오를수록 R 값 단조 증가, 휘도 step 단독으로 elevation 성립.
- **light raised-2 인버전 회피**: `--elev` 255 가 천장이라 `--elev-2` 252 는 raised 보다 어둡다 → light raised-2 는 fill 을 바꾸지 않고 `--shadow-raised-2` 로만 표현. `--elev-2` fill 은 dark 전용.
- shadow 의 내부 `rgba()` 농도는 의도적으로 alpha-비합성 — box-shadow 는 `<alpha-value>` 보간 대상이 아니므로 테마별 값에 baked-in.

### 3.2a 토큰 종류 2종 (Dual Token Convention)

| Kind | 형식 | 범위 | 소비 |
|------|------|------|------|
| **A — RGB-triplet** | `R G B` (alpha 없음) | §3.1 의 모든 색 · 표면 (~33개). 그중 Tailwind `theme.extend.colors` 매핑은 16개 (surface · elev · sunken · line · ink · dim · faint · accent · crit · warn · ok · info · cat-1..4) | `rgb(var(--ink) / α)` · Tailwind `bg-elev` 등 |
| **B — 완결 리터럴** | length · scalar · box-shadow · z-index | 아래 블록 + §3.2 의 glass/shadow | `var(--fs-meta)` 그대로 (alpha 합성 불가) |

```css
:root {
  /* type steps — 유일한 스케일 소스, 정수 px, 13px floor (§5.2) */
  --fs-kpi: 32px;  --fs-display: 24px;  --fs-stat: 20px;  --fs-title: 16px;
  --fs-body: 15px;  --fs-control: 14px;  --fs-meta: 13px;
  --fs-micro: var(--fs-meta);   /* 은퇴한 step — floor 아래로 떨어지지 않게 alias 만 유지 */
  /* radius by role — inline < control < tile < card/overlay */
  --radius-inline: 4px;  --radius-control: 6px;  --radius-tile: 8px;  --radius-card: 12px;
  --radius-badge: 6px;
  /* hit height · card anatomy */
  --ctl-min-h: 32px;
  --card-head-h: 48px;  --card-pad: 16px;  --row-h: 40px;
  /* focus */
  --focus-ring-width: 2px;  --focus-ring-offset: 2px;
  /* z stack */
  --z-overlay: 100;  --z-confirm: 150;  --z-toast: 200;
  /* form-control box (base.css) */
  --ctl-pad-y: 5px;  --ctl-pad-x: 9px;  --ctl-font: var(--fs-control);  --ctl-line: 1.4;
  --ctl-radius: var(--radius-control);  --ctl-h: var(--ctl-min-h);
}
```

- 새 **색/표면** 토큰은 kind A 로만 추가. kind B 는 length · scalar · shadow · z 에 한정.
- line-height 는 토큰이 없다 — class 별 리터럴(§5.2).

### 3.3 Tier 3 — COMPONENT (`window.UI` atom + `base.css` class)

- 화면은 `window.UI` atom 을 조합한다. atom 이 있는 역할을 screen-local JSX/CSS 로 다시 만들지 않는다.
- atom 인벤토리 (`ui.jsx`):

| 역할 | atom | styling class |
|------|------|---------------|
| 카드 | `Card` · `CardHead` · `CardInfo` · `SubCard` | `.card*` · `.sub-card` |
| 레이아웃 | `SplitRow` · `SplitColumn` · `TileSplit` | `.split-row*` · `.split-col*` · `.tile-split` |
| overlay | `DetailSurface` · `Modal`(= confirm 위임) · `Popover` | `.detail-*` · `.popover-*` |
| 공개 | `Disclosure` · `DisclosureButton` | `.card.is-collapsed` |
| 배지·상태 | `Badge` · `Pill`(→ Badge) · `StatusDot` · `AgentBadge` | `.pill*` |
| 수치 | `KPI` · `KpiValue` · `Delta` · `Sparkline` · `TrendChart` · `Bar` · `BulletBar` | `.kpi*` |
| 표 | `Table` · `TableHead` · `ClampCell` · `ClampText` | `.tbl` · `.cell-clamp` · `.clamp-2` |
| 페이지 | `PageHeader` · `PageVerdict` · `SectionLabel` · `EmptyState` | `.page-verdict*` · `.section-label` · `.placeholder` |
| 기타 | `Icon` · `Tabs` · `ChipGroup` · `DetailField` | `.tabs` · `.seg` |

- **예약 class (소비처 없음)**: `.glass-surface` · `.card-raised` · `.elev-overlay` 는 `base.css` 에 정의돼 있으나 `public/src` 소비처가 없다.
  - `.glass-surface` 는 향후 transient glass 표면 전용. 상시 표면에 쓰지 않는다.
  - 표면이 필요하면 `Card` / `DetailSurface` / `Popover` atom 을 쓴다.

### 3.4 소비 경로 · shadow 규칙

- **Tailwind 유틸**: 매핑된 16색만 (`bg-elev` · `text-dim` · `border-line` …). 그 외 토큰은 class 안 `var()` 또는 inline style.
- **CDN 런타임 class-scan 유지**: `index.html` → "Tailwind CDN (JIT) — viewer R6 path" 주석. PostCSS 빌드로 바꾸면 런타임 유틸이 조용히 빠진다.
- **Shadow 는 `--shadow-*` 만.**
  - Tailwind `boxShadow.card` / `.float` 는 정의만 남아 있고 소비처가 없다 — 쓰지 않는다.
  - 알려진 하드코딩 예외 (코드 수정 대상): `cost.jsx` · `agents.jsx` → `tooltipStyle` (`0 4px 12px rgba(0,0,0,0.12)`) · `improvement.jsx` toast inline (`0 8px 24px rgba(0,0,0,0.18)`) · `improvement.jsx` → `.i-card-shadow`.

### 3.5 tweaks-panel glass — dev-only carve-out

- `tweaks-panel.jsx` → `__TWEAKS_STYLE` 의 `.twk-panel` 은 개발용 floating 패널이며 monitor 에서 glass 가 있는 유일한 상시 chrome.
- 현재 사실:
  - `backdrop-filter: blur(24px) saturate(160%)` — 12px cap 초과, `saturate` 는 예산 어휘 밖.
  - 색은 하드코딩 (`rgba(250,249,247,.78)` · `#29261b` · `rgba(255,255,255,.6)`) — `--glass-*` 토큰 비구동.
  - `@media (prefers-reduced-transparency: reduce)` fallback 있음 → blur 해제 + 불투명 `rgba(250,249,247,1)`.
  - 텍스트는 `--fs-control` / `--fs-meta` (13px floor 준수).
  - z-index 2147483646 — §6.5 z stack 밖.
- **분류**: 사용자 대면 화면이 아니므로 12px cap · ≤2 예산 산정에서 제외. reduced-transparency fallback 의무는 dev 도구에도 적용 (충족).

---

## 4. 컬러 (Color — Light / Dark · Semantic · Severity vs Categorical)

- 베이스 = **warm-stone** 중립 (≈ Tailwind stone). 새 hue 를 발명하지 않는다.

### 4.1 Semantic 토큰 (name · role)

| Token | Light `R G B` | Dark `R G B` | Role |
|-------|---------------|--------------|------|
| `--surface` | 250 250 249 | 12 10 9 | 페이지 바탕 (dark 에선 가장 어두움) |
| `--elev` | 255 255 255 | 28 25 23 | 카드 · 패널 · 사이드바 면 (raised) |
| `--elev-2` | 252 252 251 | 36 32 30 | raised-2 fill — **dark 전용** (light 는 인버전이라 미사용) |
| `--overlay-surface` | 255 255 255 | 28 25 23 | drawer · dialog · popover 불투명 면 |
| `--sunken` | 245 245 244 | 24 20 17 | 함몰 홈 · `th` · 배지 shell · tabs track |
| `--line` | 231 229 228 | 41 37 36 | 1px 경계선 · ring |
| `--ink` | 28 25 23 | 250 250 249 | 본문 텍스트 (dark 에서도 순백 아님) |
| `--dim` | 87 83 78 | 214 211 209 | 읽는 캡션 · 2차 텍스트 · card meta |
| `--faint` | 112 106 101 | 160 154 150 | timestamp · ID · 차트 tick 전용 |
| `--accent` | 37 99 235 | 96 165 250 | 인터랙션 (fallback 값 — §4.4) |
| `--focus-ring` | 37 99 235 | 96 165 250 | focus outline — theme-owned, accent 와 분리 |
| `--selected-fill` / `--selected-ink` | 28 25 23 / 250 250 249 | 214 211 209 / 12 10 9 | 유일한 filled selected 상태 (§7.6) |
| `--pip-empty` | 138 132 127 | 120 113 108 | 빈 stage pip — 모든 면에서 ≥ 3:1 |

- **텍스트 role 규칙**: primary = `--ink` · 읽는 캡션 = `--dim` · `--faint` 는 timestamp · ID · tick 같은 진짜 메타데이터에만 (`base.css` → `.card-sub` 주석).
- **계산된 명암비** (WCAG 2.2 상대휘도, 이번 갱신에서 python 으로 계산):

| fg | Light: elev / surface / sunken | Dark: elev / surface / sunken / elev-2 |
|----|-------------------------------|----------------------------------------|
| `--ink` | 17.49 / 16.74 / 16.03 | 16.74 / 18.92 / 17.53 / 15.46 |
| `--dim` | 7.63 / 7.30 / 6.99 | 11.74 / 13.26 / 12.29 / 10.84 |
| `--faint` | 5.33 / 5.11 / 4.89 | 6.29 / 7.11 / 6.59 / 5.81 |
| `--focus-ring` (≥3:1 UI) | 5.17 / 4.95 / 4.74 | 6.88 / 7.77 / 7.20 / 6.35 |
| `--pip-empty` (≥3:1 UI) | 3.69 / 3.54 / 3.38 | 3.65 / 4.12 / 3.82 / 3.37 |
| `--selected-ink` on `--selected-fill` | 16.74 | 13.26 |

- 모든 텍스트 쌍 ≥ 4.5 (AA), 모든 UI 쌍 ≥ 3.0. 회귀 테스트: `test/tokens.contrast.unit.test.ts`.

### 4.2 Severity (crit / warn / info / ok) — 색만 쓰지 말 것

| Token | Light | Dark | 의미 | `TONE_GLYPH` |
|-------|-------|------|------|--------------|
| `--crit` | 220 38 38 | 248 113 113 | 실패 · 위험 | ✕ |
| `--warn` | 217 119 6 | 251 191 36 | 경고 · 주의 | ⚠ |
| `--ok` | 5 150 105 | 52 211 153 | 정상 · 성공 | ✓ |
| `--info` | 8 145 178 | 34 211 238 | 정보 · blocked(중립) | ℹ |
| neutral | — | — | 톤 없음 | ℹ |

- **인코딩 = glyph + 색 + 단어, neutral shell 위.**
  - tone 은 선행 glyph(또는 `Icon`, `TONE_ICON` check/warn/x/info)에만 `text-<tone>` 으로. 라벨 텍스트는 `--dim`/`--ink` 유지.
  - shell(배지 배경 · 카드 fill · 행 배경) · 좌측 stripe · tone border 에 tone 을 칠하지 않는다.
  - `StatusDot`: glyph + sr-only 단어(`STATUS_DOT_WORD` OK/Warning/Critical/Info). 미지 status 는 `–` + "Unknown" (`--faint`).
  - `KpiValue tone`: glyph 장식(aria-hidden), 수치는 neutral ink.
  - `PageVerdict`: glyph 만 tone, 단어와 문장은 ink.
- **Badge 3 role** (`ui.jsx` → `Badge`):
  - `status` — 반응이 필요한 lifecycle/health. 선행 glyph 가 tone 운반. glyph 가 없을 때만(`glyph` false) 라벨이 tone 을 운반, shell 은 여전히 neutral.
  - `metadata` — 서술 속성 (agent-only · md · model id). neutral, glyph 없음, 소문자.
  - `count` — 순수 수량. neutral, glyph 없음, mono tabular.
  - 변형: `absent`(dashed · 무배경 · `--faint`) · `interactive`(`<button>`) · icon-only(정사각, 의미는 aria-label/title).
- **alert-card glyph well** (`base.css` → `.alert-card`):
  - light: tone 색 **solid well + `--elev` knock-out glyph** — tinted light well 은 `--warn` glyph 를 2.81:1 로 떨어뜨린다.
  - dark: tone 0.12 tinted well + tone glyph.
- **severity 요소는 glass/blur 위에 두지 않는다** — desaturation 이 응급 신호를 약화 (§6.3).
- **알려진 예외 (현재 코드, 수정 대상)**:
  - `.nav-badge.warn` 과 `app.jsx` → `NAV_BADGE_CRIT_STYLE`: tone 0.15 tinted fill + tone 텍스트. light 명암비 warn 2.71 · crit 3.82 (< 4.5).
  - `.doc-toast.<tone>`: tone 0.14 tinted fill + tone 텍스트(`--fs-body`). light 명암비 warn 2.64 · info 3.00 · ok 3.06 · crit 3.73 (< 4.5). dark 는 전부 ≥ 6.0.
  - `clauded-docs.jsx` → `.doc-row.is-selected` / `.is-pending-delete`: inset 4px accent / crit stripe.
  - light `--warn` glyph on `--sunken` 배지 shell = 2.92:1 (UI 3:1 미달).
- `.diff-line--add/--del` 의 옅은 tint 는 허용 — `+`/`−` glyph 가 1차 신호.

### 4.3 Categorical — 차트 · 식별 전용

| Token | Light | Dark | 용도 |
|-------|-------|------|------|
| `--cat-1` | 124 58 237 | 167 139 250 | 분류 시각화 (chart fill · swatch) |
| `--cat-2` | 13 148 136 | 45 212 191 | 〃 |
| `--cat-3` | 37 99 235 | 96 165 250 | 〃 |
| `--cat-4` | 219 39 119 | 244 114 182 | 〃 |

- severity 와 categorical 분리: cat-* 는 분류용, 위험도용 아님.
- `--cat-2` 3.74:1 · `--cat-4` 4.60:1 on light `--elev` (sunken 에서 3.43 / 4.21) → **fill/swatch 한정, text 색 금지**.
- **Agent 식별 팔레트** `--agent-1..8` + `--agent-ink`:
  - `AgentBadge` 22px 원형 fill. named agent 는 고정 슬롯, 그 외는 id 해시로 배정.
  - 테마 불변. 이니셜 전경 = `--agent-ink`(고정 dark), 8색 모두 ≥ 4.1:1.

### 4.4 Accent

- `--accent` 는 인터랙션 전용 (link · focus 된 field border · 선택 hint).
- **런타임 값은 Tweaks 가 정한다**: `App` effect 가 `<html>` 에 `--accent` 를 `tweaks.accent` 로 inline 기록 (기본 `#3b82f6` = 59 130 246, 양 테마 공통) → `tokens.css` 값은 fallback.
- accent 가 사용자 선택이므로 focus 는 `--focus-ring` 으로 분리 (테마별 고정, 모든 면에서 ≥ 3:1).
- 화면당 accent ≤ 2 (CTA/인터랙션 한정, 장식 금지). categorical 팔레트에 새 색을 추가하지 않는다.

---

## 5. 타이포그래피 (Typography)

### 5.1 Family · OpenType

| 역할 | Family | 비고 |
|------|--------|------|
| UI 본문 · 제목 | `'Pretendard Variable'` → Pretendard → system-ui | `body` 전역 |
| 수치 · 코드 · ID · 시각 | `'JetBrains Mono'` → ui-monospace | `.font-mono` · `code` · `.mono` |

- `body`: `font-feature-settings: 'tnum' 1, 'cv11' 1`. 금융/데이터 수치(KPI · 비용 · token 수 · latency)는 tnum 필수 — mono + tnum 으로 충족.
- Inter / Roboto / Arial / Fraunces 를 1차로 두지 않는다.

### 5.2 Type scale (13px floor)

- `tokens.css` 의 `--fs-*` 가 **유일한 스케일 소스**. `TypeScaleStyle`(`ui.jsx`)은 `.fs-*` class 만 싣는다.

| Token | px | 역할 |
|-------|----|------|
| `--fs-kpi` | 32 | KPI value (mono 600, -0.025em) |
| `--fs-display` | 24 | page title (h1) |
| `--fs-stat` | 20 | inline stat · primary metric |
| `--fs-title` | 16 | card title · drawer title · KPI unit |
| `--fs-body` | 15 | 행 primary · prose · toast |
| `--fs-control` | 14 | button · input · table cell · nav label |
| `--fs-meta` | 13 | **floor** — label · `th` · caption · badge · chart tick · card meta |

- **floor**: 렌더되는 모든 text node ≥ 13px — default view 의 System map label, tweaks 패널 포함. `--fs-micro` 는 `--fs-meta` alias.
- px 리터럴 font-size 금지 — 토큰만.
- **named exception**: `.hero-stat` 30px (`TypeScaleStyle`) — 패널당 하나의 지배 수치 (drawer hero). 스케일 밖 step 이며 소비처는 `agents.jsx` 1곳.
- **line-height**: 토큰 없음, class 리터럴 — `.fs-title` 1.4 · `.fs-body` 1.45 · `.fs-meta` 1.4 · `.card-sub` 1.5 · `.kpi-value` 1.15 · `--ctl-line` 1.4.
- **weight (≤ 3 · signature 1)**: 400 regular · 500 medium (label · nav active · button · badge) · 600 semibold (card title · KPI value · page title). signature = 600 + mono 수치.
- **수치 표기**:
  - 큰 KPI value 는 `letter-spacing: -0.025em` 으로 한 덩어리처럼.
  - **값:단위 = 2:1** — `.kpi-value` 32 ↔ `.kpi-value .unit` 16 (`--fs-title`, "half of --fs-kpi"). 다른 수치 UI 도 자기 스케일 안에서 2:1 페어.
- **page header** (`PageHeader`):
  - h1 = `--fs-display` 600 leading-tight. sub = `--fs-meta` mono `--faint` uppercase, 제목과 같으면 생략.
  - subtitle 문장 ≤ 60자.
- **chart tick**: `CHART_AXIS_TICK_STYLE` = `--fs-meta` · JetBrains Mono · `--faint`. 겹침 판정 문자 폭 `CHART_TICK_CHAR_PX` 8, tick 간 최소 간격 `CHART_TICK_MIN_GAP_PX` 8.
- glass 표면 위 라벨은 한 step 무겁게 (600) — 투명도로 인한 명도 손실 보상.

### 5.3 카피 규칙 (Copy Rules)

- **문장보다 라벨.** "This shows… / counts every…" 금지 — 숫자나 명사로 시작.
- **길이 cap**:

| 텍스트 | cap | 테스트 |
|--------|-----|--------|
| card title | ≤ 24자 | `outcomes.screen-render` → `COPY_CAP.title` |
| header meta | ≤ 32자 | `COPY_CAP.meta` · `ui.card-layout.e2e` → `CAPPED_META` |
| KPI label | ≤ 24자 | — |
| KPI hint | ≤ 40자, 1줄 | — |
| footnote | ≤ 90자, 카드당 최대 1개 | `FOOTNOTE_CAP` (dashboard · improvement · wiki) |

- **cap 을 넘는 설명** → card header 의 focusable ⓘ (`CardInfo`)가 여는 drawer 로 옮긴다.
  - drawer 제목 = `infoLabel`: 기본 "How this is counted", 설정 용어집은 "About settings" (`model-config.jsx` → `SETTINGS_INFO_LABEL_MC`).
  - ⓘ 는 `aria-describedby` = 카드 제목. **hover-only `title` 로 정의를 숨기지 않는다.**
- **데이터는 고치지 않고 clamp 한다**: 요약 · 문서 제목 = 1줄 ellipsis + `title` (`ClampCell`) · 사유 · 제안 = 2줄 clamp (`ClampText`), 전문은 행 drawer.
- **header-meta slack**: 전체가 읽혀야 하는 header meta 는 header 텍스트를 1.1배 넓게 그려도 들어가야 한다 (`improvement.loop-output.e2e` · `outcomes.render-structure.e2e` → `TEXT_SCALE`).
  - 긴 형태는 caller 의 `<span title>` 에 둔다 — node meta 는 `CardHead` 가 title 을 달지 않는다 (예: `improvement.jsx` → `getLoopBasisI` = `{ text, title }`).

---

## 6. 표면 · 깊이 · 유리 머티리얼 (Surface · Depth · Glass)

### 6.1 4-Level Elevation (정본)

| Level | 토큰 | 쓰임 | Light | Dark |
|-------|------|------|-------|------|
| **sunken** | `--surface-sunken` | 홈 · `th` · 배지 shell · tabs track · 미니바 트랙 | 245 fill | 24 fill |
| **base** | `--surface-base` | 페이지 바탕 | 250 | 12 (가장 어두움) |
| **raised** | `--surface-raised` | 카드 · KPI · 사이드바 | 255 fill + 1px `--line`, **shadow 없음** | 28 fill + 1px `--line` + `--shadow-raised` + inset 하이라이트 |
| raised-2 (상태) | `--surface-raised-2` | 선택형 카드 hover/focus | raised + `--shadow-raised-2` + border `--faint` | 36 fill + `--shadow-raised-2` + inset |
| **overlay** | `--surface-overlay` | drawer · dialog · popover · toast | 255 fill + `--shadow-overlay` | 28 fill + `--shadow-overlay` |

- 5단계 이상 금지. overlay 는 그림자가 필수, raised 는 테마별로 다르다.

### 6.2 떠오름 채널 — blur 가 아니라 border · luminance

- **light**: `--surface` 250 < `--elev` 255. resting 카드 = 1px `--line` border 만 (border-first elevation, `base.css` → `.card` 주석).
  - hover/focus(raised-2) 는 fill 을 바꾸지 않고 `--shadow-raised-2` + border `--faint`. `--elev-2` fill 금지 (인버전).
- **dark**: shadow 가 거의 보이지 않으므로 휘도 step 이 주채널 — raised 28 → raised-2 36. shadow 는 보조.
- **상단 inset 하이라이트**: dark 전용 — `.card` 는 `inset 0 1px 0` `--glass-border` 0.06, `.sub-card` 는 0.04. 순백 fill 위 흰 선은 비가시라 light 에 넣지 않는다.

### 6.3 backdrop-filter — 허용 / 금지

- 단일 규칙: **blur = transient · light-dismiss 전용. 상시 정보 표면 = 불투명.**

**허용 (ALLOW)**

- overlay scrim: `.detail-overlay` · `.modal-backdrop` 의 "smoke" (`blur(8px)` + 0.35 black). `@supports (backdrop-filter)` 이고 `prefers-reduced-transparency: no-preference` 일 때 기본 적용, 그 외엔 솔리드 0.42.
- 열린 drawer/fullscreen 위 confirm 스택 = blur 2겹 — 허용 상한. 3겹째 금지.
- 떠 있는 chrome 1개 (dev-only `.twk-panel`, §3.5).
- 사이드바는 본문과 겹치지 않는 별도 grid 컬럼 → blur 불필요, 불투명 유지.

**금지 (FORBID)**

- 테이블/리스트 row 개별 blur (`.tbl tbody tr` · `.alarm-row`): row 마다 컴포지팅 레이어 → 스크롤 frame drop.
- KPI 그리드 일괄 blur (`.kpi` ×N): GPU 예산 초과 + 카드끼리 뭉개짐.
- severity 요소(`.alert-card` · `Badge`/`.pill` · `.alarm-row`) 위 blur: desaturation.
- 폼 필드, 실시간 차트 · 로그 스트림 위 정적 glass.

**Anti-pattern 체크**: AP-1 모든 카드 blur · AP-2 scrim 없는 raw glass 위 텍스트 · AP-3 동적 콘텐츠 위 glass · AP-4 dark 휘도 보상 없는 glass · AP-5 `prefers-reduced-transparency` fallback 누락 · AP-6 severity 색 dilution · AP-7 blur 3겹 이상 · AP-8 border 없는 glass.

### 6.4 Glass 를 쓸 때의 필수 4종 세트

1. **Scrim**: 텍스트가 얹히면 그 뒤에 `rgb(var(--elev) / 0.85)` 이상 면 — 4.5:1 확보.
2. **Border**: `1px solid` `--glass-border` 0.15 — 경계가 blur 에만 의존하지 않게.
3. **dark 보상**: fill 불투명도 ↑ (`--material-glass-alpha` 0.82), 휘도 step 확보.
4. **Fallback**: `@media (prefers-reduced-transparency)` 로 불투명 대체 (§9.3).

### 6.5 기타 표면 · z stack

- **`.sub-card`** (`SubCard`): 중첩 섹션 · 메트릭 타일. radius `--radius-tile` 8 · padding 16 · ring = `box-shadow 0 0 0 1px` `--line` (box model 무영향) · 그림자 없음 · dark 는 inset 0.04 추가. 면 = `bg-elev` 또는 `sunken`.
- **`.popover-panel`** (`Popover`): non-modal.
  - 트리거 아래 우측 정렬 (`top: calc(100% + 4px)`), min 240 · max min(360px, 100vw − 32px) · max-h 60vh · padding 12.
  - `--overlay-surface` + 1px `--line` + `--radius-card` + `--shadow-overlay`.
  - z = overlay − 1 → 열린 `DetailSurface` 가 덮는다. 열려 있는 동안만 카드가 overflow 를 푼다 (`.card:has(.popover-panel)`).
- **`.save-banner`**: sticky bottom dirty-state 바. 불투명 `--elev` + 상단 1px `--line` + `--shadow-overlay` · z 10 · padding 12px 20px.
- **`.doc-toast`**: fixed 우하단 24px · `--radius-tile` · `--fs-body` · `--shadow-overlay` · max-w 480. tone fill 은 §4.2 예외.
- **z stack** (`tokens.css` → `--z-overlay` 주석, 테마 무관):

| z | 레이어 |
|---|--------|
| 1 | sticky `th` (`STICKY_TH_STYLE`) |
| 10 | `.save-banner` |
| 99 (`--z-overlay` − 1) | `.popover-panel` |
| 100 `--z-overlay` | `.detail-overlay` · `.modal-backdrop` · `.skip-link` |
| 150 `--z-confirm` | drawer/fullscreen 위 confirm (`.detail-overlay.detail-confirm`) |
| 200 `--z-toast` | `.doc-toast` |
| 2147483646 | `.twk-panel` (dev-only, 스택 밖) |

---

## 7. 컴포넌트 가이드 (Component Guide)

- 기준은 `window.UI` atom (§3.3). 화면은 atom 을 조합하고, class 를 직접 쓸 때도 아래 규칙을 따른다.
- 컴포넌트 = 7 속성 (BG / Text / Padding / Radius / Shadow / Hover / Purpose).
- state layer (hover/focus/active alpha) 구체값은 dev-front State Layers SSoT. 본 문서는 표면 · 깊이 · 치수 규칙을 정의한다.

### 7.1 Card — `Card` · `CardHead` · `CardInfo` (`.card*`)

- **anatomy**: flex column — head(고정) · body(남은 높이) · foot(하단 고정).
  - `.card`: `--elev` fill · 1px `--line` · `--radius-card` 12 · `overflow: hidden` · light 는 shadow 없음 · dark 는 `--shadow-raised` + inset.
  - `.card-head`: 한 줄 · min-height `--card-head-h` 48 · padding `4px` × `--card-pad` · gap 8×12 · 하단 1px `--line`. 컨트롤이 안 들어갈 때만 wrap.
  - `.card-body`: padding `--card-pad` 16 · `flex: 1 1 auto`. `max-height: 70vh` 내부 스크롤은 **혼자 놓인 무크기 또는 L 카드에만** — stretched row · S · M 카드는 스크롤 없이 자란다. `.flush` = padding 0.
  - `.card-foot`: `margin-top: auto` 로 하단 고정 · min-height `--row-h` 40 · `--fs-meta` `--dim` · 상단 1px `--line`. 내용은 `Show all N` · `Other` · footnote 1줄 중 하나.
- **head 내용**:
  - title (`.card-title`, h2): `--fs-title` 600 · -0.005em · ellipsis.
  - meta (`.card-sub`): `--fs-meta` · `--dim` · Pretendard · 1줄 ellipsis. 문자열 meta 는 `CardHead` 가 `title` 툴팁을 단다.
    - `contain: inline-size` → 컨트롤이 wrap 되기 전에 meta 가 먼저 ellipsis. `.is-wrap` 는 구조적/인터랙티브 meta 의 opt-out.
  - ⓘ (`CardInfo`): `btn ghost sm icon` 32×32 · `aria-label` = `infoLabel` (기본 "How this is counted") · `aria-describedby` = 제목 id · `aria-haspopup="dialog"` · `DetailSurface` drawer 를 연다.
  - actions: 우측 정렬 (ⓘ → 컨트롤 순).
- **S/M/L slot** (`CARD_SLOTS`, `getSlotRows`):

| Size | visible rows | chart plot | 쓰임 |
|------|--------------|-----------|------|
| S | 5 | 160px | ≤ 5 항목 · 단일 stat + bar set |
| M | 8 | 220px | 기본 목록 · 차트 |
| L | 12 | 300px | 화면의 1차 ledger |

  - 한 행의 peer 는 같은 slot 을 공유 → 끝선 일치 (두 M 목록 = 8 × 40 + 40 foot).
  - `getSlotRows` 가 slot 의 row budget 으로 자르고 숨긴 개수를 돌려준다 → foot 의 `Show all N` / `Show top N` 이 제자리에서 토글.
- **raised-2**: 선택형 카드만 (`.card.raised-2:hover` · `.card.is-focused`) — §6.1. 120ms `border-color` · `box-shadow`.
- **blur 금지.**

### 7.2 KPI — `KPI` · `KpiValue` (`.kpi*`)

- `.kpi`: `<button>` · `--elev` · 1px `--line` · `--radius-card` · padding 14px 16px · min-height 110 · hover border `--faint` 120ms.
- `.kpi-label`: `--fs-meta` `--dim` 500. hint: `--fs-meta` mono `--faint`.
- `.kpi-value`: `--fs-kpi` 32 mono 600 · -0.025em · line-height 1.15. `.unit`: `--fs-title` 16 `--dim` 500 Pretendard (2:1).
- `.kpi-delta`: `--fs-meta` mono · up = `--crit` · down = `--ok` · flat = `--faint` (`Delta inverse` 로 의미 반전).
- `.kpi-spark`: 68×26 sparkline, 우하단, opacity 0.85.
- 그리드 일괄 blur 금지 (AP-1). 값 변동 애니메이션은 출하되지 않았다 (§8.2).

### 7.3 Badge — `Badge` · `Pill` (`.pill*`)

- **neutral shell 하나** (모든 role · tone 공용): `--sunken` bg · `--dim` text · 1px `--line` · min-height 22 · padding 3px 8px · `--radius-badge` 6 · `--fs-meta` · 500 · Pretendard · nowrap.
- tone 은 내부 glyph/Icon 에만 (§4.2). `Pill` 은 `Badge` 로 위임 (neutral → metadata, 그 외 → status `glyph` false).
- 변형:
  - `.pill--absent`: 투명 · `--faint` · dashed `--line`.
  - `.pill--meta`: 소문자. `.pill--count`: mono tabular.
  - `.pill--ctl-h`: 같은 행 `.field` 와 높이 맞춤 (`--ctl-h`).
  - `.pill--interactive`: `<button>` · min-height `--ctl-min-h` · min-width 24 · pressed = selected fill.
  - `.pill--icon-only`: 정사각, 의미는 aria-label/title.
- glass 위에 올리지 않는다 (AP-6).

### 7.4 Button — `.btn`

- base: padding 6px 12px · min-height `--ctl-min-h` 32 · `--radius-control` 6 · `--fs-control` 14 · 500 · `--elev` fill · 1px `--line` · transition 120ms.
- hover: `--sunken` + border `--faint`.
- `.primary`: `--ink` fill + `--surface` text. `.danger`: `--crit` fill + white text. `.ghost`: 투명 · `--dim` → hover `--sunken` + `--ink`.
  - `.danger` 명암비: light 4.83 · **dark 2.77 (< 4.5, 수정 대상)** — dark `--crit` 248 113 113 위 흰 글자.
- `.sm`: padding 4px 9px · `--fs-meta`. `.icon`: 32×32 정사각, padding 0.
- disabled: opacity 0.5 · `not-allowed`. pressed (`aria-pressed="true"`) = `--selected-fill` / `--selected-ink`.
- 120ms 가 hover 표준 속도. glass 불필요.

### 7.5 Table — `Table` · `TableHead` · `ClampCell` · `ClampText` (`.tbl`)

- `.tbl`: `--fs-control`. cell padding 9px 14px · 하단 1px `--line`.
- `th`: `--fs-meta` · uppercase · 0.04em · 500 · `--dim` on `--sunken`. `TableHead` 는 `scope="col"` 을 단다.
- sticky head (`isHeadSticky` → `STICKY_TH_STYLE`): 불투명 `--elev`, z 1 — 스크롤 시 본문을 가리지 않게.
- `td`: height `--row-h` 40.
- `.num`: mono · 우측 정렬 · nowrap.
- clamp: `.cell-clamp` = 1줄 + `title` · `.clamp-2` = 2줄 + `title` + drawer 전문.
- row: cursor pointer · hover `--sunken` · 마지막 행 border 없음.
- 그룹 행: `.is-grouped` 라벨 행 + `.row-desc` 전폭 설명 행 = 한 논리 행. hover 는 둘을 함께 밝힌다.
- caption: 기본 sr-only, `isCaptionShown` 이면 section-label 스타일.
- **row blur 금지.**

### 7.6 Tabs · Segmented — `Tabs` (`.tabs`/`.tab`) · `.seg`

- `.tabs`: `--sunken` track · 1px `--line` · `--radius-control` · padding 3 · gap 2.
- `.tab`: padding 4px 11px · min-height 32 · `--fs-meta` · `--dim` · 500 · `--radius-inline`.
- `.seg`: `--elev` · 1px `--line` · `--radius-control` · clip. 버튼 padding 5px 10px · min-height 32 · `--fs-meta` · `--dim` · 사이 1px `--line`.
- **filled selected 상태는 하나**: `.tab.active` · `[aria-selected]` · `.seg button.active` · `[aria-pressed]` · `.btn[aria-pressed]` · `.pill--interactive[aria-pressed]` 모두 `--selected-fill` / `--selected-ink` · 500.
- `.seg` focus ring 은 inset (`outline-offset` = −ring width) — `.seg` 가 자식을 clip 하므로.

### 7.7 Sidebar — `.shell-sidebar` · `.nav-item`

- 폭 220px. **< 1200px 에서 56px icon rail**: 라벨은 제거하지 않고 clip (`.rail-hide`) → 접근 이름 유지. 첫 배지는 우상단, 나머지 배지는 clip.
- 면: `bg-elev` 불투명 · `border-r` · sticky. glass 로 바꾸지 않는다.
- `.nav-item`: `--fs-control` · `--dim` · padding 6px 10px · `--radius-control` · Icon 14. hover/active = `--sunken` + `--ink`, active 500.
- `.nav-num`: mono `--fs-meta` `--faint` (active 는 `--dim`).
- `.nav-badge`: mono `--fs-meta` · `--sunken` · 1px `--line` · pill radius. 내용 = glyph + 값 + sr-only 설명 (`title` 동반). warn/crit tinted fill 은 §4.2 예외.
- liveness: 시스템 롤업 dot 는 ok 일 때만 `.live-dot`, 그 외 정적.

### 7.8 DetailSurface — drawer · fullscreen · confirm (`.detail-*`)

- 유일한 overlay 컴포넌트. `Modal()` 은 `variant="confirm"` 위임 alias.
- **variant**:

| variant | 배치 | 치수 | 진입 모션 |
|---------|------|------|-----------|
| `drawer` (기본) | 우측, 전고 | min(720px, 92vw) · 좌측 border 만 · ≤ 640px 에서 100vw 시트 | translateX 100%→0, 240ms `cubic-bezier(0.16,1,0.3,1)` |
| `fullscreen` | 중앙 | 100% × 100%, max-w 980 | opacity, 180ms ease-out |
| `confirm` | 중앙 소형 | min(560px, 92vw) · max-h 86vh · `--radius-card` | opacity + scale 0.97→1, 180ms ease-out |

- 면: `.detail-panel` = `--overlay-surface` 불투명 + `--shadow-overlay` + 1px `--line` (텍스트 대비 보장).
- head 14px 20px (`.detail-title` `--fs-title` 600 · `.detail-sub` `--fs-meta` `--faint`) · body 18px 20px · foot 12px 20px `--sunken`.
- **상호작용 계약**:
  - 닫기 3가지: X · Esc · backdrop.
  - focus trap: 진입 포커스 + Tab 순환 + 닫힐 때 트리거로 복귀.
  - 배경 `inert` + body scroll-lock.
  - 가장 나중에 열린 surface 가 키보드를 소유 (drawer 위 confirm).
  - `nav` 제공 시 foot 에 Prev/Next + Arrow 키.
- **scrim**: 솔리드 `rgba(0,0,0,0.42)` 가 기본, smoke 는 조건부 (§6.3 · §9.3). z: §6.5.
- `.modal` / `.modal-backdrop` class 는 `clauded-docs.jsx` 의 다이얼로그 1곳에만 남아 있다. 새 다이얼로그는 `DetailSurface` 로.

### 7.9 Alarm row · Alert card — `.alarm-row` · `.alert-card`

- **`.alarm-row`**: flat hairline 행 — grid (glyph · 본문 · 액션) · gap 12 · padding 12px 16px · 하단 1px `--line`. tone 은 선행 glyph 색에만 (`data-tone`). stripe · tinted fill 없음.
- **`.alert-card`**: glyph well 카드 — grid (well · content · actions), padding 12px 16px.
  - well: 32×32 `--radius-tile` · `.is-inset` 이면 24×24 `--radius-control`. 채움 규칙 §4.2.
  - content: gap 4 · title line-height 20 · body max 72ch.
  - container query (≤ 36rem): 액션이 content 아래로 내려간다.
  - 진입 150ms opacity (`detailFade`), reduced-motion 시 정지.
- 둘 다 불투명 면 위, blur 금지.

### 7.10 Empty state — `EmptyState` (`.placeholder`)

- `.placeholder`: dashed `--faint` 0.5 · `--radius-tile` · padding 28 · `--faint` mono `--fs-meta` · 가운데 정렬.
- `EmptyState`: message 1줄 (원인) + 선택 hint (다음 단계) + 선택 action (재시도 버튼).
- 가짜 SVG 일러스트 · 더미 데이터로 채우지 않는다. 실 자산은 사용자에게 요청.

### 7.11 레이아웃 — `SplitRow` · `SplitColumn` · `TileSplit` · 간격 그리드

- **`SplitRow({ ratio = '1:1', layout = 'equal' })`**:
  - ratio: `1:1` · `2:1` 만 (`SPLIT_ROW_RATIOS`). 미지 값은 1:1 로.
  - layout: `equal`(기본, peer 높이 맞춤) · `content`(opt-in — rail 컬럼과 peer 가 아닌 행). 미지 값은 equal 로.
  - < 1280px 세로 스택 · ≥ 1280px 나란히 · gap 16.
  - wrapper 로 감싼 카드도 stretch 높이를 물려받는다. 접힌 fold(`.is-collapsed`)는 header 높이를 유지하고 늘어나지 않는다.
  - stretch 유효 조건과 해법 (a)→(b)→(c): §1 의 6) — `STRETCH_FLOOR` 0.75.
  - 알려진 예외: `cost` 의 lg 2fr/1fr override.
- **`SplitColumn({ isRail })`**: 한 컬럼의 카드 스택, gap 16. `isRail` → ≥ 1280px 에서 top 24 sticky.
- **`TileSplit`**: 타일 내부 lead | detail — 641–1279px 에서 2열, 그 외 세로.
- **간격 · radius · breakpoint**:

| 항목 | 값 |
|------|----|
| main padding | 24 (`<main>` `p-6`) |
| card gap · section gap | 16 (`.gap-card` · `.space-cards`) · 24 (`.gap-section` · `.space-sections`) |
| card 내부 | `--card-pad` 16 · head 48 · row 40 |
| radius role | inline 4 < control 6 < tile 8 < card 12 · badge 6 |
| SplitRow 나란히 | ≥ 1280px |
| sidebar rail | < 1200px |
| TileSplit 2열 | 641–1279px |
| drawer 전면 시트 | ≤ 640px |

- 한 view 에서 radius family 를 섞지 않는다 — 역할로만 스케일.

### 7.12 Disclosure · Popover

- **`Disclosure({ kind, title, sub, tone })`**: `.card` 위 fold.
  - header = `DisclosureButton` (chevron 14 · `aria-expanded` · min-height 32) — 제목 500 `--ink` + sub `--fs-meta` `--faint`.
  - 열림 규칙: §1 의 4).
- **`Popover({ label, title })`**: 트리거 = `btn ghost sm` (`aria-haspopup="dialog"` · `aria-expanded`). 패널 `role="dialog"`.
  - non-modal: inert · scroll-lock · trap 없음.
  - Esc 또는 바깥 press 로 닫힘, 포커스는 트리거로 복귀. 치수는 §6.5.

### 7.13 폼 · diff · 기타 atom

- **`.field`** (input · select):
  - min-height `--ctl-h` 32 · padding `--ctl-pad-y` × `--ctl-pad-x` · `--ctl-font` · `--elev` · 1px `--line` · `--ctl-radius`.
  - hover border `--faint`. focus = `--accent` border + 전역 focus outline. error `.is-error` = `--crit` border (메시지는 `--fs-meta` crit 텍스트).
  - disabled opacity 0.5.
  - `.field--mono`: mono tnum. `.field-select`: 테마별 `--faint` 색 chevron.
  - `.field-affix` (`$` 등): wrapper 가 border · focus 를 소유, `:has(:focus-visible)` 로 outline.
- **`.diff-line`**: mono `--fs-meta` · `--add` / `--del` 은 `+`/`−` glyph(`--ok`/`--crit`) + 0.10 tint — glyph 가 1차 신호.
- **`.stage-pip`**: 8px 원 · 빈 pip `--pip-empty` · 채움 `--ink`.
- **`.low-sample`** (`LowSampleMark`): 작은 표본 비율 옆 italic `--faint` `(n=N)`.
- **`.page-verdict`** (`PageVerdict`): glyph 가 tone, 단어 · 문장은 ink. chip 은 resting button chrome (`--elev` · `--line` · `--ink`), 맨 텍스트 금지.
- **`.section-label`** (`SectionLabel`): `--fs-meta` 600 uppercase 0.06em `--dim`, 실제 h2/h3.
- **`.skip-link`**: 첫 Tab stop, focus 시 화면 안으로.

### 7.14 System map — R2 two-column layout (`architecture.jsx`)

- **두 컬럼, 각각 위→아래**:

| 컬럼 | zone (위 → 아래) | 역할 |
|------|------------------|------|
| 좌 `map_col_sources` | Inputs (`entry`) → Daemons (`daemon`, 멤버는 선언 순서로 세로 스택) | 일을 시작하는 쪽 |
| 우 `map_col_pipeline` | Orchestrator → Agents → Safety (`hooks`) → Store (`data`) → Documents (`export`) | 일이 처리되는 spine |

- **배치** (`MAP.COL`, SVG 단위):
  - 컬럼 사이 gutter 80 · sources 컬럼은 Orchestrator 와 상단 정렬.
  - spine zone 사이 간격 `GAP.SPINE` 52 · 재스택 멤버 간격 `GAP.MEMBER` 24.
  - 컬럼당 frame 폭 하나 (가장 넓은 zone 기준).
- **edge**:
  - spine edge 4개 (assigns work · tool calls · saves results · renders stored content) — 직선 수직.
  - bus 2개: user → Orchestrator · Daemons → Orchestrator 가 gutter 중앙을 내려와 Orchestrator 좌측으로 진입. `_turn` id clone, `data-arch-edge="bus"`.
  - bypass 1개: "saves documents" (Agents → Store) 는 spine 오른쪽 60 lane (`BYPASS.LANE`), 라벨은 lane 오른쪽.
  - 총 link 7 · crossing 0 (`architecture.map-fit.e2e`).
- **spine label**: 각 라벨은 **자기 edge 의 오른쪽**, edge 와 `LABEL_PAD` 16 · 다른 edge 와 ≥ 16.
  - r10 방향 문서의 "왼쪽 gutter lane" 과 다른 as-built 배치 — owner 확인 대기.
- **크기**: arrowhead 2× (`ARROW_SCALE`).
  - default view = contain fit 의 `DEFAULT_VIEW_SHARE` 0.9.
  - map pane 높이 floor 500px (`PANE.FLOOR_PX`) — 첫 화면 높이가 모자라면 floor 가 이기고 Part health 는 첫 화면 아래로.
  - zoom 컨트롤용 우측 inset ≥ 48px (`CONTROLS_MIN_INSET_PX`) — 컨트롤 아래 box 0개.
  - default view 의 모든 라벨 ≥ 13px (1024 에서 13.49px 측정).
- **Tab 순서**: sources 컬럼 위→아래, 그다음 spine 위→아래 (`data-arch-rank`).

---

## 8. 모션 (Motion — 절제된 라이브 마이크로 인터랙션)

- **상시 ambient 루프는 하나**: `.live-dot` (1.6s `liveBlink`, opacity 1→0.35) — 사이드바 시스템 롤업이 ok 일 때만.
  - `.pulse-ring` 은 `tokens.css` 에 정의만 있고 소비처가 없다 — 쓰지 않는다. 새 상시 루프 신설 금지.
- **로딩 표시 범주** (로딩 중에만 돈다):
  - skeleton pulse 1.4s ease-in-out: `skelPulseC`(cost) · `skelPulseO`(outcomes) · `skelPulseCD`(clauded-docs).
  - spinner: `.ga-spin` 0.9s (dashboard) · `.doc-action-spinner` 900ms (clauded-docs) · `.i-act-spin` 0.7s (improvement) · `RefreshButton` `motion-safe:animate-spin`.
  - 모두 reduced-motion 게이트 필수 (§8.4).

### 8.1 Motion hierarchy

- **primary — overlay 진입** (variant 별, 퇴장 모션 없음 — 즉시 닫힘):
  - drawer: `detailDrawerSlide` translateX 100%→0, 240ms `cubic-bezier(0.16, 1, 0.3, 1)`.
  - fullscreen: `detailFade` opacity, 180ms ease-out.
  - confirm: `detailPop` opacity + scale 0.97→1, 180ms ease-out.
  - alert-card: `detailFade` 150ms `cubic-bezier(0.2, 0, 0, 1)` (effects-fast).
- **secondary — hover 깊이**: `border-color` + `box-shadow` (+ `background`) 120ms — `.btn` · `.kpi` · `.card.raised-2` · `.field`.
- **ambient**: `.live-dot` 만.
- disclosure chevron 회전은 즉시 (transition 없음).

### 8.2 데이터 변경 신호

- 데이터 변경은 애니메이션하지 않는다 — 새 값은 제자리에서 다시 렌더된다.
- `base.css` 의 `@keyframes valueFlash` + `.kpi-value.updated` 는 정의만 있고 `.updated` 를 토글하는 코드가 없다 (미출하).
- 리스트 reorder transition · sparkline draw 애니메이션도 없다.
- 이 신호를 배선할 때는 effects 계열(opacity/color, overshoot 없음)로, §8.4 게이트 안에서.

### 8.3 타이밍 표준

- hover/state-change 120ms · alert 진입 150ms · fullscreen/confirm 진입 180ms · drawer 진입 240ms · ambient 1.6s · skeleton 1.4s · spinner 0.7–0.9s.
- informational 요소의 `animation: infinite` 는 `.live-dot` 과 로딩 표시 외 금지.

### 8.4 prefers-reduced-motion 계약 (필수)

- 모든 모션은 `@media (prefers-reduced-motion: reduce)` 게이트를 갖는다. 출하된 reduce 범위:
  - `base.css` 블록 1: `.live-dot` 정지(opacity 0.8) · `.pulse-ring::after` · `.kpi-value.updated` · `.alert-card` 애니메이션 정지 · `.card.raised-2` / `.is-focused` transition 제거.
  - `base.css` 블록 2: `DetailSurface` 3 variant 진입 `animation-duration: 0.01ms`.
  - `base.css` 블록 3: `.field` · `.field-affix` transition 제거.
  - 화면별: `.ga-spin` · `.doc-action-spinner` · `.doc-group-toggle .chevron` · `.tbl.doc-ledger-busy` · `[class*="i-anim-"]` · `.i-act-spin` · architecture 노드 · `.arch-zoom-btn`.
- **위반 (코드 수정 대상)**: inline style skeleton 3개 — `cost.jsx` `skelPulseC` · `outcomes.jsx` `skelPulseO` · `clauded-docs.jsx` `skelPulseCD` — 에 reduce 게이트가 없다.

```css
@media (prefers-reduced-motion: reduce) {
  .live-dot { animation: none; opacity: 0.8; }
  .alert-card { animation: none; }
  .card.raised-2:hover, .card.is-focused { transition: none; }
  .detail-drawer .detail-panel, .detail-fullscreen .detail-panel, .detail-confirm .detail-panel { animation-duration: 0.01ms !important; }
  .field, .field-affix { transition: none; }
}
```

---

## 9. 접근성 & 성능 가드레일 (A11y & Performance)

### 9.1 WCAG (검증 가능 항목)

- 본문 텍스트 ≥ **4.5:1**, large-text (≥ 18.66px bold · ≥ 24px) ≥ 3:1, UI · glyph ≥ 3:1. AAA (7:1) 권장. 모든 면(`--elev-2` 포함)에서 측정 — §4.1 표.
- 투명 표면 위 텍스트는 렌더된 합성(glass + 실배경) 기준, 가장 불리한 배경에서 측정. glass 위 텍스트엔 scrim (`rgb(var(--elev) / ≥0.85)`).
- `cat-2` / `cat-4` 는 text 색 금지.
- **hit target**: 모든 인터랙티브 atom 의 최소 높이 `--ctl-min-h` 32px. 절대 하한 = WCAG 2.2 §2.5.8 24×24 (`.pill--interactive` min-width 24 · ≤ 640px drawer head 버튼 ≥ 24).
- **focus 표시 하나**: `:focus-visible` (및 `[data-focus-handoff]:focus`) = `outline` `--focus-ring-width` solid `--focus-ring` + `--focus-ring-offset`. box-shadow ring 금지.
  - `.seg` 버튼은 inset ring. `.field-affix` 는 `:has(:focus-visible)` 로 wrapper outline. `outline: none` 은 대체 표시가 있을 때만.
- skip link: 첫 Tab stop → `#main-content`.
- ⓘ 정의는 버튼 + `aria-describedby`, hover-only 금지. tone glyph 는 aria-hidden 이고 단어는 sr-only 로 (`StatusDot` · nav badge).
- 키보드: overlay 는 focus trap + 트리거 복귀 (§7.8). 테이블 행 · chip 은 roving focus 헬퍼 (`getRovingIndex` · `getRowFocusProps`).

### 9.2 backdrop-filter 성능 예산

- **뷰포트당 동시 backdrop-filter ≤ 2** — drawer/fullscreen 위 confirm 스택이 상한. 스크롤 리스트 아이템엔 금지.
- blur radius ≤ 12px (`--glass-blur`). production overlay scrim = 8px.
- 각 backdrop-filter 는 새 GPU 컴포지팅 레이어 + 스크롤마다 repaint → 상시 표면에 쓰지 않는다.

### 9.3 prefers-reduced-transparency 계약

- 솔리드가 기본, glass 는 조건부로 얹는다 (fallback-first). 모든 glass 선언에 솔리드 fallback.

```css
.modal-backdrop, .detail-overlay { background: rgba(0,0,0,0.42); }   /* 솔리드 기본 */
@supports (backdrop-filter: blur(1px)) {
  @media (prefers-reduced-transparency: no-preference) {
    .modal-backdrop, .detail-overlay { background: rgb(0 0 0 / 0.35); backdrop-filter: blur(8px); }
  }
}
@media (prefers-reduced-transparency: reduce) {
  .glass-surface { background: rgb(var(--elev)); backdrop-filter: none; }
}
```

---

## 10. 일관성 체크리스트 (Consistency Checklist)

모든 monitor 디자인/구현 작업은 아래를 만족한다.

**토큰**
- [ ] 새 hue 를 발명하지 않았다 — 신규 색은 warm-stone 팔레트에서 도출한 kind A triplet, alpha 는 사용처 합성.
- [ ] font-size 는 `--fs-*` 토큰만, px 리터럴 없음. radius 는 role 토큰.
- [ ] shadow 는 `--shadow-*` 만 (Tailwind `shadow-card`/`shadow-float` · 하드코딩 금지).
- [ ] 토큰을 바꾸면 `tokens.css` 와 본 문서 §3 블록을 같은 변경에서 고쳤다.

**타이포 · 카피**
- [ ] 렌더 텍스트 13px 미만 없음 (map default view · tweaks 패널 포함).
- [ ] copy cap: card title ≤ 24 · header meta ≤ 32 · KPI label ≤ 24 · KPI hint ≤ 40 (1줄) · footnote ≤ 90 (카드당 1).
- [ ] cap 초과 설명은 ⓘ drawer 로 — hover-only `title` 아님.
- [ ] 데이터 텍스트는 clamp, 고쳐 쓰지 않음.
- [ ] 전체가 읽혀야 하는 header meta 는 텍스트 1.1배에서도 들어간다. 긴 형태는 caller span 의 `title`.
- [ ] 수치는 mono tnum, 값:단위 2:1 (KPI 32/16).

**레이아웃 · 카드**
- [ ] card head 는 한 줄 48px. 긴 설명은 ⓘ.
- [ ] `SplitRow` 는 `1:1`/`2:1`, layout 은 의도대로 (`equal` 기본 · rail/non-peer 는 `content`).
- [ ] peer 행 stretch 는 ≥ 75% 일 때만. 아니면 row budget → condensed S → re-pair, filler 금지.
- [ ] 목록은 S/M/L slot 의 row budget + `Show all N` foot. stretched 행 안 중첩 스크롤 없음.
- [ ] 아이콘은 `Icon`(Lucide) 으로만.

**색 · severity**
- [ ] severity = glyph + 색 + 단어. tone 은 glyph 에만 — shell · stripe · fill · border 아님.
- [ ] severity 요소를 glass/blur 위에 올리지 않았다.
- [ ] `--cat-*` 는 분류(차트)에만, cat-2/4 text 금지.
- [ ] focus 는 `--focus-ring`, `--accent` 아님.

**유리 · 깊이**
- [ ] backdrop-filter 는 transient(overlay scrim · 떠 있는 chrome)에만.
- [ ] 상시 표면(card · kpi · tbl · alarm-row · alert-card · sidebar)은 불투명.
- [ ] 뷰포트당 backdrop-filter ≤ 2, blur ≤ 12px.
- [ ] light raised = border 만, shadow 는 raised-2 · overlay 부터. light raised-2 에 `--elev-2` fill 없음.
- [ ] dark 떠오름은 휘도 step.
- [ ] glass 표면에 scrim + border + dark 보상 + reduced-transparency fallback.

**모션**
- [ ] 상시 루프는 `.live-dot` 하나. 로딩 표시는 로딩 중에만.
- [ ] 모든 모션(inline style 포함)에 `prefers-reduced-motion: reduce` 게이트.
- [ ] 타이밍: hover 120 · alert 150 · fullscreen/confirm 180 · drawer 240ms.

**접근성 · 성능**
- [ ] 본문 텍스트 ≥ 4.5:1, UI · glyph ≥ 3:1 — 모든 면에서.
- [ ] glass/투명 표면 위 텍스트는 합성 대비를 가장 불리한 배경에서 light · dark 양쪽 실측해 기록했다 (토큰 self-attestation 아님).
- [ ] 인터랙티브 atom 높이 ≥ `--ctl-min-h` 32, 절대 하한 24×24.
- [ ] 보이는 focus outline 하나, `outline: none` 은 대체 표시와 함께만.

**슬롭 금지**
- [ ] 더미 섹션 · 발명 통계 · lorem 채움 · 가짜 SVG 일러스트 없음 (빈자리는 `EmptyState` 또는 레이아웃).
- [ ] aggressive 그라데이션 · beige/peach 캔버스 기본값 · 순백(#fff) dark 텍스트 없음.

---

## 11. AI Model Guidelines (MCP / Codegen 소비 규칙)

- Figma Make · MCP-fed coding agent 가 이 문서를 소비할 때의 규칙. 자동 생성 레이아웃은 본 철학 검토 없이 머지 금지.
- **스택 사실 (코드 생성 전 필수)**:
  - Tailwind CDN-JIT + 런타임 `tailwind.config` 객체. Tailwind v4 `@theme` / Oxide / OKLCH 가 **아니다** → `@theme` 자동 토큰 · `text-[var(…)]` 색 파싱 가정 불가.
  - JSX 는 esbuild 로 precompile — `public/src` 를 고치면 `npm run build:jsx`.
  - UI 는 `window.UI` atom 으로 생성 (`Card` · `CardHead` · `SplitRow` · `DetailSurface` · `Badge` · `Table`/`ClampCell` · `KPI` · `EmptyState`). `.glass-surface` · `.card-raised` · `.elev-overlay` 는 소비처 없는 예약 class — 생성하지 않는다.

**Non-negotiable**

- warm-stone 팔레트 + `tokens.css` 토큰. 새 hue 금지. 새 색 토큰은 kind A triplet.
- type 은 `--fs-*` 토큰만, 13px floor, px 리터럴 금지.
- copy cap (title 24 · meta 32 · KPI label 24 · hint 40 · footnote 90) · 초과분은 ⓘ drawer.
- `SplitRow` ratio 는 `1:1` / `2:1` 만.
- tone 은 glyph 에만 — shell · stripe · fill · border 금지. severity = glyph + 색 + 단어.
- focus 는 `--focus-ring` outline, `--accent` 아님. 인터랙티브 atom 높이 `--ctl-min-h`.
- 상시 표면 불투명, backdrop-filter 는 transient 전용 (≤ 2 · ≤ 12px).
- light raised = border 만 · light raised-2 = shadow (`--elev-2` fill 금지) · dark raised-2 = `--elev-2`.
- 모든 glass 에 reduced-transparency fallback, 모든 모션에 reduced-motion 게이트.

**Flexible**

- `--glass-blur` (8–12px) · `--material-glass-alpha` (light 0.7–0.8 / dark 0.8–0.85).
- 카드 slot 선택 (S/M/L) · `SplitRow layout` 선택 (근거: peer 여부).
- overlay 진입 easing (effects 계열, overshoot 없음).

**Bad examples (생성 금지 앵커)**

- ✕ `.kpi { backdrop-filter: blur(16px); }` — 상시 KPI 그리드 일괄 blur (AP-1 · 성능 · 뭉개짐).
- ✕ `.alarm-row[data-tone="crit"] { background: rgb(var(--crit) / 0.12); backdrop-filter: blur(10px); }` — tone 을 행 fill 에 칠하고 severity 위 blur (AP-6).
- ✕ `<span className="pill" style={{ background: 'rgb(var(--warn) / 0.15)' }}>` — tone 을 배지 shell 에 칠함. `Badge role="status" tone="warn"` 로.
- ✕ `.card-sub { font-size: 12px; }` — floor 아래 px 리터럴.
- ✕ light 모드 `.card:focus { background: rgb(var(--elev-2)); }` — 252 < 255 휘도 인버전 (§6.2).
- ✕ 빈 카드를 발명 통계("99% faster") · 더미 차트로 채우기 (슬롭).

---

### Research references (synthesized)

- Axess Lab — *Glassmorphism Meets Accessibility* (blur-on-dynamic-bg · 4.5:1 실패 · reduced-transparency fallback).
- Microsoft Learn (Fluent) — *Materials in Windows apps* (Acrylic transient / Mica 불투명 / Solid 상시 — §6.3 근거).
- Create with Swift — *Legibility & contrast in visionOS*.
- Infinum — *iOS 26 Liquid Glass* (1.5:1 실측 · severity desaturation 경고).
- Orizon — *Glassmorphism in 2026* ("never body text on raw glass" · ≤ 2 blur layers).
- Design Systems Surf · Atlassian Elevation · Muzli (dark 는 그림자 대신 surface color step · 4단계 elevation).
- Matuzo — *prefers-reduced-transparency* (fallback 패턴).
- Smashing — *UX for Real-Time Dashboards* (≤ 5 focal/zone).
- Feature-Sliced Design — *Design Token Architecture* (primitive → semantic → component).
- Payload 3 admin · Strapi 5 content manager · PatternFly card sizing (Quiet Ledger referent · S/M/L slot).
- Atrium (architecture) — glass-roofed central void · diffuse top-light · layered galleries (movement 근거).
