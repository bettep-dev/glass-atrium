"""Behavioral tests for the shared sensitive-file refusal source.

The refusal set — a sensitive harness file, or a diff carrying an irreversible
command — is the COMPILED regex tuples in ``daemon_cycle.py``, the single source.
``autoagent/lib/sensitive_patterns.py`` reaches that set by IMPORTING those tuples
(no shell-ERE re-implementation) and is the only bridge over them; this suite is
its only consumer.

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
    "rules/security.md",  # the retired phantom — must stay clean
    "rules/security-notes.md",
    # The two rule-file rows the tuple no longer names, plus the neighbours a
    # basename pattern over them used to have to miss.
    "rules/glass-atrium/core-security.md",
    "rules/glass-atrium/core-learning-log.md",
    "rules/glass-atrium/core-learning-log-notes.md",
    "hooks/learning-aggregator.py",
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
    "+ git rebase --onto main feature",  # published-history rewrite
    "+ const out = execSync(cmd);",  # the Sync call form the bare exec row missed
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
    "+ git pull --rebase origin main",  # replays local commits, rewrites no published history
    "+ execFile(bin, args)",  # outside the exec-call claim, pinned below as a limit
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
class DaemonAndHelperRefuseSameSet(unittest.TestCase):
    """The three PATH surfaces refuse the SAME corpus: the helper, the daemon's
    bare match_sensitive_path, and classify_safety_tier under a path-only patch.

    No shell consumer stands behind these: the helper's only caller is this suite,
    as the module header states, so the parity proved here is python-to-python."""

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
            "rules/security.md",
            "rules/glass-atrium/core-security.md",
            "rules/glass-atrium/core-learning-log.md",
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
# classify_safety_tier over an UNCHANGED set. The classes below assert this pair
# per consumer instead.
_CHARTER_REAL = "agents/GLASS_ATRIUM_GLOBAL_RULES.md"
_CHARTER_LINK = "rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md"
_RETAINED_SENSITIVE = "scoped/scope-security.md"


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class CharterRowsRefuseOnEveryMatcher(unittest.TestCase):
    """One matcher now spans every consumer, so the charter pair and the retained
    rule row must refuse on the daemon matcher and on the helper alike."""

    def test_charter_pair_and_retained_row_refuse(self) -> None:
        for path in (_CHARTER_REAL, _CHARTER_LINK, _RETAINED_SENSITIVE):
            self.assertIsNotNone(
                dc.match_sensitive_path(path), msg=f"daemon must refuse {path!r}"
            )
            self.assertIsNotNone(
                sp.is_sensitive_path(path), msg=f"helper must refuse {path!r}"
            )


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class CharterStaysSafetySensitive(unittest.TestCase):
    """The two consumers that reach the matcher through their own call sites.
    Both must keep refusing the charter."""

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
class CliPathModeRefusesTheCharterRows(unittest.TestCase):
    """`path` is the only path mode the CLI offers; a caller reaching for another
    spelling gets a usage error rather than a quieter verdict."""

    def _run(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(_HELPER), *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_path_mode_refuses_both_charter_rows(self) -> None:
        for path in (_CHARTER_REAL, _CHARTER_LINK):
            res = self._run(["path", path])
            self.assertEqual(res.returncode, sp.EXIT_SENSITIVE, msg=f"for {path!r}")
            self.assertIn("REFUSED", res.stderr)

    def test_a_second_path_mode_is_a_usage_error(self) -> None:
        res = self._run(["path-sync", _CHARTER_REAL])
        self.assertEqual(res.returncode, sp.EXIT_USAGE)


# The two rule-file rows the path tuple no longer names. Both live outside the
# agents directory, and both matchers' callers pass an agent body path, so a row
# for either could not have fired.
_CORE_SECURITY_ROW = "rules/glass-atrium/core-security.md"
_TRIGGER_LIST_ROW = "rules/glass-atrium/core-learning-log.md"

# Every manifest row the strict matcher refuses. Pinning the whole set is what
# bounds a path-pattern edit's blast radius: a widening that reaches an
# unintended row fails here rather than at the next release.
_REFUSED_MANIFEST_ROWS: frozenset[str] = frozenset(
    {
        "agents/GLASS_ATRIUM_GLOBAL_RULES.md",
        "rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md",
        "monitor/.env.example",
        "scoped/scope-security.md",
    }
)


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class RuleFileRowsAreOutOfReach(unittest.TestCase):
    """Neither rule file is a path the tuple's callers can present: both matcher
    consumers pass an agents/<name>.md body path. A row for either would read as
    protection the code cannot deliver, so the tuple names neither."""

    def test_rule_file_rows_are_not_refused(self) -> None:
        for path in (_CORE_SECURITY_ROW, _TRIGGER_LIST_ROW):
            self.assertIsNone(
                dc.match_sensitive_path(path), msg=f"unexpected refusal for {path!r}"
            )
            self.assertIsNone(sp.is_sensitive_path(path))

    def test_rule_file_rows_classify_auto_on_the_daemon_path(self) -> None:
        # The tier consumer, driven: a benign-diff patch against either row is
        # auto-eligible, which is what the removed rows would otherwise claim to
        # prevent for a target the daemon never builds.
        for path in (_CORE_SECURITY_ROW, _TRIGGER_LIST_ROW):
            patch = dc.PatchProposal(
                target_file=path,
                rationale="probe",
                proposed_diff="+ a benign documentation line\n",
                touched_frontmatter=False,
                estimated_added_lines=1,
                raw_response="",
            )
            self.assertEqual(dc.classify_safety_tier(patch), "", msg=f"for {path!r}")

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


# The diff patterns the daemon-lifecycle and force-push widenings own, each
# spelled with the source the matcher must return — a source, never a count, so
# a widening that fires through some OTHER entry of the tuple fails here.
_LIFECYCLE_SOURCE = r"\blaunchctl\s+(bootstrap|bootout|kickstart|load|unload)\b"
_FORCE_LONG_SOURCE = r"\bgit\s+push\b.*\s--force\b"
_FORCE_SHORT_SOURCE = r"\bgit\s+push\b.*\s-f\b"


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class LaunchctlLifecycleVerbsAreGuarded(unittest.TestCase):
    """The legacy `load`/`unload` verbs drive the same daemon lifecycle as the
    modern ones and are still functional on macOS, so the pattern must reach
    both spellings — and reach them through the lifecycle entry, not another."""

    def test_legacy_verbs_return_the_lifecycle_source(self) -> None:
        for line in (
            "+ launchctl load ~/Library/LaunchAgents/com.glass-atrium.monitor.plist",
            "+ launchctl unload -w ~/Library/LaunchAgents/com.glass-atrium.monitor.plist",
        ):
            self.assertEqual(
                dc.match_sensitive_diff(line), _LIFECYCLE_SOURCE, msg=f"for {line!r}"
            )

    def test_modern_verbs_keep_firing(self) -> None:
        for line in (
            "+ launchctl bootstrap gui/501 x.plist",
            "+ launchctl bootout gui/501",
            "+ launchctl kickstart -k gui/501/com.glass-atrium.monitor",
        ):
            self.assertEqual(
                dc.match_sensitive_diff(line), _LIFECYCLE_SOURCE, msg=f"for {line!r}"
            )

    def test_legacy_verbs_on_non_added_lines_stay_clean(self) -> None:
        # The added-lines-only mechanic is what keeps a removed hazard from
        # re-routing the proposal that removes it.
        for line in (
            "- launchctl load com.glass-atrium.monitor.plist",
            "  launchctl unload com.glass-atrium.monitor.plist",
        ):
            self.assertIsNone(dc.match_sensitive_diff(line), msg=f"for {line!r}")

    def test_lifecycle_lookalikes_stay_clean(self) -> None:
        for line in (
            "+ launchctl list",
            "+ launchctl print gui/501",
            "+ the loader downloads the payload",
        ):
            self.assertIsNone(dc.match_sensitive_diff(line), msg=f"for {line!r}")


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class ForcePushFlagPositionsAreGuarded(unittest.TestCase):
    """The flag usually trails the refspec in real usage. Each form asserts the
    per-flag source, so the pair's WARN attribution survives the widening."""

    def test_flag_after_refspec_returns_the_matching_flag_source(self) -> None:
        for line, source in (
            ("+ git push origin main --force", _FORCE_LONG_SOURCE),
            ("+ git push origin main --force-with-lease", _FORCE_LONG_SOURCE),
            ("+ git push origin -f", _FORCE_SHORT_SOURCE),
        ):
            self.assertEqual(dc.match_sensitive_diff(line), source, msg=f"for {line!r}")

    def test_flag_adjacent_forms_keep_their_attribution(self) -> None:
        for line, source in (
            ("+ git push --force origin main", _FORCE_LONG_SOURCE),
            ("+ git push --force-with-lease", _FORCE_LONG_SOURCE),
            ("+ git push -f origin main", _FORCE_SHORT_SOURCE),
        ):
            self.assertEqual(dc.match_sensitive_diff(line), source, msg=f"for {line!r}")

    def test_ordinary_push_forms_stay_clean(self) -> None:
        for line in (
            "+ git push origin main",
            "+ git push --follow-tags",
        ):
            self.assertIsNone(dc.match_sensitive_diff(line), msg=f"for {line!r}")

    def test_bundled_short_flag_cluster_is_the_accepted_gap(self) -> None:
        # Named as a limit, not a claim: `\s-f\b` wants the force flag standing
        # alone after whitespace, and a cluster denies it from either side — a
        # letter after `f` fails the trailing `\b`, a letter before it fails the
        # literal `-f`. Pinned so the gap is a decision on record.
        for line in (
            "+ git push origin main -fq",
            "+ git push origin main -qf",
            "+ git push origin main -fu",
            "+ git push origin main -xf",
        ):
            self.assertIsNone(dc.match_sensitive_diff(line), msg=f"for {line!r}")


_REBASE_SOURCE = r"\bgit\s+rebase\b"


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class PublishedHistoryRewriteIsGuarded(unittest.TestCase):
    """The Tier-2 clause names a rebase of a published branch, so the plain
    spelling must route to safety through THIS entry. Publishedness is not
    regex-decidable, so the row escalates every branch — the over-escalation
    forms below are pinned as chosen behaviour, not as an unnoticed spill."""

    def test_plain_forms_return_the_rebase_source(self) -> None:
        for line in (
            "+ git rebase main",
            "+ git rebase -i HEAD~3",
            "+ git rebase --onto main feature",
        ):
            self.assertEqual(
                dc.match_sensitive_diff(line), _REBASE_SOURCE, msg=f"for {line!r}"
            )

    def test_recovery_subcommands_are_deliberate_over_escalation(self) -> None:
        # These ABORT or resume a rewrite rather than starting one, and they
        # still escalate. Fail-closed in direction, so pinned as the chosen
        # cost of a row that cannot read intent off the flag.
        for line in (
            "+ git rebase --abort",
            "+ git rebase --continue",
            "+ git rebase --skip",
        ):
            self.assertEqual(
                dc.match_sensitive_diff(line), _REBASE_SOURCE, msg=f"for {line!r}"
            )

    def test_hyphen_suffixed_tokens_are_deliberate_over_escalation(self) -> None:
        # A hyphen satisfies the trailing `\b`, so a non-command token fires.
        for line in (
            "+ git rebase-todo",
            "+ git rebase-merge state dir",
        ):
            self.assertEqual(
                dc.match_sensitive_diff(line), _REBASE_SOURCE, msg=f"for {line!r}"
            )

    def test_split_pair_spellings_are_the_accepted_gap(self) -> None:
        # `\s+` demands adjacency, so anything between the two words denies the
        # match. Named as a family-wide limit, not a claim.
        for line in (
            "+ git -c pull.rebase=true rebase main",
            "+ git -C /tmp/repo rebase main",
            "+ git rb main",
        ):
            self.assertIsNone(dc.match_sensitive_diff(line), msg=f"for {line!r}")

    def test_non_rewriting_and_prose_forms_stay_clean(self) -> None:
        for line in (
            "+ git pull --rebase origin main",
            "+ git pull --rebase=merges",
            "+ git config pull.rebase true",
            "+ rebase the feature branch onto main",
            "+ npm run rebase",
            "- git rebase main",  # removed line — the added-lines-only mechanic
        ):
            self.assertIsNone(dc.match_sensitive_diff(line), msg=f"for {line!r}")

    def test_row_source_and_descriptive_idiom_do_not_self_fire(self) -> None:
        # A comment or a rule sentence documenting this row must stay clean, or
        # documenting the hazard becomes a fire of the hazard.
        for line in (
            "+ " + _REBASE_SOURCE,
            "+ a git-rebase of a published branch is a Tier-2 trigger",
        ):
            self.assertIsNone(dc.match_sensitive_diff(line), msg=f"for {line!r}")

    def test_clause_line_keeps_its_pre_existing_force_attribution(self) -> None:
        # The clause spells the rewrite with no `git ` prefix, so this row adds
        # no fire on it; the line's fire is the force row's, and predates it.
        self.assertEqual(
            dc.match_sensitive_diff("+   - git push --force / rebase published branch"),
            _FORCE_LONG_SOURCE,
        )


_EXEC_SOURCE = r"\bexec(?:Sync)?\s*\("
_EVAL_SOURCE = r"\beval\s*\("


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class DynamicExecutionCallFormsAreGuarded(unittest.TestCase):
    """The `Sync` variant is the form a body recipe actually spells, and the
    bare row missed it. The eval neighbour must keep its own attribution, so a
    widening here cannot quietly swallow the row beside it."""

    def test_sync_and_bare_call_forms_return_the_exec_source(self) -> None:
        for line in (
            "+ const out = execSync(cmd);",
            "+ const out = execSync (cmd);",
            "+ exec(cmd, cb)",
            "+ exec (cmd, cb)",
            "+ child_process.execSync(cmd)",
        ):
            self.assertEqual(
                dc.match_sensitive_diff(line), _EXEC_SOURCE, msg=f"for {line!r}"
            )

    def test_eval_neighbor_keeps_its_own_source(self) -> None:
        for line in ("+ eval(src)", "+ eval (src)"):
            self.assertEqual(
                dc.match_sensitive_diff(line), _EVAL_SOURCE, msg=f"for {line!r}"
            )

    def test_file_execution_family_is_the_accepted_gap(self) -> None:
        # `execFile`/`execFileSync` take an argv array rather than a shell
        # string, and no row reaches them. Named as a limit, not a claim.
        for line in (
            "+ execFile(bin, args)",
            "+ execFileSync(bin, args)",
            "+ spawnSync(bin, args)",
        ):
            self.assertIsNone(dc.match_sensitive_diff(line), msg=f"for {line!r}")

    def test_word_boundary_lookalikes_stay_clean(self) -> None:
        for line in (
            "+ execute(plan)",
            "+ codeexec(cmd)",
            "+ the runner executes the plan",
        ):
            self.assertIsNone(dc.match_sensitive_diff(line), msg=f"for {line!r}")


_RM_CLUSTER_SOURCE = r"\b" + _RM + r"\s+-[rRfF]+\b"


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class RmFlagClusterFormsAreGuarded(unittest.TestCase):
    """The deletion entry fires on a short-flag cluster of only r/R/f/F letters.
    The flagless form, a cluster carrying any other letter, and the
    `farm`/`confirm` word-boundary negatives all stay clean — that is what keeps
    the safety queue from flooding on ordinary prose."""

    def test_flag_clusters_return_the_deletion_source(self) -> None:
        for line in (
            "+ " + _RM + " -rf build/",
            "+ " + _RM + " -f x",
            "+ " + _RM + " -r dir",
            "+ " + _RM + " -fr build/",
        ):
            self.assertEqual(
                dc.match_sensitive_diff(line), _RM_CLUSTER_SOURCE, msg=f"for {line!r}"
            )

    def test_mixed_flag_cluster_is_the_accepted_gap(self) -> None:
        # Named as a limit, not a claim: `-[rRfF]+\b` wants the cluster to end
        # at a word boundary, so a letter outside r/R/f/F anywhere in the same
        # cluster denies the match from either side. Pinned so the gap is a
        # decision on record.
        for line in (
            "+ " + _RM + " -rfv /tmp/x",
            "+ " + _RM + " -fq x",
            "+ " + _RM + " -vrf /tmp/x",
        ):
            self.assertIsNone(dc.match_sensitive_diff(line), msg=f"for {line!r}")

    def test_flagless_and_word_boundary_lookalikes_stay_clean(self) -> None:
        for line in (
            "+ " + _RM + " file.txt",
            "+ the farm was rebuilt",
            "+ please confirm the layout",
        ):
            self.assertIsNone(dc.match_sensitive_diff(line), msg=f"for {line!r}")


_GA_PLIST_SOURCE = r"(^|/)com\.glass-atrium\.[^/]+\.plist$"
_LEGACY_PLIST_SOURCE = r"(^|/)com\.claude\.[^/]+\.plist$"
# The label set the Tier-2 plist clause names by hand — each one must be a form
# the tuple demonstrably matches, or the clause claims a control that is not there.
_CLAUSE_PLIST_LABELS: tuple[str, ...] = (
    "monitor",
    "autoagent-daemon",
    "daemon-daily-restart",
)


@unittest.skipIf(_IMPORT_ERROR is not None, f"import failed: {_IMPORT_ERROR}")
class PlistLabelFamiliesAreGuarded(unittest.TestCase):
    """Both label families the clause names stay matched, in bare-basename and
    absolute form; a plist under any other prefix stays clean, which is the
    other half of what the clause asserts."""

    def test_clause_named_labels_match_in_both_path_forms(self) -> None:
        for label in _CLAUSE_PLIST_LABELS:
            name = f"com.glass-atrium.{label}.plist"
            for path in (name, f"/Users/x/Library/LaunchAgents/{name}"):
                self.assertEqual(
                    dc.match_sensitive_path(path), _GA_PLIST_SOURCE, msg=f"for {path!r}"
                )

    def test_retained_legacy_family_still_matches(self) -> None:
        for path in (
            "com.claude.monitor.plist",
            "/Users/x/Library/LaunchAgents/com.claude.autoagent-daemon.plist",
        ):
            self.assertEqual(
                dc.match_sensitive_path(path), _LEGACY_PLIST_SOURCE, msg=f"for {path!r}"
            )

    def test_other_label_prefixes_stay_clean(self) -> None:
        for path in (
            "com.apple.something.plist",
            "homebrew.mxcl.postgresql@18.plist",
            "com.glass-atrium.monitor.plist.bak",
        ):
            self.assertIsNone(dc.match_sensitive_path(path), msg=f"for {path!r}")


if __name__ == "__main__":
    unittest.main()
