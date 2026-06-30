# RAG / Search / Embedding Domain Reference

> Reference for `intel-reporter` agent. Use when authoring RAG / search / embedding domain reports. Code-level fixes → delegate back to `dev-rag`.

## Terminology Cheatsheet

| Term | One-line meaning |
|------|------------------|
| BM25 | Bag-of-words ranking with TF saturation + length normalization (keyword precision baseline) |
| Vector search | Embedding similarity (cosine/dot) over dense vectors — captures semantic proximity |
| Hybrid search | BM25 + Vector combined — covers keyword exactness AND semantic intent |
| RRF (Reciprocal Rank Fusion) | Score-free fusion: `1/(k + rank)`; default `k=60` — merges hybrid results without normalization |
| Re-ranking | Second-pass model (cross-encoder) re-scores top-N retrieved docs for higher precision |
| Embedding model | Encoder producing fixed-dim vectors; **dimension change = full re-index required** |
| Chunking strategy | Splits source docs into retrievable units (size + overlap balance context vs precision) |
| Query Rewriting | Conversation context → self-contained query (resolves pronouns/ellipsis) |
| Confidence Scoring | Threshold (0.7–0.8 typical); below → respond "no information" |
| MRR / nDCG / precision / recall | Retrieval quality metrics — required for any "improvement" claim |

## Common RAG Report Structures

- **Search quality analysis report**: Summary → Current pipeline (BM25/Vector/RRF config) → Symptom (low precision/recall) → Root cause (parameter, chunking, embedding) → Recommendation matrix → Roadmap
- **Embedding model comparison report**: Summary → Candidates (dim, cost, license) → Eval setup (dataset, metrics) → Score matrix (MRR/nDCG) → Recommendation + migration cost
- **RAG architecture review report**: Summary → C4 Level 1-3 diagram → Component breakdown → Trade-off table → Risk matrix → References
- **Chunking strategy report**: Summary → Strategy comparison (fixed/sliding/semantic) → Eval results → Recommendation per content type

## Required Quantitative Elements

- Before/after metrics for any change claim: precision, recall, MRR, nDCG (at minimum 1 metric)
- Embedding swap reports MUST cite dimension compatibility check
- Parameter change reports MUST cite A/B test sample size + statistical significance

## When to Delegate Back to dev-rag

| Situation | Action |
|-----------|--------|
| User wants the actual code change applied (not just analysis) | Delegate to `dev-rag` |
| BM25 weights / RRF k-value need to be tuned in source files | Delegate to `dev-rag` |
| Embedding model swap requires `.ts` retrieval module changes | Delegate to `dev-rag` |
| Reader needs SQL query optimizations applied | Delegate to `dev-rag` |
| Reader only needs the report (synthesis, comparison, recommendation) | Stay with `intel-reporter` |
