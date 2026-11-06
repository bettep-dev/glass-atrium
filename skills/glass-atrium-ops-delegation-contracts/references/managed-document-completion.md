# Managed Document Completion — stage-write detail and the supersede decision

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `## Managed Document Completion (Direct Handling)`.
- **Author-side counterpart** — includes the completing agent's revise carve-out duty and its chain-root content, which a delegation cannot suspend: `scoped/scope-report.md` → `### Document Lifecycle — completion + exposure routing`.

## Stage write recipe — worked call and error cases

- A body sent in another format's field converts the document (HTML↔plain) or is rejected `400` (plain↔plain).
- An omitted `last_status_model` stores a null status actor.
- A status-only PUT → `400 invalid_body`.

```sh
DOC=$(curl -sf http://127.0.0.1:16145/api/clauded-docs/123)
curl -sf -X PUT http://127.0.0.1:16145/api/clauded-docs/123 -H 'content-type: application/json' \
  --data "$(jq -n --argjson d "$DOC" --arg s implementing --arg m '<running model id>' \
    '{($d.format + "_body"): $d.body, expected_hash: $d.content_hash, doc_status: $s, last_status_model: $m}')"
```

## Supersede vs new document

| Topic | Predecessor | Path |
|-------|-------------|------|
| same topic | `done` | **supersede-POST** |
| same topic | `doc_review`, and not a Stage-2 revise cycle | **PUT-edit** the existing document |
| same topic | `doc_review`, and returned `revise`/`infeasible` by the Stage-2 gate | **supersede-POST**, never a PUT-edit (**Stage-2 revise carve-out**) |
| same topic | `implementing` · `impl_review` · `impl_done` | **supersede-POST at the predecessor's stage** — the new POST carries its `doc_status` |
| unrelated topic | any | **new POST**, `supersedes_id` omitted |
| relatedness uncertain | any | **new POST**, never reopen a `done` document |

- **Every supersede-POST**: a new POST with `supersedes_id` set, plus `last_status_model` — the monitor sets the predecessor to `done` under that actor.
- **supersede-POST at the predecessor's stage**: GET the predecessor for its stage; the revision stays open, so it stays on the session-start open-plan list.
- **Stage-2 revise carve-out** — why: it makes the reviewed revision an immutable, fetchable chain root the revising actor cannot rewrite, so the next Stage-2 pass's scope-fidelity check compares against the origin rather than the declaration that actor just authored.
- **new POST on uncertain relatedness**: the cost is asymmetric — a surplus new document is cheap and recoverable, whereas reopening a `done` document undoes a close.
- **Residual — the per-cycle persist-path choice is honor-system and fails open silently**: no hook tells a revise-case PUT-edit from a sanctioned same-topic `doc_review` edit.
