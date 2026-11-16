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
  its API routes, including the opt-in remote listener described under
  [Remote access](#remote-access-opt-in).
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
- **Loopback-only monitor by default** — the monitor binds `127.0.0.1:16145`;
  only the opt-in remote listener below ever binds another interface.
  PostgreSQL is peer-auth over a Unix socket with no password material in
  the repository.
- **Least-privilege agents** — each agent's tool allowlist is frozen at spawn
  time; high-impact actions require explicit user approval.
- **Owner queue approvals** — an owner answer or owner message counts as
  that explicit approval, for the one action it states, once the session
  has claimed it, `get` has returned it for that session and `ack` has
  printed `first`.
  - The queue has no login: any process on the same machine can produce an
    answer, and a session acts on any answer the monitor holds.
  - So a forged or mistaken approval is acted on, and can resume an ended
    session that carries out a high-impact action with no one at its
    terminal.
  - The monitor records each answer's route and request signal, and the
    Queue page marks an answer it holds no record of; the mark is for the
    owner and stops no session.
  - A host permission prompt, a blocked command or a sandbox denial is never
    answered by the queue.
- **CI least privilege** — deny-all workflow token (`permissions: {}`),
  `pull_request` (never `pull_request_target`), pinned action SHAs.

## Remote access (opt-in)

Off by default. The installer asks once (default no; an install with no
terminal stays loopback-only), `glass-atrium remote on|off` changes it later,
and `glass-atrium update` never turns it on.

- **What it opens** — a second HTTPS listener on the Mac's Wi-Fi address at
  `[remote_access].port`, only while the Mac is on a network listed in
  `[remote_access].trusted_networks` (the router's address and hardware
  address; unreadable means closed). The trusted-network check is an accident
  guard against opening on another Wi-Fi, not authentication.
- **Who gets in** — only a registered device. A device registers once with a
  short-lived code shown on the Mac's own monitor page; there is no CLI or
  remote path that opens registration. A registered device then has every
  function the Mac's page has, with no expiry, until it is revoked
  (`glass-atrium remote revoke <id>` / `revoke-all`).
- **Transport** — TLS with a local CA created on this Mac (name-constrained to
  `.local` names and private address ranges). Each device trusts the CA
  certificate once; the CA and leaf keys stay owner-only under
  `monitor/data/remote-access/` and are excluded from Time Machine.
  The running monitor and the updater reissue the leaf silently 30 days
  before expiry and when the Wi-Fi address or the Bonjour name changes;
  devices trust the CA, so nothing is asked again. `glass-atrium doctor`
  checks the key modes, the exclusion, the leaf's host name, address and
  expiry, the listener's bound address against the trusted network, and the
  firewall state (read-only).
- **Loopback stays login-free** — a request on the remote listener is never
  judged as loopback.
- **Uninstall** removes the keys and the device rows; remove the CA trust on
  each device yourself.

### Residual risks (accepted by the owner)

- A lost, stolen or infected registered device can do everything the page can,
  with no expiry, until it is revoked: answer and order sessions that run
  without permission prompts (commands on this Mac), change settings, apply a
  self-update, and read every document and session text. This is not designed
  against.
- Where a queue answer counts as approval and resumes an ended session, such a
  device can approve a deploy, merge or deletion that runs unattended. The
  queue record does not yet show whether an answer came from a phone; the
  remote audit row does.
- A copied session cookie equals the owner until the device is revoked.
- A process running as the owner on this Mac can forge the page-origin
  headers, open registration, read the code and register a device. The
  devices list and the audit row make this visible; they do not prevent it.
- The registration page is reachable by anyone on the trusted Wi-Fi.
- A device that ignores the CA's name constraints would let anyone holding the
  CA key, which never leaves this Mac, impersonate other private-network sites
  to that device.
