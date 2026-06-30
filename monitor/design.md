# Atrium Monitor — Design System SoT

> Atrium Monitor 의 시각 언어(Visual Language) Source-of-Truth.
> 기존 `public/styles/tokens.css` + `public/styles/base.css` 가 **baseline** 이다. 본 문서는 그 위에 **additive** 로만 확장하며, 기존 토큰명을 rename/delete 하지 않는다.
> 구현 스택: React 18 + Tailwind(CDN JIT) + CSS custom-property(`rgb(var(--token) / <alpha>)`) 규약.
> 용어는 영어 토큰/CSS 원형 유지, 설명은 한국어.

**Movement name — "Daylight Atrium"**: 건물 아트리움이 유리 지붕(glass roof)으로 위에서 빛을 받아 중앙 보이드(central void)를 가장 밝고 명료한 면으로 만들고, 주변 갤러리는 그 보이드를 가리지 않고 층층이 물러나며 정렬되는 구조 — 이것을 데이터 밀집 대시보드의 시각 원칙으로 번역한다. "Glass" 는 표면마다 blur 를 바르는 장식이 아니라, **빛·개방감·구조적 명료성의 에토스**다. 투명도는 일시적(transient) 표면에만, 그것도 가독성·성능·명암비 근거를 동반할 때만 쓴다.

---

## 1. 디자인 철학 (Design Philosophy)

Atrium Monitor 는 self-improving 멀티에이전트 하니스의 상태를 실시간으로 읽는 **운영 계기판(operator instrument)** 이다. 사용자는 "예쁜 화면" 이 아니라 "지금 무엇이 위험한가" 를 1초 안에 판독하려고 들어온다. 따라서 시각 언어의 최우선 목적은 **판독 속도(legibility-at-a-glance)** 이고, 미감은 그 목적에 종속된다. 물리 아트리움의 다섯 가지 공간 특성을 다음과 같이 UI 원칙으로 옮긴다.

**1) 중심 명료 영역 (Central Clarity Zone).** 아트리움의 유리 지붕은 중앙 보이드를 공간에서 가장 밝은 면으로 만든다. UI 에서는 각 화면의 본문 데이터 면(카드 그리드 · 차트 캔버스 · 테이블)이 그 보이드다. 사이드바·헤더 같은 주변 chrome 은 `--dim`/`--faint` 톤으로 물러나고, 데이터 표면이 뷰포트에서 가장 밝고 선명한 plane 으로 읽혀야 한다. 현재 `app.jsx` 의 좌측 `aside`(`bg-elev` · `border-r`)는 이 "물러난 chrome" 의 자리이며, 본문 카드가 그보다 한 단계 위로 떠오른다.

**2) 가리지 않는 레이어드 깊이 (Layered Depth Without Occlusion).** 아트리움 갤러리는 중앙 보이드를 결코 가리지 않는다. UI 의 깊이는 **휘도 차(luminance delta) + 경계 정의(border)** 로 표현하지, 아래 레이어를 뭉개는 blur 로 표현하지 않는다. 사이드바=같은 평면/sunken, 카드=한 단계 위(raised), 모달/팝오버=두 단계 위(overlay). 어떤 레이어도 그 아래 정보를 흐려 가리지 않는다.

**3) 위에서 오는 확산광 (Diffuse Top-Light).** 아트리움은 위에서 들어온 빛이 상단 면에 부드러운 하이라이트를 남긴다. UI 에서는 떠오른 표면이 상단 1px inset 하이라이트(표면 fill 보다 밝은 선)와 base 대비 밝은 fill 로 "위의 유리 지붕에서 빛이 든다" 는 인상을 blur 없이 만든다. 단, **이 채널은 테마·표면에 따라 다르게 적용**된다 — 라이트의 순백 카드(`--elev` 255)는 이미 천장이라 흰 하이라이트가 비가시이므로 그림자/경계로 대체하고, 다크 카드는 하이라이트가 가시이며 휘도 step 으로 떠오름을 만든다(구체 규칙 §6.2 / §7.1).

**4) 숨 쉴 공간 (Airy Breathing Room).** 아트리움이 넓게 느껴지는 이유는 꽉 채우지 않기 때문이다. UI 는 일관된 20~24px 카드 padding(기존 `.card-body` 20px · `.card-head` 16×20 정합), 그리드 아이템 간 의도적 여백, 한 뷰포트 zone 당 5개 이하의 1차 초점 요소로 호흡을 만든다. 밀도는 여백을 죽여서가 아니라 sparkline·미니 서브컴포넌트·점진적 공개(progressive disclosure, `<details>` / drill-down)로 달성한다.

**5) 구조적 투명성 — 논리적이지 시각적이지 않다 (Structural, not Visual, Transparency).** 유리 건축의 투명성은 "안에서 건물의 조직을 추론할 수 있음" 이다(층·출구·용도 zone 이 한눈에 읽힘). UI 의 등가물은 **배치·타이포 위계·색 코딩으로 정보 위계가 첫눈에 읽히는 것** — 어떤 glassmorphic 효과보다 먼저 충족돼야 한다. 좌상단=가장 중요, 타이포 weight 등급, severity 색 코딩이 그 수단이다.

> 데이터 밀도와의 화해(Reconciliation): 투명도/blur 는 "유리 지붕 순간" — 오버레이·모달·flyout·(있다면) 떠 있는 chrome — 에만 건축적으로 정당하다. 상시 정보 표면(테이블·KPI 그리드·alert row·차트)은 불투명한 면 위에 머문다. 이것이 "편법 금지" 의 시각 언어 버전이다.

---

## 2. 디자인 원칙 (Design Principles)

각 원칙은 검증 가능한 기준을 동반한다. (연구 출처는 §9·문서 말미 참조.)

1. **Data-density first.** 한 화면의 존재 이유는 데이터다. 장식 요소가 데이터 표면의 명료성을 1px 라도 떨어뜨리면 제거한다. (Smashing — real-time dashboard: 한 zone 당 1차 초점 ≤ ~5.)

2. **Legibility is non-negotiable.** 모든 텍스트는 렌더된 실제 배경 대비 WCAG AA(본문 4.5:1 · large-text ≥18px 3:1)를 만족한다. 투명 표면 위 텍스트는 반드시 scrim 을 둔다(§6·§9). (Apple Liquid Glass 가 복잡 배경에서 1.5:1 까지 떨어진 실측 — 같은 함정을 피한다.)

3. **Restraint — 절제된 투명도.** glass/blur 는 **transient·light-dismiss·소수(뷰포트당 1~2)** 표면에만. 상시 표면은 불투명. "모든 카드에 backdrop-blur" 는 금지. (Microsoft Fluent: Acrylic 은 transient 전용, 상시는 Mica(불투명)·Solid.)

4. **Elevation through luminance, not blur.** 깊이는 표면 휘도 step + (라이트 모드)그림자 + border 로 표현한다. 다크 모드에선 그림자가 사라지므로 표면을 위로 갈수록 밝힌다. (Atlassian · Muzli: 다크 모드는 그림자 대신 surface color step.)

5. **정확히 4단계 elevation.** `sunken → base → raised → overlay`. 4단계를 넘기면 위계가 무너진다. 각 단계는 surface+shadow 토큰을 항상 짝으로 쓴다.

6. **Semantic 토큰이 항상 매개한다.** 신규 component class 는 primitive RGB triplet 을 직접 참조하지 않고 semantic/material 토큰을 소비한다(§3). material/theme 변경이 component CSS 를 건드리지 않고 전파되게 한다. (기존 base.css 의 primitive 직접 참조는 시스템 규모상 허용 — 신규 glass/elevation 만 Tier 2 경유 강제.)

7. **Motion clarifies change, never decorates.** 모션은 "값이 바뀌었다 / 순서가 바뀌었다" 를 알리는 용도. 상시 애니메이션 루프는 기존 `.live-dot`·`.pulse-ring` 2종이 예산 전부다(§8).

8. **색맹 안전(dual-encoding) 보존.** severity 는 색만이 아니라 기호+색으로 인코딩한다(기존 `TONE_GLYPH` ✓/⚠/✕/ℹ 관행 유지). glass 가 severity 색을 desaturate 시키지 않게 severity 요소는 불투명 면 위에 둔다(§6 AP-6).

9. **Backdrop-filter 성능 예산.** 뷰포트당 동시 backdrop-filter ≤ 2, blur radius ≤ 12px(8~15px 범위), 스크롤 리스트 아이템엔 금지(§9).

---

## 3. 토큰 시스템 (Token Architecture — 3-Tier)

### 3.0 현재 구조 진단

`tokens.css` 는 이미 **Tier 1(primitive)** 을 암묵적으로 구현한다 — 모든 값이 raw `R G B` space-separated triplet 이라 Tailwind alpha(`rgb(var(--token) / <alpha>)`)가 동작한다. 빠진 것은 **Tier 2(semantic/material)** 와 elevation/translucency 어휘다. `.card`/`.btn`/`.modal` 이 토큰을 직접 참조하는 것은 소규모 시스템에선 허용되지만, blur 변형·elevation 변형을 추가하려면 모든 component 를 건드려야 한다. 그래서 **신규 표면(glass·다단 elevation)만 Tier 2 를 경유**시킨다.

### 3.1 Tier 1 — PRIMITIVE (현행 유지 · 문서화만)

`tokens.css` 의 기존 토큰을 그대로 둔다. 신규 component 는 이를 직접 참조하지 않는다.

```
--surface --elev --sunken --line --ink --dim --faint
--accent --crit --warn --ok --info
--cat-1 --cat-2 --cat-3 --cat-4
```

규약: **모든 값은 `R G B` (콤마 아님) space-separated triplet**. alpha 는 저장하지 않고 사용처에서 `rgb(var(--token) / α)` 로 합성. 신규 토큰도 동일 규약을 따른다.

### 3.2 Tier 2 — SEMANTIC / MATERIAL (신규 · additive)

`tokens.css` 의 `:root` / `[data-theme="dark"]` 블록 끝에 **append** 한다(기존 토큰 위에 추가, 변경 없음).

```css
:root {
  /* ── Elevation tier (신규 primitive 1개 + semantic alias) ───────── */
  --elev-2: 252 252 251;          /* NEW primitive: elev 위 한 단계 (focused/hover 카드) */
  --overlay-surface: 255 255 255; /* NEW primitive: 모달/팝오버 불투명 면 (= elev, 의미 분리) */

  /* surface elevation semantic aliases (primitive 재참조 — 의미 명명) */
  --surface-sunken:   var(--sunken);          /* 함몰 홈, 테이블 헤더, 칩 배경 */
  --surface-base:     var(--surface);         /* 페이지 바탕 */
  --surface-raised:   var(--elev);            /* 카드/패널 (raised) */
  --surface-raised-2: var(--elev);            /* focused/hover 카드 fill (라이트=elev 순백 유지, 떠오름은 shadow/ring step; 다크는 아래 elev-2 로 override) */
  --surface-overlay:  var(--overlay-surface); /* 모달/팝오버 */

  /* raised-2 의 "한 단계 더" 채널 (라이트=shadow/ring, 다크=휘도) */
  --shadow-raised-2: 0 2px 6px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.05); /* 라이트 raised-2: elev fill + 이 강한 그림자 */

  /* ── Glass / material (신규) ────────────────────────────────────── */
  --glass-tint:    255 255 255;   /* (kind A: R G B triplet) 라이트 화이트 틴트 유리 베이스 */
  --glass-border:  255 255 255;   /* (kind A: R G B triplet) 유리 엣지 하이라이트 (alpha 는 사용처) */
  --glass-blur:    12px;          /* (kind B: length 리터럴) production blur radius (cap) */
  --material-glass-alpha: 0.75;   /* (kind B: unitless 스칼라) 라이트 모드 유리 fill 불투명도 */

  /* ── Shadow / depth (신규 — 합성 그림자 토큰) ──────────────────── */
  --shadow-raised:  0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04); /* (kind B: box-shadow 리스트, 내부 rgba 는 alpha 비합성) */
  --shadow-overlay: 0 10px 40px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08); /* (kind B: box-shadow 리스트) */
}

[data-theme="dark"] {
  --elev-2: 36 32 30;             /* 다크: elev(28 25 23) 위 한 휘도 step ↑ */
  --overlay-surface: 28 25 23;    /* 다크: 불투명 모달 면 */

  --surface-raised-2: var(--elev-2); /* 다크 raised-2: 휘도 step 으로 떠오름 (36 > 28) — 라이트의 elev 유지와 달리 fill 자체가 밝아짐 */

  --glass-tint:    28 25 23;      /* (kind A) 다크: warm-dark 틴트 유리 베이스 */
  --glass-border:  255 255 255;   /* (kind A) 다크: 화이트 엣지 (낮은 alpha 로 가시화) */
  --material-glass-alpha: 0.82;   /* (kind B) 다크: fill 불투명도 ↑ (washed-out 방지) */

  --shadow-raised:    0 1px 4px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2);
  --shadow-raised-2:  0 3px 10px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.25); /* 다크 raised-2: 휘도 step 이 주채널, 그림자는 거의 무효 — 보조용 */
  --shadow-overlay:   0 10px 40px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3);
}
```

**다크 모드 elevation 프로토콜(핵심).** 그림자는 어두운 면에서 사라지므로 surface 는 z 가 올라갈수록 **밝아진다**. 현재 다크 팔레트의 실제 휘도 서열(R 값 기준): `base(--surface 12 10 9) < sunken(--sunken 24 20 17) < raised(--elev 28 25 23) < raised-2(--elev-2 36 32 30)`. 즉 페이지 바탕(`--surface`)이 가장 어둡고, 함몰면(`--sunken`)·카드(`--elev`)·포커스 카드(`--elev-2`) 순으로 밝아진다. 카드(`--elev` 28)가 페이지 바탕(`--surface` 12)보다 밝아 "떠 있음" 이 휘도만으로 읽힌다. shadow 토큰의 rgba 불투명도는 다크에서 크게 올린다(0.06→0.3, 0.18→0.5).

> **검증 노트(다크)**: 위 다크 휘도 서열 `base(12) < sunken(24) < raised(28) < raised-2(36)` 은 기존 `tokens.css` 값을 사실 그대로 옮긴 것이며 새 값을 발명하지 않았다(신규 primitive 는 `--elev-2` 1개뿐, elev 위 한 step). 다크에서는 z 가 올라갈수록 R 값이 단조 증가하므로 휘도 step 단독으로 elevation 이 성립한다.
>
> **라이트 모드 raised-2 주의(필독 — 인버전 회피).** 라이트 값은 반대로 surface(250)가 어둡고 elev(255)가 가장 밝다. 그런데 `--elev`(255)가 이미 순백 천장이라 그 위 단계인 `--elev-2`(252)는 **fill 휘도로는 elev 보다 더 밝아질 수 없고 오히려 약간 어둡다**(252 < 255). 따라서 **라이트 모드의 raised-2 는 "더 밝은 fill" 로 표현하지 않는다** — 휘도 인버전이 발생하기 때문이다. 라이트에서 raised-2 의 "한 단계 더 떠오름" 은 **그림자/ring step 으로만** 표현한다(아래 §6.2 / §7.1 규칙). 즉 라이트 raised-2 = `--elev`(255 순백) fill + 한 단계 강한 `--shadow-raised`(또는 1px ring) ; `--elev-2`(252) fill 은 다크 전용으로 둔다. 다크는 휘도 step 단독(36 > 28), 라이트는 shadow/ring step 단독 — 테마별로 "떠오름" 채널이 다르다.

### 3.2a 토큰 종류 2종 명시 (Dual Token Convention — 필독)

이번 추가로 `tokens.css` 는 더 이상 100% RGB-triplet 이 아니다. 신규 토큰은 **두 종류(kind)** 가 섞이며, 리뷰어가 kind B 를 "패턴 위반" 으로 오인하지 않도록 명시한다.

| Kind | 형식 | 예 | 소비 방식 |
|------|------|----|-----------|
| **A — RGB-triplet primitive** | `R G B` (space-separated, alpha 없음) | `--glass-tint` `--glass-border` 및 기존 16개 전부 | `rgb(var(--token) / <alpha>)` 로 사용처에서 alpha 합성 (Tailwind `<alpha-value>` 호환) |
| **B — pre-composed literal** | 완결된 CSS 값(length·scalar·box-shadow list) | `--glass-blur`(12px) · `--material-glass-alpha`(0.75) · `--shadow-raised`/`-raised-2`/`-overlay` | `var(--token)` 로 그대로 사용 (alpha 합성 불가) |

- length(blur)·unitless scalar(alpha)·box-shadow list 는 **본질적으로 triplet 으로 표현 불가** → kind B 는 정당하고 표준적이다.
- 특히 **`--shadow-*` 의 내부 `rgba()` 불투명도는 의도적으로 alpha-비합성**이다 — box-shadow 는 Tailwind `<alpha-value>` 보간 대상이 아니므로, 그림자 농도는 라이트/다크 토큰 값 자체에 baked-in 한다(이것이 정상이며 alpha 패턴 위반이 아니다).
- 신규 **색/표면** 토큰은 반드시 kind A(triplet)로만 추가한다. kind B 는 length/scalar/shadow 에 한정한다.

### 3.3 Tier 3 — COMPONENT (Tier 2 소비)

신규 glass/elevation component 는 Tier 2 만 참조한다. 예시(§6·§7 에서 재사용):

```css
.glass-surface {                              /* transient 표면 공통 */
  background: rgb(var(--glass-tint) / var(--material-glass-alpha));
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid rgb(var(--glass-border) / 0.15);
}
.card-raised {                                /* 상시 카드 — blur 없음 */
  background: rgb(var(--surface-raised));
  box-shadow: var(--shadow-raised);
  border: 1px solid rgb(var(--line));
}
.elev-overlay {                               /* 모달/팝오버 불투명 면 */
  background: rgb(var(--surface-overlay));
  box-shadow: var(--shadow-overlay);
}
```

### 3.4 Migration note (호환성)

- 기존 토큰은 **무삭제·무개명**. 신규 토큰은 전부 append.
- 기존 `.card`/`.kpi`/`.modal` 의 primitive 직접 참조는 회귀 위험 없이 그대로 둔다. 신규 glass 표면만 Tier 2 강제.
- **소비 경로 권장 = CSS component class (`.glass-surface`/`.card-raised`/`.elev-overlay`).** 현재 스택은 **Tailwind CDN-JIT + 런타임 `tailwind.config` 객체**이지 Tailwind v4 `@theme`/Oxide/OKLCH 가 아니다(§3.5 참조). `index.html` 의 `tailwind.config.theme.extend.colors` 에는 신규 토큰이 매핑돼 있지 않으므로, glass 클래스는 **CSS 컴포넌트 클래스로 소비**하는 것이 가장 안전하다 — `index.html` L14 가 경고하는 CDN 런타임 class-scan 의존을 피한다. Tailwind 유틸이 꼭 필요하면 `config.theme.extend.colors` 에 기존 16개와 동일 패턴(`'glass': "rgb(var(--glass-tint) / <alpha-value>)"`)으로 추가한다(선택, additive, kind A 토큰만 가능).
- **Shadow source-of-truth 수렴 (소유자·트리거 명시).** 기존 Tailwind `boxShadow.card`/`boxShadow.float`(index.html) 와 신규 `--shadow-raised`/`-raised-2`/`-overlay` 는 의미가 중복된다. 정본 = **신규 CSS 변수**. 강제 마이그레이션은 하지 않되 다음 수렴 계약을 둔다 — **소유자: dev-front**; **수렴 트리거: 다음번 `.card`/`.modal` 의 elevation 관련 수정이 들어오는 시점에 해당 사용처를 `var(--shadow-*)` 로 교체**(touch-when-you-edit 원칙). 신규 코드는 처음부터 `--shadow-*` 만 쓴다. 즉 "점진 수렴" 은 막연한 미래가 아니라 "다음 elevation 수정 PR" 이라는 구체 트리거를 갖는다.

### 3.5 기존 glass 표면 1곳 정합 (tweaks-panel — dev-only carve-out)

> **전제 정정**: "현재 UI 에 glassmorphism 이 전혀 없다" 는 부정확하다. **`public/src/tweaks-panel.jsx` 의 `.twk-panel`(개발용 floating tweaks 패널) 한 곳에 이미 glass 가 존재**한다 — `backdrop-filter: blur(24px) saturate(160%)`, 하드코딩 색(`rgba(250,249,247,.78)`·`#29261b`·`rgba(255,255,255,.6)`), reduced-transparency fallback 없음.

이 표면은 본 문서 §6.3 ALLOW 의 "떠 있는 transient chrome(유리 지붕 순간)" 정의에는 부합하지만, (a) blur 24px 가 production cap 12px 초과, (b) `saturate(160%)` 는 예산 어휘 밖, (c) token-driven 이 아니라 신규 `--glass-*` 토큰과 silent drift 위험, (d) AP-5(reduced-transparency fallback) 누락이다. 처리 방침을 **dev-only carve-out** 으로 명시한다:

- **분류**: `.twk-panel` 은 **개발 도구(dev-only) 전용 chrome** 이며 production 토큰 시스템의 cap 적용 대상에서 **명시적으로 예외(carve-out)** 처리한다. 사용자 대면 화면이 아니므로 12px cap·예산 ≤2 산정에서 제외한다.
- **단, 최소 의무 1개는 부과**: dev 도구라도 `@media (prefers-reduced-transparency: reduce)` fallback(불투명 `rgba(250,249,247,1)` 복귀)은 추가한다(AP-5 — 접근성은 dev 도구도 면제되지 않음).
- **권장(비강제)**: 차후 `.twk-panel` 수정 시 하드코딩 색을 `--glass-tint`/`--glass-border`/`--material-glass-alpha` 로 이관하고 blur 를 cap 으로 끌어내리거나, "dev-tool 의도적 cap 예외" 로 1줄 주석을 남긴다. 이관 소유자 = dev-front, 트리거 = `.twk-panel` 차기 수정 PR.
- **핵심**: production 표면(card·kpi·tbl·alert-row·sidebar)에는 여전히 glass 가 없다 — glass 가 사는 유일한 곳이 곧 시스템이 아직 일관되지 않은 유일한 곳이므로, 위 carve-out 으로 "예외임을 명시" 해 drift 를 가시화한다.

---

## 4. 컬러 (Color — Light / Dark · Semantic · Severity vs Categorical)

베이스는 **warm-stone** 중립(거의 Tailwind stone). 새 hue 를 발명하지 않는다.

### 4.1 Semantic 토큰 (name · role)

| Token | Light `R G B` | Dark `R G B` | Role |
|-------|---------------|--------------|------|
| `--surface` | 250 250 249 | 12 10 9 | 페이지 바탕 (다크에선 가장 어두움) |
| `--elev` | 255 255 255 | 28 25 23 | 카드/패널 면 (raised) |
| `--elev-2` *(신규)* | 252 252 251 | 36 32 30 | raised-2 fill — **다크 전용**(36, 휘도 step). 라이트(252)는 elev(255)보다 어두워 raised-2 fill 로 쓰지 않음(§6.2 인버전 회피); 라이트 raised-2 는 shadow/ring 으로 표현 |
| `--sunken` | 245 245 244 | 24 20 17 | 함몰 홈 · 테이블 헤더 · 칩 |
| `--line` | 231 229 228 | 41 37 36 | 1px 경계선 |
| `--ink` | 28 25 23 | 250 250 249 | 본문 텍스트 (다크에서도 순백 #fff 아님) |
| `--dim` | 87 83 78 | 214 211 209 | 2차 텍스트 |
| `--faint` | 168 162 158 | 120 113 108 | 3차/placeholder 텍스트 |
| `--accent` | 37 99 235 | 96 165 250 | 인터랙션/링크 (cool blue) |

다크 텍스트 위계는 순백 금지를 이미 준수한다(`--ink` = 250 250 249, 순백 아님). primary=ink / secondary=dim / tertiary=faint 3단계.

### 4.2 Severity (crit / warn / info / ok) — 색만 쓰지 말 것

| Token | Light | Dark | 의미 | 기호(dual-encode) |
|-------|-------|------|------|-------------------|
| `--crit` | 220 38 38 | 248 113 113 | 실패/위험 | ✕ |
| `--warn` | 217 119 6 | 251 191 36 | 경고/주의 | ⚠ |
| `--ok` | 5 150 105 | 52 211 153 | 정상/성공 | ✓ |
| `--info` | 8 145 178 | 34 211 238 | 정보/blocked(중립) | ℹ |

- severity 는 항상 **기호+색** (기존 `TONE_GLYPH`·`.sev-bar`·`StatusDot` 관행). 색 단독 인코딩 금지.
- severity 칩 배경은 기존 `rgb(var(--token) / 0.12~0.15)` 패턴 유지(`.pill.crit` 등).
- **severity 요소는 glass/blur 위에 두지 않는다** — desaturation 이 응급 신호를 약화시킨다(§6 AP-6).

### 4.3 Categorical (cat-1..4) — 차트 전용

| Token | Light | Dark | 용도 |
|-------|-------|------|------|
| `--cat-1` | 124 58 237 | 167 139 250 | 분류 시각화(차트 fill/swatch) |
| `--cat-2` | 13 148 136 | 45 212 191 | 〃 |
| `--cat-3` | 37 99 235 | 96 165 250 | 〃 |
| `--cat-4` | 219 39 119 | 244 114 182 | 〃 |

- **severity 와 categorical 의 분리 유지**: cat-* 는 "분류" 용이지 "위험도" 용이 아니다(기존 주석 명시). 둘을 섞지 않는다.
- WCAG 주의(기존 dashboard.jsx 주석): `cat-2`/`cat-4` 는 라이트 면 대비 3.5~3.9:1 → **chart fill/swatch 한정, text 색상 금지**. 신규 작업도 이 제약을 따른다.

### 4.4 Accent 방향성 — "유리 너머의 따뜻한 빛"

`--accent`(cool blue)는 인터랙션 전용으로 유지한다. "Daylight Atrium" 의 따뜻함은 **새 hue 추가 없이** 기존 `--warn`(amber) 방향을 liveness 신호로 재사용해 표현한다(예: liveness dot, "신규" 마커). categorical 팔레트에 새 색을 추가하지 않는다. 액센트는 화면당 ≤2 (CTA/인터랙션 한정, 장식 금지).

---

## 5. 타이포그래피 (Typography)

새 타입페이스 불필요. `Pretendard Variable`(UI) + `JetBrains Mono`(수치/코드)가 모든 역할을 커버한다(index.html 로드 확인).

| 역할 | Family | 비고 |
|------|--------|------|
| UI 본문/제목 | `'Pretendard Variable'` → Pretendard → system-ui | `body` 전역 |
| 수치·코드·ID·시각 | `'JetBrains Mono'` → ui-monospace | `.font-mono` / `code` / `.mono` |

**OpenType feature.**
- 전역 `body`: `font-feature-settings: 'tnum' 1, 'cv11' 1`(기존). 표·KPI·차트 축의 숫자 정렬 폭 보장.
- 금융/데이터 수치(KPI value · 비용 · token 수 · latency)는 **tnum 필수** — 이미 mono+tnum 으로 충족.

**Weight 운용 (≤3 weight · 1 signature).**
- 400(regular) / 500(medium · 라벨·nav) / 600(semibold · 카드 타이틀·KPI value). signature = 600 semibold + mono 수치.
- **Glass 표면 위 라벨**(예: 떠 있는 chrome 의 nav 텍스트)은 한 step 무겁게 — `font-weight: 600` — 투명도로 인한 명도 손실을 보상.

**수치 표기.**
- 큰 KPI value 는 `letter-spacing: -0.025em`(기존 `.kpi-value` 정합)으로 한 덩어리 수처럼 읽히게.
- **Numeric-to-Unit 비율 ≈ 2:1**: 값과 단위의 크기비를 약 2:1 로. 기존 `.kpi-value`(26px) ↔ `.kpi-value .unit`(13px) = 정확히 2:1 — 이 비율을 신규 수치 UI 의 기준 페어로 삼는다. (프로젝트 자체 스케일에서 도출 — Hero/KPI/Donut/Chart/List 페어는 이 26/13 기준에서 파생.)

> 슬롭 회피: Inter/Roboto/Arial/Fraunces 등 범용 폰트를 1차로 두지 않는다. 시스템은 이미 Pretendard+JetBrains Mono 라는 명확한 선택을 갖고 있으므로 그대로 보존한다.

---

## 6. 표면·깊이·유리 머티리얼 (Surface · Depth · Glass)

### 6.1 4-Level Elevation (정본)

| Level | 토큰 (Tier2) | 쓰임 | 라이트 표현 | 다크 표현 |
|-------|--------------|------|-------------|-----------|
| **sunken** | `--surface-sunken` | 함몰 홈·테이블 헤더·칩·미니바 트랙 | 어두운 fill | 더 어두운 fill |
| **base** | `--surface-base` | 페이지 바탕 | 기본 | 가장 어두움 |
| **raised** | `--surface-raised` (+`--shadow-raised`) | 카드·패널 | fill + 약한 shadow + 1px line | 휘도 ↑ + 1px line (그림자 거의 무효) |
| **overlay** | `--surface-overlay` (+`--shadow-overlay`) | 모달·팝오버·flyout | fill + 강한 shadow | 휘도 ↑ + 강한 shadow rgba |

규칙: 각 level 은 surface+shadow 토큰을 **항상 짝으로** 쓴다. 5단계 이상 금지.

### 6.2 떠오름은 blur 가 아니라 luminance/border/tint 로 (상시 카드)

Linear/Vercel/Raycast 패턴을 따른다 — 카드 elevation 은 다음 요소로 표현하고 **blur 를 쓰지 않는다**:
(a) `--shadow-raised`(라이트 4~6% black), (b) base 대비 더 밝은 fill, (c) 상단 1px inset 하이라이트(단, **순백 천장 표면에는 적용 불가** — 아래 주의).

**테마별 "떠오름" 채널이 다르다(인버전 회피).**
- **라이트 모드**: `--surface`(250) < `--elev`(255 순백). 카드(raised)는 elev 순백 fill + `--shadow-raised`. **raised-2(focused/hover)는 fill 을 더 밝게 만들 수 없다**(255 가 천장) → raised-2 는 **elev 순백 fill 유지 + 한 단계 강한 `--shadow-raised-2`(또는 1px ring)** 로 표현한다. 라이트에서 `--elev-2`(252) fill 을 raised-2 에 쓰면 raised(255)보다 어두워져 휘도 인버전이 난다 — **금지**.
- **다크 모드**: 그림자가 거의 무효이므로 raised=`--elev`(28), raised-2=`--elev-2`(36)로 **fill 휘도 step** 만으로 떠오름을 만든다(36 > 28, 인버전 없음).

**상단 inset 하이라이트 적용 조건(필독).** "위에서 오는 빛" 하이라이트는 *fill 보다 밝은 선* 이라야 보인다. **순백(`--elev` 255) fill 위에는 흰 하이라이트가 보이지 않으므로 적용하지 않는다.** 적용 대상은: (i) **다크 모드 카드**(28 25 23 위 `inset 0 1px 0 rgb(var(--glass-border) / 0.06)` — 가시), (ii) 라이트에서 순백이 아닌 표면(예: sunken/칩 위 또는 overlay 면). 라이트의 순백 카드는 하이라이트 대신 **하단 `--shadow-raised` 와 1px `--line` 경계**로 떠오름을 만든다.

### 6.3 backdrop-filter — 허용/금지 가드레일 (편법 방지의 핵심)

> 단일 규칙: **Acrylic(blur) = transient·light-dismiss 전용. 상시 정보 표면 = 불투명(Solid).** (Microsoft Fluent.)

**허용 (ALLOW) — 모두 "유리 지붕 순간":**
- 모달/시트 오버레이의 **backdrop scrim**: 배경을 dim·후퇴시켜 모달에 집중. 전면 1장 합성이라 비용 한정.
- **flyout/컨텍스트 메뉴 · 툴팁/팝오버**: transient·소면적 → GPU 비용 허용.
- **떠 있는 chrome 1개**(있을 경우): 스크롤 콘텐츠 위로 떠 공간 분리. 단 blur ≤ 12px + 명암비 검증 + scrim 필수.

> 본 프로젝트 현황: 네비게이션은 좌측 `aside`(`bg-elev` 불투명 · `sticky top-0` · `border-r`)이며 떠 있는 top-bar 가 없다. 사이드바는 **본문 위에 겹치지 않으므로**(grid 의 별도 컬럼) blur 가 불필요하다 — 불투명 유지가 정답이다. "skylight glass nav" 는 **향후 떠 있는 top-bar 를 신설할 때에만** 적용하는 선택 패턴이며, 현재 사이드바를 glass 로 바꾸는 것은 근거 없는 장식이므로 하지 않는다.
>
> production 상시 표면에는 glass 가 없으나, **개발용 floating 패널 `.twk-panel` 한 곳에는 이미 glass 가 존재**한다(§3.5). 이는 이 ALLOW 의 "떠 있는 transient chrome" 정의에 부합하는 dev-only 표면으로, §3.5 의 carve-out(cap 예외 + reduced-transparency fallback 의무) 으로 다룬다.

**금지 (FORBID) — 데이터 밀집 UI 에서 실패:**
- 테이블/리스트 row 개별 blur (`.tbl tbody tr`, `.alert-row`): row 마다 컴포지팅 레이어 → 스크롤 frame drop + 값 변동 시 가독성 붕괴.
- **KPI 카드 그리드 일괄 blur** (`.kpi` ×8~16): GPU 예산 초과 + 카드가 서로 뭉개져 독립 신호성 상실.
- severity 색 요소(`.sev-bar`·`.pill.crit`·`.nav-badge.crit`) 위 blur: desaturation 으로 응급 신호 약화.
- 폼/입력 필드, 동적 콘텐츠 위 정적 glass(실시간 차트·로그 스트림 뒤).

**Anti-pattern 체크(연구 종합):** AP-1 모든 카드 blur · AP-2 scrim 없는 raw glass 위 텍스트 · AP-3 동적 콘텐츠 위 glass · AP-4 다크 휘도 보상 없는 glass · AP-5 `prefers-reduced-transparency` fallback 누락 · AP-6 severity 색 dilution · AP-7 중첩 blur 2겹 초과 · AP-8 border 없는 glass(저대비 배경에서 비가시).

### 6.4 Glass 를 쓸 때의 필수 4종 세트

glass 표면을 정당하게 쓸 때는 항상:
1. **Scrim**: 텍스트가 얹히면 그 뒤에 `background: rgb(var(--elev) / 0.85)` 칩/면 — 4.5:1 확보.
2. **Border**: `1px solid rgb(var(--glass-border) / 0.15)`(다크) — 경계가 blur 에만 의존하지 않게.
3. **다크 보상**: fill 불투명도 ↑(`--material-glass-alpha` 0.82), 휘도 step 확보.
4. **Fallback**: `@media (prefers-reduced-transparency)` 로 불투명 토큰 대체(§9).

---

## 7. 컴포넌트 가이드 (Component Guide — 기존 클래스 보존)

클래스명을 **개명하지 않는다**. 글래스/elevation 원칙을 기존 `base.css` 클래스에 어떻게 적용하는지를 규정한다. 컴포넌트는 7 속성(BG/Text/Padding/Radius/Shadow/Hover/Purpose)으로 본다.

### 7.1 `.card` / `.card-head` / `.card-body` — raised, 불투명
- BG `rgb(var(--elev))` · border `1px solid rgb(var(--line))` · radius 12px · padding(head 16×20 / body 20px) — 기존 유지.
- **추가(선택)**: `box-shadow: var(--shadow-raised)` 로 raised 깊이 보강. **blur 금지.**
- **상단 inset 하이라이트는 다크 전용**: `[data-theme="dark"] .card { box-shadow: var(--shadow-raised), inset 0 1px 0 rgb(var(--glass-border) / 0.06); }` (28 25 23 위라 가시). **라이트 모드 순백 카드에는 하이라이트를 넣지 않는다** — 4% 흰선이 순백(255) 위에서 비가시이기 때문(§6.2 주의). 라이트는 하단 `--shadow-raised` + 1px `--line` 으로 떠오름 표현.
- **raised-2(focused/hover) 카드**: 라이트 = `--elev`(순백 유지) + `var(--shadow-raised-2)`(또는 1px ring) — fill 을 더 밝히지 않는다(인버전 금지). 다크 = `--surface-raised-2`(`--elev-2` 36, 휘도 step) + (보조)`--shadow-raised-2`.
- Hover: 선택형 카드만 `border-color: rgb(var(--faint))` + (라이트)`--shadow-raised-2` / (다크)`--surface-raised-2` 로 한 step, 120ms.

### 7.2 `.kpi` (+`-label`/`-value`/`-delta`/`-spark`) — raised, 불투명
- 26px mono semibold value + 13px unit(2:1) 유지. **그리드 일괄 blur 절대 금지**(AP-1). hover `border-color` 120ms 유지.
- 값 변동 플래시는 §8 의 `valueFlash` 사용(persistent 루프 신설 금지).

### 7.3 `.pill` (+crit/warn/info/ok) — severity 칩, 불투명 면 위
- 기존 `rgb(var(--token) / 0.12)` 배경 유지. **glass 위에 올리지 않는다**(AP-6). 색 단독 금지 — 텍스트/기호 동반.

### 7.4 `.btn` (+primary/danger/ghost/sm) — 불투명
- 기존 유지. transition 120ms(`.btn` 기준 속도 = 신규 hover 표준). glass 불필요.

### 7.5 `.tbl` — 상시 표면, 절대 불투명
- sticky thead 는 `rgb(var(--elev))` 불투명 유지(기존 `STICKY_TH_STYLE`). **row blur 금지**(AP-2). row hover `bg-sunken` 유지.

### 7.6 `.tabs`/`.tab`, `.seg` — 불투명
- 기존 유지. 활성 탭 `--elev` + 미세 shadow. glass 불필요.

### 7.7 `.nav-item` (+badge) / 사이드바 — 같은-평면 chrome, 불투명
- 사이드바는 `bg-elev` 불투명 유지(§6.3 근거). nav-badge severity 는 색+값. glass 로 바꾸지 않는다.

### 7.8 `.modal` / `.modal-backdrop` / `-head`/`-body`/`-foot` — overlay (유리 허용 지점)
- `.modal` 면 자체는 `--surface-overlay` **불투명** + `--shadow-overlay`(텍스트 4.5:1 보장).
- **`.modal-backdrop` 만 glass 허용**: 현재 `rgba(0,0,0,0.42)` 솔리드 scrim 을 유지하거나, 선택적으로 `background: rgb(0 0 0 / 0.35); backdrop-filter: blur(8px)` 로 "smoke" 효과. **단** `prefers-reduced-transparency` fallback 으로 솔리드 0.42 복귀(§9). 뷰포트당 backdrop-filter 1장 — 모달 오픈 중 다른 glass(있다면) blur 해제(AP-7).

### 7.9 `.alert-row` — severity 행, 불투명
- 좌측 `.sev-bar` 색 막대 + 본문. **blur 금지**(AP-2/AP-6). hover `bg-sunken` 유지. acked 는 `opacity 0.5`.

### 7.10 `.placeholder` — 자산 부재 시 정직한 빈자리
- 기존 dashed border + faint 텍스트 유지. 가짜 SVG 일러스트/더미 데이터로 채우지 않는다(슬롭 금지). 빈 공간은 레이아웃으로 풀고, 실 자산은 사용자에게 요청.

> 컴포넌트별 5 state(default/hover/active/focus/disabled): hover/focus/active 의 alpha(state layer) 구체값은 dev-front State Layers SSoT 를 따른다. 본 문서는 표면/깊이/material 규칙을 정의한다.

---

## 8. 모션 (Motion — 절제된 라이브 마이크로 인터랙션)

기존 2개 ambient 루프가 예산 전부다: `.live-dot`(1.6s `liveBlink` opacity 1→0.35) · `.pulse-ring`(1.6s `pulseRing` scale 0.95→1.15). 1.6s 주기는 적정(더 빠르면 불안·느리면 정체). **세 번째 상시 루프 신설 금지.**

### 8.1 Motion hierarchy (이 프로젝트 선언)
- **primary** — 모달/flyout 진입: `opacity 0→1` + `translateY(-4px→0)` 180ms(하강 = 유리 지붕 메타포), 퇴장 140ms.
- **secondary** — 카드 hover 깊이: `border-color` + `box-shadow` 120ms(`.btn` 기준 속도).
- **ambient** — `.live-dot`/`.pulse-ring` 만(1.4~1.8s). 추가 liveness 필요 시 `.pulse-ring` 를 색 modifier 로 재사용.

### 8.2 데이터 변경 신호 (change blindness 대응)
- **수치 갱신 플래시**: 새 라이브 값 도착 시 `valueFlash` 0.3~0.4s — `--ok`/`--crit` 색으로 잠깐 플래시 후 `--ink` 복귀. pulse-ring 재트리거 아님.
  ```css
  @keyframes valueFlash { 0% { color: rgb(var(--ok)); } 100% { color: rgb(var(--ink)); } }
  .kpi-value.updated { animation: valueFlash 0.35s ease-out; }
  ```
- **리스트 reorder**(alert severity 재정렬): `transition: transform 280ms ease-in-out`(<300ms).
- **spark 갱신**: `.kpi-spark` SVG `stroke-dasharray` draw 400ms ease-out("새 데이터" 트레이스, 카드 전체 플래시 아님).

### 8.3 타이밍 표준
load/state-change 150~200ms · data-update flash 300~400ms · overlay enter/exit 140~200ms · ambient 1.4~1.8s. informational 요소에 `animation: infinite` 는 2개 canonical 루프 외 금지.

### 8.4 prefers-reduced-motion 계약 (필수)
```css
@media (prefers-reduced-motion: reduce) {
  .live-dot { animation: none; opacity: 0.8; }
  .pulse-ring::after { animation: none; }
  .kpi-value.updated, [class*="valueFlash"] { animation: none; }
  /* transform 기반 enter/reorder 는 즉시 적용(transition 제거) */
}
```
브라우저/OS 가 `@media (prefers-reduced-motion: reduce)` 를 자동 반영. 모든 신규 모션은 이 게이트로 감싼다.

---

## 9. 접근성 & 성능 가드레일 (A11y & Performance)

### 9.1 WCAG (검증 가능 항목)
- 본문 텍스트 ≥ **4.5:1**, large-text(≥18px/24px bold 등) ≥ 3:1. AAA(7:1) 권장.
- **투명 표면 위 텍스트는 렌더된 합성(glass+실배경) 기준으로 측정** — glass 레이어만 보고 통과 처리 금지. 가장 불리한 배경에서 측정(APCA 또는 WCAG 2.2, 실제 다크/라이트 스크린샷 대상).
- glass 위 텍스트엔 scrim(`rgb(var(--elev) / ≥0.85)`) 필수.
- 기존 제약 승계: `cat-2`/`cat-4` 는 text 색 금지(차트 fill 한정).
- touch target ≥ 44×44px, 인접 간격 ≥ 8px(터치 환경).

### 9.2 backdrop-filter 성능 예산
- **뷰포트당 동시 backdrop-filter ≤ 2.** 스크롤 리스트 아이템엔 금지.
- blur radius **≤ 12px**(8~15px 허용 상한). 더 높은 값은 지수적으로 비쌈.
- 각 backdrop-filter 는 새 GPU 컴포지팅 레이어 + 스크롤마다 repaint → 상시 표면에 쓰지 않는다(이것이 "모든 카드 blur" 금지의 성능 근거).
- 중첩 blur ≤ 1/z-context(모달이 glass chrome 위로 뜨면 chrome blur 해제).

### 9.3 prefers-reduced-transparency 계약 (1급 설계 조건)
macOS "Reduce Transparency" 사용자(약 15~20%)를 위해 **모든 glass 선언에 솔리드 fallback** 을 둔다. 솔리드를 기본값으로 두고 glass 는 조건부로 얹는 패턴 권장:
```css
.modal-backdrop { background: rgba(0,0,0,0.42); }              /* 솔리드 기본 */
@supports (backdrop-filter: blur(1px)) {
  @media (prefers-reduced-transparency: no-preference) {
    .modal-backdrop { background: rgb(0 0 0 / 0.35); backdrop-filter: blur(8px); }
  }
}
/* 또는 reduce 측 명시 복귀 */
@media (prefers-reduced-transparency: reduce) {
  .glass-surface { background: rgb(var(--elev)); backdrop-filter: none; }
}
```

---

## 10. 일관성 체크리스트 (Consistency Checklist)

향후 모든 monitor 디자인/구현 작업은 아래를 만족해야 한다(검증 가능).

**토큰**
- [ ] 기존 `tokens.css` 토큰을 rename/delete 하지 않았다(append-only).
- [ ] 새 색(hue)을 발명하지 않았다 — 신규 색/표면 토큰은 기존 warm-stone 팔레트에서만 도출(§4 "새 hue 발명 금지"). migration note 동반.
- [ ] 신규 glass/elevation component 는 primitive 가 아닌 Tier 2 semantic/material 토큰을 참조한다.
- [ ] **색/표면(kind A) 토큰은 `R G B` space-separated triplet 이고 alpha 는 사용처에서 합성**한다. kind B(length·scalar·box-shadow, §3.2a)는 완결 리터럴로 두되, 신규 색은 kind B 로 추가하지 않았다.
- [ ] **라이트 모드 raised-2 는 더 밝은 fill 이 아니라 shadow/ring step 으로 표현**했다(`--elev`(255) 순백 천장이라 fill 인버전 발생 — §6.2). 다크 raised-2 만 `--elev-2`(36) 휘도 step 사용.

**색·severity**
- [ ] severity 는 색 단독이 아니라 기호+색(dual-encode)으로 표현했다.
- [ ] severity 요소를 glass/blur 위에 올리지 않았다.
- [ ] `--cat-*` 를 분류(차트)에만 썼고 위험도/텍스트색으로 쓰지 않았다(cat-2/4 text 금지).

**유리·깊이**
- [ ] backdrop-filter 를 transient(모달 backdrop·flyout·tooltip·떠 있는 chrome)에만 적용했다.
- [ ] 상시 표면(card·kpi·tbl·alert-row·sidebar)은 불투명이다.
- [ ] 뷰포트당 동시 backdrop-filter ≤ 2, blur ≤ 12px, 중첩 blur ≤ 1/z-context.
- [ ] elevation 은 4단계(sunken/base/raised/overlay) 이내, surface+shadow 토큰을 짝으로 썼다.
- [ ] 다크 모드에서 떠오름을 휘도 step 으로 표현했다(그림자 단독 의존 금지).
- [ ] glass 표면에 scrim + 1px border + 다크 휘도 보상 + reduced-transparency fallback 4종을 갖췄다.

**타이포**
- [ ] Pretendard Variable / JetBrains Mono 역할 분리 유지, 범용 슬롭 폰트 1차 사용 안 함.
- [ ] 수치는 tnum(mono) 정렬, 값:단위 ≈ 2:1.
- [ ] weight ≤ 3, glass 위 라벨은 600 으로 보상.

**모션**
- [ ] 상시 루프는 `.live-dot`/`.pulse-ring` 2개뿐, 세 번째 신설 안 함.
- [ ] 모든 신규 모션에 `prefers-reduced-motion: reduce` fallback 을 뒀다.
- [ ] 타이밍 표준(load 150~200ms · flash 300~400ms · overlay 140~200ms) 준수.

**접근성/성능**
- [ ] 본문 텍스트 ≥ 4.5:1.
- [ ] **(구현 단계 필수 산출물) glass/투명 표면 위 텍스트는 합성(glass+실배경) 대비를 가장 불리한 배경에서 라이트·다크 양쪽 실측해 ≥ 4.5:1(large-text ≥ 3:1)을 기록**했다 — 토큰 레벨 self-attestation 이 아니라 렌더링 측정 수치를 남긴다(이 항목은 문서/토큰만으로 검증 불가, 가독성 회귀가 가장 잘 나는 지점이므로 산출물 의무).
- [ ] **기존 `.twk-panel`(dev-only glass)에 `prefers-reduced-transparency: reduce` fallback 을 추가**했다(§3.5 carve-out 최소 의무).
- [ ] touch target ≥ 44×44px(터치 환경), 간격 ≥ 8px.

**슬롭 금지**
- [ ] 더미 섹션·발명 통계·lorem 채움·가짜 SVG 일러스트 없음(빈자리는 `.placeholder` 또는 레이아웃으로 해결).
- [ ] aggressive 그라데이션 배경·beige/peach 캔버스 기본값·순백(#fff) 다크 텍스트 없음.
- [ ] 모든 glass/투명 권고가 가독성·성능·명암비 근거를 동반한다(장식 목적 blur 금지).

---

## 11. AI Model Guidelines (MCP / Codegen 소비 규칙)

Figma Make · MCP-fed coding agent 가 이 문서를 소비할 때 따르는 규칙. 자동 생성 레이아웃은 본 철학 검토 없이 머지 금지.

**스택 사실 정정(코드 생성 전 필수):** 이 프로젝트는 **Tailwind CDN-JIT + 런타임 `tailwind.config` 객체**다. Tailwind v4 `@theme`/Oxide/OKLCH 가 **아니다** → v4 의 `@theme` 자동 토큰 생성·`text-[var(--x)]` 색 파싱 가정은 적용되지 않는다. 신규 glass/elevation 토큰은 **CSS 컴포넌트 클래스(`.glass-surface`/`.card-raised`/`.elev-overlay`)로 소비**하라(CDN 런타임 class-scan 의존 회피). Tailwind 유틸이 필요하면 `config.theme.extend.colors` 에 `rgb(var(--token) / <alpha-value>)` 패턴(kind A 한정)으로 추가.

**Non-negotiable (절대 토큰/규칙):**
- warm-stone 팔레트 + `tokens.css` 토큰 SoT. 새 hue 발명 금지(oklch 등 신규 색 도출 경로 없음 — 기존 stone 팔레트에서만 도출).
- 상시 표면(card·kpi·tbl·alert-row·sidebar) 불투명. backdrop-filter 는 transient 전용.
- severity = 기호+색 dual-encode. 본문 4.5:1, glass 위 텍스트는 합성 배경 실측.
- **라이트 raised-2 = shadow/ring step**(더 밝은 fill 금지 — `--elev` 순백 천장 인버전). 다크 raised-2 = `--elev-2` 휘도 step.
- 모든 glass 에 `prefers-reduced-transparency` fallback, 모든 모션에 `prefers-reduced-motion` fallback. dev-only `.twk-panel` 도 fallback 만은 의무(§3.5).
- 신규 **색** 토큰은 kind A(`R G B` triplet)로만 추가(§3.2a). length/scalar/shadow 만 kind B.

**Flexible (재량 토큰):**
- `--glass-blur`(8~15px 내), `--material-glass-alpha`(라이트 0.7~0.8 / 다크 0.8~0.85), 카드 hover shadow 적용 여부, overlay enter 타이밍(140~200ms), raised-2 의 shadow-vs-ring 선택(라이트).

**Bad examples (앵커 — 생성 금지):**
- ✕ `.kpi { backdrop-filter: blur(16px); }` — 상시 KPI 그리드 일괄 blur(AP-1·성능·뭉개짐).
- ✕ `.alert-row.crit { background: rgb(var(--crit)/0.12); backdrop-filter: blur(10px); }` — severity 위 blur(AP-6 desaturation).
- ✕ glass 카드에 scrim/border/fallback 없이 본문 텍스트 직접 배치(AP-2/AP-8, 1.5:1 위험).
- ✕ 라이트 모드에서 `.card:focus { background: rgb(var(--elev-2)); }` — 252 < 255 라 raised 보다 어두워지는 휘도 인버전(§6.2). 라이트는 shadow/ring 으로.
- ✕ 라이트 순백 카드에 `inset 0 1px 0 rgb(255 255 255 / 0.04)` 하이라이트 — 순백 위 흰선은 비가시(§7.1). 다크 전용.
- ✕ 빈 카드를 발명 통계("99% faster")·더미 차트로 채우기(슬롭).

---

### Research references (synthesized)

- Axess Lab — *Glassmorphism Meets Accessibility* (blur-on-dynamic-bg · 4.5:1 실패 · reduced-transparency fallback · ≤20px blur).
- Microsoft Learn (Fluent) — *Materials in Windows apps* (Acrylic transient / Mica 불투명 / Solid 상시 — 본 문서 §6.3 categorical rule 의 근거).
- Create with Swift — *Legibility & contrast in visionOS* ("darker over lighter for depth, lighter over darker for interaction").
- Infinum — *iOS 26 Liquid Glass* (1.5:1 실측 · severity desaturation 경고).
- Orizon — *Glassmorphism in 2026* ("never body text on raw glass" · ≤2 blur layers).
- Design Systems Surf · Atlassian Elevation · Muzli (다크 모드는 그림자 대신 surface color step · 4단계 elevation).
- Matuzo — *prefers-reduced-transparency* (fallback 패턴 SoT).
- Smashing — *UX for Real-Time Dashboards* (count-up/flash on update · reorder <300ms · ≤5 focal/zone).
- Feature-Sliced Design — *Design Token Architecture* (primitive → semantic → component, component 는 primitive 직접 참조 금지).
- Atrium (architecture) — glass-roofed central void · diffuse top-light · layered galleries(§1 메타포 근거).
