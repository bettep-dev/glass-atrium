"""List-form subprocess wrappers for the derived-chain steps (dev-note 2/3).

Responsibilities:
    Invoke git, generate-manifest.sh, and the glass-atrium `agents-only` swap
    with argv-LIST form only (never shell=True with an interpolated <name>), check
    each returncode, and raise StepError on a non-zero exit so the transaction
    treats the step as failed and rolls back (dev-note 3 — a silent regenerator
    failure must never leave an inconsistent farm under a success report).

Every command is built from a fixed argv list + already-validated path
arguments — no string interpolation reaches a shell. The CLI validates <name>
against ^[a-z0-9-]+$ and asserts realpath-inside-agents BEFORE any path here is
composed (validation.py), so these wrappers see only safe inputs.
"""

from __future__ import annotations

import os
import subprocess  # noqa: S404 — list-form only, shell=False, no interpolated input
from pathlib import Path

from .paths import default_ga_root


class StepError(RuntimeError):
    """A subprocess step exited non-zero (or could not be launched).

    Carries the argv + returncode + captured streams so the transaction can log
    the failure and the rollback can proceed with full context.
    """

    def __init__(
        self,
        message: str,
        *,
        argv: list[str],
        returncode: int | None,
        stdout: str = "",
        stderr: str = "",
    ) -> None:
        super().__init__(message)
        self.argv = argv
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _run(
    argv: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    """Run an argv list with shell=False, capturing output; raise on non-zero.

    Never uses shell=True and never interpolates a value into a command string —
    the argv list is passed verbatim to the kernel exec, so there is no shell
    metacharacter surface.

    `env` adds/overrides variables on top of the inherited os.environ (it is
    MERGED, never a bare replacement — a replacement dict would strip PATH and
    break the git/jq/stat lookups the called scripts depend on). The sandbox
    target-home override (GA_TARGET_HOME / GA_MANIFEST) is threaded through here.
    """
    proc_env = {**os.environ, **env} if env is not None else None
    try:
        proc = subprocess.run(  # noqa: S603 — argv list, shell=False, validated input
            argv,
            cwd=str(cwd) if cwd is not None else None,
            env=proc_env,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as exc:
        raise StepError(
            f"could not launch {argv[0]!r}: {exc}",
            argv=argv,
            returncode=None,
        ) from exc
    if proc.returncode != 0:
        raise StepError(
            f"{argv[0]!r} exited {proc.returncode}: {proc.stderr.strip()}",
            argv=argv,
            returncode=proc.returncode,
            stdout=proc.stdout,
            stderr=proc.stderr,
        )
    return proc


def git_add(ga_root: Path, rel_path: str) -> None:
    """`git add <rel_path>` in the GA work tree — register the new .md as tracked.

    Without this the new file is invisible to `git ls-files`, so the manifest
    regeneration drops its row (B2 latent orphan).
    """
    _run(["git", "-C", str(ga_root), "add", "--", rel_path])


def git_unstage(ga_root: Path, rel_path: str) -> None:
    """`git reset HEAD <rel_path>` — the reverse-op for git_add (unstage)."""
    _run(["git", "-C", str(ga_root), "reset", "--quiet", "HEAD", "--", rel_path])


# In-tree sandbox target-home name: a fixed descendant of the operated-on
# ga_root. glass-atrium keys its symlink TARGET off GA_TARGET_HOME (default the
# live ~/.claude when unset) — so without this override a `--ga-root <copy>`
# run would farm symlinks into the REAL ~/.claude. By pinning the target to a
# provable descendant of the resolved ga_root, glass-atrium can NEVER escape the
# operated-on root: the structural guarantee F2 requires.
SANDBOX_TARGET_HOME_DIRNAME = ".claude-target"


def target_home(ga_root: Path) -> Path:
    """The symlink-farm home glass-atrium writes into, by root kind — SINGLE SoT.

    Mirrors the engine's `TARGET_HOME="${GA_TARGET_HOME:-${HOME}/.claude}"`
    combined with the sandbox_env pin:
      - REAL default root → ~/.claude (sandbox_env returns {}, glass-atrium falls
        back to its HOME-based default).
      - COPY root → <ga_root>/.claude-target (sandbox_env pins GA_TARGET_HOME there).

    sandbox_env, the DELETE symlink prune (#3), and orphan-scan symlink-integrity
    (#4) ALL resolve the farm home through THIS one function — no divergent
    re-derivation of "where does the agents/<name>.md symlink live".
    """
    if ga_root.resolve() == default_ga_root().resolve():
        return (Path.home() / ".claude").resolve()
    return (ga_root / SANDBOX_TARGET_HOME_DIRNAME).resolve()


def sandbox_env(ga_root: Path) -> dict[str, str]:
    """Env overrides pinning glass-atrium's TARGET_HOME + manifest — COPY-ONLY.

    Conditional contract (the live-path correction): the sandbox pin applies ONLY
    when operating on a COPY (`ga_root.resolve() != default_ga_root().resolve()`).

    - COPY root → return GA_TARGET_HOME=<copy>/.claude-target + GA_MANIFEST=
      <copy>/manifest.json. glass-atrium honors GA_TARGET_HOME (the symlink
      target home) and GA_MANIFEST (the manifest it reads); pinning both to
      in-tree descendants of the resolved copy means a `--ga-root <copy>` add/delete
      can NEVER touch the real ~/.claude farm or live manifest (copy-escape proof).
    - DEFAULT (live) root → return {} (no override) so glass-atrium falls back to its
      live default `${GA_TARGET_HOME:-${HOME}/.claude}` = the real ~/.claude. The
      former unconditional pin redirected the live target to
      ~/.glass-atrium/.claude-target, so a live add/delete never reached the real
      ~/.claude/agents farm (registry-present but not spawnable) — this conditional
      restores the live path while leaving copy sandboxing untouched.

    GA_TARGET_HOME is derived from target_home() so this env pin and the prune /
    orphan-scan farm-home resolution can never drift (single SoT).

    generate-manifest.sh honors no env at all (GA_ROOT + MANIFEST are readonly from
    BASH_SOURCE), so for it these vars are inert either way.
    """
    if ga_root.resolve() == default_ga_root().resolve():
        return {}
    return {
        "GA_TARGET_HOME": str(target_home(ga_root)),
        "GA_MANIFEST": str(ga_root / "manifest.json"),
    }


def regenerate_manifest(generate_manifest_script: Path, ga_root: Path) -> None:
    """Invoke generate-manifest.sh to rebuild manifest.json from git ls-files.

    The manifest is a DERIVED store (hard contract: never hand-edited) — this
    regenerates it. A non-zero exit raises StepError -> the chain rolls back.
    """
    _run([str(generate_manifest_script)], cwd=ga_root, env=sandbox_env(ga_root))


def swap_symlinks(ga_entry: Path, ga_root: Path) -> None:
    """Invoke `glass-atrium agents-only` to rebuild the symlink farm.

    The `agents-only` subcommand is the symlink-only path: it swaps each per-file
    symlink from the manifest files array WITHOUT the full install (no doctor, no
    wire_hooks) — the derived-chain only needs the farm re-pointed. glass-atrium
    reads the manifest and swaps each per-file symlink into the target home. The
    TARGET home is forced inside `ga_root` via sandbox_env so the live ~/.claude
    farm is NEVER mutated when operating on a `--ga-root <copy>`. A non-zero exit
    raises StepError -> the chain rolls back.
    """
    _run([str(ga_entry), "agents-only"], cwd=ga_root, env=sandbox_env(ga_root))


def farm_symlink_path(ga_root: Path, name: str) -> Path:
    """The farm symlink for `name`: <target_home(ga_root)>/agents/<name>.md.

    Resolves the farm home through target_home() (the single SoT) — same logic
    sandbox_env pins for glass-atrium. `name` is already validated upstream
    (^[a-z0-9-]+$, realpath-inside-agents) before reaching here.
    """
    return target_home(ga_root) / "agents" / f"{name}.md"


def prune_farm_symlink(ga_root: Path, name: str) -> None:
    """Unlink ONLY the farm symlink for `name` — never its target .md.

    The glass-atrium `agents-only` swap is ADD/UPDATE-only: it never removes a
    symlink whose manifest entry is gone, so a delete leaves a DANGLING farm
    symlink (#3). This removes it. Guarded to act ONLY on a symlink: a regular
    file or directory at the path is left untouched (Path.unlink removes the
    link entry itself, never following it to the target). Idempotent — an absent
    path is a no-op (rollback safety).
    """
    link = farm_symlink_path(ga_root, name)
    if link.is_symlink():
        link.unlink()


def restore_farm_symlink(ga_root: Path, name: str) -> None:
    """Reverse-op for prune_farm_symlink: re-link the farm symlink (rollback).

    Recreates <target_home>/agents/<name>.md -> <ga_root>/agents/<name>.md, the
    same src/dst the glass-atrium swap builds (GA_ROOT/rel <- TARGET_HOME/rel).
    Idempotent: a correct symlink already present is a no-op. Only re-links when
    the GA source .md exists (a restore during rollback runs after the .md is back
    from ~/.Trash; if it is somehow absent, leave the farm untouched rather than
    forge a dangling link).
    """
    link = farm_symlink_path(ga_root, name)
    src = (ga_root / "agents" / f"{name}.md").resolve()
    if link.is_symlink() and link.readlink() == src:
        return
    if not src.exists():
        return
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(src)
