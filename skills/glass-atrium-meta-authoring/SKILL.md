---
name: glass-atrium-meta-authoring
description: Quality standards, structural conventions, CSO (description optimization), and TDD guidelines for writing new skills. Use when writing new skills, improving existing skills, skill quality review, creating SKILL.md, skill review, skill structure design. Do NOT use for agent instructions (agents/), system prompt design, general markdown documentation.
---

# Writing Skills Standard

## Overview

A meta-skill for consistent quality when writing SKILL.md files: directory structure, frontmatter conventions, body structure, description optimization (CSO) for automatic activation, and TDD-based quality verification.

## When to Use

- Creating a new SKILL.md file from scratch
- Improving an existing skill's description or structure
- A skill quality review is requested
- Role boundaries between skills are unclear

## Skill Structure Standard

### Directory Structure

```
~/.claude/skills/{skill-name}/
  SKILL.md              # Body <5000 tokens, <500 lines
  scripts/              # Optional: executable code
  references/           # Optional: detailed reference material (on-demand loading)
  assets/               # Optional: templates, images, data files
```

### Progressive Disclosure (3-Stage Loading)

1. **Metadata** (~100 tokens): name + description — loaded at startup for all skills
2. **Body** (<5000 tokens): SKILL.md body — loaded when the skill is activated
3. **Resources** (on demand): scripts/, references/, assets/ — loaded during task execution

### Frontmatter Required/Optional Fields (per Agent Skills Spec)

```yaml
---
name: skill-name          # Required - 1-64 chars, lowercase+digits+hyphens only, MUST match directory name
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

- Lowercase a-z, digits and hyphens only.
- No leading or trailing hyphen, and no consecutive hyphens (`--`).
- Matches the directory name.

### Project-Local Extension Fields (`triggers`)

- Beyond the spec fields above, this ecosystem's review/gate skills (e.g. `glass-atrium-design-anti-slop`, `glass-atrium-design-5-axis-critique`, `glass-atrium-design-contrast-check`) carry one project-local frontmatter extension.
- It is not part of the Agent Skills Spec: use it only when the skill is a structured review/gate skill.
- Keep the field name exactly as below — no alias such as `trigger`.

```yaml
triggers:                 # Optional (project-local) - explicit short trigger phrases (complements the CSO keywords in description)
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
{Step-by-step instructions, input -> processing -> output flow}

## Edge Cases
{Exception handling}

## Output Format
{Example template -- if applicable}

## References
{references/ links -- if applicable}
```

## CSO (Contextual Skill Optimization)

The `description` field is the key to automatic activation: Claude decides whether to invoke a skill from its description.

### Description Pattern

```
{Description}. Use when {trigger keyword list}. Do NOT use for {exclusion conditions}.
```

### Trigger Keyword Principles

- Write in **words users actually use**
- Include both technical terms and everyday expressions: `SKILL.md creation, skill writing`
- Include verb forms: `write, improve, review, audit`
- Include relevant file names/paths: `SKILL.md, skills/`

### Do NOT Use For Clause

- Prevents false activation — explicitly delineates boundaries with **similar but distinct skills/agents**
- Example: `Do NOT use for agent instructions, system prompt design`

## Quality Checklist

Verify after completing a skill:

- [ ] SKILL.md body within 5000 tokens and 500 lines
- [ ] Detailed content separated into `references/`
- [ ] Frontmatter `name`: lowercase + hyphens only, 64 chars max, matching the directory name
- [ ] Frontmatter `description`: within 1024 chars, including "Use when" and "Do NOT use for"
- [ ] Trigger keywords match actual usage scenarios — words users type, not jargon
- [ ] At least 3 activation and 2 false-activation scenarios defined before the body and cross-checked against the description
- [ ] Role boundaries with existing skills and agents are clear and addressed in the description
- [ ] Output format defined

## TDD Skill Development

Ensure skill quality through a test-driven approach.

### Before Writing: Define Activation Scenarios

Define these **before** writing the skill.

#### Scenarios that MUST activate (minimum 3)

- "Create a new skill" → should activate
- "Check if this SKILL.md structure is correct" → should activate
- "Improve this skill's description" → should activate

#### Scenarios that MUST NOT activate (minimum 2)

- "Edit agent instructions" → should not activate
- "Write a README.md" → should not activate

### After Writing: Matching Verification

- Manually verify that description keywords match the words in activation scenarios
- Confirm that false-activation scenario words are reflected in Do NOT use for
- If matching fails → add or modify description keywords

## Core Process

1. **Define scenarios** → 3 activation + 2 false-activation
2. **Create directory** → `~/.claude/skills/{skill-name}/`
3. **Write frontmatter** → name + CSO pattern description
4. **Write body** → standard structure (purpose → when to use → rules → output)
5. **Check tokens** → over 5000, separate into `references/`
6. **Run the Quality Checklist**
7. **Matching verification** → cross-check description keywords against scenarios

## References

- [Agent Skills Specification](https://agentskills.io/specification) — Anthropic official standard
- [anthropics/skills GitHub](https://github.com/anthropics/skills/blob/main/spec/agent-skills-spec.md) — spec source

## Common Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "The description doesn't matter, I'll just write good instructions" | The description is the ONLY field Claude reads at startup for all skills. A poor description means the skill never activates, no matter how good the body is. |
| "I don't need 'Do NOT use for' — my trigger keywords are specific enough" | Without negative conditions, similar skills collide. Two copy-generation skills both triggering on 'marketing copy' without explicit boundaries fire ambiguously. |
| "TDD for skills is overkill" | Skills without activation scenarios cannot be verified. You discover false activation or missed activation in production, not during writing. |
| "I'll keep everything in SKILL.md for convenience" | Skills over 5000 tokens degrade progressive loading. Split reference material into `references/` — the body stays lean, resources load on demand. |
