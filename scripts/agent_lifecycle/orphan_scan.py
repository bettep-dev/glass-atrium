"""6-mode orphan-scan + symlink integrity + reconciliation (AC4 / §5).

Responsibilities:
    Lint the agent definition's spread across stores (md / registry / matrix /
    inject-list / manifest / symlink) for the six mismatch modes plus symlink
    integrity, with the NON-AGENT EXCLUSION SET applied BEFORE every check so a
    clean store never false-fires on GLOBAL_RULES.md / references/ / templates/.
    count-mismatch keys on a SINGLE declared-count SoT = the registry agents dict
    (23). domains-overlap reuses the ONE overlap predicate (overlap.py) the R1-Q3
    gate also calls — same function, same threshold, no drift. A reconciliation
    mode surfaces failed-rollback recovery markers left by the transaction.

Every check is a pure function over the parsed stores (read by readers.py), so
the scan is testable against a temp fixture with no live tree. The scan REPORTS
findings; it never edits a store (bash-array stores in particular are lint-only,
fixes handed to a human/DEV).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .atomic import load_json
from .overlap import scan_existing_pairs
from .paths import NON_AGENT_DIRS, NON_AGENT_EXCLUSIONS, StorePaths
from .readers import (
    ReaderError,
    load_registry_agents,
    parse_dev_set_text,
    parse_inject_arrays,
    parse_scope_dev_roster,
    parse_scope_legend_names,
    parse_sql_in_list_text,
    registry_domains,
)
from .subproc import target_home

# DEV roster size SoT cross-check — the QA names INJECT_AGENTS adds over the DEV
# roster (DEV + QA). Used by inject-list-mismatch to model the QA-vs-DEV split.
_QA_NAMES: frozenset[str] = frozenset({"qa-code-reviewer", "qa-debugger"})

# NAMING_AGENTS expected-membership inputs (the narrower 4th array): it adds
# qa-code-reviewer ONLY (NEVER qa-debugger) and EXCLUDES dev-swift from the DEV
# roster. Mirrors inject_sync._expected_naming_membership so detection and the
# fix agree on the same dedicated rule.
_NAMING_QA_NAMES: frozenset[str] = frozenset({"qa-code-reviewer"})
_NAMING_EXCLUDED_DEV: frozenset[str] = frozenset({"dev-swift"})


@dataclass(frozen=True)
class Finding:
    """One orphan-scan finding: which mode fired, the offending name, why."""

    mode: str
    name: str
    detail: str


@dataclass
class ScanReport:
    """Aggregate of every finding, grouped by mode, plus the registry count SoT."""

    findings: list[Finding] = field(default_factory=list)
    registry_count: int = 0

    @property
    def clean(self) -> bool:
        return not self.findings

    def by_mode(self, mode: str) -> list[Finding]:
        return [f for f in self.findings if f.mode == mode]

    def render(self) -> str:
        if self.clean:
            return f"orphan-scan: clean ({self.registry_count} agents, 0 violations)."
        lines = [
            f"orphan-scan: {len(self.findings)} violation(s) "
            f"(registry SoT = {self.registry_count} agents):"
        ]
        for f in self.findings:
            lines.append(f"  [{f.mode}] {f.name}: {f.detail}")
        return "\n".join(lines)


def _is_excluded(rel_path: str) -> bool:
    """True when an agents/-relative path is a non-agent file (M3 exclusion set).

    Applied BEFORE any mismatch / dangling / count check so a clean store never
    flags GLOBAL_RULES.md or a references/ / templates/ file as an orphan.
    """
    if rel_path in NON_AGENT_EXCLUSIONS:
        return True
    head = rel_path.split("/", 1)[0]
    return head in NON_AGENT_DIRS and "/" in rel_path


def _agent_md_names(paths: StorePaths) -> set[str]:
    """Agent names from agents/*.md, excluding non-agent files (top-level only)."""
    if not paths.agents_dir.is_dir():
        return set()
    names: set[str] = set()
    for md in paths.agents_dir.glob("*.md"):
        rel = md.name
        if _is_excluded(rel):
            continue
        names.add(md.stem)
    return names


def _manifest_agent_paths(paths: StorePaths) -> set[str]:
    """The agents/*.md paths in the manifest (post-exclusion) for symlink checks.

    Single parse of the manifest + single filter loop; the agent-name set is
    derived from these paths via a stem comprehension at the call site, so the
    manifest is read once per scan and the exclusion/filter rule lives in one
    place.
    """
    manifest = load_json(paths.manifest)
    files = manifest.get("files", []) if isinstance(manifest, dict) else []
    out: set[str] = set()
    for path in files:
        if not isinstance(path, str) or not path.startswith("agents/"):
            continue
        rel = path[len("agents/") :]
        if _is_excluded(rel) or "/" in rel or not rel.endswith(".md"):
            continue
        out.add(path)
    return out


def _stems_of(agent_paths: set[str]) -> set[str]:
    """Map a set of `agents/<name>.md` paths to their `<name>` stems."""
    return {p[len("agents/") : -len(".md")] for p in agent_paths}


def _check_md_without_registry(
    registry_names: set[str], md_names: set[str]
) -> list[Finding]:
    """Mode 1: a real agents/<name>.md with no registry entry (un-routable)."""
    return [
        Finding("md-without-registry", name, "agents/.md present, no registry entry")
        for name in sorted(md_names - registry_names)
    ]


def _check_registry_without_md(
    registry_names: set[str], md_names: set[str]
) -> list[Finding]:
    """Mode 2: a registry entry with no agents/<name>.md (spawn would fail)."""
    return [
        Finding("registry-without-md", name, "registry entry present, no agents/.md")
        for name in sorted(registry_names - md_names)
    ]


def _check_matrix_name_absent(
    paths: StorePaths, registry_names: set[str]
) -> list[Finding]:
    """Mode 3: a registry agent absent from the compliance-matrix Scope Legend.

    Keys on NAME presence (not the stale rules/scope-*.md path strings, F2-RT-09).
    """
    try:
        legend = parse_scope_legend_names(paths)
    except (ReaderError, OSError) as exc:
        return [
            Finding("matrix-name-absent", "<matrix>", f"could not parse legend: {exc}")
        ]
    return [
        Finding("matrix-name-absent", name, "registry agent missing from Scope Legend")
        for name in sorted(registry_names - legend)
    ]


def _check_count_mismatch(
    registry_names: set[str],
    md_names: set[str],
    manifest_names: set[str],
) -> list[Finding]:
    """Mode 4: a normalized store count != the single registry SoT (23).

    Each store is normalized via the exclusion set FIRST, then compared to the
    registry agents dict count (the routing-authority SoT).
    """
    sot = len(registry_names)
    findings: list[Finding] = []
    for label, names in (
        ("agents-md", md_names),
        ("manifest-agents", manifest_names),
    ):
        if len(names) != sot:
            findings.append(
                Finding(
                    "count-mismatch",
                    label,
                    f"normalized count {len(names)} != registry SoT {sot}",
                )
            )
    return findings


def _check_one_inject_array(
    array_name: str, members: set[str], expected: set[str]
) -> list[Finding]:
    """Diff one inject array against its expected membership (symmetric set diff).

    `array_name` is the bash variable (e.g. INJECT_AGENTS) used in the human-
    readable detail. A name in `expected` but not `members` is a missing-from
    finding; the reverse is a stale-extra finding. Same finding `mode` for all
    four arrays so a single reconcile pass can act on the full set.
    """
    findings: list[Finding] = []
    for name in sorted(expected - members):
        findings.append(
            Finding("inject-list-mismatch", name, f"missing from {array_name}")
        )
    for name in sorted(members - expected):
        findings.append(
            Finding("inject-list-mismatch", name, f"{array_name} name not expected")
        )
    return findings


def _check_inject_list_mismatch(
    paths: StorePaths, registry_names: set[str], roster: list[str]
) -> list[Finding]:
    """Mode 5: an inject-scope-rules.sh bash array out of sync with the roster (B4).

    Parses all 4 arrays: INJECT_AGENTS (DEV+QA), STYLEREF_AGENTS (DEV),
    MINIMALISM_AGENTS (DEV), NAMING_AGENTS (DEV − {dev-swift} + qa-code-reviewer,
    EXCLUDES qa-debugger). STYLEREF + MINIMALISM must equal the DEV roster;
    INJECT must equal the DEV roster + QA; NAMING uses the narrower dedicated
    predicate. Lint-only — a fix is reported to a human/DEV, never auto-edited
    here (the reconcile-inject CLI verb owns writes).
    """
    try:
        inject, styleref, minimalism, naming = parse_inject_arrays(paths)
    except (ReaderError, OSError) as exc:
        return [
            Finding(
                "inject-list-mismatch", "<inject>", f"could not parse arrays: {exc}"
            )
        ]

    dev_roster = set(roster)
    naming_expected = (dev_roster - _NAMING_EXCLUDED_DEV) | _NAMING_QA_NAMES
    findings: list[Finding] = []
    findings += _check_one_inject_array(
        "INJECT_AGENTS", set(inject), dev_roster | _QA_NAMES
    )
    findings += _check_one_inject_array("STYLEREF_AGENTS", set(styleref), dev_roster)
    findings += _check_one_inject_array(
        "MINIMALISM_AGENTS", set(minimalism), dev_roster
    )
    findings += _check_one_inject_array("NAMING_AGENTS", set(naming), naming_expected)
    return findings


def _check_one_gate_site(
    label: str, members: set[str], roster: set[str]
) -> list[Finding]:
    """Diff one gate site's DEV-set against the roster (symmetric set diff).

    Mirrors _check_one_inject_array: a roster name absent from the site is a
    missing-from finding; a site name absent from the roster is a stale-extra.
    Same `gate-roster-mismatch` mode for every site so one reconcile pass (the
    sync-gate-roster verb) acts on the full set.
    """
    findings: list[Finding] = []
    for name in sorted(roster - members):
        findings.append(Finding("gate-roster-mismatch", name, f"missing from {label}"))
    for name in sorted(members - roster):
        findings.append(
            Finding("gate-roster-mismatch", name, f"{label} name not in DEV roster")
        )
    return findings


def _check_gate_roster_mismatch(paths: StorePaths, roster: list[str]) -> list[Finding]:
    """Mode 7: a gate site's hardcoded DEV-set out of sync with the roster (lint).

    The 3 sites are DEV-only (no QA names): the two hook `DEV_SET="..."` bash
    strings + the two byte-identical gate-audit.sh `agent IN (...)` SQL lists.
    Reports a divergence per site (and flags the two SQL occurrences diverging
    from each other). Lint-only — the fix is the sync-gate-roster CLI verb, never
    auto-edited here (parallels inject-list-mismatch staying read-only).
    """
    dev_roster = set(roster)
    findings: list[Finding] = []

    for label, path in (
        ("enforce-verification-gate.sh DEV_SET", paths.enforce_verification_gate),
        (
            "enforce-workflow-verify-stage.sh DEV_SET",
            paths.enforce_workflow_verify_stage,
        ),
    ):
        try:
            members = set(
                parse_dev_set_text(path.read_text(encoding="utf-8"), source=str(path))
            )
        except (ReaderError, OSError) as exc:
            findings.append(
                Finding(
                    "gate-roster-mismatch", label, f"could not parse DEV_SET: {exc}"
                )
            )
            continue
        findings += _check_one_gate_site(label, members, dev_roster)

    try:
        occurrences = parse_sql_in_list_text(
            paths.gate_audit.read_text(encoding="utf-8"), source=str(paths.gate_audit)
        )
    except (ReaderError, OSError) as exc:
        findings.append(
            Finding(
                "gate-roster-mismatch",
                "gate-audit.sh",
                f"could not parse SQL IN list: {exc}",
            )
        )
        return findings

    for idx, names in enumerate(occurrences):
        findings += _check_one_gate_site(
            f"gate-audit.sh SQL#{idx + 1}", set(names), dev_roster
        )
    if len(occurrences) >= 2 and any(occ != occurrences[0] for occ in occurrences[1:]):
        findings.append(
            Finding(
                "gate-roster-mismatch",
                "gate-audit.sh",
                "the two SQL IN lists diverge from each other (must be byte-identical)",
            )
        )
    return findings


def _check_domains_overlap(paths: StorePaths) -> list[Finding]:
    """Mode 6: an existing registry pair whose domains overlap >= 50% (R1-Q3 drift).

    Reuses scan_existing_pairs -> the SAME overlap_ratio + OVERLAP_THRESHOLD the
    R1-Q3 ADD gate calls (one owner, two call sites — AC4 asserts no divergence).
    """
    flagged = scan_existing_pairs(registry_domains(paths))
    return [
        Finding(
            "domains-overlap",
            f"{pair.a}+{pair.b}",
            f"domains overlap {pair.ratio:.2f} >= 0.50 (R1-Q3 violation signal)",
        )
        for pair in flagged
    ]


def _check_symlink_integrity(
    paths: StorePaths,
    md_names: set[str],
    manifest_paths: set[str],
    manifest_stems: set[str],
    registry_names: set[str],
) -> list[Finding]:
    """Symlink integrity: manifest-relation checks PLUS actual-farm enumeration.

    Two layers, both exclusion-set aware:
      (1) Manifest relation (unchanged): a manifest agents/<name>.md whose GA
          source file is missing (symlink-dangling), and a GA agents/<name>.md
          not in the manifest slice (symlink-manifest-mismatch).
      (2) Actual target-home farm (#4): enumerate <target_home>/agents/*.md and
          flag STRAY (a farm symlink with no registry agent — e.g. a delete that
          pruned the registry but left the link) and DANGLING (a farm symlink
          whose target .md is missing — the glass-atrium ADD/UPDATE-only swap can
          never prune a deleted agent's link). Manifest checks alone reported
          "clean" against a dangling link because they only validate
          MANIFEST-LISTED paths, never the live farm directory.
    """
    findings: list[Finding] = []
    # (1) dangling: a manifest agents/<name>.md whose GA source file is missing.
    for path in sorted(manifest_paths):
        src = paths.ga_root / path
        if not src.exists():
            findings.append(
                Finding(
                    "symlink-dangling",
                    path,
                    "manifest lists path but GA source missing",
                )
            )
    # (1) manifest-mismatch: a GA agents/<name>.md not listed in the manifest slice.
    for name in sorted(md_names - manifest_stems):
        findings.append(
            Finding(
                "symlink-manifest-mismatch",
                name,
                "GA agents/.md not in manifest agents/ slice",
            )
        )
    # (2) actual-farm enumeration (#4): walk <target_home>/agents/*.md directly.
    findings += _check_farm_symlinks(paths, registry_names)
    return findings


def _check_farm_symlinks(paths: StorePaths, registry_names: set[str]) -> list[Finding]:
    """Enumerate the live target-home farm: flag STRAY + DANGLING symlinks (#4).

    Resolves the farm home through target_home() (the single SoT shared with
    sandbox_env + the DELETE prune). Each <target_home>/agents/<name>.md symlink
    is checked: a link whose stem is not a registry agent is STRAY (post-exclusion),
    and a link whose target is missing is DANGLING. The non-agent exclusion set
    (GLOBAL_RULES.md, references/*, templates/*) is applied so legit farm symlinks
    are never flagged. A missing farm dir is a no-op (nothing to enumerate).
    """
    farm_agents = target_home(paths.ga_root) / "agents"
    if not farm_agents.is_dir():
        return []
    findings: list[Finding] = []
    for link in sorted(farm_agents.glob("*.md")):
        rel = link.name
        if _is_excluded(rel):
            continue
        # only farm SYMLINKS are in scope — a real user file is not our concern.
        if not link.is_symlink():
            continue
        name = link.stem
        if name not in registry_names:
            findings.append(
                Finding(
                    "symlink-stray",
                    name,
                    "farm symlink present but no registry agent (stray/orphaned link)",
                )
            )
        # exists() follows the symlink → False on a dangling link (target gone).
        if not link.exists():
            findings.append(
                Finding(
                    "symlink-dangling",
                    name,
                    "farm symlink target missing (dangling link in target home)",
                )
            )
    return findings


# The canonical mode names a caller may pass to restrict the scan.
ALL_MODES = (
    "md-without-registry",
    "registry-without-md",
    "matrix-name-absent",
    "count-mismatch",
    "inject-list-mismatch",
    "gate-roster-mismatch",
    "domains-overlap",
    "symlink-integrity",
)


def run_scan(paths: StorePaths, modes: list[str] | None = None) -> ScanReport:
    """Run the requested orphan-scan modes (default: all) over the GA stores.

    Args:
        paths: the GA stores (a temp fixture in tests).
        modes: restrict to these mode names; None or empty => every mode.

    Returns:
        A ScanReport whose `findings` are empty on a clean store (exclusion set
        applied) and whose `registry_count` is the count-mismatch SoT.
    """
    selected = set(modes) if modes else set(ALL_MODES)
    registry_names = set(load_registry_agents(paths))
    md_names = _agent_md_names(paths)
    # parse the manifest once; the agent-name set is the stem view of the paths.
    manifest_paths = _manifest_agent_paths(paths)
    manifest_names = _stems_of(manifest_paths)

    try:
        roster = parse_scope_dev_roster(paths)
    except (ReaderError, OSError):
        roster = []

    report = ScanReport(registry_count=len(registry_names))

    if "md-without-registry" in selected:
        report.findings += _check_md_without_registry(registry_names, md_names)
    if "registry-without-md" in selected:
        report.findings += _check_registry_without_md(registry_names, md_names)
    if "matrix-name-absent" in selected:
        report.findings += _check_matrix_name_absent(paths, registry_names)
    if "count-mismatch" in selected:
        report.findings += _check_count_mismatch(
            registry_names, md_names, manifest_names
        )
    if "inject-list-mismatch" in selected:
        report.findings += _check_inject_list_mismatch(paths, registry_names, roster)
    if "gate-roster-mismatch" in selected:
        report.findings += _check_gate_roster_mismatch(paths, roster)
    if "domains-overlap" in selected:
        report.findings += _check_domains_overlap(paths)
    if "symlink-integrity" in selected:
        report.findings += _check_symlink_integrity(
            paths, md_names, manifest_paths, manifest_names, registry_names
        )

    return report


def find_recovery_markers(paths: StorePaths) -> list[Path]:
    """Reconciliation mode: list failed-rollback recovery markers in the GA root.

    The Wave-1 transaction writes `.agent-lifecycle-recovery-*.json` on a
    failed-rollback STOP (B5). This surfaces them so the operator can finish the
    half-cleaned reconciliation the marker describes (orphan-scan is the
    designated post-failure reconciliation tool).
    """
    if not paths.ga_root.is_dir():
        return []
    return sorted(paths.ga_root.glob(".agent-lifecycle-recovery-*.json"))


def render_reconciliation(markers: list[Path]) -> str:
    """Render the reconciliation report for any recovery markers found."""
    if not markers:
        return "reconciliation: no failed-rollback recovery markers found."
    lines = [f"reconciliation: {len(markers)} recovery marker(s) — reconcile manually:"]
    for m in markers:
        lines.append(f"  {m}")
    return "\n".join(lines)


__all__ = [
    "ALL_MODES",
    "Finding",
    "ScanReport",
    "find_recovery_markers",
    "render_reconciliation",
    "run_scan",
]
