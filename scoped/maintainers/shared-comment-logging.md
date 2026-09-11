# Maintainer note — `scoped/shared-comment-logging.md`

Corpus-maintenance companion to that rule file. Nothing here is delivered to an agent; the rule file itself carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

DEV + QA agents, plus glass-atrium-meta-prompt-engineer under the "prompts = code" Tier-3 inheritance. The authoritative membership lives on the registry row (`agent-registry.json` → each agent's `rules.shared`) and in the compliance matrix; the rule file states it nowhere.

## Injected block — edit rules

- The `AGENT-INJECT` marker pair in `## Agent Injection Core` is extracted verbatim by the `inject-scope-rules.sh` SubagentStart hook and delivered to the DEV/QA roster. Edit that text in the rule file only; nothing else in the file reaches an agent through the hook.
- Each marker line must stay alone on its line with no surrounding whitespace — the extractor drops the markers by whole-line match — and no second copy of either marker string may appear in the file, which would restart the extraction range.
- **Machine-checked**: `hooks/test/inject-scope-rules-nodrop.bats` drives the hook against the live rule file (not a fixture copy) and asserts that the block's opening bolded phrase reaches every roster member and that the assembled context stays inside the 9984-byte ceiling. `hooks/test/h2-untrusted-ingest.bats` re-asserts the ceiling against the same file. Rewording that opening phrase, or growing the block, turns both red.
- Body text OUTSIDE the marker pair costs no injection bytes: the hook extracts only the marked range, so a restructure of the rest of the file cannot move the assembly figure.

## Restructure + diet pass (this wave)

Dropped as already delivered to the receiving agent through the injected block:

- the why-over-what / stale-comment opener (the block carries the stale-comment rule; the restating-code prohibition survives in `## Comments That MUST NOT Be Written`)
- the long-form docblock-escalation paragraph, including its demotion guards and its `/** */`-bearing-language enumeration — the block carries both, and the worked BAD/GOOD example stayed as the only calibration of the one-essence-line form
- the standalone mid-sentence-line-wrap rule; its worked example stayed, reattached to the style rule it calibrates
- the standalone density-gate bullet — dropped, then RESTORED in compressed form under `## Comment Principles` in the follow-up fix pass, because three prose sites invoke "the density gate" by name (the one-line sufficiency gate · the step-numbers / branch-labels bullet · the over-narration entry under `## Comments That MUST NOT Be Written`) and a non-roster reader of the prose has no other definition. One in-file definition closes all three; the injected block keeps its own copy
- the convention-mirror precedence paragraph, whose mirror rule and two carve-outs the block carries compressed — the Justified-header test it referred to remains defined under `## File / Module Header Comments`
- the history / changelog / attribution prohibition and the TODO owner+ticket format
- the `console.*` production prohibition at all THREE sites it held: the `Logger` bullet under `## Log Message Composition`, the entry under `## Prohibitions`, and the NestJS bullet under `## Platform-Specific Rules`. No duty was lost — the injected block carries the ban with its test-file exemption — and the three surviving bullets keep their non-`console.*` content

Also dropped: the applies-to membership line (above) and the two maintainer blockquotes now held in this note.

## Follow-up fix pass — structure

Three sections the diet pass did not reach were restructured, with no rule added or removed:

- `## Comment Language & Style` — the six-rule `**Style**` bullet split one rule per bullet (form · causality · ending · JSDoc lines · decoration).
- `## Log Message Composition` — the four packed bullets split into ten, one rule each; the error-log ELEMENT list and its STRUCTURE rule are now separate bullets.
- `## Comments That MUST NOT Be Written` — the standalone bolded `**Positive rule**` paragraph became the section's closing bullet, so no bold lead stands in for a heading.
- Plus the density-gate definition restored under `## Comment Principles`, recorded in the drop list above.

Every edit sits OUTSIDE the `AGENT-INJECT` marker pair, so the injected block is unchanged and the assembly byte figures do not move.

## Platform-Specific Rules — kept, with the reason

Each branch names its own platform, so the condition travels with the duty; only two of the three were confirmed to be restated in the body of the agent they bind, which is not enough to call the section redundant.
