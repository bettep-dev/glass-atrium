// Agents folder enumeration + the one-line role — the list the Models screen reads (fs fixtures, no DB).
// Runner: npx tsx --test test/agents.agent-files.unit.test.ts

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAgentFiles, ROLE_LINE_MAX_LENGTH } from "../src/server/agents/registry.js";
import { deleteTempDirectory } from "./lib/remove-dir.js";

const TEMP_PREFIX = "agent-files-test-";

let tmpRoot: string;
let agentsDir: string;

function agentMarkdown(name: string, extraLines: string[] = []): string {
  return ["---", `name: ${name}`, ...extraLines, "tools: [Read]", "---", "", `${name} body.`, ""].join("\n");
}

async function writeAgentsFolder(): Promise<void> {
  await mkdir(join(agentsDir, "references"));
  await mkdir(join(agentsDir, "templates"));
  await writeFile(join(agentsDir, "references", "glass-atrium-ref-note.md"), agentMarkdown("glass-atrium-ref-note"));
  await writeFile(join(agentsDir, "templates", "glass-atrium-template.md"), agentMarkdown("glass-atrium-template"));
  await writeFile(join(agentsDir, "GLASS_ATRIUM_GLOBAL_RULES.md"), "# Rules\n");
  await writeFile(join(agentsDir, "glass-atrium-notes.txt"), agentMarkdown("glass-atrium-notes"));
  await writeFile(join(agentsDir, "glass-atrium-dev-node.md"), agentMarkdown("glass-atrium-dev-node", ["model: claude-opus-5-5"]));
  await writeFile(join(agentsDir, "glass-atrium-hand-added.md"), agentMarkdown("glass-atrium-hand-added"));
  await writeFile(join(agentsDir, "glass-atrium-no-fence.md"), "# glass-atrium-no-fence\n\nno frontmatter\n");
  await writeFile(join(agentsDir, "glass-atrium-renamed.md"), agentMarkdown("glass-atrium-old-name"));
  await writeFile(join(agentsDir, "glass-atrium-no-name.md"), "---\ndescription: Has no name key.\n---\n");
  await writeFile(join(agentsDir, "glass-atrium-bad-yaml.md"), "---\nname: glass-atrium-bad-yaml\ndescription: [unclosed\n---\n");
  await writeFile(join(agentsDir, "glass-atrium-locked.md"), agentMarkdown("glass-atrium-locked"));
  await chmod(join(agentsDir, "glass-atrium-locked.md"), 0o000);
  await writeFile(join(tmpRoot, "glass-atrium-outside.md"), agentMarkdown("glass-atrium-outside"));
  await symlink(join(tmpRoot, "glass-atrium-outside.md"), join(agentsDir, "glass-atrium-outside.md"));
  await symlink(join(tmpRoot, "absent.md"), join(agentsDir, "glass-atrium-dangling.md"));
  await writeFile(join(agentsDir, ".glass-atrium-linked-source.md"), agentMarkdown("glass-atrium-linked"));
  await symlink(join(agentsDir, ".glass-atrium-linked-source.md"), join(agentsDir, "glass-atrium-linked.md"));
}

async function getRoleOf(description: string, line = `description: ${JSON.stringify(description)}`): Promise<string | null> {
  const dir = await mkdtemp(join(tmpRoot, "role-"));
  await writeFile(join(dir, "glass-atrium-role.md"), agentMarkdown("glass-atrium-role", [line]));
  const list = await listAgentFiles(dir);
  assert.strictEqual(list.agents.length, 1, "fixture agent is listed");
  return list.agents[0]?.role ?? null;
}

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  agentsDir = join(tmpRoot, "agents");
  await mkdir(agentsDir);
  await writeAgentsFolder();
});

after(async () => {
  await chmod(join(agentsDir, "glass-atrium-locked.md"), 0o600);
  deleteTempDirectory(tmpRoot, TEMP_PREFIX);
});

describe("listAgentFiles: which entries of the agents folder are listed", () => {
  test("only top-level lowercase .md entries appear — the rules file, subfolders and other extensions never do", async () => {
    const list = await listAgentFiles(agentsDir);
    const shown = [...list.agents.map((a) => a.file), ...list.unreadable.map((u) => u.file)].sort();
    assert.deepStrictEqual(shown, [
      "glass-atrium-bad-yaml.md",
      "glass-atrium-dangling.md",
      "glass-atrium-dev-node.md",
      "glass-atrium-hand-added.md",
      "glass-atrium-linked.md",
      "glass-atrium-locked.md",
      "glass-atrium-no-fence.md",
      "glass-atrium-no-name.md",
      "glass-atrium-outside.md",
      "glass-atrium-renamed.md",
    ]);
  });

  test("a file whose frontmatter name equals its base name is an agent, sorted by name, with its frontmatter fields", async () => {
    const list = await listAgentFiles(agentsDir);
    assert.deepStrictEqual(
      list.agents.map((a) => [a.name, a.file]),
      [
        ["glass-atrium-dev-node", "glass-atrium-dev-node.md"],
        ["glass-atrium-hand-added", "glass-atrium-hand-added.md"],
        ["glass-atrium-linked", "glass-atrium-linked.md"],
      ],
    );
    const devNode = list.agents.find((a) => a.name === "glass-atrium-dev-node");
    assert.strictEqual(devNode?.frontmatter.model, "claude-opus-5-5");
  });

  const unreadableRows = [
    { name: "no frontmatter fence", file: "glass-atrium-no-fence.md", reason: "No frontmatter block" },
    { name: "frontmatter name of another agent", file: "glass-atrium-renamed.md", reason: "Frontmatter name differs from the file name" },
    { name: "frontmatter without a name", file: "glass-atrium-no-name.md", reason: "Frontmatter name differs from the file name" },
    { name: "frontmatter that is not YAML", file: "glass-atrium-bad-yaml.md", reason: "Frontmatter could not be parsed" },
    { name: "a file the server may not read", file: "glass-atrium-locked.md", reason: "File could not be read" },
    { name: "a link whose target is missing", file: "glass-atrium-dangling.md", reason: "File could not be read" },
    { name: "a link resolving outside the folder", file: "glass-atrium-outside.md", reason: "File is outside the agents folder" },
  ];
  for (const row of unreadableRows) {
    test(`unreadable with its reason: ${row.name}`, async () => {
      const list = await listAgentFiles(agentsDir);
      assert.deepStrictEqual(
        list.unreadable.filter((u) => u.file === row.file),
        [{ file: row.file, reason: row.reason }],
      );
    });
  }

  test("a missing agents folder lists nothing instead of failing", async () => {
    const list = await listAgentFiles(join(tmpRoot, "no-such-folder"));
    assert.deepStrictEqual(list, { agents: [], unreadable: [] });
  });
});

describe("role line: a short phrase from the description's first sentence, one line on every screen", () => {
  const rows = [
    { name: "a short first sentence loses its period and a trailing 'agent'", description: "Systematic debugging expert agent. Use when a test fails.", role: "Systematic debugging expert" },
    { name: "a trailing 'development agent' is dropped", description: "Angular web application development agent. Use when editing components.", role: "Angular web application" },
    { name: "a leading 'Agent for' is dropped and the phrase starts upper case", description: "Agent for requirements analysis and prioritization. Use when planning.", role: "Requirements analysis and prioritization" },
    { name: "a leading 'Agent that' is dropped", description: "Agent that synthesizes research data into reports — request-driven format.", role: "Synthesizes research data into reports" },
    { name: "an 'agent' inside the phrase is dropped", description: "Systematic research agent for web search. Use when citing.", role: "Systematic research for web search" },
    { name: "only the clause before an em dash is kept", description: "Code quality and design review — project-rule-based code review agent. Use when reviewing.", role: "Code quality and design review" },
    { name: "quote marks and backticks are dropped", description: '"Ship it" gate for `release` builds. Use when tagging.', role: "Ship it gate for release builds" },
    { name: "a long phrase is cut after its last whole word", description: "Kotlin/Jetpack Compose Android app development and code-level layering validation agent. Use when.", role: "Kotlin/Jetpack Compose Android app development…" },
    { name: "a cut drops a dangling conjunction and comma", description: "Python application, CLI, data-processing, and web-API development agent — pure Python runtime.", role: "Python application, CLI, data-processing…" },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      assert.strictEqual(await getRoleOf(row.description), row.role);
    });
  }

  test("a single-quoted YAML description reads without its quotes", async () => {
    const role = await getRoleOf("", "description: 'Single owner of the wiki (`~/.glass-atrium/wiki/`). Handles all wiki writes.'");
    assert.strictEqual(role, "Single owner of the wiki (~/.glass-atrium/wiki/)");
  });

  test("a cut role stays within the cap and ends on a whole word of its phrase", async () => {
    const phrases = [
      "Swift/SwiftUI native Apple-platform app development and code-level architecture and concurrency",
      "Shell/Bash script development for Claude Code automation infrastructure",
      "Single owner of the Atrium-internal, LLM-only wiki and its sqlite index",
    ];
    for (const phrase of phrases) {
      const role = await getRoleOf(`${phrase}. Use when building.`);
      assert.ok(role !== null && role.endsWith("…"), `"${phrase}" is cut`);
      const kept = role.slice(0, -1);
      assert.ok([...role].length <= ROLE_LINE_MAX_LENGTH, `role "${role}" within the cap`);
      assert.ok(phrase.startsWith(kept), `"${role}" keeps the phrase's opening words`);
      assert.match(phrase.slice(kept.length), /^[^\p{L}\p{N}]/u, `"${role}" ends between words`);
    }
  });

  test("an empty description gives no role line", async () => {
    assert.strictEqual(await getRoleOf("   "), null);
  });
});
