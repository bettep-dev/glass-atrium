<!-- `od:` extension pattern adapted from nexu-io/open-design `docs/skills-protocol.md` (Apache 2.0). Optional opt-in schema for structured I/O metadata on review / template / generator skills. -->

# SKILL.md `od:` Extension Pattern

## Purpose

Optional `od:` frontmatter block for skills with structured workflow metadata (mode, inputs, outputs, capabilities). Adapted from open-design SKILL.md schema. **OPT-IN** — skill-loader does NOT require it; skills without `od:` continue to load via existing convention (name + description + triggers).

## Schema

```yaml
od:
  mode: prototype | deck | template | design-system | review
  preview:
    type: html | image | pdf
    entry: path/to/preview-entry
  design_system:
    inject: true | false
    sections: [color, typography, spacing, components]
  craft: [slug-1, slug-2]          # craft references (e.g., specific design movement)
  inputs:
    - name: param-name
      type: file_path | color | enum | text | number
      label: human-readable label
      default: optional-default
      values: [enum, values, if, type=enum]
  parameters:                       # typed defaults block (alternative to inputs[].default)
    key: value
  outputs:
    primary: output-filename.md
    secondary: [optional-array]
  capabilities_required: [Read, Grep, Bash, Edit, Write]
```

## When to Adopt

ADD `od:` when:
- Skill has structured I/O contract (specific input parameters, named output file)
- Skill is invoked as a discrete review / template / generator workflow
- Skill consumes specific capabilities (Read / Grep / Bash) that benefit from declarative manifest

DO NOT add `od:` when:
- Skill is narrative / guidance (e.g., `glass-atrium-meta-authoring`)
- Skill has no fixed I/O shape (e.g., `glass-atrium-core-iron-laws` cross-cutting invariant)
- Skill is consumed implicitly during task execution rather than invoked

## Validation

- `od:` is OPT-IN — absence does not block skill load
- When present, `name` MUST still match directory name (existing skill-loader rule)
- `mode` value SHOULD be one of canonical 5 (prototype / deck / template / design-system / review); custom values permitted but lose IDE / future-tooling integration
- `capabilities_required` SHOULD match actual tool usage — under-declaration risks runtime tool-gate failure

## Adopting Examples (P2.B phase)

3 design skills adopted `od:` as `mode: review`:

- **anti-slop** (`~/.claude/skills/glass-atrium-design-anti-slop/SKILL.md`): inputs=[artifact], outputs=review_report.md, capabilities=[Read, Grep]
- **design-5-axis-critique** (`~/.claude/skills/glass-atrium-design-5-axis-critique/SKILL.md`): inputs=[artifact], outputs=critique_report.md, capabilities=[Read]
- **contrast-check** (`~/.claude/skills/glass-atrium-design-contrast-check/SKILL.md`): inputs=[fg_color, bg_color, text_size], outputs=contrast_report.md, capabilities=[Bash, Read]

These illustrate `mode: review` shape. Future template / generator skills should mirror the corresponding shape per upstream open-design protocol.

## Cross-References

- Open-design canonical spec: `docs/skills-protocol.md` (Apache 2.0 upstream)
- `glass-atrium-meta-authoring` SKILL.md — general SKILL.md authoring conventions
- Skill-registry.json — registration registry (separate concern from `od:` block)
