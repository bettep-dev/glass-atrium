"""Behavioral tests for the shared sensitive-file refusal source (T15 / gate G7).

The update skill (a shell pipeline) must refuse to sync a sensitive harness file
or a diff carrying an irreversible command. The refusal set is the COMPILED
regex tuples in ``daemon_cycle.py`` — the single source. The skill consults that
set ONLY by shelling out to ``autoagent/lib/sensitive_patterns.py``, which
IMPORTS those tuples (no shell-ERE re-implementation).

These tests pin the SINGLE-SOURCE invariant:
  * the python helper imports the daemon's compiled matchers (object identity);
  * the helper, the daemon's ``classify_safety_tier`` (path-only patch), and the
    daemon's bare ``match_sensitive_path`` refuse the EXACT SAME path corpus;
  * GLASS_ATRIUM_GLOBAL_RULES / security scope rules / .env / launchd plist are
    refused with a loud, non-zero CLI verdict; ordinary agent files (including
    the pre-rename GLOBAL_RULES.md basenames) are CLEAN;
  * the CLI exit-code contract (0 clean / 3 sensitive / 2 usage / 4 env) holds.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_sensitive_patterns.py -v
    python3 -m unittest autoagent.test.test_sensitive_patterns -v
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_LIB_DIR = _AUTOAGENT_DIR / "lib"
_HELPER = _LIB_DIR / "sensitive_patterns.py"

if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

try:
    import daemon_cycle as dc
    import sensitive_patterns as sp

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — import failure → skip, not error
    dc = None  # type: ignore[assignment]
    sp = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

# A path corpus spanning every sensitive class + plausible CLEAN siblings.
_PATH_CORPUS: tuple[str, ...] = (
    # sensitive
    "rules/GLASS_ATRIUM_GLOBAL_RULES.md",
    "rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md",
    "agents/GLASS_ATRIUM_GLOBAL_RULES.md",
    "GLASS_ATRIUM_GLOBAL_RULES.md",
    "rules/glass-atrium/core-security.md",
    "scoped/scope-security.md",
    "rules/glass-atrium/core-learning-log.md",
    "project/.env",
    "project/.env.local",
    "~/Library/LaunchAgents/com.claude.monitor.plist",
    "x/com.claude.autoagent-daemon.plist",
    # clean
    "agents/dev-python.md",
    "rules/scope-dev.md",
    "scripts/lib/apply-spine.sh",
    "scripts/update.sh",
    "config.toml",
    "rules/security.md",  # the retired phantom — must stay clean
    "rules/security-notes.md",  # not exactly core-security.md
    "rules/glass-atrium/core-learning-log-notes.md",  # suffix near-miss
    "hooks/learning-aggregator.py",  # live manifest neighbor, not the rule file
    "envoy.md",  # not .env
    # clean — pre-rename charter basenames lock in the GLASS_ATRIUM_ rename:
    # the refusal SoT matches ONLY the new name, so the old forms are ordinary.
    "rules/GLOBAL_RULES.md",
    "agents/GLOBAL_RULES.md",
    "GLOBAL_RULES.md",
)

# Diff bodies spanning every sensitive diff class + CLEAN near-misses. Tokens
# split so this test file never embeds a literal dangerous command.
_RM = "r" "m"
_CHMOD = "c" "hmod"

# The SAFE inherited-tree recipe (dev-react "Pre-Execution Verification" bullet,
# I1). It NAMES stash/pop/drop/build but PRESCRIBES only the tagged-stash flow,
# so the diff detector MUST leave it clean — a false positive here would flag
# the very instruction that closes the hazard. Pinned verbatim below.
_I1_BULLET = (
    "- **Inherited-tree baseline (no bare stash)**: on a pre-broken WIP tree, "
    "preserve existing work with `git stash push -u -m <unique-tag>`, immediately "
    "capture the entry SHA, and restore ONLY via `git stash apply <sha>` (never "
    "`pop`) — drop the entry by its tag afterwards · a transient WIP commit is "
    "NOT the default (`git add -A` is forbidden by the Tier-1 git rule + "
    "pre-commit hooks may fail on a pre-broken tree, and a tagged stash bypasses "
    "commit hooks) · record pre-existing compile state with TYPE-CHECK ONLY "
    "(`tsc --noEmit` / `npm run typecheck`, never a full build) · pre-existing "
    "errors blocking scope → escalate to orchestrator"
)

_DIFF_SENSITIVE: tuple[str, ...] = (
    f"+ {_RM} -rf /tmp/x",
    f"+ {_RM} -f x",
    f"+ {_RM} -r dir",
    f"+    {_CHMOD} 0777 secret",
    "+ git push --force origin main",
    "+ DROP TABLE core.outcomes;",
    "+ launchctl bootout gui/501",
    # Inherited-tree baseline hazards (I2) — a body recipe prescribing a raw
    # working-tree reset. Embedded literally, matching the `git push --force`
    # precedent above (only rm/chmod are token-split).
    "+ git stash && npm run build",  # bare git stash (the rolled-back proposal-9 recipe)
    "+ git stash pop",
    "+ git stash clear",
    "+ git stash drop stash@{0}",  # index-addressed drop
    "+ git reset --hard HEAD~1",
    "+ git checkout .",
    "+ git checkout -- .",  # double-dash bare-dot — same discard, past the `.`-only pattern
    "+ git restore .",  # modern worktree discard (default --worktree)
    "+ git restore --worktree .",  # explicit-worktree bare-dot discard
    "+ git clean -fd",
)
_DIFF_CLEAN: tuple[str, ...] = (
    "+ this confirms the farm output",  # 'confirm'/'farm' must NOT match \brm\b
    f"- {_RM} -rf /tmp/x",  # removed line, not added → ignored
    "+++ b/path.md",  # diff header, not body
    "+ a perfectly ordinary documentation line",
    f"+ {_RM} file.txt",  # flagless deletion — outside the cluster claim
    # The SAFE tagged-stash recipe (I1) must NEVER trip the detector — the
    # negative-lookahead keeps push/apply/list clean.
    "+ git stash push -u -m tag",
    "+ git stash apply <sha>",
    "+ the note explains why a bare stash is risky without a restore step",  # prose, prescribes nothing
    # Non-discard restore/checkout forms — a bare-dot `--staged` unstage (working
    # tree preserved), a specific-file restore, a dot-prefixed path, and a branch
    # checkout MUST stay clean.
    "+ git restore --staged .",  # bare-dot but --staged → tree preserved
    "+ git restore path/to/file.ts",  # single-file restore, not the bare-dot tree
    "+ git checkout .gitignore",  # dot-prefixed path, not the bare-dot tree discard
    "+ git checkout feature-branch",  # branch switch, not a pathspec discard
    f"+ {_I1_BULLET}",  # the I1 bullet verbatim — pins the safe instruction clean
)


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class SingleSourceIdentity(unittest.TestCase):
    """The helper must DELEGATE to the daemon's compiled matchers, not re-define."""

    def test_helper_path_match_is_the_daemon_match(self) -> None:
        for path in _PATH_CORPUS:
            self.assertEqual(
                sp.is_sensitive_path(path),
                dc.match_sensitive_path(path),
                msg=f"path verdict diverged for {path!r}",
            )

    def test_helper_diff_match_is_the_daemon_match(self) -> None:
        for diff in (*_DIFF_SENSITIVE, *_DIFF_CLEAN):
            self.assertEqual(
                sp.is_sensitive_diff(diff),
                dc.match_sensitive_diff(diff),
                msg=f"diff verdict diverged for {diff!r}",
            )


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class DaemonAndSkillRefuseSameSet(unittest.TestCase):
    """AC: a test asserts the python daemon and the shell skill refuse the SAME
    path set. The skill refuses iff the helper refuses (it shells out to it), so
    helper-vs-daemon parity over the corpus IS that proof — cross-checked here
    against the daemon's own classify_safety_tier (path-only patch)."""

    def _path_only_tier(self, path: str) -> str:
        # A patch that ONLY changes target_file (benign body) — isolates the
        # path trigger from the diff/frontmatter triggers.
        patch = dc.PatchProposal(
            target_file=path,
            rationale="probe",
            proposed_diff="+ a benign documentation line\n",
            touched_frontmatter=False,
            estimated_added_lines=1,
            raw_response="",
        )
        return dc.classify_safety_tier(patch)

    def test_same_path_refusal_set(self) -> None:
        for path in _PATH_CORPUS:
            helper_refuses = sp.is_sensitive_path(path) is not None
            daemon_refuses = dc.match_sensitive_path(path) is not None
            tier_refuses = self._path_only_tier(path) == "safety"
            self.assertEqual(
                (helper_refuses, daemon_refuses),
                (tier_refuses, tier_refuses),
                msg=f"refusal set diverged for {path!r}: "
                f"helper={helper_refuses} daemon={daemon_refuses} "
                f"tier={tier_refuses}",
            )

    def test_known_sensitive_paths_all_refused(self) -> None:
        for path in (
            "rules/GLASS_ATRIUM_GLOBAL_RULES.md",
            "rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md",
            "rules/glass-atrium/core-security.md",
            "scoped/scope-security.md",
            "rules/glass-atrium/core-learning-log.md",
            "project/.env",
            "~/Library/LaunchAgents/com.claude.monitor.plist",
        ):
            self.assertIsNotNone(
                sp.is_sensitive_path(path), msg=f"expected refusal for {path!r}"
            )

    def test_ordinary_agent_files_clean(self) -> None:
        # includes the pre-rename charter basenames — CLEAN post-rename siblings.
        for path in (
            "agents/dev-python.md",
            "rules/scope-dev.md",
            "config.toml",
            "rules/security.md",
            "rules/glass-atrium/core-learning-log-notes.md",
            "hooks/learning-aggregator.py",
            "rules/GLOBAL_RULES.md",
            "GLOBAL_RULES.md",
        ):
            self.assertIsNone(
                sp.is_sensitive_path(path), msg=f"unexpected refusal for {path!r}"
            )

    def test_diff_sensitive_and_clean_corpus(self) -> None:
        for diff in _DIFF_SENSITIVE:
            self.assertIsNotNone(
                sp.is_sensitive_diff(diff), msg=f"expected refusal for {diff!r}"
            )
        for diff in _DIFF_CLEAN:
            self.assertIsNone(
                sp.is_sensitive_diff(diff), msg=f"unexpected refusal for {diff!r}"
            )


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class CliExitContract(unittest.TestCase):
    """The shell-out boundary: exit 0 clean / 3 sensitive / 2 usage / 4 env, plus
    a loud stderr refusal line on a sensitive match."""

    def _run(self, args: list[str], stdin: str | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(_HELPER), *args],
            input=stdin,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_path_sensitive_exits_3_with_loud_message(self) -> None:
        for path in (
            "rules/GLASS_ATRIUM_GLOBAL_RULES.md",
            "rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md",
        ):
            res = self._run(["path", path])
            self.assertEqual(res.returncode, sp.EXIT_SENSITIVE)
            self.assertIn("REFUSED", res.stderr)
            self.assertIn("GLASS_ATRIUM_GLOBAL_RULES", res.stderr)

    def test_path_clean_exits_0_silent(self) -> None:
        res = self._run(["path", "agents/dev-python.md"])
        self.assertEqual(res.returncode, sp.EXIT_CLEAN)
        self.assertEqual(res.stderr, "")

    def test_diff_stdin_sensitive_exits_3(self) -> None:
        res = self._run(["diff", "-"], stdin=f"+ {_RM} -rf /t\n")
        self.assertEqual(res.returncode, sp.EXIT_SENSITIVE)
        self.assertIn("REFUSED", res.stderr)

    def test_diff_stdin_clean_exits_0(self) -> None:
        res = self._run(["diff", "-"], stdin="+ ordinary line\n")
        self.assertEqual(res.returncode, sp.EXIT_CLEAN)

    def test_bad_subcommand_exits_usage(self) -> None:
        res = self._run(["bogus"])
        self.assertEqual(res.returncode, sp.EXIT_USAGE)

    def test_diff_missing_file_exits_usage(self) -> None:
        res = self._run(["diff", "/no/such/diff.txt"])
        self.assertEqual(res.returncode, sp.EXIT_USAGE)
        self.assertIn("cannot read diff source", res.stderr)


# The charter pair, spelled once: the REAL manifest row and the SYMLINK row that
# points at it. Deliberately NOT added to _PATH_CORPUS — that corpus feeds the
# identity assertions above, which must keep proving helper == daemon ==
# classify_safety_tier over an UNCHANGED set. The carve-out below is a separate
# matcher, asserted separately.
_CHARTER_REAL = "agents/GLASS_ATRIUM_GLOBAL_RULES.md"
_CHARTER_LINK = "rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md"
_RETAINED_SENSITIVE = "scoped/scope-security.md"


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class SyncExemptionIsOneConsumerWide(unittest.TestCase):
    """The charter is reachable through the updater's CHANGED-FILE partition and
    nowhere else. Each test below names the consumer it pins, so a silent
    widening of the carve-out cannot ship as a green suite."""

    def test_charter_is_exempt_on_the_sync_matcher(self) -> None:
        self.assertIsNone(
            dc.match_sensitive_path_for_sync(_CHARTER_REAL),
            msg="the charter must be syncable — the updater is the only live write seam",
        )
        self.assertIsNone(sp.is_sensitive_path_for_sync(_CHARTER_REAL))

    def test_charter_is_still_refused_by_the_strict_matcher(self) -> None:
        # The strict matcher is what the vendor-removal sweep and every non-sync
        # consumer call; the carve-out must not reach it.
        self.assertIsNotNone(dc.match_sensitive_path(_CHARTER_REAL))
        self.assertIsNotNone(sp.is_sensitive_path(_CHARTER_REAL))

    def test_charter_symlink_row_is_not_exempt(self) -> None:
        # C5: the spine stages with a dereferencing `cp -p` and commits by rename,
        # so syncing this row would replace the link with a regular file and let
        # the two manifest rows drift apart. The real file alone clears both.
        self.assertIsNotNone(
            dc.match_sensitive_path_for_sync(_CHARTER_LINK),
            msg="the symlink row must stay refused — a byte-swap would delete the link",
        )
        self.assertIsNotNone(sp.is_sensitive_path_for_sync(_CHARTER_LINK))

    def test_retained_entry_refuses_on_every_matcher(self) -> None:
        for matcher in (
            dc.match_sensitive_path,
            dc.match_sensitive_path_for_sync,
            sp.is_sensitive_path,
            sp.is_sensitive_path_for_sync,
        ):
            self.assertIsNotNone(
                matcher(_RETAINED_SENSITIVE),
                msg=f"{matcher.__name__} must still refuse {_RETAINED_SENSITIVE!r}",
            )

    def test_exemption_set_is_exact_relpaths_not_patterns(self) -> None:
        # An exact set cannot over-match the way the tuple's own `core-security.md`
        # pattern does; a regex or a glob character here would reopen that class.
        for entry in dc._SYNC_EXEMPT_RELPATHS:
            self.assertNotIn("*", entry)
            self.assertFalse(entry.startswith("/"))
            self.assertEqual(entry, entry.strip())
        self.assertEqual(dc._SYNC_EXEMPT_RELPATHS, frozenset({_CHARTER_REAL}))


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class CharterStaysSafetySensitive(unittest.TestCase):
    """The two consumers the carve-out is most likely to weaken by accident. Both
    reach the bare matcher without traversing the bridge, and both must keep
    refusing the charter."""

    def test_classify_safety_tier_still_returns_safety_for_the_charter(self) -> None:
        patch = dc.PatchProposal(
            target_file=_CHARTER_REAL,
            rationale="probe",
            proposed_diff="+ a benign documentation line\n",
            touched_frontmatter=False,
            estimated_added_lines=1,
            raw_response="",
        )
        self.assertEqual(dc.classify_safety_tier(patch), "safety")

    def test_build_merge_candidate_still_refuses_the_charter(self) -> None:
        sys.path.insert(0, str(_LIB_DIR))
        import editable_merge as em  # noqa: PLC0415 — deferred, mirrors the module's own seam

        cand = em.build_merge_candidate(
            _CHARTER_REAL, "old\n", "new\n", base_text=None, skip_pre_verify=True
        )
        self.assertIsNotNone(
            cand.sensitive_hit,
            msg="the agent-body merge must keep refusing the charter",
        )


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class SyncCliExitContract(unittest.TestCase):
    """`path-sync` is the mode the updater's changed-file partition shells out to."""

    def _run(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(_HELPER), *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_path_sync_clears_the_charter_silently(self) -> None:
        res = self._run(["path-sync", _CHARTER_REAL])
        self.assertEqual(res.returncode, sp.EXIT_CLEAN)
        self.assertEqual(res.stderr, "")

    def test_path_sync_still_refuses_the_symlink_row_and_a_retained_entry(self) -> None:
        for path in (_CHARTER_LINK, _RETAINED_SENSITIVE):
            res = self._run(["path-sync", path])
            self.assertEqual(res.returncode, sp.EXIT_SENSITIVE, msg=f"for {path!r}")
            self.assertIn("REFUSED", res.stderr)

    def test_strict_path_mode_is_unchanged_for_the_charter(self) -> None:
        res = self._run(["path", _CHARTER_REAL])
        self.assertEqual(res.returncode, sp.EXIT_SENSITIVE)
        self.assertIn("REFUSED", res.stderr)


# The rule-file rows the path tuple guards, each spelled with the pattern source
# it must return — a source, never a count, so a widening cannot pass by
# refusing more rows than it claims.
_CORE_SECURITY_ROW = "rules/glass-atrium/core-security.md"
_CORE_SECURITY_SOURCE = r"(^|/)core-security\.md$"
_TRIGGER_LIST_ROW = "rules/glass-atrium/core-learning-log.md"
_TRIGGER_LIST_SOURCE = r"(^|/)core-learning-log\.md$"

# Every manifest row the strict matcher refuses. Pinning the whole set is what
# bounds a path-pattern edit's blast radius: a widening that reaches an
# unintended row fails here rather than at the next release.
_REFUSED_MANIFEST_ROWS: frozenset[str] = frozenset(
    {
        "agents/GLASS_ATRIUM_GLOBAL_RULES.md",
        "rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md",
        "monitor/.env.example",
        "scoped/scope-security.md",
        _CORE_SECURITY_ROW,
        _TRIGGER_LIST_ROW,
    }
)


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class RuleFileRowsAreGuarded(unittest.TestCase):
    """The Tier-2 clause list names the security rules and its own definition
    file; the tuple must actually reach both, and reach nothing adjacent."""

    def test_core_security_row_returns_its_pattern_source(self) -> None:
        self.assertEqual(
            dc.match_sensitive_path(_CORE_SECURITY_ROW), _CORE_SECURITY_SOURCE
        )

    def test_trigger_list_row_returns_its_pattern_source(self) -> None:
        self.assertEqual(
            dc.match_sensitive_path(_TRIGGER_LIST_ROW), _TRIGGER_LIST_SOURCE
        )

    def test_retired_phantom_and_suffix_near_misses_stay_clean(self) -> None:
        for path in (
            "rules/security.md",
            "rules/security-notes.md",
            "rules/glass-atrium/core-learning-log-notes.md",
            "hooks/learning-aggregator.py",
        ):
            self.assertIsNone(
                dc.match_sensitive_path(path), msg=f"unexpected refusal for {path!r}"
            )

    def test_live_neighbors_stay_refused(self) -> None:
        # Refusal, not source equality — the charter literal is owned by a
        # separate replaceability track, so pinning it here would fail this
        # suite for a reason unrelated to the rule-file rows.
        for path in (_CHARTER_REAL, _CHARTER_LINK, _RETAINED_SENSITIVE):
            self.assertIsNotNone(
                dc.match_sensitive_path(path), msg=f"expected refusal for {path!r}"
            )

    def test_refused_manifest_rows_are_exactly_the_named_set(self) -> None:
        manifest = _REPO_ROOT / "manifest.json"
        if not manifest.exists():
            self.skipTest("manifest.json absent — release manifest not in this tree")
        rows = json.loads(manifest.read_text(encoding="utf-8"))["files"]
        refused = {row for row in rows if dc.match_sensitive_path(row) is not None}
        self.assertEqual(refused, set(_REFUSED_MANIFEST_ROWS))


if __name__ == "__main__":
    unittest.main()
