# RAG / Search / Embedding Domain Reference

> Reader: `glass-atrium-intel-reporter`.

## Terminology Cheatsheet

| Term | Meaning |
|------|---------|
| RRF (Reciprocal Rank Fusion) | Score-free fusion of hybrid results: `1/(k + rank)`; default `k=60` |
| Embedding model | Encoder producing fixed-dim vectors; **dimension change = full re-index required** |
| Confidence Scoring | Threshold (0.7–0.8 typical); below → respond "no information" |

## Common RAG Report Structures

Section order after the summary:

- **Search quality analysis report**: Current pipeline (BM25/Vector/RRF config) → Symptom (low precision/recall) → Root cause (parameter, chunking, embedding) → Recommendation matrix → Roadmap
- **Embedding model comparison report**: Candidates (dim, cost, license) → Eval setup (dataset, metrics) → Score matrix (MRR/nDCG) → Recommendation + migration cost
- **RAG architecture review report**: C4 Level 1-3 diagram → Component breakdown → Trade-off table → Risk matrix → References
- **Chunking strategy report**: Strategy comparison (fixed/sliding/semantic) → Eval results → Recommendation per content type

## Required Quantitative Elements

- The before/after gate needs at minimum 1 metric per change claim.

## When to Delegate Back to glass-atrium-dev-rag

- Code change wanted, not just analysis (BM25 weights, RRF k, `.ts` retrieval module embedding swap, SQL optimizations) → hand it back to the orchestrator for `glass-atrium-dev-rag`.
