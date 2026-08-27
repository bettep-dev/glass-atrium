// Mermaid 런타임 설정 — 뷰어와 HTML 내보내기가 함께 읽는 단일 소스.
// index.html 은 이 전역을 initialize 에 그대로 넘기고, 내보내기는 이 파일의 텍스트를
// 렌더 페이지에 주입한다. 두 표면에 값을 각자 적으면 한쪽만 고쳐지는 드리프트가 생긴다.
// 색은 hex 로만 적는다 — `rgb(` 표기의 공백 하나가 content-budget 계수기에 오프너로 잡힌다.

window.MERMAID_CONFIG = {
  startOnLoad: false,

  // 기본 5(fatal) 에서는 log.warn 이 no-op 이라 미등록 레이아웃 폴백 경고가 콘솔에 안 뜸 → 3(warn) 으로 가시화.
  logLevel: 3,

  // securityLevel:'loose' — 소스는 백엔드가 저장소에서 직접 읽은 internal 텍스트 (외부 사용자 입력 아님).
  securityLevel: 'loose',

  // 전역 기본 레이아웃. 문서별 opt-out 은 한 줄 `%%{init: {"layout":"dagre"}}%%` 지시자.
  layout: 'elk',

  // 7키 전부를 명시 — 지시자로는 앞의 4개만 통과하고 뒤의 3개는 이 설정에서만 전달된다.
  // mergeEdges 만 기본값과 다름(교차 최소화); 나머지는 현재 값을 고정해 업스트림 기본값 변경이 조용히 배치를 바꾸는 것을 막는다.
  elk: {
    mergeEdges: true,
    nodePlacementStrategy: 'BRANDES_KOEPF',
    forceNodeModelOrder: false,
    considerModelOrder: 'NODES_AND_EDGES',
    nodePlacementAlignment: 'NONE',
    cycleBreakingStrategy: 'GREEDY',
    keepEntryNodeOnTop: false,
  },

  theme: 'dark',
  themeVariables: {
    darkMode: true,

    // ── tokens.css 다크 블록 파생 ────────────────────────────────────────────
    // background/edgeLabelBackground=--surface · clusterBkg=--sunken · nodeTextColor=--ink
    // lineColor=--ink 40% 를 --surface 위에 합성한 값.
    background: '#0c0a09',
    edgeLabelBackground: '#0c0a09',
    clusterBkg: '#181411',
    nodeTextColor: '#fafaf9',
    lineColor: '#6b6a69',
    // 캔버스 < 존 < 노드 세 톤과 각자의 테두리 — 같은 온기(r>g>b)를 유지한 채 이어붙인 단계.
    // 단차의 하한은 architecture.merged-surface.e2e 의 대비 판정이 소유한다.
    clusterBorder: '#3d3733',
    mainBkg: '#332e2a',
    nodeBorder: '#5c534e',

    // ── mermaid 11 다크 가독성 고정값 ────────────────────────────────────────
    // 타입별 텍스트 기본값이 "calculated"/"black" 으로 남아 어두운 캔버스 위에서 안 보이는 것을 막음.
    // primaryTextColor 는 flowchart 노드만 커버하므로 타입별 변수를 각각 명시해야 한다.
    primaryColor: '#1e3a8a',
    primaryTextColor: '#e5e7eb',
    fontSize: '14px',
    // 재는 서체와 그리는 서체가 같아야 라벨이 상자를 넘지 않음 — 캔버스 CSS 가 거는 서체와 같은 값.
    fontFamily: 'Pretendard, system-ui, -apple-system, sans-serif',

    // labelTextColor→actorTextColor / textColor→primaryTextColor 체인의 dark 기본값이 "black"/"calculated".
    textColor: '#e5e7eb',
    labelTextColor: '#e5e7eb',
    titleColor: '#f1f5f9',
    noteTextColor: '#0a0a0a',     // noteBkg 가 밝은 황색 → 노트 텍스트는 어둡게(대비 확보)
    noteBkgColor: '#fde68a',

    // 섹션 fill — light 텍스트가 얹히도록 어두운 면색 표준화 (자동 cScale 밝은 fill 회피).
    secondaryColor: '#334155',
    tertiaryColor: '#475569',
    secondaryTextColor: '#e5e7eb',
    tertiaryTextColor: '#e5e7eb',

    // pie — title/section/legend 텍스트는 raw 기본값 미할당(→ 종종 검정) → 전부 light, stroke 는 line 톤.
    pieTitleTextColor: '#f1f5f9',
    pieSectionTextColor: '#e5e7eb',
    pieLegendTextColor: '#e5e7eb',
    pieStrokeColor: '#0a0a0a',
    pieOuterStrokeColor: '#94a3b8',

    // journey — actor/task/label 텍스트 + label 박스 배경 (dark 기본 actorTextColor="black" 보정).
    actorTextColor: '#e5e7eb',
    taskTextColor: '#e5e7eb',
    labelBoxBkgColor: '#1e293b',
    // section 타이틀 텍스트(.section-type-N)는 fillType0..7 을 쓰고 기본값이 primaryColor 라 어두운 캔버스 위에서 불가시.
    fillType0: '#e5e7eb', fillType1: '#e5e7eb', fillType2: '#e5e7eb', fillType3: '#e5e7eb',
    fillType4: '#e5e7eb', fillType5: '#e5e7eb', fillType6: '#e5e7eb', fillType7: '#e5e7eb',

    // stateDiagram-v2 — 상태 라벨 + 복합 상태 타이틀 배경.
    labelColor: '#e5e7eb',
    stateLabelColor: '#e5e7eb',
    compositeTitleBackground: '#1e293b',

    // mindmap — 라벨색은 cScaleLabel0..11(= labelTextColor invert 체인) 을 쓰므로
    // 무색/중심 노드가 dark-on-dark 로 사라진다. 12개 전부 명시해 invert fallback 을 끊음.
    cScaleLabel0: '#e5e7eb', cScaleLabel1: '#e5e7eb', cScaleLabel2: '#e5e7eb',
    cScaleLabel3: '#e5e7eb', cScaleLabel4: '#e5e7eb', cScaleLabel5: '#e5e7eb',
    cScaleLabel6: '#e5e7eb', cScaleLabel7: '#e5e7eb', cScaleLabel8: '#e5e7eb',
    cScaleLabel9: '#e5e7eb', cScaleLabel10: '#e5e7eb', cScaleLabel11: '#e5e7eb',
  },

  // useMaxWidth 가 참이면 mermaid 가 산출 <svg> 에 인라인 max-width 를 찍어 컨테이너 규칙을 이김 → 폭은 컨테이너가 정하도록 전부 해제.
  // BaseDiagramConfig 소속이라 상속이 없음 — 채택 타입(diagram-types.json)마다 따로 꺼야 함.
  // curve 는 두지 않음: ELK 아래에서는 렌더러가 rounded 로 고정한다.
  flowchart: {
    htmlLabels: true,
    padding: 12,
    // 화면이 존 rect 를 위로 늘려 제목 띠를 만들므로(architecture.jsx ZONE_TITLE_BAND) 기본 8 은 viewBox 밖으로 나감.
    diagramPadding: 16,
    nodeSpacing: 50,
    rankSpacing: 60,
    useMaxWidth: false,
  },
  sequence: { useMaxWidth: false },
  state: { useMaxWidth: false },
  er: { useMaxWidth: false },
  class: { useMaxWidth: false },
  gitGraph: { useMaxWidth: false },
  c4: { useMaxWidth: false },
};
