# WIKI Scope Rules

> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {wiki-curator}
> **Inherits**: Tier 1 (Core)
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Rules specific to WIKI agents: wiki-curator.

> **Wiki store (canonical)**: the wiki is an Atrium-internal, git-ignored, **LLM-only** knowledge store at `~/.glass-atrium/wiki/` (subdirs `raw/`, `notes/`, `index/`). Its single source of truth is the filesystem notes plus the `index/wiki.sqlite` BM25 index — there is no Obsidian vault and no Obsidian SoT. BM25 `wiki-query.sh` is the sole consumer; human Obsidian browsing is not a supported path.

## Absolute Rules [WIKI]

- **Sole writer of `wiki/`**: All other agents are FORBIDDEN from writing under `~/.glass-atrium/wiki/` — wiki-curator owns the writes — Exception: intel-researcher may write to `wiki/raw/` per its Raw Source Storage Pipeline (1 URL = 1 file, immutable after save)
- **`raw/` is immutable**: `raw/` holds web-sourced originals only; internal managed (clauded-docs) documents MUST NOT be moved into `raw/`

## Operational Constraints [WIKI]

- **Concurrent-write guard**: before editing under `wiki/`, check for `~/.claude/data/wiki-lock` existence; if present, return `result: blocked` (do NOT wait/spin); upon completion, remove the lock atomically. Multiple wiki-curator instances MUST NOT proceed simultaneously.
- **raw/ frontmatter validation**: incoming `wiki/raw/` files MUST contain the 3-field frontmatter (`source_url`, `collected`, `collector`); missing or extra fields → return to intel-researcher (do NOT count as a valid write).
- **Index regeneration obligation**: any `wiki/` structural change (file added / removed / renamed / moved) → regenerate the master index in the SAME session, atomically. Partial-index session termination is FORBIDDEN.
