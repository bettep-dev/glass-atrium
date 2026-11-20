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

async function getRoleOf(description: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpRoot, "role-"));
  const line = `description: ${JSON.stringify(description)}`;
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

describe("role line: the description's first sentence, one line on every screen", () => {
  test("a long first sentence is cut to the cap and ends in an ellipsis, keeping its opening words", async () => {
    const sentence =
      "Swift/SwiftUI native Apple-platform app development and code-level architecture and concurrency agent.";
    const role = await getRoleOf(`${sentence} Use when building iOS apps.`);
    assert.ok(role !== null);
    assert.ok([...role].length <= ROLE_LINE_MAX_LENGTH, `role "${role}" within the cap`);
    assert.ok(role.endsWith("…"));
    assert.ok(sentence.startsWith(role.slice(0, -1)), "the cut keeps the sentence's opening words");
  });

  test("a first sentence within the cap is returned whole", async () => {
    assert.strictEqual(await getRoleOf("Systematic debugging expert agent. Use when a test fails."), "Systematic debugging expert agent.");
  });

  test("a description starting with a quote reads without quote marks or backticks", async () => {
    const role = await getRoleOf('"Ship it" gate for `release` builds. Use when tagging.');
    assert.strictEqual(role, "Ship it gate for release builds.");
  });

  test("an empty description gives no role line", async () => {
    assert.strictEqual(await getRoleOf("   "), null);
  });
});
