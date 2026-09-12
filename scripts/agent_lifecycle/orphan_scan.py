"""orphan-scan + symlink integrity + reconciliation (AC4 / §5).

Responsibilities:
    Lint the agent definition's spread across stores (md / registry / matrix /
    inject-list / manifest / symlink) for every mismatch mode plus symlink
    integrity, with the NON-AGENT EXCLUSION SET applied BEFORE every check so a
    clean store never false-fires on GLASS_ATRIUM_GLOBAL_RULES.md / references/ / templates/.
    count-mismatch keys on a SINGLE declared-count SoT = the registry agents dict.
    domains-overlap reuses the ONE overlap predicate (overlap.py) the R1-Q3
    gate also calls — same function, same threshold, no drift. A reconciliation
    mode surfaces failed-rollback recovery markers left by the transaction.

    rules-membership-mismatch is the reconcile that binds the registry's
    per-agent `rules` object to the compliance matrix. It runs HERE, off the
    delivery path, which is what makes a fail-open matrix parser the right
    instrument: a table-format edit that defeats the parser costs a report line,
    not a silently short assembly at spawn.

Every check is a pure function over the parsed stores (read by readers.py), so
the scan is testable against a temp fixture with no live tree. The scan REPORTS
findings; it never edits a store (bash-array stores in particular are lint-only,
fixes handed to a human/DEV).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .atomic import load_json
from .inject_sync import _expected_membership
from .overlap import scan_existing_pairs
from .paths import NON_AGENT_DIRS, NON_AGENT_EXCLUSIONS, StorePaths
from .readers import (
    ReaderError,
    load_registry_agents,
    load_registry_rules,
    parse_dev_set_text,
    parse_inject_arrays,
    parse_scope_dev_roster,
    parse_scope_legend_names,
    parse_sql_in_list_text,
    registry_domains,
)
from .scope_infer import (
    build_scope_index_from_registry,
    build_scope_index_from_text,
    build_tier2_index_from_text,
    build_tier3_index_from_text,
)
from .subproc import target_home

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
    flags GLASS_ATRIUM_GLOBAL_RULES.md or a references/ / templates/ file as an orphan.
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
        Finding(
            "matrix-name-absent",
            name,
            "registry agent missing from Scope Legend — a GOVERNANCE gap: the "
            "legend is a hand-maintained record no store reads for membership, "
            "and the updater overwrites a hand-added row because the matrix is "
            "not merge-claimed",
        )
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
    """Diff one tracked inject array against its expected membership.

    `array_name` is the bash variable (e.g. STYLEREF_AGENTS) used in the human-
    readable detail. A name in `expected` but not `members` is a missing-from
    finding; the reverse is a stale-extra finding. Same finding `mode` for every
    tracked array so a single reconcile pass can act on the full set.
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
    """Mode 5: a tracked roster array out of sync with the DEV roster (B4).

    The tracked set is readers._TRACKED_INJECT_ARRAYS: INJECT_AGENTS (DEV + QA),
    STYLEREF_AGENTS and MINIMALISM_AGENTS (the DEV roster whole), NAMING_AGENTS
    (DEV − {dev-swift} + qa-code-reviewer, EXCLUDES qa-debugger) and
    BUDGET_DEV_AGENTS (DEV minus the daemon carriers). The untracked governance
    rosters are not linted — their membership is not roster-derivable, so a
    predicate would be a second copy of the array.

    The expected sets come from inject_sync._expected_membership — the SAME
    function the fix applies, not a mirror of it, so detection and the fix
    cannot disagree. This mode does not decide whether an agent receives its
    scope RULES (that follows the registry `rules` object, linted by
    rules-membership-mismatch); it decides whether the agent is in the rosters
    that gate the injected BLOCKS. Lint-only — a fix is reported to a human/DEV,
    never auto-edited here (the reconcile-inject CLI verb owns writes).
    """
    try:
        arrays = parse_inject_arrays(paths)
    except (ReaderError, OSError) as exc:
        return [
            Finding(
                "inject-list-mismatch", "<inject>", f"could not parse arrays: {exc}"
            )
        ]

    expected = _expected_membership(set(roster))
    findings: list[Finding] = []
    for array_name, members in arrays.items():
        findings += _check_one_inject_array(
            array_name, set(members), expected[array_name]
        )
    return findings


def _check_rules_membership_mismatch(paths: StorePaths) -> list[Finding]:
    """Mode 9: a registry `rules` object disagreeing with the matrix declarations.

    Compares in BOTH directions against the Tier-2 table and the Tier-3
    DECLARATION rows — never the Compliance Matrix table cell, whose ticks are a
    coarser summary. `scoped/shared-naming.md` is declared for DEV and for
    glass-atrium-qa-code-reviewer alone while its Compliance Matrix QA cell
    carries a bare tick, so a cell reader reports a permanent false divergence
    for glass-atrium-qa-debugger.

    Asserted forwards: a file whose Tier-3 row names the agent's scope
    UNQUALIFIED, or names the agent itself, must sit in `rules.shared`.
    Asserted in reverse: every file the row carries must be declared by some
    Tier-3 row, for a scope or agent that covers this one. A SUBSET declaration
    (`UI-emitting DEV subset ‡`) satisfies the reverse direction and is never
    asserted forwards — which agents of that scope are members is stated in
    prose no parser reproduces.
    """
    try:
        rules_by_agent = load_registry_rules(paths)
        matrix_text = paths.compliance_matrix.read_text(encoding="utf-8")
    except (ReaderError, OSError) as exc:
        return [
            Finding("rules-membership-mismatch", "<registry>", f"could not read: {exc}")
        ]

    tier2 = build_tier2_index_from_text(matrix_text)
    tier3 = build_tier3_index_from_text(matrix_text)
    legend = build_scope_index_from_text(matrix_text)
    scope_of = build_scope_index_from_registry(rules_by_agent)
    scope_by_file = {f: scope for scope, files in tier2.items() for f in files}

    findings: list[Finding] = []
    for name in sorted(rules_by_agent):
        rules = rules_by_agent[name]
        scope_file = rules["scope"]
        scope = scope_of.get(name)
        if scope is None or scope_file not in scope_by_file:
            findings.append(
                Finding(
                    "rules-membership-mismatch",
                    name,
                    f"rules.scope `{scope_file}` is declared by no Tier-2 row",
                )
            )
            continue
        declared_scope = scope_by_file[scope_file]
        legend_scope = legend.get(name)
        if legend_scope is not None and legend_scope != declared_scope:
            findings.append(
                Finding(
                    "rules-membership-mismatch",
                    name,
                    f"Scope Legend says {legend_scope}, rules.scope resolves to "
                    f"{declared_scope} via the Tier-2 row",
                )
            )
        carried = set(rules.get("shared") or [])
        conditional = {
            entry.get("file")
            for entry in (rules.get("conditional") or [])
            if isinstance(entry, dict)
        }
        for rule_file, decl in sorted(tier3.items()):
            if scope in decl["scopes"] or name in decl["agents"]:
                if rule_file not in carried:
                    findings.append(
                        Finding(
                            "rules-membership-mismatch",
                            name,
                            f"Tier-3 row declares `{rule_file}` for this agent "
                            "unconditionally; rules.shared does not carry it",
                        )
                    )
        for rule_file in sorted(carried | conditional):
            decl = tier3.get(rule_file)
            if decl is None:
                findings.append(
                    Finding(
                        "rules-membership-mismatch",
                        name,
                        f"row cites `{rule_file}`, declared by no Tier-3 row",
                    )
                )
                continue
            covered = (
                scope in decl["scopes"]
                or scope in decl["subsets"]
                or name in decl["agents"]
                or name in decl["subsets"]
            )
            if not covered:
                findings.append(
                    Finding(
                        "rules-membership-mismatch",
                        name,
                        f"row carries `{rule_file}`, whose Tier-3 row declares "
                        f"neither {scope} nor this agent",
                    )
                )
    return findings


def _check_dev_roster_declaration_mismatch(
    paths: StorePaths, roster: list[str]
) -> list[Finding]:
    """Mode 10: the two declarations of the DEV set disagreeing.

    `scoped/scope-dev.md`'s brace list gates DEV_SET and the SQL audit lists;
    `{name : rules.scope == the Tier-2 DEV file}` is the registry's answer to the
    same question. Nothing binds them, and gate_roster_sync deliberately does not
    read the registry — writing a second store into a lock-free transaction step
    would be the wrong fix. This check is the binding.
    """
    try:
        rules_by_agent = load_registry_rules(paths)
    except (ReaderError, OSError) as exc:
        return [
            Finding(
                "dev-roster-declaration-mismatch",
                "<registry>",
                f"could not read registry rules: {exc}",
            )
        ]
    from .registry_ops import SCOPE_RULE_FILES

    dev_file = SCOPE_RULE_FILES["DEV"]
    from_registry = {
        name for name, rules in rules_by_agent.items() if rules.get("scope") == dev_file
    }
    from_brace = set(roster)
    findings = [
        Finding(
            "dev-roster-declaration-mismatch",
            name,
            "carries the DEV Tier-2 file on its registry row but is absent from "
            "the scope-dev.md brace roster",
        )
        for name in sorted(from_registry - from_brace)
    ]
    findings += [
        Finding(
            "dev-roster-declaration-mismatch",
            name,
            "is in the scope-dev.md brace roster but its registry row does not "
            "carry the DEV Tier-2 file",
        )
        for name in sorted(from_brace - from_registry)
    ]
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

    A malformed registry entry is reported as a mode-6 finding, not raised: the
    ADD gate must HALT on it, but a scan that aborts would take every other mode
    down with it and would make the advisory launchd caller cycle-killing.
    """
    try:
        domains = registry_domains(paths)
    except (ReaderError, OSError) as exc:
        return [
            Finding(
                "domains-overlap",
                "agent-registry.json",
                f"could not read domains: {exc}",
            )
        ]
    flagged = scan_existing_pairs(domains)
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
    (GLASS_ATRIUM_GLOBAL_RULES.md, references/*, templates/*) is applied so legit farm symlinks
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
    "rules-membership-mismatch",
    "dev-roster-declaration-mismatch",
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
    if "rules-membership-mismatch" in selected:
        report.findings += _check_rules_membership_mismatch(paths)
    if "dev-roster-declaration-mismatch" in selected:
        report.findings += _check_dev_roster_declaration_mismatch(paths, roster)

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
