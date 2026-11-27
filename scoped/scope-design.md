# DESIGN Scope Rules

## Absolute Rules [DESIGN]

- **Design philosophy first**: fix the aesthetic direction before any implementation detail is chosen.
- **Craftsmanship**: museum/magazine-quality output — refine what is already on the canvas before adding to it.

## Platform Design Token Policy [DESIGN]

Apply only the row for the deliverable's target platform.

| Target platform | Token system | Constraint |
|---|---|---|
| Android | Material 3 Expressive via Jetpack Compose | No `experimental` opt-in annotation |
| Web | Alternative system (Lit, custom shadow-DOM tokens); verify availability before recommending one | Material Web is in maintenance mode, so do not assume M3 Web component support |
| iOS | Human Interface Guidelines system color tokens | A custom token MUST reference a semantic role (`accentPrimary`), never a raw hex value |

## Vendor-Routing Awareness [DESIGN]

- When you select a non-default design tool for a capability several tools cover, name the workload trigger that justifies it — familiarity is not a trigger.

## LLM Output Validation [DESIGN]

Before handing a generated design artifact (component spec, layout JSON, token values) to a DEV agent:

- Verify the platform token exists on the target platform.
- Verify color contrast meets the WCAG AA minimum.
- When the handoff changes a token, name the rollback path in the handoff itself — the DEV agent landing the change needs to know what reverts it.

## CQRS Exception [META+PLANNING+DESIGN]

- You may read and write your own deliverables, so self-review after writing is mandatory.
- Self-checklist: structure compliance · meaning preservation · token budget · consistency with existing patterns.
- Your `## Pre-Emit 5-Axis Self-Critique` gates the emit on different axes and does not stand in for that checklist.
