"""Fail-closed credential scan for authored agent-body text at the CLI boundary.

Why this exists separately from the Write/Edit/Bash secret hooks: those hooks
(`validate-secret-scan.sh` / `detect-secret-file-write.sh`) gate the harness tool
channels, but `--body-file` is read by this CLI via `Path.read_text` — that read
never crosses a Write/Edit/Bash tool, so the hook surface does not see it. A
hardcoded agent .md must never carry a credential; this is the matching gate at
the one entry point the hooks cannot reach.

Patterns are a DELIBERATE MIRROR of `validate-secret-scan.sh` PATTERNS (the SoT),
the same mirror discipline `detect-secret-file-write.sh` already documents — there
is no shared lib to import (the hooks are bash). Update both on a pattern change.
"""

from __future__ import annotations

import re

# Mirror of validate-secret-scan.sh PATTERNS (the SoT). Each entry pairs with a
# human-readable label so a hit names the credential TYPE, never its value.
_SECRET_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"AKIA[0-9A-Z]{16}", "AWS access key"),
    (r"ghp_[a-zA-Z0-9]{36}", "GitHub token"),
    (r"sk-[a-zA-Z0-9]{20,}", "API key (sk-)"),
    (r"eyJ[a-zA-Z0-9_-]*\.eyJ", "JWT token"),
    (r"postgres://[^ ]*@", "Postgres connection string"),
    (r"mongodb(\+srv)?://[^ ]*@", "MongoDB connection string"),
    (r"AIza[0-9A-Za-z_-]{35}", "Google API key"),
    (r"xox[bpoa]-[0-9a-zA-Z-]+", "Slack token"),
    (
        r"""(password|passwd|api[_-]?key|secret|token|access[_-]?key|aws_secret_access_key)["' ]*[:=][ ]*["']?[^\s"']{8,}""",
        "Generic credential assignment",
    ),
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "PEM private key"),
    (r'"private_key"[ ]*:[ ]*"-----BEGIN', "Service-account private key"),
    (r'"type"[ ]*:[ ]*"service_account"', "Service-account JSON marker"),
)

_COMPILED: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pat, re.IGNORECASE), label) for pat, label in _SECRET_PATTERNS
)


class SecretDetected(ValueError):
    """A credential pattern was found in scanned text — the caller MUST HALT."""


def scan_for_secrets(text: str) -> None:
    """HALT (raise SecretDetected) on the first credential pattern in `text`.

    Fail-closed: any matched pattern raises, naming the credential TYPE only —
    the matched value is never surfaced (core-security: secrets never logged).
    Clean text returns None.
    """
    for pattern, label in _COMPILED:
        if pattern.search(text):
            raise SecretDetected(
                f"credential pattern detected in body ({label}) — "
                "remove the hardcoded secret; use an environment variable"
            )


__all__ = ["SecretDetected", "scan_for_secrets"]
