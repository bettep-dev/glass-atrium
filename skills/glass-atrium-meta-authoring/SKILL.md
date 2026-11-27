---
name: glass-atrium-meta-authoring
description: Quality standards, structural conventions, CSO (description optimization), and TDD guidelines for SKILL.md files. Use when creating, restructuring or reviewing a skill, or when a skill triggers too often or too rarely. Do NOT use for agent instructions (agents/), system prompt design, general markdown documentation.
---

# Writing Skills Standard

## Skill Structure Standard

### Directory Structure

```
~/.claude/skills/{skill-name}/
  SKILL.md
  scripts/              # Optional: executable code
  references/           # Optional: detailed reference material
  assets/               # Optional: templates, images, data files
```

### Progressive Disclosure (3-Stage Loading)

1. **Metadata** (~100 tokens): name + description — loaded at startup for all skills
2. **Body** (<5000 tokens, <500 lines): SKILL.md body — loaded when the skill is activated
3. **Resources** (on demand): scripts/, references/, assets/ — loaded during task execution

### Frontmatter Required/Optional Fields (per Agent Skills Spec)

```yaml
---
name: skill-name          # Required - see the name rules below
description: ...          # Required - 1-1024 chars, apply CSO pattern (see below)
license: Apache-2.0       # Optional - license name or LICENSE file reference
compatibility: ...        # Optional - environment requirements (1-500 chars)
allowed-tools: Bash Read  # Optional - pre-approved tool list (experimental)
metadata:                 # Optional - arbitrary key-value pairs
  author: org-name
  version: "1.0"
---
```

#### `name` rules

- 1-64 chars: lowercase a-z, digits and hyphens only.
- No leading or trailing hyphen, and no consecutive hyphens (`--`).
- Matches the directory name.

### Project-Local Extension Fields (`triggers`)

- Project-local frontmatter, not part of the Agent Skills Spec: use it only on a structured review/gate skill (e.g. `glass-atrium-design-anti-slop`).
- Keep the field name exactly as below — no alias such as `trigger`.

```yaml
triggers:                 # Optional - explicit short trigger phrases (complements the CSO keywords in description)
  - short trigger phrase
```

### SKILL.md Body Structure

The official spec does not enforce a body format; this structure is recommended:

```markdown
# Skill Name
{Purpose in 1-2 sentences}

## When to Use
- Bullet list

## Core Rules / Procedures
{Outcomes, constraints and how to verify; exact commands only for fragile operations (destructive, deploy, auth) where one sequence is safe}

## Edge Cases
{Exception handling}

## Output Format
{Example template -- if applicable}

## References
{references/ links -- if applicable}
```

## CSO (Contextual Skill Optimization)

The `description` field is the key to automatic activation: Claude decides whether to invoke a skill from it.

### Description Pattern

```
{Description}. Use when {intent categories}. Do NOT use for {exclusion conditions}.
```

### Trigger Keyword Principles

- Name generalized **categories of intent** in words users actually use (`creating or reviewing a skill`) — the description rides in every request, and a list of near-synonymous phrasings generalizes worse than a category
- A distinctive file name or path the user would type (`SKILL.md`) sits inside the category, not as a separate trigger entry

### Do NOT Use For Clause

- Prevents false activation — explicitly delineates boundaries with **similar but distinct skills/agents**
- Example: `Do NOT use for agent instructions, system prompt design`

## Quality Checklist

Verify after completing a skill:

- [ ] SKILL.md body within the **Body** caps of `### Progressive Disclosure (3-Stage Loading)`
- [ ] Detailed content separated into `references/`
- [ ] Frontmatter `name` passes the `name` rules
- [ ] Frontmatter `description`: within its cap, including "Use when" and "Do NOT use for"
- [ ] Trigger keywords follow `### Trigger Keyword Principles`
- [ ] The scenarios of `## TDD Skill Development` defined before the body and cross-checked against the description
- [ ] Role boundaries with existing skills and agents are clear and addressed in the description
- [ ] Output format defined

## TDD Skill Development

### Before Writing: Define Activation Scenarios

- Why: without scenarios, false or missed activation surfaces in production, not during writing.

#### Scenarios that MUST activate (minimum 3)

- "Create a new skill"
- "Check if this SKILL.md structure is correct"
- "Improve this skill's description"

#### Scenarios that MUST NOT activate (minimum 2)

- "Edit agent instructions"
- "Write a README.md"

### After Writing: Matching Verification

- Manually verify that each activation scenario falls inside an intent category the description names
- Confirm that each false-activation scenario falls inside an exclusion the Do NOT use for clause names
- If matching fails → widen or re-word the intent category that should have matched; never append the missed phrase verbatim

## References

- [Agent Skills Specification](https://agentskills.io/specification)
