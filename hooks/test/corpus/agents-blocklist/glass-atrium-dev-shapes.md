---
name: "glass-atrium-dev-shapes"
description: >
  Synthetic shape-coverage fixture for the frontmatter extractor.
  Second continuation line, indented under a folded block scalar.
title: 'quoted scalar under a non-guarded key'

# full-line comment directly above tools:
tools:
  - Read
  - Glob # inline comment after a list item
  - Grep
skills:
- glass-atrium-dev-naming
- glass-atrium-dev-patterns
skills_policy:
  status: "selective_injection_allowed"
  rationale: "quoted value inside a nested map"
model: claude-model-a
maxTurns: 80
---
# Body

Intro line.

- ordinary prose bullet
- second prose bullet
