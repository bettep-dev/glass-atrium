---
name: glass-atrium-wiki-compiler
description: Convert raw/ source materials into wiki/notes/ markdown and sync via SQLite. Use when wiki compilation, raw document to notes conversion, incremental wiki build is needed. Do NOT use for web material collection (->glass-atrium-intel-researcher), report writing (->glass-atrium-intel-reporter), Q&A queries (->glass-atrium-intel-researcher), index/master-index direct editing (-> wiki-sync.sh), health check (-> glass-atrium-wiki-curator).
---

> **Output language**: Frontmatter keys stay English; the body stays in the source page's original language, because translation loses information.

# Wiki Compiler

## Overview

- Scope: the interactive path — a spawned glass-atrium-wiki-curator compiling raw files itself; the scheduled batch never loads this skill (`## Integration`).
  - "The curator body" below is `agents/glass-atrium-wiki-curator.md`, which that reader already holds.
- The LLM does only `raw → notes` markdown conversion and linking; scripts own indexing.
- Per-file targets, which the narrow LLM surface exists to hold: <60s, <$0.05, <20 tool calls.

## Core Process

### Step 1 — Convert (LLM, batched)

- **Input**: delta set of `raw/{slug}.md` files (`## Incremental Rules` → `Delta only`).
- **Output**: `wiki/notes/{slug}.md`, flat; tags are the grouping mechanism.
- **Work performed**:
  - Transform frontmatter: raw `source_url`/`collected`/`collector` → the shape in `## Notes Frontmatter`.
  - Clean body:
    - Deduplicate, normalize headings.
    - No summary rewriting beyond removing boilerplate.
  - Auto-extract tags from content (keywords + domain terms). No predefined tag list.
  - Link: the curator body → **Linking**.
- **Forbidden in Step 1**:
  - Hand-editing `index/master-index.md`: it is a build artifact that Step 2 regenerates
  - Creating category subdirectories under `notes/`
- **Tools**: the curator body → `## Path Constraint & Tools`.

### Step 2 — Sync (script, no LLM)

- Invoke `~/.glass-atrium/scripts/wiki-sync.sh` under the write lock (the curator body → `### Concurrent Write Safety`).
- The script scans `wiki/notes/` and `wiki/raw/`, upserts `wiki.sqlite` (FTS5 + metadata), and regenerates `master-index.md` when the index changed.

## Notes Frontmatter

- The one shape: the curator body → **Frontmatter**.
- `title`: original language, Sentence case.

## Incremental Rules

| Rule | Description |
|------|-------------|
| Delta only | Only unprocessed raw files — defined in the curator body → `### Incremental Compilation` → **Unprocessed** |
| 1 raw = 1 note | Never merge; never split |
| Safe deletion | Raw deletion does not auto-delete notes |
| No full rebuild | Full recompilation is forbidden; rebuild the index via `wiki-sync.sh` instead |

## Compilation Exclusion

- Criteria, and how a skip is reported: the curator body → `### Exclusion Criteria`.

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
title: Prompt compression techniques
category: prompt-engineering
type: source-summary
created: 2026-04-08
updated: 2026-04-08
source_raw: 2026-04-08-a1b2c3d4.md
source_url: https://example.com/prompt-compression
tags: [prompt-engineering, token-optimization]
---
# Prompt compression techniques
Telegram style achieves 42% token reduction...
```

## Integration

- The scheduled compile does not load this skill: launchd `com.glass-atrium.wiki-compile` runs `scripts/wiki-daily-compile.sh`, whose own `PROMPT` drives the batch, and that script then runs `wiki-sync.sh`.

## Verification

Check the finished run against:

- `### Step 1 — Convert (LLM, batched)` → **Forbidden in Step 1**
- `## Incremental Rules`
- `## Overview` → the per-file targets
- the Output language line: body language matches the source
- `wiki-sync.sh` ran after Step 1
