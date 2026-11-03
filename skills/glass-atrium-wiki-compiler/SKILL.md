---
name: glass-atrium-wiki-compiler
description: Convert raw/ source materials into wiki/notes/ markdown and sync via SQLite. Use when wiki compilation, raw document to notes conversion, incremental wiki build is needed. Do NOT use for web material collection (->glass-atrium-intel-researcher), report writing (->glass-atrium-intel-reporter), Q&A queries (->glass-atrium-intel-researcher), index/master-index direct editing (-> wiki-sync.sh), health check (-> glass-atrium-wiki-curator).
---

> **Output language**: Frontmatter keys stay English; the body stays in the source page's original language, because translation loses information.

# Wiki Compiler

## Overview

- The LLM does only batched `raw → notes` markdown conversion; scripts own indexing.
- Per-file targets, which the narrow LLM surface exists to hold: <60s, <$0.05, <20 tool calls.

## Core Process

### Step 1 — Convert (LLM, batched)

- **Input**: delta set of `raw/{slug}.md` files (`## Incremental Rules` → `Delta only`).
- **Output**: `wiki/notes/{slug}.md`, flat; tags are the grouping mechanism.
- **Batch**: N raw files → **1 claude call**. Per-file calls are forbidden: each call re-pays the fixed system-prompt and tool-schema cost.
- **Work performed**:
  - Transform frontmatter: raw `source_url`/`collected`/`collector` → the shape in `## Notes Frontmatter`.
  - Clean body:
    - Deduplicate, normalize headings.
    - No summary rewriting beyond removing boilerplate.
  - Auto-extract tags from content (keywords + domain terms). No predefined tag list.
- **Forbidden in Step 1**:
  - Reading other `raw/` or `notes/` files for cross-reference: it breaks the per-file time target
  - Inserting `[[wikilinks]]` or backlinks
  - Inserting a Markdown link `[](...)` to anything but an external URL
  - Touching `wiki/index/**`, whose `master-index.md` is a build artifact
  - Creating category subdirectories under `notes/`
- **Tools**: Read (raw file), Write (notes file). Nothing else.

### Step 2 — Sync (script, no LLM)

- Invoke `~/.glass-atrium/scripts/wiki-sync.sh`.
- The script scans `wiki/notes/` and `wiki/raw/`, upserts `wiki.sqlite` (FTS5 + metadata), and regenerates `master-index.md` when the index changed.

## Notes Frontmatter

```yaml
---
type: source-summary
title: {noun phrase, original language, Sentence case}
source_refs:
  - raw/{slug}.md
tags: [{auto-extracted}]
updated: YYYY-MM-DD
---
```

## Incremental Rules

| Rule | Description |
|------|-------------|
| Delta only | Process only raw files whose mtime > corresponding notes mtime, or that have no notes counterpart |
| 1 raw = 1 note | Never merge; never split |
| Safe deletion | Raw deletion does not auto-delete notes |
| No full rebuild | Full recompilation is forbidden; rebuild the index via `wiki-sync.sh` instead |

## Compilation Exclusion

- Skip raw materials that are:
  - project-specific code/config with no general reuse
  - one-off debug/deploy logs
  - raw copies of official docs replaceable by a link
- Heuristic: "If proper nouns are removed, does reusable knowledge remain?" — if no, skip and log in `build.log`.

## Examples

### Good — minimal conversion

Input `raw/2026-04-08-a1b2c3d4.md`:

```
---
source_url: https://example.com/prompt-compression
collected: 2026-04-08
collector: glass-atrium-intel-researcher
---
# Prompt compression techniques
Telegram style achieves 42% token reduction...
```

Output `wiki/notes/2026-04-08-a1b2c3d4.md`:

```
---
type: source-summary
title: Prompt compression techniques
source_refs: [raw/2026-04-08-a1b2c3d4.md]
tags: [prompt-engineering, token-optimization]
updated: 2026-04-08
---
# Prompt compression techniques
Telegram style achieves 42% token reduction...
```

## Integration

- The scheduled compile does not load this skill: launchd `com.glass-atrium.wiki-compile` runs `scripts/wiki-daily-compile.sh`, whose own `PROMPT` drives the batch, and that script then runs `wiki-sync.sh`.

## Verification

Check the finished run against:

- `### Step 1 — Convert (LLM, batched)` → **Batch**, **Forbidden in Step 1**, **Tools**
- `## Incremental Rules`
- `## Overview` → the per-file targets
- the Output language line: body language matches the source
- `wiki-sync.sh` ran after Step 1
