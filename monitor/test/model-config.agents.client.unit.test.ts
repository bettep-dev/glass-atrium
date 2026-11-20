// Agent models card on the Models screen (screens/model-config.jsx): the selection, the one-model apply body,
// each per-file result and refusal, and the words every row and bar state reads. Real ui.jsx atoms render the markup.
//
// Runner: npx tsx --test test/model-config.agents.client.unit.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, getHtml, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = (await loadScreenModule(resolve(HERE, "../public/src/ui.jsx"))).UI as Record<string, unknown>;
const screen = await loadScreenModule(resolve(HERE, "../public/src/screens/model-config.jsx"), { window: { UI } });

type Fn = (...args: unknown[]) => unknown;
const fn = (name: string): Fn => {
  assert.strictEqual(typeof screen[name], "function", `${name} reachable`);
  return screen[name] as Fn;
};
const h = (screen.React as { createElement: Fn }).createElement;
const render = (component: string, props: Record<string, unknown>): RenderedNode => renderScreen(h(fn(component), props)) as RenderedNode;
const sameRealm = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const KNOWN = [OPUS, SONNET];

const AGENTS = [
  { name: "glass-atrium-dev-android", file: "glass-atrium-dev-android.md", role: "Android apps in Kotlin and Compose", pin: OPUS, registered: true },
  { name: "glass-atrium-dev-shell", file: "glass-atrium-dev-shell.md", role: "Shell scripts and bats suites", pin: "claude-opus-4-1", registered: true },
  { name: "glass-atrium-intel-researcher", file: "glass-atrium-intel-researcher.md", role: "Web and codebase research with cited sources", pin: null, registered: true },
  { name: "glass-atrium-sec-guard", file: "glass-atrium-sec-guard.md", role: null, pin: SONNET, registered: true },
  { name: "my-new-agent", file: "my-new-agent.md", role: "Drafts release notes", pin: null, registered: false },
];
const UNREADABLE = [{ file: "glass-atrium-broken.md", reason: "No frontmatter block" }];

describe("Apply sends one model for every ticked agent, each with the pin the page last showed", () => {
  const rows = [
    { name: "a roster model over pinned and unpinned agents", model: SONNET, ticked: ["glass-atrium-intel-researcher", "glass-atrium-dev-android"] },
    { name: "the no-pin choice", model: "inherit", ticked: ["glass-atrium-sec-guard"] },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const body = sameRealm(fn("getAgentApplyBodyMC")(row.model, AGENTS, new Set(row.ticked))) as { model: string; agents: Array<{ name: string; expected_pin: string | null }> };
      const expected = AGENTS.filter((agent) => row.ticked.includes(agent.name)).map((agent) => ({ name: agent.name, expected_pin: agent.pin }));
      assert.deepStrictEqual(body, { model: row.model, agents: expected });
    });
  }
});

describe("a 200 answer becomes a toast when every ticked file took the model, else one warn alarm with the failed rows kept ticked", () => {
  const ok = (name: string, status = "applied") => ({ name, status });
  const rows = [
    { name: "all applied", model: SONNET, results: [ok("a"), ok("b"), ok("c", "unchanged")], toast: "Sonnet 5.5 set on 3 agents" },
    { name: "one agent applied", model: SONNET, results: [ok("a")], toast: "Sonnet 5.5 set on 1 agent" },
    { name: "the pin removed", model: "inherit", results: [ok("a"), ok("b", "unchanged")], toast: "Pin removed from 2 agents" },
    { name: "nothing to write", model: SONNET, results: [ok("a", "unchanged"), ok("b", "unchanged"), ok("c", "unchanged")], toast: "3 agents were already on Sonnet 5.5" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const outcome = sameRealm(fn("getAgentApplyOutcomeMC")(row.results, row.model)) as Record<string, unknown>;
      assert.deepStrictEqual(outcome, { toast: row.toast, alarm: null, retry: [], reasons: {} });
    });
  }

  // one line: the count agrees in number, a row's own reason line names the cause, a gone file has no row so the line names it
  const failures = [
    {
      name: "one refused of three → one line, singular",
      results: [ok("glass-atrium-dev-android"), { name: "glass-atrium-dev-react", status: "refused", reason: "File is outside the agents folder" }, ok("glass-atrium-intel-researcher", "unchanged")],
      title: "1 of 3 agents not changed — reason on its row",
      retry: ["glass-atrium-dev-react"],
    },
    {
      name: "two to retry and one gone of five → one line, plural, the gone file named",
      results: [
        ok("glass-atrium-dev-android"),
        { name: "glass-atrium-dev-shell", status: "changed_since_load" },
        { name: "glass-atrium-sec-guard", status: "refused", reason: "File is outside the agents folder" },
        ok("glass-atrium-intel-researcher", "unchanged"),
        { name: "glass-atrium-old-agent", status: "gone" },
      ],
      title: "3 of 5 agents not changed — reasons on their rows · old-agent — its file is no longer in the folder",
      retry: ["glass-atrium-dev-shell", "glass-atrium-sec-guard"],
    },
  ];
  for (const row of failures) {
    test(`a partial failure is one warn line and keeps only the files that can be retried: ${row.name}`, () => {
      const outcome = sameRealm(fn("getAgentApplyOutcomeMC")(row.results, SONNET)) as { toast: unknown; alarm: unknown; retry: unknown; reasons: Record<string, string> };
      assert.strictEqual(outcome.toast, null);
      assert.deepStrictEqual(outcome.alarm, { tone: "warn", title: row.title });
      assert.deepStrictEqual(outcome.retry, row.retry);
      const words = row.results.filter((result) => row.retry.includes(result.name)).map((result) => [result.name, fn("getAgentReasonMC")(result)]);
      assert.deepStrictEqual(outcome.reasons, Object.fromEntries(words));
    });
  }
});

describe("each per-file failure reads as the spec's words on its row", () => {
  const rows = [
    { name: "a pin moved since the page loaded", result: { status: "changed_since_load" }, words: "Not changed — the file changed after this page loaded" },
    { name: "a write that would change more than the model line", result: { status: "refused", reason: "The write would change another frontmatter key" }, words: "Not changed — only the model line may change, and more would have" },
    { name: "a body change on read-back", result: { status: "refused", reason: "The write would change the body" }, words: "Not changed — only the model line may change, and more would have" },
    { name: "a file outside the agents folder", result: { status: "refused", reason: "File is outside the agents folder" }, words: "Not changed — the file is outside the agents folder" },
    { name: "a failed write", result: { status: "refused", reason: "The file could not be written" }, words: "Not changed — the file could not be written" },
    { name: "a refusal the screen has no words for keeps the server's reason", result: { status: "refused", reason: "More than one model line" }, words: "Not changed — more than one model line" },
  ];
  for (const row of rows) {
    test(row.name, () => assert.strictEqual(fn("getAgentReasonMC")({ name: "x", ...row.result }), row.words));
  }
});

describe("an answer that wrote nothing is one crit alarm whose detail names the next step", () => {
  const rows = [
    { name: "400 → the server's validation message", answer: { status: 400, data: { error: "invalid_body", field: "model", reason: "must be a known model id" } }, detail: "must be a known model id" },
    { name: "409 → another writer", answer: { status: 409, data: { error: "apply_in_progress", reason: "x" } }, detail: "Another process is writing agent files. Apply again when it finishes." },
    { name: "no answer → the monitor did not answer", answer: { status: null, data: null }, detail: "The monitor did not answer. Apply again." },
    { name: "another refusal keeps the server's reason", answer: { status: 503, data: { error: "model_roster_unavailable", reason: "the pricing roster is unreadable" } }, detail: "the pricing roster is unreadable" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.deepStrictEqual(sameRealm(fn("getAgentApplyFailureMC")(row.answer)), { tone: "crit", title: "No agent was changed", detail: row.detail });
    });
  }
});

test("a fresh read keeps the ticks of every agent still listed and drops the rest", () => {
  const ticks = fn("getTicksAfterReadMC")(new Set(["glass-atrium-dev-android", "glass-atrium-gone"]), AGENTS) as Set<string>;
  assert.deepStrictEqual([...ticks], ["glass-atrium-dev-android"]);
});

test("agents and unreadable files share one list ordered by file name", () => {
  const list = sameRealm(fn("getAgentListMC")(AGENTS, UNREADABLE)) as Array<{ file: string }>;
  assert.deepStrictEqual(list.map((item) => item.file), [...AGENTS.map((a) => a.file), ...UNREADABLE.map((u) => u.file)].sort());
});

function rowHtml(item: unknown, extra: Record<string, unknown> = {}): string {
  const view = { isStacked: false, columnCount: 4 };
  return getHtml(render("AgentRowMC", { view, item, isTicked: false, knownModels: KNOWN, focusProps: {}, onToggle: () => {}, ...extra }));
}
const agentItem = (name: string) => ({ file: `${name}.md`, agent: AGENTS.find((a) => a.name === name) });
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("each row's cells read as the spec words", () => {
  test("a roster pin shows its display name, the id in its title", () => {
    const html = rowHtml(agentItem("glass-atrium-dev-android"));
    assert.match(textOf(html), /Opus 5\.5/);
    assert.match(html, new RegExp(`title="${OPUS}"`));
  });
  test("a pin outside the roster shows the id and the fallback-rate note", () => {
    const text = textOf(rowHtml(agentItem("glass-atrium-dev-shell")));
    assert.match(text, /claude-opus-4-1/);
    assert.match(text, /No price listed — billed at the conservative fallback rate/);
  });
  test("no model line reads as no pin, never as a model", () => {
    assert.match(textOf(rowHtml(agentItem("glass-atrium-intel-researcher"))), /No pin — session model/);
  });
  test("a file the registry lacks says so under its name, and its role shows whole", () => {
    const html = rowHtml(agentItem("my-new-agent"));
    assert.match(textOf(html), /Not registered/);
    assert.match(html, /title="No entry in agent-registry\.json — the lifecycle CLI does not track this file"/);
    assert.match(textOf(html), /Drafts release notes/);
  });
  test("a missing role reads None, never a dash", () => {
    assert.match(textOf(rowHtml(agentItem("glass-atrium-sec-guard"))), /None/);
  });
  test("an unreadable file shows its name, the reason and Not loaded, with no checkbox", () => {
    const html = rowHtml({ file: UNREADABLE[0].file, unreadable: UNREADABLE[0] });
    assert.match(textOf(html), /glass-atrium-broken\.md No frontmatter block Not loaded/);
    assert.doesNotMatch(html, /type="checkbox"/);
  });
  test("a ticked row takes the sunken fill and a checked box; while applying the box is disabled", () => {
    const html = rowHtml(agentItem("glass-atrium-dev-android"), { isTicked: true, isApplying: true });
    assert.match(html, /<tr[^>]*style="background: rgb\(var\(--sunken\)\)"/);
    assert.match(html, /<input[^>]*type="checkbox"[^>]*checked="true"[^>]*disabled="true"|<input[^>]*disabled="true"[^>]*checked="true"/);
  });
  test("a failure reason is a detail line under its row, after the tick and agent columns", () => {
    const html = rowHtml(agentItem("glass-atrium-dev-shell"), { reason: "Not changed — the file changed after this page loaded" });
    assert.match(html, /<tr class="[^"]*\bis-grouped\b[^"]*"/);
    assert.match(html, /<td colSpan="2"[^>]*>.*Not changed — the file changed after this page loaded/);
  });
});

function barText(props: Record<string, unknown>): { html: string; text: string } {
  const html = getHtml(render("AgentBarMC", { count: 0, model: "", knownModels: KNOWN, isModelMissing: false, isApplying: false, onModel: () => {}, onApply: () => {}, onClear: () => {}, ...props }));
  return { html, text: textOf(html) };
}

describe("the selection bar reads its state in words", () => {
  test("nothing ticked → the invitation only, no controls", () => {
    const { html, text } = barText({});
    assert.strictEqual(text, "Select agents to set one model for all of them");
    assert.doesNotMatch(html, /<select|<button/);
  });
  test("ticked → the count, the model choice in order, Apply naming the count and Clear selection", () => {
    const { html, text } = barText({ count: 3 });
    assert.match(text, /^3 selected .*Apply to 3 agents Clear selection$/);
    const options = [...html.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(options, ["", OPUS, SONNET, "inherit"]);
    assert.match(html, /<option[^>]*value="inherit"[^>]*>No pin — session model</);
    assert.match(html, /<option[^>]*value=""[^>]*>Choose a model</);
  });
  test("one ticked → the singular", () => assert.match(barText({ count: 1 }).text, /Apply to 1 agent Clear/));
  test("Apply with no model → the alert and the select's crit edge", () => {
    const { html } = barText({ count: 3, isModelMissing: true });
    assert.match(html, /role="alert"[^>]*>(?:<[^>]+>)*✕/);
    assert.match(textOf(html), /Choose a model first/);
    assert.match(html, /<select[^>]*class="field field-select is-error"/);
  });
  test("applying → Applying… and every bar control disabled", () => {
    const { html, text } = barText({ count: 3, model: SONNET, isApplying: true });
    assert.match(text, /Applying…/);
    assert.strictEqual((html.match(/disabled="true"/g) ?? []).length, 3);
  });
});

describe("the card states", () => {
  const section = (props: Record<string, unknown>) =>
    render("AgentModelsSectionMC", { state: "ready", agents: AGENTS, unreadable: [], knownModels: KNOWN, onAgentsRead: () => {}, showToast: () => {}, ...props });
  test("no agent files → the first-use words, no bar, no foot", () => {
    const tree = section({ agents: [], unreadable: [] });
    const text = collectText(tree);
    assert.match(text, /No agent files in\s*~\/\.glass-atrium\/agents/);
    assert.match(text, /An agent appears here once its file is in that folder — then press Refresh\./);
    assert.doesNotMatch(text, /Select agents to set/);
    assert.doesNotMatch(text, /Fable and Opus reason deepest/);
  });
  test("a failed read says the agent list could not be read", () => {
    assert.match(collectText(section({ state: "unavailable", agents: undefined })), /Not available — the agent list could not be read\./);
  });
  test("a listed card carries the timing sub, the cost line foot and the head mark for unreadable files", () => {
    const text = collectText(section({ unreadable: UNREADABLE }));
    assert.match(text, /Agent models/);
    assert.match(text, /Applies after a session restart/);
    assert.match(text, /Fable and Opus reason deepest and cost the most per token; Haiku is fastest and cheapest/);
    assert.match(text, /1 file not readable/);
  });
  test("loading holds twelve skeleton rows under the header", () => {
    const tree = section({ state: "loading", agents: undefined });
    const skeleton = findNodes(tree, (node) => node.type === "tr" && node.props["aria-hidden"] === "true");
    assert.strictEqual(skeleton.length, 12);
  });
});
