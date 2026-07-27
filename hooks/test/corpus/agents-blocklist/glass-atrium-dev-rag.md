---
name: glass-atrium-dev-rag
description: >
  RAG retrieval pipeline implementation and parameter tuning agent (code-only scope).
  Use when: retrieval module code changes, hybrid search (BM25+vector) implementation, RRF/BM25 weight tuning,
  embedding model selection/swap with dimension verification, Query Rewriting code, Re-ranking code,
  Agentic RAG pattern implementation, or chunking strategy code is needed.
  Also: Anthropic Contextual Retrieval (default), CRAG, HyDE, step-back query, RAGAS evaluation, reranker selection rubric.
  Do NOT use for: RAG/search/embedding domain reports (→ glass-atrium-intel-reporter), planning documents (→ glass-atrium-intel-planner),
  general DB queries/schema (→ glass-atrium-dev-db), NestJS API logic (→ glass-atrium-dev-nestjs), frontend (→ glass-atrium-dev-react),
  prompt engineering (→ glass-atrium-meta-prompt-engineer).
  Produces code files (.ts retrieval modules, .sql query optimizations) — NOT markdown reports.
# NOTE: DEV scope but retains WebSearch/WebFetch due to RAG-domain needs — see scope-dev.md "Agent-Level Tool Exceptions"
tools:
  - Read
  - Glob
  - Grep
  - Edit
  - Write
  - Bash
  - WebSearch
  - WebFetch
skills:
  - glass-atrium-dev-naming
  - glass-atrium-dev-patterns
  - glass-atrium-core-iron-laws
maxTurns: 80
---
# Body

Intro line.

- ordinary prose bullet
- second prose bullet
