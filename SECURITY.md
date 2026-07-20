# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest release (v1.0.1 line) | Yes |
| Older releases | No — please reproduce on the latest release |

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

- **Primary channel**: [GitHub Private Vulnerability Reporting](https://github.com/bettep-dev/glass-atrium/security/advisories/new)
  (Security Advisories) on `bettep-dev/glass-atrium`.
- **Fallback**: email hongdaesik88@gmail.com with `[glass-atrium security]`
  in the subject.

Please include:

- Reproduction steps (a minimal proof of concept is ideal).
- The affected file(s) or component (installer, hook, monitor route, daemon…).
- The version or release bundle you tested against.

## What counts as in scope

- The `curl | bash` installer (`install.sh`) and the per-file **SHA-256
  manifest** (`manifest.json`) that serves as its integrity trust anchor.
- The hook enforcement layer (`hooks/` — secret-scan, delegation, and
  verification gates wired into Claude Code).
- The Atrium Monitor (Node service bound to loopback, `127.0.0.1:16145`) and
  its API routes.
- The launchd daemons (monitor + self-improvement loop) and their rendered
  plists.
- The secret-scan / PII-scan gates (`scripts/pii-scan.sh` and the fail-closed
  PreToolUse hooks) — a bypass of these gates is a valid finding.

Out of scope: vulnerabilities requiring an already-compromised local user
account, and issues in third-party dependencies without a Glass Atrium
specific exploitation path (report those upstream, but a heads-up is
appreciated).

## Response expectations

- Acknowledgment within **7 days** of the report.
- Confirmed vulnerabilities are fixed and shipped via a **new GitHub Release
  bundle** (live installs update from release bundles, not from `main`), with
  credit to the reporter unless anonymity is requested.

## Hardening summary

- **Fail-closed secret scanning** — PreToolUse hooks block writes containing
  secret material before they land; the release gate adds a repo-wide PII
  scan (worktree + git history).
- **Per-file SHA-256 release verification** — every bundled file is hash-
  pinned in `manifest.json`; `glass-atrium doctor` verifies integrity on the
  installed tree.
- **Loopback-only monitor** — the monitor binds `127.0.0.1:16145` and is
  never exposed on an external interface; PostgreSQL is peer-auth over a
  Unix socket with no password material in the repository.
- **Least-privilege agents** — each agent's tool allowlist is frozen at spawn
  time; high-impact actions require explicit user approval.
- **CI least privilege** — deny-all workflow token (`permissions: {}`),
  `pull_request` (never `pull_request_target`), pinned action SHAs.
