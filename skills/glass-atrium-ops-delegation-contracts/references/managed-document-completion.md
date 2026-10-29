# Managed Document Completion — stage-write detail and the supersede decision

- **Pointer site**: `skills/glass-atrium-ops-orchestrator.md` → `## Managed Document Completion (Direct Handling)` — the stages, who closes, the `implementing` write, the recipe, the `done`-immutability rule and the delivery-point close.
- Author-side counterpart: `scoped/scope-report.md` → `### Document Lifecycle — completion + exposure routing`.

## Stage write recipe — worked call and error cases

- A body sent in another format's field converts the document (HTML↔plain) or is rejected `400` (plain↔plain).
- An omitted `last_status_model` stores a null status actor.
- A status-only PUT (bare `{"doc_status":…}`) → `400 invalid_body`.

```sh
DOC=$(curl -sf http://127.0.0.1:16145/api/clauded-docs/123)
curl -sf -X PUT http://127.0.0.1:16145/api/clauded-docs/123 -H 'content-type: application/json' \
  --data "$(jq -n --argjson d "$DOC" --arg s implementing --arg m '<running model id>' \
    '{($d.format + "_body"): $d.body, expected_hash: $d.content_hash, doc_status: $s, last_status_model: $m}')"
```

## Supersede vs new document

Two axes decide the path: topic sameness, and the predecessor's stage — at `doc_review`, also whether this is a Stage-2 revise cycle.

| Topic | Predecessor | Path |
|-------|-------------|------|
| same topic | `done` | **supersede** — new POST with `supersedes_id` set |
| same topic | `doc_review`, and NOT a Stage-2 revise cycle | **PUT-edit** the existing document (continue working the same doc) |
| same topic | `doc_review`, and returned `revise`/`infeasible` by the Stage-2 gate | **supersede-POST** — new POST with `supersedes_id` set, NEVER a PUT-edit |
| same topic | `implementing` · `impl_review` · `impl_done` | **supersede-POST at the predecessor's stage** — the new POST carries its `doc_status` |
| unrelated topic | any | **new-document POST** (`supersedes_id` omitted) |
| topic-relatedness uncertain | any | default to a **new POST**, never reopen a done document |

Row notes:

- **Every supersede-POST** sends `last_status_model`: the monitor sets the predecessor to `done` under that actor.
- **supersede-POST at the predecessor's stage**: GET the predecessor for its stage; the revision stays open, so a mid-implementation revision stays on the session-start open-plan list.
- **supersede-POST** (the Stage-2 revise carve-out; gate: `skills/glass-atrium-ops-orchestrator-role.md` → `### Plan Direction Verification (Stage-2 gate)`): the only branch where a `doc_review` predecessor is superseded.
  - Why: it makes the reviewed revision an immutable, fetchable chain root the revising actor cannot rewrite, so the next pass compares against the origin rather than the declaration that actor just authored.
  - The completing agent's own duty, including what the chain root must contain: `scoped/scope-report.md` → `### Document Lifecycle — completion + exposure routing`.
- **new POST on uncertain relatedness** breaks ties because the cost is asymmetric: a surplus new document is cheap and recoverable, whereas reopening a done document undoes a close.
- **Residual — the per-cycle persist-path choice is honor-system and fails open silently**: no hook tells a revise-case PUT-edit from a sanctioned same-topic `doc_review` edit.
  - Skipping the carve-out raises no error: no chain root is created, the next Stage-2 pass has no immutable comparand, and the scope-fidelity check degrades to the declaration it exists to replace.
  - That is why the duty sits in the completing agent's own loaded rules rather than in the delegation asking for the edit: a control the acting agent can suspend by phrasing is not a control.
