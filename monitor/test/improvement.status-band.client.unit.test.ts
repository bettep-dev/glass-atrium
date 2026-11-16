// Render guards for the status band in public/src/screens/improvement.jsx.
//
// The band is one StatRow of the counts that change the operator's next action. Its
// contract: every payload state reads distinctly, nothing reads as a zero that was never
// loaded, and a value and its population are counted over the same table. Same harness
// limit as the sibling guards — the emitted element tree, not CSS.
//
// Runner: npx tsx --test test/improvement.status-band.client.unit.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";
import { createFakeDocument } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMPROVEMENT_SRC = resolve(__dirname, "../public/src/screens/improvement.jsx");

interface RecordedElement {
  type: unknown;
  props: Record<string, unknown>;
}

interface BandSandbox {
  React: { createElement: unknown };
  window: { UI: Record<string, unknown> };
  document: Record<string, unknown>;
  tileStatusI: (state: { status: string }, value: unknown) => string;
  StatusBandI: (props: Record<string, unknown>) => RecordedElement;
  InstrumentationViewI: (props: Record<string, unknown>) => RecordedElement | null;
  getBannerFocusTargetI: (view: string) => string;
  getPageFailuresI: (regions: unknown[], view: string) => { banner: unknown; speakers: Map<string, string> };
  KanbanCardI: (props: Record<string, unknown>) => RecordedElement;
  BucketRowI: (props: Record<string, unknown>) => RecordedElement;
  ErrorBannerI: (props: Record<string, unknown>) => RecordedElement;
  BoardRowI: (props: Record<string, unknown>) => RecordedElement;
  CompactProposalCardI: (props: Record<string, unknown>) => RecordedElement;
  ProposalCardI: (props: Record<string, unknown>) => RecordedElement;
  LedgerHeldSectionI: (props: Record<string, unknown>) => RecordedElement | null;
  InstrumentationStripI: (props: Record<string, unknown>) => RecordedElement | null;
  getInstrumentationChipsI: (
    verdicts: unknown,
    styleRef: unknown,
    corpusAuditState: unknown,
    at?: string | null,
  ) => Array<Record<string, unknown>>;
}

function isElement(value: unknown): value is RecordedElement {
  return typeof value === "object" && value !== null && "props" in value && "type" in value;
}

function collectElements(node: unknown, out: RecordedElement[]): RecordedElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (!isElement(node)) return out;
  out.push(node);
  const children = node.props.children;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) collectElements(child, out);
  return out;
}

// Depth-first concatenation of every string/number leaf, function children left
// uninvoked — every placeholder branch emits host elements only.
function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isElement(node)) return "";
  return Object.values(node.props)
    .filter(
      (v) => Array.isArray(v) || isElement(v) || typeof v === "string" || typeof v === "number",
    )
    .map(textOf)
    .join(" ");
}

const sandbox = await buildScreenSandbox<BandSandbox>(IMPROVEMENT_SRC);
sandbox.React.createElement = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => ({
  type,
  props: { ...(props ?? {}), children: rest.length > 1 ? rest : rest[0] },
});
// Installed once → every test sees the same UI, whatever order they run in.
const PageVerdictStub = () => null;
Object.assign(sandbox.window.UI, { titleOf: (value: unknown) => value, PageVerdict: PageVerdictStub });

// The relationship, not four hand-picked pairs: the tile's state is the payload's
// state, except that a landed payload carrying no value is "unavailable", never ready.
test("a tile's state follows its own payload, and a missing value is never ready", () => {
  assert.equal(sandbox.tileStatusI({ status: "loading" }, { n: 1 }), "loading");
  assert.equal(sandbox.tileStatusI({ status: "error" }, { n: 1 }), "error");
  assert.equal(sandbox.tileStatusI({ status: "ready" }, null), "unavailable");
  assert.equal(sandbox.tileStatusI({ status: "ready" }, undefined), "unavailable");
  assert.equal(sandbox.tileStatusI({ status: "ready" }, { n: 1 }), "ready");
});

const LANDED = { status: "ready", busy: false, error: null, data: {} };
const STATS_DATA = {
  cycles_generated_applied_7d: 3,
  cycle_total_7d: 12,
  latest_cycle_started_at: "2026-09-16T10:00:00.000Z",
};
const NEEDS_HUMAN = [{ cause: "repeat-apply-cap", count: 2, agents: 1 }];

type BandStat = { key: string; label: string; value: unknown; context?: unknown };

function renderBand(props: Record<string, unknown> = {}): RecordedElement {
  return sandbox.StatusBandI({
    asOf: null,
    statsState: { ...LANDED, data: STATS_DATA },
    listState: LANDED,
    learningLogState: LANDED,
    suppression: { pending_total: 0, parked: [] },
    awaiting: 0,
    ...props,
  });
}

// the stats the band hands its one StatRow, keyed by stat key
function getBandStats(props: Record<string, unknown> = {}): Map<string, BandStat> {
  const statRow = collectElements(renderBand(props), []).find((el) => el.type === sandbox.window.UI.StatRow);
  assert.ok(statRow, "the band must render one shared StatRow");
  return new Map(Array.from(statRow.props.stats as BandStat[], (stat) => [stat.key, stat]));
}

test("the band is one stat row of the counts that change the next action, with no verdict line and no tiles", () => {
  const elements = collectElements(renderBand({ awaiting: 2, suppression: { pending_total: 4, parked: NEEDS_HUMAN } }), []);
  const stats = getBandStats({ awaiting: 2 });

  assert.deepEqual([...stats.values()].map((stat) => stat.label), ["Awaiting your decision", "Applied, 7d", "Held, needs a human"]);
  assert.equal(elements.filter((el) => el.type === sandbox.window.UI.StatRow).length, 1);
  assert.ok(!elements.some((el) => el.type === PageVerdictStub), "the verdict line under the h1 is retired");
  assert.ok(!elements.some((el) => el.type === sandbox.window.UI.KPI), "a tile per stat is retired");
});

test("no stat carries a status glyph — attention lives in the card that owns the rows", () => {
  const stats = getBandStats({ awaiting: 2, suppression: { pending_total: 4, parked: NEEDS_HUMAN } });
  for (const stat of stats.values()) {
    const glyphs = collectElements([stat.label, stat.value], []).filter(
      (el) => typeof el.type === "function" && /^(SymI|Icon)$/.test((el.type as { name: string }).name),
    );
    assert.equal(glyphs.length, 0, `${stat.label} draws a glyph`);
  }
});

describe("a stat whose payload has not landed never shows the value it was handed", () => {
  const rows = [
    { name: "a first read in flight is busy", state: { status: "loading", data: null }, kind: "loading" },
    { name: "a failed read reads Not loaded and points at its owning group", state: { status: "error", data: null, error: "HTTP 500" }, kind: "not-loaded", context: /^Not read — see the .+ below$/ },
    { name: "a landed payload with no value reads Not loaded", state: { status: "ready", data: null }, kind: "not-loaded", context: /no value/ },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const stats = getBandStats({ statsState: row.state, listState: row.state, learningLogState: row.state, suppression: row.state.data, awaiting: 7 });
      for (const stat of stats.values()) {
        const value = stat.value as RecordedElement;
        assert.ok(!/\d/.test(textOf(value)), `${stat.label} shows a number it never read`);
        if (row.kind === "loading") assert.equal(value.props["aria-busy"], "true", stat.label);
        else {
          assert.equal(value.type, sandbox.window.UI.AbsentValue, stat.label);
          assert.equal(value.props.kind, "not-loaded", stat.label);
          assert.match(textOf(stat.context), row.context as RegExp, stat.label);
        }
      }
    });
  }
});

test("a stat in flight holds its context line blank, so the card keeps its height when the read lands", () => {
  const loading = { status: "loading", data: null };
  const stats = getBandStats({ statsState: loading, listState: loading, learningLogState: loading, suppression: null });
  for (const stat of stats.values()) {
    assert.ok(stat.context, `${stat.label} drops its context line while loading`);
    assert.equal(textOf((stat.context as RecordedElement).props.children).trim(), "", `${stat.label} prints a context it has not read`);
  }
});

test("the applied stat is counted over the same population its context names, last cycle stamp whole", () => {
  const applied = getBandStats().get("applied");
  const stamp = collectElements(applied?.context, []).find((el) => el.type === sandbox.window.UI.NoWrap);

  assert.equal(applied?.value, "3", "the value is the cycle count its population denominates");
  assert.match(textOf(applied?.context), /of 12 cycles · last /);
  assert.ok(stamp, "the last-cycle stamp is one unbreakable token");
});

test("the applied stat names a one-cycle week in the singular", () => {
  const applied = getBandStats({ statsState: { ...LANDED, data: { cycles_generated_applied_7d: 1, cycle_total_7d: 1 } } }).get("applied");
  assert.match(textOf(applied?.context), /of 1 cycle · /);
});

test("the held count links to the ledger's held section only while a held pattern needs a human", () => {
  const byDesign = getBandStats({ suppression: { pending_total: 0, parked: [{ cause: "non-promptable", count: 4, agents: 2 }] } }).get("held");
  const suppression = { pending_total: 0, parked: NEEDS_HUMAN, parked_patterns: [] };
  const jump = getBandStats({ suppression }).get("held")?.value as RecordedElement;
  // the screen's jump wrapper rendered one level → the shared Link it hands the count
  const needsHuman = (jump.type as (props: Record<string, unknown>) => RecordedElement)(jump.props);
  const heldIds = collectElements(sandbox.LedgerHeldSectionI({ suppression }), []).map((el) => el.props.id);

  assert.equal(byDesign?.value, "0", "rows closed by a design decision wait on no one, so no link");
  assert.equal(needsHuman.type, sandbox.window.UI.Link);
  assert.equal(textOf(needsHuman.props.children), "2");
  assert.ok(heldIds.includes(String(needsHuman.props.href).replace(/^#/, "")), "the link lands on the held section");
});

describe("a failed refresh over held numbers marks them Last known", () => {
  const asOf = new Date().toISOString();
  const rows = [
    { name: "the empty decision queue", key: "awaiting", props: { listState: { ...LANDED, error: "HTTP 500" } } },
    { name: "the applied count", key: "applied", props: { statsState: { ...LANDED, data: STATS_DATA, error: "HTTP 500" } } },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const settled = getBandStats({ asOf }).get(row.key);
      const warmError = getBandStats({ asOf, ...row.props }).get(row.key);
      assert.doesNotMatch(textOf(settled?.context), /Last known/);
      assert.match(textOf(warmError?.context), /^Last known · /);
    });
  }
});

test("clicking the held count keeps the hash and moves focus to the held section without a scroll jump", () => {
  const suppression = { pending_total: 0, parked: NEEDS_HUMAN, parked_patterns: [] };
  const jump = getBandStats({ suppression }).get("held")?.value as RecordedElement;
  const link = (jump.type as (props: Record<string, unknown>) => RecordedElement)(jump.props);
  const attributes = new Map<string, string>();
  const calls: unknown[][] = [];
  const section = {
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    scrollIntoView: (options: unknown) => calls.push(["scroll", options]),
    focus: (options: unknown) => calls.push(["focus", options]),
  };
  const heldId = String(link.props.href).replace(/^#/, "");
  const doc = createFakeDocument();
  doc.elements.set(heldId, section);
  const fileDocument = sandbox.document;
  let isDefaultPrevented = false;

  sandbox.document = doc as unknown as Record<string, unknown>;
  try {
    (link.props.onClick as (event: unknown) => void)({ preventDefault: () => { isDefaultPrevented = true; } });
  } finally {
    sandbox.document = fileDocument;
  }

  assert.equal(isDefaultPrevented, true, "the default navigation would hand the hash router an unknown screen");
  assert.equal(attributes.get("tabindex"), "-1", "a plain section takes focus only through tabindex -1");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["scroll", { block: "nearest" }], ["focus", { preventScroll: true }]]);
});

// a held corpus reading under a failed refresh takes the shared freshness rule; the strip then shows it only while it alerts
describe("the corpus growth gauge keeps the shared freshness rule over a failed refresh", () => {
  const asOf = new Date().toISOString();
  const corpus = (verdict: Record<string, unknown>) => ({
    styleRefGradeBadgeI: () => ({ symbol: "✓", tone: "text-ok", label: "ok", hint: "h1" }),
    getCorpusGrowthVerdictI: () => ({ ...verdict, hint: "h2" }),
  });
  const allClear = { symbol: "✓", tone: "text-ok", label: "within threshold" };
  const alert = { symbol: "⚠", tone: "text-warn", label: "trend alert" };
  const rows = [
    { name: "a settled all-clear keeps its label and stays off the strip", verdict: allClear, error: null, label: /^within threshold$/, tone: "text-ok", isOnStrip: false },
    { name: "an all-clear held under a failed read reads Last known and stays off the strip", verdict: allClear, error: "HTTP 500", label: /^Last known$/, tone: "text-faint", isOnStrip: false },
    { name: "an alert held under a failed read keeps its tone and stays on the strip", verdict: alert, error: "HTTP 500", label: /^Last known: trend alert$/, tone: "text-warn", isOnStrip: true },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const corpusAuditState = { status: "ready", data: { audits: [{ id: 1 }] }, error: row.error };
      const chip = sandbox.getInstrumentationChipsI(corpus(row.verdict), null, corpusAuditState, asOf).find((c) => c.key === "corpus");
      (sandbox.window as Record<string, unknown>).ImprovementInstrumentationVerdicts = corpus(row.verdict);
      const strip = sandbox.InstrumentationStripI({ styleRef: null, corpusAuditState, at: asOf, onOpen: () => {} });

      assert.match(String(chip?.label), row.label);
      assert.equal(chip?.tone, row.tone);
      assert.equal(textOf(strip).includes("Corpus growth"), row.isOnStrip);
    });
  }
});

test("the page banner hands focus to a card the open view renders", () => {
  const operatorIds = collectElements(renderBand(), []).map((el) => el.props.id);
  const instrumentationIds = collectElements(sandbox.InstrumentationViewI({}), []).map((el) => el.props.id);

  assert.ok(operatorIds.includes(sandbox.getBannerFocusTargetI("operator")));
  assert.ok(instrumentationIds.includes(sandbox.getBannerFocusTargetI("instrumentation")));
});

describe("the instrumentation strip shows only the gauges that deviate", () => {
  const judge = (tone: string) => ({
    styleRefGradeBadgeI: () => ({ symbol: "⚠", tone, label: "warn", hint: "h1" }),
    getCorpusGrowthVerdictI: () => ({ symbol: "✓", tone: "text-ok", label: "within threshold", hint: "h2" }),
  });
  const rows = [
    { name: "a warn gauge is shown and an ok one is not", verdicts: judge("text-warn"), shown: ["Graduation gate"] },
    { name: "nothing renders when every gauge is ok", verdicts: judge("text-ok"), shown: [] },
  ];
  for (const row of rows) {
    test(row.name, () => {
      (sandbox.window as Record<string, unknown>).ImprovementInstrumentationVerdicts = row.verdicts;
      const strip = sandbox.InstrumentationStripI({
        styleRef: { overall_emission_rate: 0.3, overall_uncorroborated_rate: 0.2 },
        corpusAuditState: { status: "ready", data: { audits: [{}] } },
        onOpen: () => {},
      });
      const text = textOf(strip);
      for (const name of ["Graduation gate", "Corpus growth"]) assert.equal(text.includes(name), row.shown.includes(name), name);
      assert.equal(strip === null, row.shown.length === 0);
    });
  }
});

test("instrumentation chips take each verdict from the instrumentation view's own rules", () => {
  const calls: unknown[][] = [];
  const latest = { id: 7 };
  const verdicts = {
    styleRefGradeBadgeI: (emission: unknown, uncorroborated: unknown) => {
      calls.push(["style", emission, uncorroborated]);
      return { symbol: "⚠", tone: "text-warn", label: "warn", hint: "h1" };
    },
    getCorpusGrowthVerdictI: (reading: unknown) => {
      calls.push(["corpus", reading]);
      return { symbol: "✓", tone: "text-ok", label: "within threshold", hint: "h2" };
    },
  };
  const chips = sandbox.getInstrumentationChipsI(
    verdicts,
    { overall_emission_rate: 0.6, overall_uncorroborated_rate: 0.374 },
    { status: "ready", data: { audits: [latest] } },
  );

  assert.deepEqual(calls, [["style", 0.6, 0.374], ["corpus", latest]]);
  // Array.from — the sandbox realm's arrays fail strict deepEqual on prototype alone.
  assert.deepEqual(Array.from(chips, (c) => c.label), ["warn", "within threshold"]);
});

test("a gauge whose payload has not landed reads not read, never a verdict", () => {
  const judge = () => {
    throw new Error("an unloaded gauge must not be judged");
  };
  const chips = sandbox.getInstrumentationChipsI(
    { styleRefGradeBadgeI: judge, getCorpusGrowthVerdictI: judge },
    null,
    { status: "loading" },
  );
  assert.deepEqual(Array.from(chips, (c) => c.label), ["not read", "not read"]);
});

test("a failed suggestions read speaks once, from the first board region it feeds", () => {
  const failed = { status: "error", data: null, error: "HTTP 500" };
  const regions = [
    { source: "suggestions", state: failed },
    { source: "loop stats", state: LANDED },
    { source: "pattern ledger", state: LANDED },
    { source: "loop events", state: LANDED },
  ];
  const failures = sandbox.getPageFailuresI(regions, "board");
  const cards = [
    sandbox.KanbanCardI({ state: failed, columnRows: { safety: [], applied: [], rejected: [] }, failures, onRetry: () => {} }),
    sandbox.BucketRowI({ state: failed, buckets: null, failures, onRetry: () => {} }),
  ];
  const resolved = cards.map((card) => {
    const wrapper = collectElements(card, []).find((el) => el.type === sandbox.ErrorBannerI);
    assert.ok(wrapper, "each suggestions region renders its failure slot");
    const failure = sandbox.ErrorBannerI(wrapper.props);
    const slot = (failure.type as (props: Record<string, unknown>) => RecordedElement)(failure.props);
    return (slot.type as { name: string }).name;
  });

  assert.equal(failures.banner, null, "one failed source is not a shared outage");
  assert.deepEqual(resolved, ["RegionUnavailable", "RegionCovered"]);
});

describe("a suggestion board row keeps its full text, clipped in every state with the whole of it in a title", () => {
  const long =
    "Move the verification gate ahead of the regex removal so reviewers see the API change before the three matching suite edits";
  const rows = [
    {
      name: "a declined row's reason",
      render: () => {
        const row = sandbox.CompactProposalCardI({ row: { id: 7, rationale: long }, onClick: () => {} });
        return sandbox.BoardRowI(row.props);
      },
    },
    {
      name: "a proposal card's pattern label",
      render: () => sandbox.ProposalCardI({ row: { id: 7, pattern_label: long, rationale: "Short reason" }, onClick: () => {} }),
    },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const text = collectElements(row.render(), []).find((el) => el.props.children === long);
      assert.ok(text, "the row must render the whole text, never a character-cut copy");
      const titled = collectElements(row.render(), []).find((el) => el.props.title === long);
      assert.ok(titled, "the clipped text's full value must ride in a title, since hover and focus never unclip it");
    });
  }
});
