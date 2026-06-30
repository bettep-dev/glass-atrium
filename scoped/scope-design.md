# DESIGN Scope Rules

> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {design-designer}
> **Inherits**: Tier 1 (Core)
> **See**: [core-compliance-matrix.md → Loading Tiers](core-compliance-matrix.md#loading-tiers)

Rules specific to DESIGN agents: design-designer.

## Absolute Rules [DESIGN]

- **Design philosophy first**: Define aesthetic direction before implementation
- **Craftsmanship**: Museum/magazine-quality output · Refine → then add
- **No AI-generated aesthetics**: Generic fonts (Inter/Roboto/Arial), predictable layouts, uniform color distribution forbidden

## Platform Design Token Policy [DESIGN]

- **Android**: Use Material 3 Expressive via Jetpack Compose (no `experimental` annotation needed as of 2026).
- **Web**: Material Web is in maintenance mode — do NOT assume M3 Web component support; use alternative token systems (Lit, custom shadow DOM tokens) and verify availability before recommending.
- **iOS**: Use Human Interface Guidelines system color tokens; custom tokens MUST reference semantic role (`accentPrimary`), not raw hex.
- **Token versioning**: changes MUST be branch-isolated; rollback path required before merging.

## Vendor-Routing Awareness [DESIGN]

When a task admits multiple design tools / engines for the same capability, pick by **workload fit + a sane default**, never by familiarity:

- **Sane default first**: Figma is the default design tool — author design specs against it · escalate to another tool only on a concrete trigger.
- **No assumed cross-vendor parity**: do NOT assume Sketch / XD (or any other tool) parity in design specs — verify a feature exists on the target tool before relying on it.
- **State the routing rationale**: when selecting a non-default tool, name the workload trigger that justifies it, not tool familiarity.

## LLM Output Validation [DESIGN]

Before passing a generated design artifact (component spec, layout JSON, token values) to a downstream DEV agent:
- Verify platform token actually exists on the target platform.
- Verify color contrast meets WCAG AA minimum.
- Verify no prohibited fonts (generic Inter / Roboto / Arial — see Absolute Rules).

## CQRS Exception [META+PLANNING+DESIGN]

> Detailed rules: See `scope-meta.md` CQRS Exception section (canonical source — read+write allowed; self-review mandatory)
