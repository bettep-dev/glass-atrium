"""Canonical GA store paths + the hardcoded safety constants the CLI keys on.

Responsibilities:
    Resolve the GA root (parent of this scripts/ dir, mirroring
    generate-manifest.sh and the glass-atrium entry), expose every store path
    the lifecycle ops touch, and own the two safety literals that must NOT be
    inferred at
    runtime: the non-agent exclusion set (M3) and the NON-DEV hardcoded
    DELETE block list (M1, fail-safe-default).

The GA root is injectable via the constructor so the disposable test suite can
point every path at an isolated tempfile.mkdtemp copy of the live store — no
test ever resolves to the live ~/.glass-atrium tree.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


def default_ga_root() -> Path:
    """GA root = parent of this package's scripts/ dir (portable, like glass-atrium).

    agent_lifecycle/paths.py -> agent_lifecycle/ -> scripts/ -> GA_ROOT.
    """
    return Path(__file__).resolve().parent.parent.parent


def trash_path(name: str, suffix: str) -> Path:
    """~/.Trash target for a moved-out agent .md (GLOBAL_RULES: source files use mv, not rm).

    The single owner of the trash-path composition both the ADD rollback and the
    DELETE use; the caller supplies the distinguishing `suffix` (e.g. a fixed
    rollback tag or a timestamped delete tag).
    """
    return Path.home() / ".Trash" / f"{name}.md{suffix}"


# Non-agent files that live under agents/ but are NOT routable agents. Every
# orphan-scan mismatch / dangling / count check excludes these BEFORE comparing,
# else a clean store false-fires (M3 / F2-RT-07). Stored as basenames + relative
# sub-paths; the scan matches on the agents/-relative path.
NON_AGENT_EXCLUSIONS: frozenset[str] = frozenset(
    {
        "GLOBAL_RULES.md",
        "references/critical-spring.md",
        "references/rag-domain.md",
        "templates/DESIGN.md",
        "templates/progress.md",
    }
)

# Sub-directories under agents/ that hold only non-agent material — any .md
# below these is excluded regardless of basename (forward-compatible with new
# reference/template files the live exclusion set does not yet enumerate).
NON_AGENT_DIRS: frozenset[str] = frozenset({"references", "templates"})

# NON-DEV shipped agents that DELETE hard-blocks (M1 / SEC-2). This is a
# HARDCODED literal block list, NOT derived from the inferred scope field: a
# corrupted / absent / mis-inferred scope can only ADD restriction, never lift
# this block (fail-safe-default). 10 names, re-confirmed live 2026-06-14.
NON_DEV_BLOCK_LIST: frozenset[str] = frozenset(
    {
        "qa-code-reviewer",
        "qa-debugger",
        "design-designer",
        "meta-agent",
        "intel-planner",
        "meta-prompt-engineer",
        "intel-reporter",
        "intel-researcher",
        "sec-guard",
        "wiki-curator",
    }
)


@dataclass(frozen=True)
class StorePaths:
    """The set of GA store paths a lifecycle op reads or writes.

    Build with `StorePaths.for_root(root)` so tests can target a temp copy.
    """

    ga_root: Path

    @classmethod
    def for_root(cls, ga_root: Path | None = None) -> StorePaths:
        return cls(ga_root=(ga_root or default_ga_root()).resolve())

    @property
    def registry(self) -> Path:
        return self.ga_root / "agent-registry.json"

    @property
    def manifest(self) -> Path:
        return self.ga_root / "manifest.json"

    @property
    def agents_dir(self) -> Path:
        return self.ga_root / "agents"

    @property
    def scope_dev(self) -> Path:
        return self.ga_root / "scoped" / "scope-dev.md"

    @property
    def compliance_matrix(self) -> Path:
        return self.ga_root / "rules" / "core-compliance-matrix.md"

    @property
    def inject_scope_rules(self) -> Path:
        return self.ga_root / "hooks" / "inject-scope-rules.sh"

    @property
    def enforce_verification_gate(self) -> Path:
        # PreToolUse(Agent) gate — carries the unpadded DEV_SET="..." bash literal.
        return self.ga_root / "hooks" / "enforce-verification-gate.sh"

    @property
    def enforce_workflow_verify_stage(self) -> Path:
        # PreToolUse(Workflow) gate — byte-identical DEV_SET="..." mirror.
        return self.ga_root / "hooks" / "enforce-workflow-verify-stage.sh"

    @property
    def gate_audit(self) -> Path:
        # Measurement tool — two byte-identical `agent IN (...)` SQL DEV-set lists.
        return self.ga_root / "scripts" / "gate-audit.sh"

    @property
    def generate_manifest(self) -> Path:
        return self.ga_root / "scripts" / "generate-manifest.sh"

    @property
    def install_script(self) -> Path:
        # The sole CLI entry; the symlink-farm rebuild runs `glass-atrium
        # agents-only` (a native engine subcommand).
        return self.ga_root / "glass-atrium"

    def agent_md(self, name: str) -> Path:
        """Path to agents/<name>.md — caller MUST validate `name` first."""
        return self.agents_dir / f"{name}.md"
