# Maintainer note — `scoped/shared-comment-logging.md`

Corpus-maintenance companion to that rule file. Nothing here is delivered to an agent; the rule file itself carries every duty.

## Companion-citation convention (corpus-wide, stated in every companion)

- Companions ship as manifest members, so a pointer to one resolves on a live install.
- A rule file carries at most ONE pointer per externally-cited stub heading — that stub is what keeps the external citation resolving in one hop, and a file with two such headings carries two and no more.
- NOT a pointer under this rule: an HTML comment addressed to the editor of a machine-extracted block — maintainer-facing, never rendered to a reader and never injected.
- Every other citation goes — other rule-file prose, and every agent body. The linkage is recorded in this note instead.

## Membership

DEV + QA agents, plus glass-atrium-meta-prompt-engineer under the "prompts = code" Tier-3 inheritance. The authoritative membership lives on the registry row (`agent-registry.json` → each agent's `rules.shared`) and in the compliance matrix; the rule file states it nowhere.

## Compressed core — edit rules

- **Delivery**: the whole rule file reaches every member through the part slots, selected by each agent's `agent-registry.json` → `rules.shared`. `hooks/inject-scope-rules.sh` extracts nothing from it, and the file carries no `AGENT-INJECT` marker.
- **The core under `## Agent Injection Core` stays as ordinary content**: several rules are stated only there — `Mirror = code form only`, the TODO owner/ticket form, the history/narration prohibition, the stale-comment rule, the mid-sentence wrap rule. Deleting it as a duplicate loses them.
- **Folding the core into its canonical sections is open work**: it needs a per-bullet audit, and it is the only way to remove the in-file restatement a member now reads twice within one part.
- **Keep the heading `## Agent Injection Core`** until the fold above lands: retitling it belongs to that change, which decides what the section still holds.
- **Keep the core's bold lead phrase** (the words before its parenthetical): `hooks/test/inject-scope-rules-nodrop.bats` → `RETIRED_NEEDLES` asserts it ABSENT from slot 1, and the check proves nothing once the phrase no longer exists in the source.
- **Precondition the retirement rests on**: `python3 hooks/lib/inject_chunk.py --audit` MUST report `events=none` for every member. An OVERFLOW displaces a member band, and no slot-1 copy remains behind it.

## Restructure + diet pass (this wave)

Dropped as already stated in the core under `## Agent Injection Core` ("the block" below):

- the why-over-what / stale-comment opener (the block carries the stale-comment rule; the restating-code prohibition survives in `## Comments That MUST NOT Be Written`)
- the long-form docblock-escalation paragraph, including its demotion guards and its `/** */`-bearing-language enumeration — the block carries both, and the worked BAD/GOOD example stayed as the only calibration of the one-essence-line form
- the standalone mid-sentence-line-wrap rule; its worked example stayed, reattached to the style rule it calibrates
- the standalone density-gate bullet — dropped, then RESTORED in compressed form under `## Comment Principles` in the follow-up fix pass, because three prose sites invoke "the density gate" by name (the one-line sufficiency gate · the step-numbers / branch-labels bullet · the over-narration entry under `## Comments That MUST NOT Be Written`) and a non-roster reader of the prose has no other definition. One in-file definition closes all three; the block keeps its own copy
- the convention-mirror precedence paragraph, whose mirror rule and two carve-outs the block carries compressed — the Justified-header test it referred to remains defined under `## File / Module Header Comments`
- the history / changelog / attribution prohibition and the TODO owner+ticket format
- the `console.*` production prohibition at all THREE sites it held: the `Logger` bullet under `## Log Message Composition`, the entry under `## Prohibitions`, and the NestJS bullet under `## Platform-Specific Rules`. No duty was lost — the block carries the ban with its test-file exemption — and the three surviving bullets keep their non-`console.*` content

Also dropped: the applies-to membership line (above) and the two maintainer blockquotes now held in this note.

## Follow-up fix pass — structure

Three sections the diet pass did not reach were restructured, with no rule added or removed:

- `## Comment Language & Style` — the six-rule `**Style**` bullet split one rule per bullet (form · causality · ending · JSDoc lines · decoration).
- `## Log Message Composition` — the four packed bullets split into ten, one rule each; the error-log ELEMENT list and its STRUCTURE rule are now separate bullets.
- `## Comments That MUST NOT Be Written` — the standalone bolded `**Positive rule**` paragraph became the section's closing bullet, so no bold lead stands in for a heading.
- Plus the density-gate definition restored under `## Comment Principles`, recorded in the drop list above.

Every edit sat outside the core under `## Agent Injection Core`, so the core text is unchanged by this pass.

## Platform-Specific Rules — kept, with the reason

Each branch names its own platform, so the condition travels with the duty; only two of the three were confirmed to be restated in the body of the agent they bind, which is not enough to call the section redundant.
