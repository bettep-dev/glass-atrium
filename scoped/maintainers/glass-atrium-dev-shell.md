# Maintainer note — agents/glass-atrium-dev-shell.md

Corpus-maintenance companion. The agent never reads this file; the body holds agent-facing duties only.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Scope of this pass

This body had already taken the restructure-and-diet pass (commit 2dbac77; touched since only by the pointer-line drop at bc03f9d). It was therefore edited here only where a disposition binds, plus one maintainer blockquote moved into this note.

## Budget-sizing bullets — why they are not a mirror

`hooks/test/inject-scope-rules-nodrop.bats` reads this body directly and asserts that the DEV budget injection block is ABSENT for this agent: it is a carrier, excluded from the injected roster because the body carries the rule instead. The two sizing bullets under the Guardrails budget heading are consequently this agent's ONLY copy — `scoped/shared-turn-budget.md` reaches no DEV agent at spawn — so deleting them as a duplicate deletes the rule while reddening nothing. A one-line guard stays in the body under `### Budget sizing`, and it states the no-mirror fact on its own — it does not cite this note, per the companion-citation convention above (verified against the body, which contains no `maintainers/` citation at all).

The same suite sizes the injected turn-budget meter from the real frontmatter `maxTurns` and counts those bytes into a pinned worst-case DEV assembly total, so `maxTurns` is machine-read, not a free knob.

## Destructive-literal convention — kept in the body deliberately

The blockquote under the role line is maintainer-facing by audience, and the wave rule would move it here. It stays in the body, and this is the reasoning: the guard protects the patchability of the file it sits in. The updater's sensitive-diff check scans ADDED lines of any patch to this body, cannot distinguish a rule forbidding a destructive command from a patch running it, and makes the merge planner refuse the file while the cycle still reports success. Whoever patches this body — including the daemon's own editor, which reads the file and not this directory — must see that constraint at the point of editing. Moving it out would leave the guard true and unread.

Its operative content, restated once here so the decision is auditable: every destructive command named in that body is written in words (verb plus flags), never as an invocation, and reflowing a line counts as adding it, so a literal form is never restored for tidiness.

## Machine constraints on the body

| Reader | What it reads | Consequence |
|---|---|---|
| `hooks/test/inject-scope-rules-nodrop.bats` | this file as a real source; carrier exclusion + `maxTurns` | see above |
| `hooks/inject-scope-rules.sh` → `read_max_turns` | `^maxTurns:` at column 0 | meter sizing |
| `hooks/enforce-harness-critical.sh` | live frontmatter identity keys (name, tools, scope) + fence-line count | blocked for every caller (LLM06); several suites additionally use a fake-HOME copy of this filename as a fixture, which is unaffected by repo-tree edits |
| the updater's sensitive-diff check | ADDED lines of any patch to this body | destructive-literal convention above |

## Decision landed in this pass

**Naming subordination**: the `Match existing style` bullet under Work Rules is the one site in this body naming a naming axis. It now mirrors indentation and logging conventions from sibling scripts and subordinates identifier naming to the `glass-atrium-dev-naming` canon, while the shell-specific `snake_case` function casing stays where it was, in the Functions bullet directly below. The bullet sits INSIDE an editable region, so the edit was held to exactly what the disposition needs — a live install with local edits resolves that region through a merge.
