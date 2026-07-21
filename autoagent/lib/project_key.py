"""Project-isolation key resolver for the self-improvement learning loop.

Deterministic key generator to isolate learning signals per project.
Storage layout: ``~/.glass-atrium/data/learning/<project_key>/`` (in-vault artifact dir).

3-tier fallback order:
  - Tier 1 (git): ``git remote get-url origin`` → SHA-256 → first 12 hex
  - Tier 2 (cwd): ``os.getcwd()`` → SHA-256 → first 12 hex (when no git remote)
  - Tier 3 (host): ``socket.gethostname()`` → SHA-256 → first 12 hex (when cwd fails)

Each tier is wrapped in its own try/except, falling through to the next on failure.
Stays inside ``~/.glass-atrium/data/learning/`` (no external path).
"""

from __future__ import annotations

import hashlib
import os
import socket
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

# The home-anchored data/log-root seam lives under hooks/; pin its dir on sys.path
# so the import resolves from this autoagent/lib module too (shared SoT with shell).
_HOOKS_DIR = Path(__file__).resolve().parent.parent.parent / "hooks"
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
import ga_paths  # noqa: E402 — sys.path insert immediately above

# Key length — first 12 chars of the SHA-256 hex digest (collisions negligible + shorter path).
_KEY_HEX_LEN = 12

# git remote lookup timeout — guards against hangs (local config read, not a network call).
_GIT_REMOTE_TIMEOUT_SEC = 5

# Learning-signal storage root — inside the vault (no external path).
_LEARNING_ROOT = ga_paths.get_data_root() / "learning"

# Fallback tier identifier used by resolve (diagnostic).
ProjectKeyTier = Literal["git", "cwd", "host"]


@dataclass(frozen=True)
class ProjectKey:
    """resolve_project_key result — 12-hex key + tier used (diagnostic)."""

    key: str               # first 12 hex of SHA-256
    tier: ProjectKeyTier   # 'git' / 'cwd' / 'host' — which fallback stage produced it


def _hash12(raw: str) -> str:
    """Input string → SHA-256 → first 12 hex.

    - Deterministic: same input → same key.
    - Input is UTF-8 encoded before hashing.
    """
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return digest[:_KEY_HEX_LEN]


def _try_git_remote() -> str | None:
    """Tier 1 — look up the git remote origin URL.

    - Success: returns the remote URL string (empty string → None).
    - Failure: git missing / not a repo / no remote / timeout → None (fall-through).
    """
    try:
        completed = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=_GIT_REMOTE_TIMEOUT_SEC,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        # git binary missing / spawn failure / timeout — next tier
        return None

    if completed.returncode != 0:
        # not a repo / no origin remote — next tier
        return None

    remote_url = completed.stdout.strip()
    return remote_url or None


def _try_cwd() -> str | None:
    """Tier 2 — current working directory path.

    - Success: absolute path string.
    - Failure: cwd deleted etc. (OSError) → None (fall-through).
    """
    try:
        return os.getcwd()
    except OSError:
        # e.g. cwd was deleted — next tier
        return None


def _hostname() -> str:
    """Tier 3 — hostname (final fallback, always succeeds).

    - Guarantees a usable key even if socket.gethostname fails.
    """
    try:
        return socket.gethostname() or "unknown-host"
    except OSError:
        # gethostname failure is extremely rare — fixed fallback guarantees a key
        return "unknown-host"


def resolve_project_key() -> ProjectKey:
    """Derive the project-isolation key via 3-tier fallback.

    - Order: git remote → cwd → hostname.
    - On each tier failure, falls through; the final tier (hostname) always succeeds.
    - Deterministic: same environment (same remote / cwd / host) → same key.

    Returns:
        ProjectKey — ``.key`` is always 12 hex, ``.tier`` identifies the derivation stage.
    """
    git_remote = _try_git_remote()
    if git_remote is not None:
        return ProjectKey(key=_hash12(git_remote), tier="git")

    cwd = _try_cwd()
    if cwd is not None:
        return ProjectKey(key=_hash12(cwd), tier="cwd")

    # final fallback — always succeeds
    return ProjectKey(key=_hash12(_hostname()), tier="host")


def learning_dir(project_key: str) -> Path:
    """Return the per-project learning-signal directory path (creating it if absent).

    - Path: ``~/.glass-atrium/data/learning/<project_key>/``.
    - First access does a parent-inclusive mkdir (idempotent — exist_ok).
    - Stays inside the vault (no external path).

    Args:
        project_key: resolve_project_key().key (12 hex) or an arbitrary identifier.

    Returns:
        Created directory Path.
    """
    target = _LEARNING_ROOT / project_key
    target.mkdir(parents=True, exist_ok=True)
    return target


if __name__ == "__main__":  # pragma: no cover
    # Diagnostic direct run — print the 12 hex key + tier
    resolved = resolve_project_key()
    print(f"{resolved.key} (tier={resolved.tier})")
