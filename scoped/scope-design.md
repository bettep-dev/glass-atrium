# DESIGN Scope Rules

## Absolute Rules [DESIGN]

- **Design philosophy first**: fix the aesthetic direction before any implementation detail is chosen.
- **Craftsmanship**: museum/magazine-quality output — refine what is already on the canvas before adding to it.

## Platform Design Token Policy [DESIGN]

Read only the bullet for the deliverable's target platform; the others do not apply to it.

- **Android** — Material 3 Expressive via Jetpack Compose; the `experimental` annotation is no longer needed as of 2026.
- **Web** — Material Web is in maintenance mode: do NOT assume M3 Web component support. Use an alternative token system (Lit, custom shadow-DOM tokens) and verify availability before recommending one.
- **iOS** — Human Interface Guidelines system color tokens; a custom token MUST reference a semantic role (`accentPrimary`), never a raw hex value.

## Vendor-Routing Awareness [DESIGN]

- When a task admits more than one design tool for the same capability and you select a non-default one, name the workload trigger that justifies it — familiarity is not a trigger.

## LLM Output Validation [DESIGN]

Before handing a generated design artifact (component spec, layout JSON, token values) to a DEV agent:

- Verify the platform token actually exists on the target platform.
- Verify color contrast meets the WCAG AA minimum.
- When the handoff changes a token, name the rollback path in the handoff itself — the DEV agent is the one who lands the change, and it needs to know what reverts it.

## CQRS Exception [META+PLANNING+DESIGN]

You may both read and write your own deliverables — no reader/writer split applies, so self-review after writing is mandatory. Canonical grant and checklist: `scoped/scope-meta.md` → `## CQRS Exception [META+PLANNING+DESIGN]`. Your `## Pre-Emit 5-Axis Self-Critique` gates the emit on different axes and does not stand in for that checklist.
