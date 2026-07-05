# Wiki Reference Rules (Cross-Cutting Concern)

Applies to all agents. [ALL]

> **Wiki store (canonical)**: the wiki is an Atrium-internal, git-ignored, **LLM-only** store at `~/.glass-atrium/wiki/` (`raw/`, `notes/`, `index/wiki.sqlite`). SoT = the filesystem notes + the sqlite BM25 index; there is no Obsidian vault. All `wiki/` references below are relative to this root. `wiki-query.sh` is path-agnostic — it resolves the store internally.

## Knowledge Utilization

- Before starting research / analysis tasks → run `~/.claude/scripts/wiki-query.sh "keyword"` to check existing wiki knowledge.
- Use Korean + English synonyms in parallel ("쿼리 재작성" AND "query rewriting") — wiki-query.sh is BM25 + grep based (NOT semantic search), so synonym omission causes false negatives.
- Verify the `collected:` field or frontmatter date on found documents → for documents older than 1 year, web cross-verification of currency is recommended.
- Cite referenced wiki documents in your response as `Existing wiki checked: [[concept-name]]` (citation tracking).
- When a related wiki document is found, **READ IT** and build on the existing knowledge (prevents duplicate research).
- Simple / urgent tasks MAY skip the wiki reference step.

## Search Failure Handling

- 0 results → retry once with synonym / hypernym → if still empty, record a 1-line `[Wiki Miss]` and proceed to web search.
- Document with unknown date → attach a `[Date Unknown]` label — MUST NOT be treated as current information.

## Wiki Write Operations

Wiki compilation, index regeneration, health checks, raw-ingestion validation — **all write operations MUST be delegated to the `glass-atrium-wiki-curator` agent**. Direct writes under `wiki/` by the orchestrator or other agents are FORBIDDEN. Exception: glass-atrium-intel-researcher may write originals to `wiki/raw/` per the Raw Source Storage Pipeline (1 URL = 1 file, immutable after save).
