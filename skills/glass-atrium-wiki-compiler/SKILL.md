---
name: glass-atrium-wiki-compiler
description: Convert raw/ source materials into wiki/notes/ markdown and sync via SQLite. Use when wiki compilation, raw document to notes conversion, incremental wiki build is needed. Do NOT use for web material collection (->glass-atrium-intel-researcher+defuddle), report writing (->glass-atrium-intel-reporter), Q&A queries (->glass-atrium-intel-researcher), index/master-index direct editing (-> T6 wiki-sync.sh), health check (-> separate skill).
---

> **Output language**: Preserve source language (D5). Frontmatter keys stay English; body stays in the source page's original language.

# Wiki Compiler

## Overview

Converts raw/ source materials into `wiki/notes/` markdown through a narrow LLM surface: batched conversion only. Indexing, backlinks, and master-index are delegated to T5/T6 SQLite scripts. Targets: <60s/file, <$0.05/file, <20 tool calls/file.

## When to Use

- New or modified raw/ files need conversion to wiki notes
- Incremental wiki build after glass-atrium-intel-researcher collects new materials
- Batch compilation of multiple raw files in a single pass
- **Exclusions**: Web material collection (glass-atrium-intel-researcher+defuddle), report writing (glass-atrium-intel-reporter), Q&A queries (glass-atrium-intel-researcher), index/master-index editing (wiki-sync.sh), health check (separate skill)

## Quick Reference

| Step | Name | LLM? | Owner | Output |
|------|------|------|-------|--------|
| 1 | Convert | Yes (1 call, batched) | glass-atrium-wiki-compiler | `wiki/notes/{slug}.md` |
| 2 | Sync | No (script) | `wiki-sync.sh` (T6) | `wiki/index/wiki.sqlite` + `master-index.md` |
| 3 (optional) | Health | Yes (weekly) | separate skill | `index/healthcheck-*.md` |

Targets (per plan §2 KPI): <60s/file, <$0.05/file, <20 tool calls/file.

## Wiki Store Structure (D7 flattened)

Atrium-internal, git-ignored, LLM-only store (no Obsidian vault; BM25 `wiki-query.sh` is the sole consumer):

```
~/.glass-atrium/wiki/
├── raw/            # Immutable sources (1 URL = 1 file, verbatim, flat)
├── notes/          # Compiled notes (flat, no category folders; tags only)
└── index/
    ├── wiki.sqlite       # SQLite FTS5 + metadata + backlinks (T5) — BM25 SoT index
    ├── master-index.md   # Build artifact (T6 script regenerates)
    ├── topic-map.md      # Build artifact (T6 script regenerates)
    └── healthcheck-*.md  # Health check reports
```

- **No category folders.** D7 fixes flat `notes/` + tag-based dynamic grouping via SQLite.
- **master-index.md / topic-map.md are build artifacts.** Never edited by this skill.

## Philosophy

Karpathy wiki pattern: LLM does only `raw → notes` markdown conversion. Cross-linking, backlinks, and indexing are SQLite triggers + shell scripts (T5/T6). Keeping the LLM surface narrow is what makes the pipeline hit <60s and <$0.05 per file.

## Core Process

### Step 1 — Convert (LLM, batched)

- **Input**: delta set of `raw/{slug}.md` files (new or modified since last run).
- **Output**: `wiki/notes/{slug}.md`, flat.
- **Batch**: N raw files → **1 claude call**. Per-file calls are forbidden (root cause of the old $0.3–0.5 cost).
- **Work performed**:
  - Transform frontmatter: raw `source_url`/`collected`/`collector` → notes `title`, `tags`, `source_refs: [raw/{slug}.md]`, `type: source-summary`, `updated`.
  - Clean body: preserve original language (D5), deduplicate, normalize headings. No translation. No summary rewriting beyond removing boilerplate.
  - Auto-extract tags from content (keywords + domain terms). No predefined tag list.
- **Forbidden in Step 1**:
  - Reading other `raw/` or `notes/` files for cross-reference
  - Inserting `[[wikilinks]]` or backlinks
  - Touching `wiki/index/**` or `master-index.md`
  - Creating category subdirectories under `notes/`
  - Merging multiple raw files into one note (1 raw = 1 note)
- **Tools**: Read (raw file), Write (notes file). Nothing else.

Pseudocode:

```
for raw_file in delta:
    content = Read(raw_file)
    note = convert(content)   # single LLM pass over the batch
    Write(f"wiki/notes/{slug(raw_file)}.md", note)
```

### Step 2 — Sync (script, no LLM)

- Invoke `~/.glass-atrium/scripts/wiki-sync.sh` (T6).
- The script: scans `wiki/notes/`, upserts SQLite `wiki.sqlite` (FTS5 + metadata + backlinks), regenerates `master-index.md` and `topic-map.md` from SQL queries.
- No LLM tokens spent. No manual editing of index files by this skill.

```
Bash("~/.glass-atrium/scripts/wiki-sync.sh")
```

### Step 3 — Health (optional, separate cadence)

Not part of the daily compile. Run weekly (or on demand) via a dedicated health-check skill / `glass-atrium-wiki-curator` health mode. Reports missing backlinks, orphan notes, duplicate concept candidates from SQLite queries + LLM interpretation. Implementation lives outside this skill (T9 or later).

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

- `[[wikilinks]]` are **not** inserted during conversion. A weekly health check may suggest candidates; insertion is manual or handled by a later T9 task.
- Markdown links `[](...)` are permitted for external URLs only.

## Incremental Rules

| Rule | Description |
|------|-------------|
| Delta only | Process only raw files whose mtime > corresponding notes mtime, or that have no notes counterpart |
| 1 raw = 1 note | Never merge; never split |
| Safe deletion | Raw deletion does NOT auto-delete notes; T6 sync marks them as orphan |
| No full rebuild | Full recompilation is forbidden; rebuild the index via `wiki-sync.sh` instead |

## Compilation Exclusion

Skip raw materials that are (a) project-specific code/config with no general reuse, (b) one-off debug/deploy logs, (c) raw copies of official docs replaceable by a link. Heuristic: "If proper nouns are removed, does reusable knowledge remain?" — if no, skip and log in `build.log`.

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

One Read, one Write. No cross-reference. No wikilinks.

### Bad — pipeline violation

- Reading all existing `notes/` to insert `[[backlinks]]` (Step 1 forbidden; that is Step 2/T6 territory)
- Editing `wiki/index/master-index.md` directly (build artifact; regenerated by T6)
- Translating an English raw file into Korean (D5 violated)
- Merging 3 raw files into a single "concept" note (1 raw = 1 note)
- Creating `wiki/notes/agent-engineering/foo.md` (D7 flat; category folders forbidden)

## Integration

| Role | Owner | Flow |
|------|-------|------|
| Source collection | glass-atrium-intel-researcher + WebFetch/defuddle | → `raw/` (flat, immutable, verbatim) |
| Conversion | **glass-atrium-wiki-compiler** (Step 1) | `raw/` → `notes/` |
| Indexing | `wiki-sync.sh` (T6) | `notes/` → `wiki.sqlite` + `master-index.md` + `topic-map.md` |
| Query | `wiki-query.sh` (T5, FTS5+BM25) | `wiki.sqlite` → results |
| Health check | separate skill (T9) | `wiki.sqlite` → `index/healthcheck-*.md` |
| Trigger | cron 04:00 daily (D4) | `wiki-daily-compile.sh` → this skill → `wiki-sync.sh` |

## Pitfalls

- Per-file LLM calls instead of batching → cost explosion
- Inserting wikilinks or editing `master-index.md` inside Step 1 → breaks the <60s budget and duplicates T6 work
- Translating body language → information loss (D5)
- Creating category subfolders under `notes/` → D7 violated; tags are the grouping mechanism

## Common Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "I'll process each raw file in a separate LLM call for accuracy" | Per-file calls are the root cause of the old $0.30-0.50/file cost. Batch N files into 1 call — accuracy is identical, cost drops 10x. |
| "I'll add wikilinks now to save a step later" | Wikilinks require cross-referencing all existing notes — that is T6/sync territory. Adding them in Step 1 breaks the <60s budget and duplicates work. |
| "This English source should be translated to Korean" | D5 mandates preserving the source language. Translation causes information loss and violates the pipeline contract. |
| "I'll organize notes into category subdirectories for clarity" | D7 mandates flat notes/ with tag-based grouping via SQLite. Category folders break the indexing pipeline. |

## Red Flags

- Individual LLM calls per raw file instead of batched processing
- `[[wikilinks]]` present in Step 1 output
- Notes placed in subdirectories under `notes/` (e.g., `notes/agents/foo.md`)
- `master-index.md` or `topic-map.md` edited directly by this skill
- Body language differs from source language (translation performed)
- Multiple raw files merged into a single note
- Full rebuild triggered instead of delta-only processing
- Tool call count exceeding 20 per file

## Verification

- [ ] Only delta raw files processed (incremental, not full rebuild)
- [ ] Batched into a single LLM call for the delta
- [ ] `notes/` is flat (no subdirectories created)
- [ ] Body language matches source (no translation)
- [ ] No `[[wikilinks]]` inserted, no `index/**` touched in Step 1
- [ ] `wiki-sync.sh` invoked after Step 1 completes
- [ ] Per-file tool calls <20, time <60s, cost <$0.05
