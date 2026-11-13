// Fixture data for the Queue page render harness: the sessions, items, orders and images of mockup v5's rest state,
// typed on the server's own view types → a change to the item view, session row or history read fails typecheck here.
// Item text keeps the mockup's shape (Korean bullets, backticks, a declared document, R1–R3 with pros and cons) in
// neutral wording: the mockup's sample text quotes private project work and this repository is public.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getImageFacts } from "../../src/server/queue/image-format.js";
import { ITEM_TITLE_MAX, SESSION_NAME_MAX } from "../../src/server/queue/schemas.js";
import type { ImageView } from "../../src/server/queue/images.js";
import type { OwnerItemView, OwnerSessionView, RecentResume } from "../../src/server/queue/owner-views.js";
import type { OwnerSessionRow } from "../../src/server/queue/owner-sessions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET_ROOT = resolve(HERE, "..", "..", "..", "docs", "assets");
const MIN_MS = 60_000;

/** The page's clock is pinned here → every relative age in a capture reads the same on every run (15:00 KST). */
export const FIXTURE_NOW = Date.UTC(2026, 10, 13, 6, 0, 0);
export const FIXTURE_CLI_PATH = "/Users/owner/.glass-atrium/scripts/atrium-queue.sh";

export interface FixtureImage {
  view: ImageView;
  bytes: Buffer;
  mime: string;
}

/** What the harness's fixture routes answer; a state swaps any part of it before its capture. */
export interface QueueFixture {
  items: OwnerItemView[];
  sessions: OwnerSessionRow[];
  orders: OwnerItemView[];
  resumes: RecentResume[];
}

const SESSION_IDS = {
  gersona: "25a65a54-3c1e-4f0a-9b2d-6e7f8a9b0c11",
  atrium: "e8923338-5d2f-4a1b-8c3e-7f9a0b1c2d22",
  aidl: "aca91592-6e3a-4b2c-9d4f-8a0b1c2d3e33",
  yoaida: "fa32c7cb-7f4b-4c3d-8e5a-9b1c2d3e4f44",
  portfolio: "5d0e77a1-8a5c-4d4e-9f6b-0c2d3e4f5a55",
} as const;
type SessionKey = keyof typeof SESSION_IDS;

const IMAGES = ["screen-dashboard.webp", "screen-agents.webp", "screen-cost.webp"].map((file, index) => getFixtureImage(file, index));

/** Image bytes by id, for the harness's serve route; nothing is read from a data directory. */
export const FIXTURE_IMAGES: ReadonlyMap<string, FixtureImage> = new Map(IMAGES.map((image) => [image.view.id, image]));

function getFixtureImage(file: string, index: number): FixtureImage {
  const bytes = readFileSync(resolve(ASSET_ROOT, file));
  const facts = getImageFacts(bytes);
  if (facts === null) throw new Error(`fixture image ${file} is not a PNG, JPEG, WebP or GIF`);
  const id = `0f1e2d3c-4b5a-4968-8778-6a5b4c3d2e1${index}`;
  const view: ImageView = { id, name: `queue-0${index + 1}.webp`, type: facts.type, bytes: bytes.length, width: facts.width, height: facts.height };
  return { view, bytes, mime: `image/${facts.type}` };
}

function getAt(minutesAgo: number): string {
  return new Date(FIXTURE_NOW - minutesAgo * MIN_MS).toISOString();
}

function buildSessionView(key: SessionKey): OwnerSessionView {
  return {
    id: SESSION_IDS[key],
    name: key,
    isNameRegistered: true,
    profileLabel: ".claude-work",
    cwd: "/Users/owner",
    cwdTail: "Users/owner",
    configDir: null,
    state: key === "portfolio" ? "exited" : "live",
    isWaiting: key !== "portfolio",
    permissionHint: "default",
    marker: null,
  };
}

function buildSessionRow(key: SessionKey, count: OwnerSessionRow["count"], minutesAgo: number): OwnerSessionRow {
  const view = buildSessionView(key);
  return {
    id: view.id,
    sessionIdPrefix: view.id.slice(0, 8),
    name: view.name,
    isNameRegistered: view.isNameRegistered,
    profileLabel: view.profileLabel,
    cwd: view.cwd,
    cwdTail: view.cwdTail,
    state: view.state,
    exitReason: key === "portfolio" ? "ended" : null,
    isWaiting: view.isWaiting,
    lastActivityAt: getAt(minutesAgo),
    count,
    markerSetAt: null,
    isSelectable: true,
  };
}

function buildItem(id: number, key: SessionKey, fields: Partial<OwnerItemView>): OwnerItemView {
  return {
    id, kind: "decision", title: "", body: "", linkedDocIds: [], options: [], recommendedCode: null,
    isFreeTextAllowed: true, isApprovalClass: false, status: "open", queuePosition: id, deferCount: 0, nextAttempt: 1,
    answer: { code: null, text: null }, askedAt: getAt(9), answeredAt: null, deliveredAt: null, sendId: null,
    attachments: [], answerRecord: null, isAnsweredOutside: false, session: buildSessionView(key), resumes: [],
    deviation: null, skipReason: null, canResend: false,
    ...fields,
  };
}

// one copy per recipient, as createMessages writes them: one send id, one answeredAt, one body
function buildOrderCopies(firstId: number, send: { sendId: string; minutesAgo: number; text: string; to: Array<[SessionKey, Partial<OwnerItemView>]>; images?: ImageView[] }): OwnerItemView[] {
  return send.to.map(([key, fields], index) => buildItem(firstId + index, key, {
    kind: "message", title: send.text.split("\n")[0], body: send.text, isFreeTextAllowed: false, status: "delivered",
    askedAt: getAt(send.minutesAgo), answeredAt: getAt(send.minutesAgo), sendId: send.sendId,
    attachments: send.images ?? [], answerRecord: { route: "message", signal: "fetch_metadata" },
    ...fields,
  }));
}

const DOC_LINE = "- 계획 문서: 모니터 44060, 이슈 DOC-120";

function buildDecision(id: number, title: string, bullets: string[], options: Array<[string, string, string]>, recommendedCode: string): OwnerItemView {
  return buildItem(id, "gersona", {
    title, body: [...bullets, DOC_LINE].join("\n"), linkedDocIds: [44060], recommendedCode,
    options: options.map(([label, pros, cons], index) => ({ code: `R${index + 1}`, label, pros, cons })),
  });
}

const DECISIONS = [
  buildDecision(103, "[도움말 프롬프트] 답의 꼴: 짧은 안내문 vs 지금의 단계별 설명", [
    "- 기획 초안은 짧은 안내문(한두 문장, 필요할 때만 예시)이고, 지금 백엔드 글은 2~5문단 단계별 설명(번호 목록 + 굵은 강조, 1,000자 안)입니다.",
    "- 두 글이 정면으로 다르고, 바꾸려면 예전에 최종 글로 정한 안내 목적 글(`guide`)을 고쳐야 합니다.",
    "- 공개 자료로 가릴 수 있는 문제가 아니라 제품 의도로 정할 일입니다.",
  ], [
    ["짧은 안내문으로 교체", "초안의 표현 규칙이 그대로 들어맞고 화면에서 읽기 쉽다", "안내 목적 글과 예문, 스냅샷 시험이 함께 바뀌고 설명 깊이가 줄어든다"],
    ["지금 꼴 유지, 짧은 안내문은 모델별 비교 평가 뒤 결정", "이미 정한 글과 시험을 건드리지 않고, 근거를 보고 정할 수 있다", "초안이 말하는 짧은 느낌과는 당분간 다르다. 짧은 질문에도 두 문단을 채운다"],
    ["기본은 짧게, 회원이 자세히를 누르면 단계별 설명", "두 쓰임을 모두 받는다", "모델이 전환 시점을 판단해야 해 답이 들쭉날쭉해질 수 있고 평가가 가장 어렵다"],
  ], "R2"),
  buildDecision(104, "[도움말 프롬프트] 모르는 질문에 어떻게 답할지", [
    "- 지금 규칙: 범위 밖 질문도 아는 만큼 답하고 출처는 밝히지 않습니다. 서버의 출처 표시 설정은 기본 꺼짐입니다.",
    "- 초안은 여기에 \"모르면 모른다고 짧게 답한다\"를 더합니다.",
    "- 조사 결과: 일부 모델은 범위 밖 질문을 거절하라는 지시를 일관되게 따르지 않습니다. 고객 지원 지침은 출처 표시를 권한다는 자료가 있습니다(요약본 기준, 확인 필요).",
  ], [
    ["초안의 짧은 거절은 넣지 않고, 지금 규칙과 출처 표시 설정을 검토에 올림", "답이 끊기는 표현을 피하고, 검토 전에 위험을 키우지 않는다", "검토 답이 올 때까지 지금 규칙이 그대로 남는다"],
    ["초안대로 반영", "기획 초안과 일치한다", "답이 자주 끊겨 불만이 늘 수 있고, 모델마다 따르는 정도가 달라진다"],
    ["범위 밖이면 출처와 함께 답하도록 지금 규칙을 바꿈", "근거를 가장 분명하게 보인다", "답이 길어질 수 있고, 예전 결정을 바꾸는 일이라 안내 목적 글을 고쳐야 한다"],
  ], "R1"),
  buildDecision(105, "[도움말 프롬프트] 도우미가 자기를 무엇으로 소개할지: 이름 vs 표시명", [
    "- 초안은 \"이름은 등록·관리용이고 표시명(역할)이 대화용\"이라고 전제합니다.",
    "- 우리 시스템에서는 이름(8자)과 표시명(20자)이 둘 다 화면에 보이는 값이고 중복도 허용합니다. 초안의 전제가 맞지 않습니다.",
    "- 코드로는 어느 쪽으로 소개할지 정해져 있지 않습니다.",
  ], [
    ["표시명으로 소개하고 이름은 대화에 쓰지 않음", "초안의 뜻과 가깝다", "표시명이 역할이나 별칭(\"친절한 안내원\")이면 자기소개가 어색해진다"],
    ["이름으로 소개하고 표시명은 별칭·역할로 받음", "이름 칸의 뜻과 맞고, 표시명이 역할이어도 자연스럽다", "초안의 전제와 반대라 기획에 알려야 한다"],
    ["기획에 먼저 확인", "화면 문구와 기획 의도를 맞춘 뒤 정한다", "그동안 이 줄만 비워 두고 진행한다"],
  ], "R2"),
  buildDecision(106, "[도움말 프롬프트] 다룰 주제의 범위를 어디까지 둘지", [
    "- 초안은 도우미가 제품 설명서 밖의 주제를 아예 다루지 않는 것으로 하고, 파일·문서·코드·표 같은 산출물 제작과 도구 사용도 못 한다고 적습니다.",
    "- 우리 시스템엔 웹 검색 도구, 첨부 파일 읽기, \"설정 방법을 차근차근 설명한다\" 같은 특기 문구가 있어 그대로는 충돌합니다.",
  ], [
    ["초안대로 전면 적용하고 특기 문구와 도구를 그에 맞춰 고침", "답의 범위가 가장 분명하다", "특기·웹 검색·첨부 기능의 쓰임이 크게 줄고 고칠 범위가 넓다"],
    ["넣지 않음", "지금 기능과 충돌이 없다", "도우미가 무엇이든 답하는 일반 챗봇처럼 느껴질 수 있다"],
    ["설명서 밖 전문 주제의 대행과 문서·표 만들기만 막고, 고른 특기와 안전 안내·도구 결과는 허용", "범위를 지키면서 지금 기능(특기, 웹 검색, 첨부)과 충돌하지 않는다", "경계가 글로만 정해져 모델별 평가가 필요하다"],
  ], "R3"),
  buildDecision(107, "[도움말 프롬프트] \"말투는 정중하게 시작\" 규칙을 넣을지", [
    "- 초안: 호칭·말투는 설정한 관계에서 바로 출발하되, 가벼운 농담은 대화가 쌓인 만큼만 보인다.",
    "- 넣으면 친근하게 설정한 도우미도 처음에는 덜 가깝게 느껴집니다. 제품 체감이 바뀌는 규칙입니다.",
  ], [
    ["넣되 친근한 설정은 따로 평가", "갑자기 가까운 말투를 쓰는 어색함을 줄이고, 관계가 쌓이는 느낌을 준다", "친근한 설정에서 처음이 차갑게 느껴질 수 있어 평가가 필요하다"],
    ["넣지 않음", "설정한 말투가 처음부터 그대로 느껴진다", "대화 기록이 없는데도 가까운 말투를 전제한 답이 나올 수 있다"],
  ], "R1"),
];

const REPORTS = [
  buildItem(101, "yoaida", {
    kind: "report", askedAt: getAt(10),
    title: "주문 서비스 단일 출처 작업 — 세 저장소 최종 정리·리뷰 완료, API 후속 수정 진행 중",
    body: [
      "- API: 최종 정리·리뷰·필수 수정 8건 반영 완료 (끝 커밋 `684bac3b`, 테스트 3280건 통과, 빌드 통과)",
      "- 웹: 완료 (`e3ec857f`, 361건 통과) · 관리 화면: 완료 (`eb4ec43`, 294건 통과, 빌드 통과)",
      "- 동작이 바뀐 곳: 수량 없이 올린 주문 파일 업로드는 400 거절(전에는 기본 수량으로 처리) · 무료 요금제 회원에게 다음 결제일을 보내지 않음",
      "- 진행 중: API 후속(웹·관리 화면이 기다리는 응답 항목 7건 + 리뷰 권고) → 타입 재생성 → 웹·관리 화면 후속 → 브라우저 확인(로그인 필요)",
      "- 아직 안 한 것: DB 기반 테스트 두 묶음 실행, dev DB 반영(DB-3), 병합 — 모두 승인 뒤",
      "- 디스크: 끝난 작업 폴더 12개 정리, 여유 5.8 GB → 22 GB",
    ].join("\n"),
  }),
  buildItem(102, "atrium", {
    kind: "report", askedAt: getAt(10),
    title: "배포 #60 완료 — 보고 큐 설정 없이 사용 가능",
    body: [
      "배포 #60이 라이브에 반영됐습니다 (`integration/deploy-60` @ `bbc6686c`).",
      "",
      "- 보고 큐: 로그인·설정 없이 Queue 페이지가 바로 열립니다. 세션 목록(이름 표시)과 다중 선택 메시지 전송이 들어갔습니다.",
      "- 업데이터: 다음 업데이트부터 모니터 의존성 설치와 Prisma 생성을 직접 합니다.",
      "- 검증: 라이브 전체 테스트 실패 0건(bats 3361 통과, 그중 84 건너뜀), 읽기 전용 검증 통과.",
      "- 마이그레이션 3건 적용, 기존 행 변경 0건, 적용 전 DB 덤프 보관.",
      "",
      "남은 일: 큐 실사용 확인(결정 요청 → 페이지에서 답변 → 세션 수령, 페이지에서 세션으로 메시지 전송), PR 병합 단계, 모니터 UI 나머지 화면.",
    ].join("\n"),
  }),
];

const ANSWERED_DECISION = buildItem(108, "aidl", {
  status: "answered", askedAt: getAt(42), answeredAt: getAt(31), linkedDocIds: [44047], recommendedCode: "R1",
  title: "[연동] 파트너 연동 안내를 어디에 둘지",
  body: "- 파트너가 읽을 연동 안내를 API 명세 위쪽에 둘지, 별도 문서로 둘지 정해야 합니다.\n- 계획 문서: 모니터 44047",
  options: [
    { code: "R1", label: "API 명세 위쪽 안내로", pros: "파트너가 한 곳만 보면 된다", cons: "명세 화면이 길어진다" },
    { code: "R2", label: "별도 문서로", pros: "명세 화면이 짧게 남는다", cons: "두 곳을 함께 고쳐야 한다" },
  ],
  answer: { code: "R1", text: null }, answerRecord: { route: "answer", signal: "fetch_metadata" },
});

const YESTERDAY_18_KST_MINUTES = 21 * 60;
const SEND_IDS = {
  yesterday: "9e8d7c6b-5a49-4382-a716-1f0e2d3c4b01",
  readme: "9e8d7c6b-5a49-4382-a716-1f0e2d3c4b02",
  screens: "9e8d7c6b-5a49-4382-a716-1f0e2d3c4b03",
  inDelivery: "9e8d7c6b-5a49-4382-a716-1f0e2d3c4b04",
  notReceived: "9e8d7c6b-5a49-4382-a716-1f0e2d3c4b05",
} as const;

// the one order still in delivery: in the owner list (answered) and in the history read
const IN_DELIVERY_ORDER = buildOrderCopies(109, {
  sendId: SEND_IDS.inDelivery, minutesAgo: 3,
  text: "API 후속 수정이 끝나면 dev DB 반영(DB-3) 전에 DB 기반 테스트 두 묶음을 먼저 돌리고 결과를 보고해 주세요.\n병합은 그 보고를 본 뒤 승인하겠습니다.",
  to: [["yoaida", { status: "answered", deliveredAt: null }]],
});

const RECEIVED_ORDERS = [
  ...buildOrderCopies(201, {
    sendId: SEND_IDS.yesterday, minutesAgo: YESTERDAY_18_KST_MINUTES, text: "오늘 작업이 끝나면 바뀐 점을 보고 한 건으로 올려 주세요.",
    to: [["gersona", { deliveredAt: getAt(YESTERDAY_18_KST_MINUTES - 2) }], ["aidl", { deliveredAt: getAt(YESTERDAY_18_KST_MINUTES - 5) }]],
  }),
  ...buildOrderCopies(203, {
    sendId: SEND_IDS.readme, minutesAgo: 85, text: "배포가 끝나면 큐 설정 안내를 README에 옮겨 주세요.",
    to: [["atrium", { deliveredAt: getAt(83) }]],
  }),
  ...buildOrderCopies(204, {
    sendId: SEND_IDS.screens, minutesAgo: 40, text: "Queue 화면에서 표시한 세 곳을 고쳐 주세요. 글자 크기, 목록 위계, 명령 입력창입니다.",
    to: [["atrium", { deliveredAt: getAt(39) }]], images: IMAGES.map((image) => image.view),
  }),
];

/** An order no session acknowledged in time: the amber `Not received` with `Resend` (mockup state 09). */
export const NOT_RECEIVED_ORDER = buildOrderCopies(210, {
  sendId: SEND_IDS.notReceived, minutesAgo: 25, text: "오늘 작업을 마치기 전에 남은 일과 막힌 곳을 한 줄씩 보고해 주세요.",
  to: [["yoaida", { status: "unacked", deviation: "unacked", canResend: true }]],
});

const SESSION_ROWS = [
  buildSessionRow("gersona", { awaiting: 5, inDelivery: 0 }, 9),
  buildSessionRow("atrium", { awaiting: 1, inDelivery: 0 }, 10),
  buildSessionRow("aidl", { awaiting: 0, inDelivery: 1 }, 10),
  buildSessionRow("yoaida", { awaiting: 1, inDelivery: 1 }, 10),
  buildSessionRow("portfolio", { awaiting: 0, inDelivery: 0 }, 180),
];

const RESUMES: RecentResume[] = [
  { sentAt: getAt(22), attempt: 1, result: "acked", abortReason: null, bgId: null, item: { id: 108, title: ANSWERED_DECISION.title }, session: { profileLabel: ".claude-work", cwdTail: "Users/owner" } },
  { sentAt: getAt(75), attempt: 1, result: "acked", abortReason: null, bgId: null, item: { id: 204, title: RECEIVED_ORDERS[3]!.title }, session: { profileLabel: ".claude-work", cwdTail: "Users/owner" } },
];

/** Mockup v5's rest state: 5 decisions, 2 reports, 2 in delivery; 4 live sessions and the ended `portfolio`. */
export function getRestFixture(): QueueFixture {
  return {
    items: [...REPORTS, ...DECISIONS, ANSWERED_DECISION, ...IN_DELIVERY_ORDER],
    sessions: SESSION_ROWS,
    orders: [...RECEIVED_ORDERS, ...IN_DELIVERY_ORDER],
    resumes: RESUMES,
  };
}

/** The rest state plus the not-received order to `yoaida`, in the owner list and the history read alike. */
export function getNotReceivedFixture(): QueueFixture {
  const rest = getRestFixture();
  return { ...rest, items: [...rest.items, ...NOT_RECEIVED_ORDER], orders: [...rest.orders, ...NOT_RECEIVED_ORDER] };
}

/** The rest state plus a report `yoaida` posts after the page first read it, its rail count raised with it. */
export function getArrivalFixture(): QueueFixture {
  const rest = getRestFixture();
  const report = buildItem(150, "yoaida", { kind: "report", askedAt: getAt(0), title: "야간 정리 작업 완료 — 끝난 작업 폴더 4개 정리", body: "- 끝난 작업 폴더 4개를 정리했습니다." });
  const sessions = rest.sessions.map((row) => (row.id === SESSION_IDS.yoaida ? { ...row, count: { ...row.count, awaiting: row.count.awaiting + 1 } } : row));
  return { ...rest, items: [...rest.items, report], sessions };
}

/** Nothing open: the In delivery band alone, its first row an order, and an order between its two answered decisions → stepping passes over orders. */
export function getOrderFirstFixture(): QueueFixture {
  const rest = getRestFixture();
  const second = { ...ANSWERED_DECISION, id: 160, askedAt: getAt(18), title: "배포 전 업데이터 점검 순서" };
  return { ...rest, items: [...IN_DELIVERY_ORDER, ANSWERED_DECISION, ...NOT_RECEIVED_ORDER, second], orders: [...rest.orders, ...NOT_RECEIVED_ORDER] };
}

/** The order the owner types in states 06–08, to `gersona` and `yoaida` (mockup v5 §18.3). */
export const FIXTURE_ORDER_TEXT = "오늘 결정한 내용은 내일 오전 보고에 한 줄씩 정리해 주세요.";

/** The rest state plus that order sent with the three images, `gersona` having received it and `yoaida` not yet. */
export function getOneReceivedFixture(): QueueFixture {
  const rest = getRestFixture();
  const sent = buildOrderCopies(220, {
    sendId: "9e8d7c6b-5a49-4382-a716-1f0e2d3c4b06", minutesAgo: 1, text: FIXTURE_ORDER_TEXT, images: IMAGES.map((image) => image.view),
    to: [["gersona", { deliveredAt: getAt(0) }], ["yoaida", { status: "answered", deliveredAt: null }]],
  });
  return { ...rest, items: [...rest.items, sent[1]!], orders: [...rest.orders, ...sent] };
}

/** The rest state with the aidl answer gone unacknowledged: `Not received` on the sheet with `Resend answer`. */
export function getAnswerNotReceivedFixture(): QueueFixture {
  const rest = getRestFixture();
  const unacked = { ...ANSWERED_DECISION, status: "unacked" as const, deviation: "unacked" as const, canResend: true };
  return { ...rest, items: rest.items.map((item) => (item.id === ANSWERED_DECISION.id ? unacked : item)) };
}

/** No item left and no order sent: the empty queue and the empty thread. */
export function getEmptyFixture(): QueueFixture {
  const rest = getRestFixture();
  return { ...rest, items: [], orders: [], sessions: rest.sessions.map((row) => ({ ...row, count: { awaiting: 0, inDelivery: 0 } })) };
}

/** The rest state with `atrium` no longer answering: its rail row `Not reachable`. */
export function getUnreachableFixture(): QueueFixture {
  const rest = getRestFixture();
  return { ...rest, sessions: rest.sessions.map((row) => (row.id === SESSION_IDS.atrium ? { ...row, state: "stale" as const, lastActivityAt: getAt(14) } : row)) };
}

/** The rest state after `yoaida` was replaced: its row listed, no longer taking a message (a tick on it is dropped). */
export function getStoppedFixture(): QueueFixture {
  const rest = getRestFixture();
  return { ...rest, sessions: rest.sessions.map((row) => (row.id === SESSION_IDS.yoaida ? { ...row, state: "exited" as const, exitReason: "replaced", isSelectable: false } : row)) };
}

/**
 * The copies one taken send writes, as the send route stores them: one per recipient, awaiting receipt.
 * @param firstId - the first copy's item id; the rest follow it
 */
export function buildSentCopies(firstId: number, send: { sendId: string; sessionIds: string[]; text: string; images: ImageView[] }): OwnerItemView[] {
  const keys = Object.keys(SESSION_IDS) as SessionKey[];
  const to = send.sessionIds.flatMap((id): Array<[SessionKey, Partial<OwnerItemView>]> => {
    const key = keys.find((candidate) => SESSION_IDS[candidate] === id);
    return key === undefined ? [] : [[key, { status: "answered", deliveredAt: null }]];
  });
  return buildOrderCopies(firstId, { sendId: send.sendId, minutesAgo: 0, text: send.text, to, images: send.images });
}

export const FIXTURE_SESSION_IDS = SESSION_IDS;

// spec 44063 §14.4's edge cases, beside the rest state: the page's limits and the facts that only show next to a neighbour
export const EDGE_SESSION_IDS = {
  twin: "b7c6d5e4-0f1a-4b2c-8d3e-1a2b3c4d5e66",
  longName: "c8d7e6f5-1a2b-4c3d-9e4f-2b3c4d5e6f77",
  busy: "d9e8f7a6-2b3c-4d4e-8f5a-3c4d5e6f7a88",
} as const;

/** The longest name a session can register (`schemas.ts` → SESSION_NAME_MAX). */
export const EDGE_LONG_SESSION_NAME = "nightly-dependency-audit-and-release-notes-for-the-public-monitor-installer-and-its-update-script-ci";
if (EDGE_LONG_SESSION_NAME.length !== SESSION_NAME_MAX) throw new Error(`the long-name fixture is ${EDGE_LONG_SESSION_NAME.length} characters, not ${SESSION_NAME_MAX}`);

/** The longest title an item can carry (`schemas.ts` → ITEM_TITLE_MAX). */
export const EDGE_LONG_TITLE = "[정리 작업] 세 저장소의 끝난 작업 폴더 정리, 의존성 감사, 릴리스 노트 초안, 설치 스크립트 점검을 한 번에 진행한 결과 — 웹·관리 화면·API 모두 테스트 통과, dev DB 반영과 병합은 승인 대기, 디스크 여유 22GB 확보, 남은 일은 브라우저 확인과 README 안내 이동, 그리고 다음 배포 전 업데이터 점검과 모니터 화면 나머지 정리입니다";
if (EDGE_LONG_TITLE.length !== ITEM_TITLE_MAX) throw new Error(`the long-title fixture is ${EDGE_LONG_TITLE.length} characters, not ${ITEM_TITLE_MAX}`);

/** Item ids and send ids of the edge cases, for the tests that select them. */
export const EDGE_IDS = {
  nineOptions: 301, approval: 302, longTitle: 303, linkedReport: 304, declaredReport: 305, threeReceipts: 310, eightImages: 320,
  threeReceiptsSend: "9e8d7c6b-5a49-4382-a716-1f0e2d3c4b10", eightImagesSend: "9e8d7c6b-5a49-4382-a716-1f0e2d3c4b11",
} as const;

// eight distinct ids over the three asset files → an order at the per-order image limit
const EDGE_IMAGES: FixtureImage[] = Array.from({ length: 8 }, (_, index) => {
  const image = IMAGES[index % IMAGES.length]!;
  return { ...image, view: { ...image.view, id: `1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5${index}`, name: `queue-edge-0${index + 1}.${image.view.type}` } };
});

/** The edge orders' image bytes by id, beside FIXTURE_IMAGES for the harness's serve route. */
export const EDGE_FIXTURE_IMAGES: ReadonlyMap<string, FixtureImage> = new Map(EDGE_IMAGES.map((image) => [image.view.id, image]));

function buildEdgeSession(id: string, name: string, awaiting: number): { view: OwnerSessionView; row: OwnerSessionRow } {
  const view: OwnerSessionView = { ...buildSessionView("atrium"), id, name };
  const row: OwnerSessionRow = { ...buildSessionRow("atrium", { awaiting, inDelivery: 0 }, 12), id, sessionIdPrefix: id.slice(0, 8), name };
  return { view, row };
}

const EDGE_SESSIONS = {
  twin: buildEdgeSession(EDGE_SESSION_IDS.twin, "atrium", 1),
  longName: buildEdgeSession(EDGE_SESSION_IDS.longName, EDGE_LONG_SESSION_NAME, 0),
  busy: buildEdgeSession(EDGE_SESSION_IDS.busy, "batch", 128),
};

const NINE_OPTION_LABELS = ["지금 꼴 유지", "짧은 안내문", "단계별 설명", "모델별 평가 뒤 결정", "기획에 먼저 확인", "회원 설정으로", "화면별로 다르게", "다음 배포로 미룸", "검토에 올림"];

const EDGE_ITEMS = [
  buildItem(EDGE_IDS.nineOptions, "gersona", {
    title: "[도움말 프롬프트] 답의 꼴을 아홉 안 가운데 하나로 정하기",
    body: "- 기획 초안과 지금 백엔드 글이 다르고, 검토에서 아홉 가지 안이 나왔습니다.\n- 계획 문서: 모니터 44060",
    linkedDocIds: [44060], recommendedCode: "R4",
    options: NINE_OPTION_LABELS.map((label, index) => ({ code: `R${index + 1}`, label, pros: "지금 기능과 충돌이 없다", cons: "평가가 필요하다" })),
  }),
  buildItem(EDGE_IDS.approval, "aidl", {
    title: "[배포] dev DB 반영(DB-3) 승인", isApprovalClass: true, recommendedCode: "R1",
    body: "- DB 기반 테스트 두 묶음이 통과했습니다.\n- 반영 전 덤프를 보관합니다.",
    options: [
      { code: "R1", label: "지금 반영", pros: "다음 작업이 바로 이어진다", cons: "반영 중 dev DB 쓰기가 잠시 멈춘다" },
      { code: "R2", label: "내일 오전 반영", pros: "작업 시간을 피한다", cons: "후속 작업이 하루 밀린다" },
    ],
  }),
  buildItem(EDGE_IDS.longTitle, "yoaida", { kind: "report", title: EDGE_LONG_TITLE, body: "- 세 저장소 모두 테스트 통과\n- dev DB 반영과 병합은 승인 대기" }),
  buildItem(EDGE_IDS.linkedReport, "atrium", {
    kind: "report", title: "배포 #61 계획 검토 완료", linkedDocIds: [44061],
    body: "- 계획 모니터 44061을 검토했고 필수 수정 2건을 반영했습니다.\n- 다음 단계: 구현 위임",
  }),
  buildItem(EDGE_IDS.declaredReport, "atrium", {
    kind: "report", session: EDGE_SESSIONS.twin.view, title: "업데이터 점검 완료", linkedDocIds: [44071],
    body: "- 업데이터의 의존성 단계가 빠진 도구를 다시 설치하는지 점검했습니다.\n- 남은 일 없음",
  }),
];

// the delivered copy leaves the owner list (TERMINAL) and stays in the history read, as on the server
const THREE_RECEIPT_ORDER = buildOrderCopies(EDGE_IDS.threeReceipts, {
  sendId: EDGE_IDS.threeReceiptsSend, minutesAgo: 30, text: "오늘 바뀐 점을 보고 한 건으로 올려 주세요.",
  to: [["gersona", { deliveredAt: getAt(28) }], ["aidl", { status: "answered", deliveredAt: null }], ["yoaida", { status: "unacked", deviation: "unacked", canResend: true }]],
});

const EIGHT_IMAGE_ORDER = buildOrderCopies(EDGE_IDS.eightImages, {
  sendId: EDGE_IDS.eightImagesSend, minutesAgo: 20, text: "표시한 여덟 화면의 글자 크기를 한 단계씩 줄여 주세요.", images: EDGE_IMAGES.map((image) => image.view),
  to: [["atrium", { status: "answered", deliveredAt: null }]],
});

/** The rest state plus every edge case of spec 44063 §14.4 the rest state leaves out, its new sessions at the rail's end. */
export function getEdgeFixture(): QueueFixture {
  const rest = getRestFixture();
  const listed = THREE_RECEIPT_ORDER.filter((copy) => copy.status !== "delivered");
  return {
    ...rest,
    items: [...rest.items, ...EDGE_ITEMS, ...listed, ...EIGHT_IMAGE_ORDER],
    sessions: [...rest.sessions, ...Object.values(EDGE_SESSIONS).map((session) => session.row)],
    orders: [...rest.orders, ...THREE_RECEIPT_ORDER, ...EIGHT_IMAGE_ORDER],
  };
}
