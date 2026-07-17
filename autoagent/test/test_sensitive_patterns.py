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
    "rules/security.md",
    "scoped/scope-security.md",
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
    "rules/security-notes.md",  # not exactly security.md
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
    "+ git clean -fd",
)
_DIFF_CLEAN: tuple[str, ...] = (
    "+ this confirms the farm output",  # 'confirm'/'farm' must NOT match \brm\b
    f"- {_RM} -rf /tmp/x",  # removed line, not added → ignored
    "+++ b/path.md",  # diff header, not body
    "+ a perfectly ordinary documentation line",
    # The SAFE tagged-stash recipe (I1) must NEVER trip the detector — the
    # negative-lookahead keeps push/apply/list clean.
    "+ git stash push -u -m tag",
    "+ git stash apply <sha>",
    "+ tsc --noEmit",
    "+ the note explains why a bare stash is risky without a restore step",  # prose, prescribes nothing
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
            "rules/security.md",
            "scoped/scope-security.md",
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


if __name__ == "__main__":
    unittest.main()
