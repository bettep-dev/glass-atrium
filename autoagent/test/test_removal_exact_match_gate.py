#!/usr/bin/env python3
# S4 (clauded-docs/762) — the removal capability, and the evidence rule that
# bounds it. The loop may delete a line ONLY when it can point at it: every
# declared removal must match exactly one line of the target, that line must sit
# inside an editable region, and it must not be a protected line. Anything else
# refuses the WHOLE diff — a partial application of a replace is the failure
# being designed out, and an addition defect is visible in the file while a
# removal defect is an absence nobody reads.
#
# The declared set is derived at APPLY time from the stored diff about to be
# applied — never transported from generation, never read from the database. That
# is one source of truth that cannot desync from what lands, and it covers the
# majority path: removals that never entered the repair path at all (proposal 314
# is the applied instance of exactly that).
#
# FAIL-AT-HEAD (observed by running, not derived from code shape):
#   * `daemon_cycle.verify_removal_evidence` and `daemon_cycle.get_removal_live`
#     both resolve to None at HEAD — no evidence helper exists, so no removal can
#     be admitted by rule.
#   * `daemon-apply.sh` at HEAD contains zero occurrences of
#     'assert_removal_evidence', 'REMOVAL_DECLARED_FILE', 'AUTOAGENT_REMOVAL_LIVE'
#     and '--removal-evidence'.
#   * the verification callback at HEAD returns rc=0 for a result in which TWO
#     before-image lines vanished, one of them undeclared — observed against the
#     extracted predicate on a two-region probe body.
#
# HERMETIC: database-free throughout. The python rule runs against frozen fixture
# strings; the shell gate, the verification callback and the transaction run
# against extracted functions in a temporary tree with the module CLI pointed at
# this repository. Nothing touches the live install.
#
# Run: python3 -m unittest autoagent.test.test_removal_exact_match_gate
#   (or, from autoagent/test/) python3 -m unittest test_removal_exact_match_gate

from __future__ import annotations

import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stderr
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_APPLY_SH = _AUTOAGENT_DIR / "daemon-apply.sh"
_GIT_TXN_SH = _AUTOAGENT_DIR / "lib" / "git-txn.sh"
_DAEMON_CYCLE_PY = _AUTOAGENT_DIR / "daemon_cycle.py"

if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import daemon_cycle as dc  # noqa: E402 — autoagent dir prepended above

# The keystone fixtures are the S1 suite's, consumed rather than re-frozen: one
# capture of a stored proposal is the SoT for both tasks.
from test_removal_discard_refusal import (  # noqa: E402
    ADD_ONLY_FRAGMENT,
    DEV_DB_WORK_RULES,
    HEADERLESS_REPLACE_FRAGMENT,
    PROPOSAL_314_DIFF,
    PROPOSAL_318_DIFF,
)

BEGIN_MARK = "<!-- EDITABLE:BEGIN -->"
END_MARK = "<!-- EDITABLE:END -->"

# A probe body carrying frontmatter, a heading, a `> Rules:` anchor and ONE
# editable region — every member of the protected set is present exactly once, so
# a removal aimed at any of them is a single-match removal that must STILL refuse
# on the protected rule rather than on match count.
PROBE_BODY = "\n".join(
    [
        "---",
        "name: probe-agent",
        "---",
        "# Probe Agent",
        "> Rules: comment-logging",
        "",
        "## Work Rules",
        BEGIN_MARK,
        "- keep one",
        "- removable line",
        "- keep two",
        END_MARK,
        "",
        "## Prohibitions",
        "- protected zone line",
        "",
    ]
)


def _diff(*hunk_lines: str, name: str = "probe-agent.md") -> str:
    """A single-hunk located diff whose body is exactly `hunk_lines`."""
    body = "".join(line + "\n" for line in hunk_lines)
    return f"--- a/{name}\n+++ b/{name}\n@@ -1,1 +1,1 @@\n{body}"


def _qa_debugger_before() -> str:
    """The qa-debugger BEFORE state, reconstructed from proposal 314's own hunk.

    The applied pure-removal diff is the fixture proving removals reach
    production without the repair path, so its target is rebuilt from the stored
    hunk (context + removed lines) rather than invented.
    """
    body = BEGIN_MARK + "\n"
    for line in PROPOSAL_314_DIFF.splitlines()[3:]:
        body += line[1:] + "\n"
    return body + END_MARK + "\n"


# -- Shell-side driver ------------------------------------------------------
#
# daemon-apply.sh runs top-level code and is not sourceable, so the functions
# under test are extracted the way the sibling S2 suite extracts them: header
# line through the first column-0 close brace.


def _extract_shell(*names: str) -> str:
    lines = _APPLY_SH.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    for name in names:
        collecting = False
        found = False
        for line in lines:
            if not collecting and line.startswith(f"{name}() {{"):
                collecting = True
            if collecting:
                out.append(line)
                if line == "}":
                    collecting = False
                    found = True
                    break
        if not found:  # loud: a silent empty snippet would test nothing
            raise AssertionError(f"could not extract {name}() from {_APPLY_SH}")
    return "\n".join(out) + "\n"


def _run_bash(script: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    full_env = dict(os.environ)
    full_env.update(env or {})
    return subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
        env=full_env,
        check=False,
    )


class _ShellCase(unittest.TestCase):
    """Temporary tree holding the extracted gate, its helpers and a probe body."""

    SHELL_FUNCS = (
        "emit_log",
        "json_escape",
        "ts_now",
        "ts_now_json",
        "verify_patched",
        "assert_removal_evidence",
    )

    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="s4-removal-"))
        self.addCleanup(shutil.rmtree, self.work, ignore_errors=True)
        self.snippet = self.work / "gate.sh"
        self.snippet.write_text(_extract_shell(*self.SHELL_FUNCS), encoding="utf-8")
        self.applied_log = self.work / "applied.jsonl"
        self.target = self.work / "probe-agent.md"
        self.target.write_text(PROBE_BODY, encoding="utf-8")

    def gate(self, diff: str, *, live: bool = False, snippet: Path | None = None):
        """Drive assert_removal_evidence; return the CompletedProcess.

        stdout carries `rc<TAB>verdict` so both travel out of the subshell.
        """
        script = f"""
        source '{snippet or self.snippet}'
        DAEMON_CYCLE_PY='{_DAEMON_CYCLE_PY}'
        APPLIED_LOG='{self.applied_log}'
        REMOVAL_VERDICT=''
        REMOVAL_DECLARED_FILE=''
        rc=0
        assert_removal_evidence '{self.target}' "$(cat '{self.work}/diff.txt')" probe-label probe-target || rc=$?
        printf '%s\\t%s\\t%s\\n' "${{rc}}" "${{REMOVAL_VERDICT}}" "${{REMOVAL_DECLARED_FILE}}"
        """
        (self.work / "diff.txt").write_text(diff, encoding="utf-8")
        env = {"AUTOAGENT_REMOVAL_LIVE": "1"} if live else {"AUTOAGENT_REMOVAL_LIVE": ""}
        return _run_bash(script, env)

    def verdict(self, diff: str, *, live: bool = False, snippet: Path | None = None):
        proc = self.gate(diff, live=live, snippet=snippet)
        # rstrip only the record separator: the declared-file field is the
        # last one and is legitimately EMPTY on every un-armed path.
        rc, verdict, declared_file = proc.stdout.rstrip("\n").splitlines()[-1].split("\t")
        return int(rc), verdict, declared_file, proc.stderr


# ---------------------------------------------------------------------------
# The evidence rule
# ---------------------------------------------------------------------------


class TestEvidenceRuleAdmits(unittest.TestCase):
    """The one shape the rule admits — fails at HEAD, where no helper exists."""

    def test_when_removal_matches_one_in_region_line_then_admitted(self) -> None:
        evidence = dc.verify_removal_evidence(
            _diff(" - keep one", "-- removable line", "+- replacement line"),
            PROBE_BODY,
        )
        self.assertTrue(evidence.ok)
        self.assertEqual(evidence.verdict, dc.REMOVAL_VERDICT_OK)
        self.assertEqual(evidence.declared, ("- removable line",))

    def test_when_no_removal_declared_then_gate_is_inert(self) -> None:
        evidence = dc.verify_removal_evidence(
            _diff(" - keep one", "+- appended line"), PROBE_BODY
        )
        self.assertTrue(evidence.ok)
        self.assertEqual(evidence.verdict, dc.REMOVAL_VERDICT_NO_REMOVAL)
        self.assertEqual(evidence.declared, ())

    def test_when_add_only_fragment_then_gate_is_inert(self) -> None:
        evidence = dc.verify_removal_evidence(ADD_ONLY_FRAGMENT, PROBE_BODY)
        self.assertTrue(evidence.ok)
        self.assertEqual(evidence.verdict, dc.REMOVAL_VERDICT_NO_REMOVAL)


class TestKeystone318(unittest.TestCase):
    """The historical instance: a removed line truncated mid-token matches nothing."""

    def test_when_318_evidenced_then_no_match_refusal(self) -> None:
        evidence = dc.verify_removal_evidence(PROPOSAL_318_DIFF, DEV_DB_WORK_RULES)
        self.assertFalse(evidence.ok)
        self.assertEqual(evidence.verdict, dc.REMOVAL_VERDICT_NO_MATCH)
        # The stored removal is truncated mid-token, so it can match nothing.
        self.assertTrue(evidence.declared[0].endswith("nee"))

    def test_when_318_reaches_the_stale_site_then_refused_not_rebuilt(self) -> None:
        # Exercised where 318 actually arrives — the stale re-derivation site.
        work = Path(tempfile.mkdtemp(prefix="s4-318-"))
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        target = work / "glass-atrium-dev-db.md"
        target.write_text(DEV_DB_WORK_RULES, encoding="utf-8")
        buf = io.StringIO()
        with redirect_stderr(buf):
            result = dc._rederive_diff_against_file(PROPOSAL_318_DIFF, target)
        self.assertEqual(result, "")
        self.assertIn("REMOVAL REFUSAL", buf.getvalue())


class TestAppliedPureRemoval314(unittest.TestCase):
    """Coverage is total, not repair-path-only: 314 never entered the repair path."""

    def test_when_314_verified_against_its_own_stored_diff_then_admitted(self) -> None:
        evidence = dc.verify_removal_evidence(PROPOSAL_314_DIFF, _qa_debugger_before())
        self.assertTrue(evidence.ok)
        self.assertEqual(len(evidence.declared), 2)
        for declared in evidence.declared:
            self.assertEqual(_qa_debugger_before().splitlines().count(declared), 1)


class TestEvidenceRuleRefuses(unittest.TestCase):
    """Every ambiguity refuses the WHOLE diff. Fail-closed is the direction."""

    def test_when_removal_bearing_set_derives_empty_then_ambiguous(self) -> None:
        # A header-less fragment declares removals no hunk can enumerate.
        evidence = dc.verify_removal_evidence(HEADERLESS_REPLACE_FRAGMENT, PROBE_BODY)
        self.assertFalse(evidence.ok)
        self.assertEqual(evidence.verdict, dc.REMOVAL_VERDICT_AMBIGUOUS)
        self.assertEqual(evidence.declared, ())

    def test_when_removal_matches_several_lines_then_refused(self) -> None:
        body = PROBE_BODY.replace("- keep two", "- removable line")
        evidence = dc.verify_removal_evidence(
            _diff("-- removable line", "+- replacement"), body
        )
        self.assertFalse(evidence.ok)
        self.assertEqual(evidence.verdict, dc.REMOVAL_VERDICT_MULTIPLE_MATCH)

    def test_when_removal_lands_outside_every_region_then_refused(self) -> None:
        evidence = dc.verify_removal_evidence(
            _diff("-- protected zone line"), PROBE_BODY
        )
        self.assertFalse(evidence.ok)
        self.assertEqual(evidence.verdict, dc.REMOVAL_VERDICT_OUT_OF_REGION)

    def test_when_target_unreadable_then_refused(self) -> None:
        evidence = dc.verify_removal_evidence(_diff("-- removable line"), "")
        self.assertFalse(evidence.ok)
        self.assertEqual(evidence.verdict, dc.REMOVAL_VERDICT_UNREADABLE)

    def test_when_replace_addition_admissible_but_removal_not_then_refused_whole(
        self,
    ) -> None:
        # The addition is ordinary content; only the removal is unevidenced. The
        # verdict is on the WHOLE diff, so no partial append can escape.
        evidence = dc.verify_removal_evidence(
            _diff("-- line that does not exist", "+- perfectly fine addition"),
            PROBE_BODY,
        )
        self.assertFalse(evidence.ok)
        self.assertEqual(evidence.verdict, dc.REMOVAL_VERDICT_NO_MATCH)


class TestProtectedSet(unittest.TestCase):
    """One criterion per member. Each is present exactly once in the probe body,
    so a match-count refusal cannot masquerade as a protected refusal."""

    def _refuse(self, removed: str) -> dc.RemovalEvidence:
        evidence = dc.verify_removal_evidence(_diff("-" + removed), PROBE_BODY)
        self.assertFalse(evidence.ok)
        self.assertEqual(evidence.verdict, dc.REMOVAL_VERDICT_PROTECTED)
        return evidence

    def test_when_frontmatter_delimiter_removed_then_refused(self) -> None:
        # `---` reaches the rule ONLY from the raw hunk lines: the fragment
        # partition drops every '---'-prefixed line as a file header, so the
        # generation-side pre-filter provably cannot see this member.
        self.assertIn("frontmatter", self._refuse("---").detail)

    def test_when_rules_anchor_removed_then_refused(self) -> None:
        self.assertIn("rules-anchor", self._refuse("> Rules: comment-logging").detail)

    def test_when_region_marker_removed_then_refused(self) -> None:
        self.assertIn("region-marker", self._refuse(BEGIN_MARK).detail)

    def test_when_heading_removed_then_refused(self) -> None:
        self.assertIn("heading", self._refuse("## Work Rules").detail)

    def test_when_blank_line_removed_then_refused(self) -> None:
        # A blank line carries no identity, so it can never be evidenced as
        # exactly one anything — the other member the pre-filter cannot see.
        self.assertIn("blank", self._refuse("").detail)


class TestDeclaredSetDerivation(unittest.TestCase):
    """Enumeration is from the RAW hunk lines, which is what makes the
    frontmatter-delimiter and `-- `-prefixed members visible at all."""

    def test_when_frontmatter_delimiter_removed_then_fragment_partition_is_blind(
        self,
    ) -> None:
        diff = _diff("----")
        _context, _added, removed = dc._split_fragment_lines(diff)
        self.assertEqual(removed, [])  # the partition drops it as a file header
        declared, bearing = dc._get_declared_removals(diff)
        self.assertTrue(bearing)
        self.assertEqual(declared, ("---",))

    def test_when_file_headers_only_then_no_removal_declared(self) -> None:
        declared, bearing = dc._get_declared_removals(
            "--- a/probe-agent.md\n+++ b/probe-agent.md\n@@ -1,1 +1,1 @@\n+- added\n"
        )
        self.assertEqual(declared, ())
        self.assertFalse(bearing)


class TestRemovalLiveOptIn(unittest.TestCase):
    """Dry-run is the default; live removal is opt-in through one named variable."""

    def test_when_unset_then_not_live(self) -> None:
        with unittest.mock.patch.dict(os.environ, {dc.REMOVAL_LIVE_ENV: ""}):
            self.assertFalse(dc.get_removal_live())

    def test_when_set_then_live(self) -> None:
        with unittest.mock.patch.dict(os.environ, {dc.REMOVAL_LIVE_ENV: "1"}):
            self.assertTrue(dc.get_removal_live())


# ---------------------------------------------------------------------------
# The apply-side gate
# ---------------------------------------------------------------------------


class TestApplyGateDryRunDefault(_ShellCase):
    def test_when_default_then_dry_run_reports_membership_and_writes_nothing(
        self,
    ) -> None:
        before = self.target.read_text(encoding="utf-8")
        rc, verdict, declared_file, stderr = self.verdict(
            _diff(" - keep one", "-- removable line", "+- replacement line")
        )
        self.assertEqual(rc, 1)  # do NOT apply
        self.assertEqual(verdict, "dry_run")
        self.assertEqual(declared_file, "")
        self.assertIn("removal_dry_run", stderr)
        self.assertIn("- removable line", stderr)  # membership, not just a count
        self.assertEqual(self.target.read_text(encoding="utf-8"), before)
        self.assertIn("removal_dry_run", self.applied_log.read_text(encoding="utf-8"))

    def test_when_no_removal_then_gate_admits_without_arming(self) -> None:
        rc, verdict, declared_file, _stderr = self.verdict(
            _diff(" - keep one", "+- appended line")
        )
        self.assertEqual(rc, 0)
        self.assertEqual(verdict, "no_removal")
        self.assertEqual(declared_file, "")


class TestApplyTimeProtectedMembers(_ShellCase):
    """The two members the generation-side pre-filter provably cannot see are
    exercised through the APPLY-time gate, which is where they actually arrive."""

    def test_when_frontmatter_delimiter_removed_then_refused_at_apply_time(
        self,
    ) -> None:
        rc, verdict, _declared_file, stderr = self.verdict(_diff("----"), live=True)
        self.assertEqual(rc, 1)
        self.assertEqual(verdict, "protected")
        self.assertIn("removal_evidence_reject", stderr)

    def test_when_blank_line_removed_then_refused_at_apply_time(self) -> None:
        rc, verdict, _declared_file, stderr = self.verdict(_diff("-"), live=True)
        self.assertEqual(rc, 1)
        self.assertEqual(verdict, "protected")
        self.assertIn("removal_evidence_reject", stderr)


class TestApplyGateLiveOptIn(_ShellCase):
    def test_when_live_then_admissible_removal_arms_the_declared_set(self) -> None:
        rc, verdict, declared_file, stderr = self.verdict(
            _diff(" - keep one", "-- removable line", "+- replacement line"), live=True
        )
        self.assertEqual(rc, 0)
        self.assertEqual(verdict, "ok")
        self.assertIn("removal_live armed", stderr)
        self.assertEqual(
            Path(declared_file).read_text(encoding="utf-8"), "- removable line\n"
        )

    def test_when_live_but_unevidenced_then_refused_with_named_line(self) -> None:
        rc, verdict, declared_file, stderr = self.verdict(
            _diff("-- line that does not exist"), live=True
        )
        self.assertEqual(rc, 1)
        self.assertEqual(verdict, "no_match")
        self.assertEqual(declared_file, "")
        self.assertIn("removal_evidence_reject", stderr)
        self.assertIn(
            "removal_evidence_reject", self.applied_log.read_text(encoding="utf-8")
        )


class TestMarkerGuardPrecondition(_ShellCase):
    """The S2 dependency is enforced by the ARTIFACT, not only by the task graph:
    a deletion power without the guard that detects a wrong deletion is privilege
    escalation. Split the pull request and S4 is inert, not dangerous."""

    def test_when_marker_check_absent_then_live_removal_refuses_loudly(self) -> None:
        stripped = self.work / "gate-no-marker.sh"
        # The real gate, then a verify_patched carrying NO marker check appended
        # over it — the callback shape this file had before S2 landed. Redefining
        # is used rather than deleting the marker lines from the extracted text,
        # which would leave a dangling loop and test a syntax error instead.
        stripped.write_text(
            self.snippet.read_text(encoding="utf-8")
            + "\nverify_patched() {\n"
            + '    [[ -s "$1" ]] || return 1\n'
            + "    grep -q '^#' \"$1\" || return 1\n"
            + "    return 0\n}\n",
            encoding="utf-8",
        )
        rc, verdict, declared_file, stderr = self.verdict(
            _diff(" - keep one", "-- removable line", "+- replacement line"),
            live=True,
            snippet=stripped,
        )
        self.assertEqual(rc, 1)
        self.assertEqual(verdict, "marker_guard_absent")
        self.assertEqual(declared_file, "")
        self.assertIn("removal_gate_precondition", stderr)


# ---------------------------------------------------------------------------
# The verification callback
# ---------------------------------------------------------------------------


class TestVerifyDeclaredMultiset(_ShellCase):
    """Compared as MULTISETS: a membership test passes exactly the case worth
    catching (both copies of a duplicated line vanishing on one declaration)."""

    def verify(self, before: str, after: str, declared: list[str] | None):
        (self.work / "before.md").write_text(before, encoding="utf-8")
        (self.work / "after.md").write_text(after, encoding="utf-8")
        arm = ""
        if declared is not None:
            (self.work / "declared.txt").write_text(
                "".join(line + "\n" for line in declared), encoding="utf-8"
            )
            arm = f"REMOVAL_DECLARED_FILE='{self.work}/declared.txt'"
        script = f"""
        source '{self.snippet}'
        VERIFY_BEFORE_IMAGE='{self.work}/before.md'
        {arm}
        rc=0
        verify_patched '{self.work}/after.md' || rc=$?
        printf '%s\\n' "${{rc}}"
        """
        proc = _run_bash(script)
        return int(proc.stdout.strip().splitlines()[-1]), proc.stderr

    def test_when_absent_multiset_equals_declared_then_verified(self) -> None:
        before = PROBE_BODY
        after = PROBE_BODY.replace("- removable line\n", "")
        rc, _stderr = self.verify(before, after, ["- removable line"])
        self.assertEqual(rc, 0)

    def test_when_duplicate_line_and_one_instance_removed_then_verified(self) -> None:
        before = PROBE_BODY.replace("- keep two", "- removable line")
        after = before.replace("- removable line\n", "", 1)
        rc, _stderr = self.verify(before, after, ["- removable line"])
        self.assertEqual(rc, 0)

    def test_when_duplicate_line_and_both_instances_vanish_then_failed(self) -> None:
        # The multiset pin: a membership test admits this, which is the bug.
        before = PROBE_BODY.replace("- keep two", "- removable line")
        after = before.replace("- removable line\n", "")
        rc, stderr = self.verify(before, after, ["- removable line"])
        self.assertEqual(rc, 1)
        self.assertIn("removal_multiset_mismatch", stderr)

    def test_when_undeclared_line_vanished_then_failed(self) -> None:
        before = PROBE_BODY
        after = PROBE_BODY.replace("- removable line\n", "").replace(
            "- keep two\n", ""
        )
        rc, stderr = self.verify(before, after, ["- removable line"])
        self.assertEqual(rc, 1)
        self.assertIn("removal_multiset_mismatch", stderr)

    def test_when_declared_set_unreadable_then_failed_closed(self) -> None:
        (self.work / "before.md").write_text(PROBE_BODY, encoding="utf-8")
        (self.work / "after.md").write_text(PROBE_BODY, encoding="utf-8")
        script = f"""
        source '{self.snippet}'
        VERIFY_BEFORE_IMAGE='{self.work}/before.md'
        REMOVAL_DECLARED_FILE='{self.work}/absent-set.txt'
        rc=0
        verify_patched '{self.work}/after.md' || rc=$?
        printf '%s\\n' "${{rc}}"
        """
        proc = _run_bash(script)
        self.assertEqual(proc.stdout.strip().splitlines()[-1], "1")
        self.assertIn("declared-removal set unreadable", proc.stderr)

    def test_when_gate_not_armed_then_check_is_inert(self) -> None:
        # The regression pin the whole design rests on: an un-armed patch keeps
        # its exact previous verification semantics, undeclared vanish included.
        before = PROBE_BODY
        after = PROBE_BODY.replace("- removable line\n", "")
        rc, _stderr = self.verify(before, after, None)
        self.assertEqual(rc, 0)


class TestVerifyFailureHandsOffToRestore(_ShellCase):
    """The transaction's atomic restore is what a failed removal verify hands to."""

    def test_when_undeclared_line_vanished_then_target_restored(self) -> None:
        before_body = PROBE_BODY
        target = self.work / "install" / "probe-agent.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(before_body, encoding="utf-8")
        (self.work / "declared.txt").write_text(
            "- removable line\n", encoding="utf-8"
        )
        # A stub apply callback stands in for git apply: it lands a patch that
        # removes the declared line AND an undeclared one. What is under test is
        # the declared-set verification and its handoff, not git's patcher.
        script = f"""
        source '{_GIT_TXN_SH}'
        source '{self.snippet}'
        apply_stub() {{
          local tgt="$1"
          grep -v -e '- removable line' -e '- keep two' '{target}' >"${{tgt}}.new"
          mv "${{tgt}}.new" "${{tgt}}"
          return 0
        }}
        REMOVAL_DECLARED_FILE='{self.work}/declared.txt'
        git_txn_apply '{self.work}/install' '{target}' '{target}' '' \
          '{self.work}/bak' apply_stub verify_patched probe-label probe-target
        printf '%s\\n' "${{GIT_TXN_RC}}"
        """
        proc = _run_bash(script)
        rc_line = proc.stdout.strip().splitlines()[-1]
        self.assertIn("removal_multiset_mismatch", proc.stderr)
        self.assertEqual(rc_line, "13")  # GIT_TXN_VERIFY_FAIL
        self.assertEqual(target.read_text(encoding="utf-8"), before_body)

    def test_when_declared_removal_lands_then_line_is_absent_and_kept(self) -> None:
        target = self.work / "install" / "probe-agent.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(PROBE_BODY, encoding="utf-8")
        (self.work / "declared.txt").write_text(
            "- removable line\n", encoding="utf-8"
        )
        script = f"""
        source '{_GIT_TXN_SH}'
        source '{self.snippet}'
        apply_stub() {{
          local tgt="$1"
          grep -v -e '- removable line' '{target}' >"${{tgt}}.new"
          mv "${{tgt}}.new" "${{tgt}}"
          return 0
        }}
        REMOVAL_DECLARED_FILE='{self.work}/declared.txt'
        git_txn_apply '{self.work}/install' '{target}' '{target}' '' \
          '{self.work}/bak' apply_stub verify_patched probe-label probe-target
        printf '%s\\n' "${{GIT_TXN_RC}}"
        """
        proc = _run_bash(script)
        self.assertEqual(proc.stdout.strip().splitlines()[-1], "0")  # GIT_TXN_OK
        self.assertNotIn("- removable line", target.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# The module CLI arm the apply script calls
# ---------------------------------------------------------------------------


class TestRemovalEvidenceCli(unittest.TestCase):
    def _run(self, diff: str, target: Path, live: bool = False):
        env = dict(os.environ)
        env["AUTOAGENT_REMOVAL_LIVE"] = "1" if live else ""
        return subprocess.run(
            [
                sys.executable,
                str(_DAEMON_CYCLE_PY),
                "--removal-evidence",
                "--target",
                str(target),
            ],
            input=diff,
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )

    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp(prefix="s4-cli-"))
        self.addCleanup(shutil.rmtree, self.work, ignore_errors=True)
        self.target = self.work / "probe-agent.md"
        self.target.write_text(PROBE_BODY, encoding="utf-8")

    def test_when_admissible_then_verdict_live_flag_and_members(self) -> None:
        proc = self._run(_diff("-- removable line"), self.target, live=True)
        self.assertEqual(proc.returncode, 0)
        lines = proc.stdout.splitlines()
        self.assertEqual(lines[0], "ok\t1\t1")
        self.assertEqual(lines[1], "- removable line")

    def test_when_target_missing_then_unreadable_verdict_not_a_crash(self) -> None:
        proc = self._run(_diff("-- removable line"), self.work / "absent.md")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.splitlines()[0], "unreadable\t0\t0")

    def test_when_target_omitted_then_usage_error(self) -> None:
        proc = subprocess.run(
            [sys.executable, str(_DAEMON_CYCLE_PY), "--removal-evidence"],
            input="", capture_output=True, text=True, check=False,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--target", proc.stderr)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
