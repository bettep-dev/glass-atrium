"""Behavioral tests for the base-aware three-way roster merge module (D3 / M).

Covered behaviors:
  * the shared contract, driven across all three shapes -> a live-only member
    survives; a base-carried, release-dropped member is absent with the local
    file unchanged; a member outside the closed vocabulary refuses loudly;
    content outside the slots is the release's bytes; the release's ordering
    leads and live-only members follow;
  * registry adapter -> a user-created key survives with its row unchanged; the
    top-level schema keys are the release's; a release-side domain removal is
    honoured while a live-added token survives; both sides appending resolve to
    a superset with no duplicate; the artifact parses as JSON;
  * markdown and shell adapters -> the release's ordering and surrounding text
    survive; a dropped name is gone; a governance array gains no name absent
    from both sides; each rewritten array declares its name exactly once on one
    physical line;
  * the two-run bootstrap -> an empty store seeds from the release, keeps the
    live-only member, emits a loud row and leaves a real base entry, and the
    same fixture run again honours a release-side removal;
  * the base entry's key -> the manifest-relative path under the sibling root;
  * the thin CLI -> a written candidate and a named vocabulary refusal.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_roster_merge.py -v
    python3 -m unittest autoagent.test.test_roster_merge -v
"""

from __future__ import annotations

import contextlib
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_LIB_DIR = _AUTOAGENT_DIR / "lib"

for _p in (_AUTOAGENT_DIR, _LIB_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

try:
    import roster_merge as rm

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — import failure -> skip, not error
    rm = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


# -- fixture builders, one per shape -------------------------------------------


_MD_HEAD = "# Scope rules\n\n"
_MD_TAIL = "\nEverything below is vendor prose.\n"
_SH_HEAD = "#!/usr/bin/env bash\nreadonly _ROSTER_LOADED=1\n"
_SH_TAIL = "\n# trailing vendor prose\n"


def _registry_text(agents: dict[str, object], version: str = "1.0.0") -> str:
    doc = {
        "$schema": "./schema.json",
        "version": version,
        "phases": ["implementation"],
        "agents": agents,
    }
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def _registry_of(names: list[str]) -> str:
    return _registry_text({name: {"phase": "implementation"} for name in names})


def _registry_names(text: str) -> list[str]:
    return list(json.loads(text)["agents"])


def _registry_strip(text: str) -> str:
    doc = json.loads(text)
    doc["agents"] = {}
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def _markdown_of(names: list[str]) -> str:
    line = "> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {"
    return _MD_HEAD + line + ", ".join(names) + "}\n" + _MD_TAIL


def _markdown_names(text: str) -> list[str]:
    body = re.search(r"∈ \{([^}]*)\}", text).group(1)
    return [name.strip() for name in body.split(",") if name.strip()]


def _markdown_strip(text: str) -> str:
    return re.sub(r"∈ \{[^}]*\}", "∈ {}", text)


def _shell_of(names: list[str], array: str = "STYLEREF_AGENTS") -> str:
    return _SH_HEAD + f'readonly {array}=" ' + " ".join(names) + ' "\n' + _SH_TAIL


def _shell_names(text: str, array: str = "STYLEREF_AGENTS") -> list[str]:
    return re.search(rf'^readonly {array}="(.*)"$', text, re.M).group(1).split()


def _shell_strip(text: str) -> str:
    return re.sub(r'^(readonly [A-Z_]+=")[^"\n]*(")$', r"\1\2", text, flags=re.M)


# path, builder, member reader, slot stripper
_SHAPES = (
    ("agent-registry.json", _registry_of, _registry_names, _registry_strip),
    ("scoped/scope-dev.md", _markdown_of, _markdown_names, _markdown_strip),
    ("hooks/lib/styleref-roster.sh", _shell_of, _shell_names, _shell_strip),
)

_VENDOR = ["glass-atrium-dev-node", "glass-atrium-dev-python"]
_LIVE_ONLY = "glass-atrium-dev-mine"


@unittest.skipIf(rm is None, f"roster_merge import failed: {_IMPORT_ERROR}")
class RosterContractTest(unittest.TestCase):
    """The one contract, driven across every shape."""

    def _build(self, path, base, live, release, names=None):
        return rm.build_roster_candidate(
            path,
            live,
            release,
            names if names is not None else [*_VENDOR, _LIVE_ONLY],
            base_text=base,
        )

    def test_live_only_member_survives_in_every_shape(self):
        for path, build, read, _ in _SHAPES:
            with self.subTest(path=path):
                got = self._build(
                    path,
                    build(_VENDOR),
                    build([*_VENDOR, _LIVE_ONLY]),
                    build(_VENDOR),
                )
                self.assertIn(_LIVE_ONLY, read(got.text))

    def test_base_carried_release_dropped_member_is_absent_in_every_shape(self):
        dropped = _VENDOR[1]
        for path, build, read, _ in _SHAPES:
            with self.subTest(path=path):
                got = self._build(
                    path,
                    build(_VENDOR),
                    build(_VENDOR),
                    build([_VENDOR[0]]),
                )
                self.assertNotIn(dropped, read(got.text))
                self.assertIn(_VENDOR[0], read(got.text))

    def test_member_outside_the_closed_vocabulary_refuses_loudly(self):
        for path, build, _, _ in _SHAPES:
            with self.subTest(path=path):
                with self.assertRaises(rm.VocabularyError) as caught:
                    self._build(
                        path,
                        build(_VENDOR),
                        build([*_VENDOR, "glass-atrium-dev-typo"]),
                        build(_VENDOR),
                        names=_VENDOR,
                    )
                self.assertIn("glass-atrium-dev-typo", str(caught.exception))

    def test_content_outside_the_slots_is_the_release_bytes(self):
        for path, build, _, strip in _SHAPES:
            with self.subTest(path=path):
                release = build(_VENDOR)
                got = self._build(
                    path, build(_VENDOR), build([*_VENDOR, _LIVE_ONLY]), release
                )
                self.assertEqual(strip(got.text), strip(release))

    def test_an_undiverged_merge_reproduces_the_release_byte_for_byte(self):
        for path, build, _, _ in _SHAPES:
            with self.subTest(path=path):
                release = build(_VENDOR)
                got = self._build(path, release, release, release)
                self.assertEqual(got.text, release)

    def test_release_ordering_leads_and_live_only_members_follow(self):
        for path, build, read, _ in _SHAPES:
            with self.subTest(path=path):
                got = self._build(
                    path,
                    build(_VENDOR),
                    build([_LIVE_ONLY, *_VENDOR]),
                    build(_VENDOR),
                )
                self.assertEqual(read(got.text), [*_VENDOR, _LIVE_ONLY])


@unittest.skipIf(rm is None, f"roster_merge import failed: {_IMPORT_ERROR}")
class RegistryAdapterTest(unittest.TestCase):
    """C3's probes — no per-field policy is authored anywhere (OD-2)."""

    PATH = "agent-registry.json"

    def _build(self, base, live, release, names=None):
        return rm.build_roster_candidate(
            self.PATH,
            live,
            release,
            names if names is not None else [*_VENDOR, _LIVE_ONLY],
            base_text=base,
        )

    def _agents(self, text):
        return json.loads(text)["agents"]

    def test_user_created_key_absent_from_the_release_survives_with_its_row_unchanged(
        self,
    ):
        row = {"phase": "implementation", "domains": ["mine"], "tools": ["Read"]}
        live = _registry_text(
            {_VENDOR[0]: {"phase": "implementation"}, _LIVE_ONLY: row}
        )
        got = self._build(_registry_of([_VENDOR[0]]), live, _registry_of([_VENDOR[0]]))
        self.assertEqual(self._agents(got.text)[_LIVE_ONLY], row)

    def test_top_level_schema_keys_match_the_release(self):
        release = _registry_text(
            {_VENDOR[0]: {"phase": "implementation"}}, version="9.9.9"
        )
        got = self._build(_registry_of(_VENDOR), _registry_of(_VENDOR), release)
        merged = json.loads(got.text)
        expected = json.loads(release)
        for key in ("$schema", "version", "phases"):
            self.assertEqual(merged[key], expected[key])

    def test_a_release_side_domain_removal_is_honoured_while_a_live_token_survives(
        self,
    ):
        name = _VENDOR[0]
        base = _registry_text({name: {"domains": ["kept", "vendor-drops"]}})
        live = _registry_text({name: {"domains": ["kept", "vendor-drops", "live-add"]}})
        release = _registry_text({name: {"domains": ["kept"]}})
        got = self._build(base, live, release)
        domains = self._agents(got.text)[name]["domains"]
        self.assertNotIn("vendor-drops", domains)
        self.assertIn("live-add", domains)
        self.assertIn("kept", domains)

    def test_both_sides_appending_resolves_to_a_superset_without_duplicates(self):
        name = _VENDOR[0]
        base = _registry_text({name: {"domains": ["shared"]}})
        live = _registry_text({name: {"domains": ["shared", "live-add"]}})
        release = _registry_text({name: {"domains": ["shared", "vendor-add"]}})
        domains = self._agents(self._build(base, live, release).text)[name]["domains"]
        self.assertEqual(sorted(domains), ["live-add", "shared", "vendor-add"])
        self.assertEqual(len(domains), len(set(domains)))

    def test_a_release_modified_row_carries_the_release_version(self):
        name = _VENDOR[0]
        base = _registry_text({name: {"phase": "implementation"}})
        release = _registry_text({name: {"phase": "review"}})
        got = self._build(base, base, release)
        self.assertEqual(self._agents(got.text)[name]["phase"], "review")

    def test_the_merged_artifact_parses_as_json(self):
        got = self._build(
            _registry_of(_VENDOR),
            _registry_of([*_VENDOR, _LIVE_ONLY]),
            _registry_of(_VENDOR),
        )
        self.assertIsInstance(json.loads(got.text), dict)


@unittest.skipIf(rm is None, f"roster_merge import failed: {_IMPORT_ERROR}")
class MarkdownAndShellAdapterTest(unittest.TestCase):
    """C4's probes — the brace list and the space-padded arrays."""

    def test_a_live_only_name_survives_with_the_release_ordering_and_prose(self):
        release = _markdown_of(_VENDOR)
        got = rm.build_roster_candidate(
            "scoped/scope-dev.md",
            _markdown_of([_LIVE_ONLY, *_VENDOR]),
            release,
            [*_VENDOR, _LIVE_ONLY],
            base_text=_markdown_of(_VENDOR),
        )
        self.assertEqual(_markdown_names(got.text), [*_VENDOR, _LIVE_ONLY])
        self.assertTrue(got.text.startswith(_MD_HEAD))
        self.assertTrue(got.text.endswith(_MD_TAIL))

    def test_a_base_carried_release_dropped_name_is_gone_from_the_array(self):
        got = rm.build_roster_candidate(
            "hooks/lib/styleref-roster.sh",
            _shell_of(_VENDOR),
            _shell_of([_VENDOR[0]]),
            _VENDOR,
            base_text=_shell_of(_VENDOR),
        )
        self.assertEqual(_shell_names(got.text), [_VENDOR[0]])

    def test_a_governance_array_gains_no_name_absent_from_both_sides(self):
        base = _shell_of(_VENDOR, array="BUDGET_ANALYSIS_AGENTS")
        live = _shell_of([*_VENDOR, _LIVE_ONLY], array="BUDGET_ANALYSIS_AGENTS")
        release = _shell_of([_VENDOR[0]], array="BUDGET_ANALYSIS_AGENTS")
        got = rm.build_roster_candidate(
            "hooks/inject-scope-rules.sh",
            live,
            release,
            [*_VENDOR, _LIVE_ONLY],
            base_text=base,
        )
        resolved = set(_shell_names(got.text, array="BUDGET_ANALYSIS_AGENTS"))
        offered = set(_shell_names(live, array="BUDGET_ANALYSIS_AGENTS")) | set(
            _shell_names(release, array="BUDGET_ANALYSIS_AGENTS")
        )
        self.assertTrue(resolved.issubset(offered))

    def test_every_array_of_a_multi_array_file_resolves_independently(self):
        def build(first, second):
            return (
                _SH_HEAD
                + f'readonly NAMING_AGENTS=" {" ".join(first)} "\n'
                + f'readonly BUDGET_DEV_AGENTS=" {" ".join(second)} "\n'
                + _SH_TAIL
            )

        got = rm.build_roster_candidate(
            "hooks/inject-scope-rules.sh",
            build([*_VENDOR, _LIVE_ONLY], _VENDOR),
            build(_VENDOR, [_VENDOR[0]]),
            [*_VENDOR, _LIVE_ONLY],
            base_text=build(_VENDOR, _VENDOR),
        )
        self.assertEqual(
            _shell_names(got.text, array="NAMING_AGENTS"), [*_VENDOR, _LIVE_ONLY]
        )
        self.assertEqual(
            _shell_names(got.text, array="BUDGET_DEV_AGENTS"), [_VENDOR[0]]
        )

    def test_each_rewritten_array_declares_its_name_exactly_once_on_one_line(self):
        got = rm.build_roster_candidate(
            "hooks/lib/styleref-roster.sh",
            _shell_of([*_VENDOR, _LIVE_ONLY]),
            _shell_of(_VENDOR),
            [*_VENDOR, _LIVE_ONLY],
            base_text=_shell_of(_VENDOR),
        )
        declarations = re.findall(
            r"^readonly STYLEREF_AGENTS=", got.text, flags=re.M
        )
        self.assertEqual(len(declarations), 1)
        line = next(
            ln for ln in got.text.splitlines() if ln.startswith("readonly STYLEREF")
        )
        self.assertIn(_LIVE_ONLY, line)
        self.assertTrue(line.endswith('"'))

    def test_a_second_brace_list_refuses_rather_than_guessing_the_slot(self):
        doubled = _markdown_of(_VENDOR) + "also agent_scope ∈ {x}\n"
        with self.assertRaises(rm.ShapeError):
            rm.build_roster_candidate(
                "scoped/scope-dev.md", doubled, doubled, _VENDOR, base_text=doubled
            )


@unittest.skipIf(rm is None, f"roster_merge import failed: {_IMPORT_ERROR}")
class BootstrapTest(unittest.TestCase):
    """The two-run fixture: seed on first sight, honour a removal on the next."""

    PATH = "hooks/lib/styleref-roster.sh"

    def test_an_empty_store_seeds_then_the_same_fixture_honours_a_removal(self):
        with tempfile.TemporaryDirectory() as tmp:
            live = _shell_of([*_VENDOR, _LIVE_ONLY])
            release_one = _shell_of(_VENDOR)
            names = [*_VENDOR, _LIVE_ONLY]

            first = rm.build_roster_candidate(
                self.PATH, live, release_one, names, state_dir=tmp
            )
            self.assertTrue(first.bootstrapped)
            self.assertTrue(any(self.PATH in row for row in first.notices))
            self.assertIn(_LIVE_ONLY, _shell_names(first.text))

            entry = rm.roster_base_store_dir(tmp) / self.PATH
            self.assertTrue(entry.is_file())
            self.assertEqual(entry.read_text(encoding="utf-8"), release_one)

            release_two = _shell_of([_VENDOR[0]])
            second = rm.build_roster_candidate(
                self.PATH, first.text, release_two, names, state_dir=tmp
            )
            self.assertFalse(second.bootstrapped)
            self.assertEqual(second.notices, ())
            self.assertNotIn(_VENDOR[1], _shell_names(second.text))
            self.assertIn(_LIVE_ONLY, _shell_names(second.text))

    def test_the_seeding_run_cannot_honour_a_release_side_removal(self):
        with tempfile.TemporaryDirectory() as tmp:
            live = _shell_of(_VENDOR)
            release = _shell_of([_VENDOR[0]])
            got = rm.build_roster_candidate(
                self.PATH, live, release, _VENDOR, state_dir=tmp
            )
            self.assertTrue(got.bootstrapped)
            self.assertIn(_VENDOR[1], _shell_names(got.text))


@unittest.skipIf(rm is None, f"roster_merge import failed: {_IMPORT_ERROR}")
class BaseStoreTest(unittest.TestCase):
    """The reader-side key: the manifest-relative path under the sibling root."""

    def test_the_entry_key_mirrors_the_manifest_relative_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            written = rm.set_roster_base_text("hooks/lib/x.sh", "body\n", tmp)
            self.assertEqual(written, Path(tmp) / "base-roster" / "hooks/lib/x.sh")
            self.assertEqual(rm.load_roster_base_text("hooks/lib/x.sh", tmp), "body\n")

    def test_an_absent_entry_reads_as_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(rm.load_roster_base_text("agent-registry.json", tmp))

    def test_an_unknown_suffix_refuses_rather_than_guessing_a_shape(self):
        with self.assertRaises(rm.ShapeError):
            rm.get_shape("hooks/whatever.conf")


@unittest.skipIf(rm is None, f"roster_merge import failed: {_IMPORT_ERROR}")
class CliTest(unittest.TestCase):
    """The invocation seam the dispatch will drive."""

    def _run(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = rm.main(argv)
        return code, out.getvalue(), err.getvalue()

    def _plan(self, tmp, live_names, release_names, agent_names):
        root = Path(tmp)
        (root / "agents").mkdir()
        for name in agent_names:
            (root / "agents" / f"{name}.md").write_text("body\n", encoding="utf-8")
        (root / "live.sh").write_text(_shell_of(live_names), encoding="utf-8")
        (root / "release.sh").write_text(_shell_of(release_names), encoding="utf-8")
        (root / "base.sh").write_text(_shell_of(_VENDOR), encoding="utf-8")
        return self._run(
            [
                "plan",
                "--target",
                "hooks/lib/styleref-roster.sh",
                "--local",
                str(root / "live.sh"),
                "--release",
                str(root / "release.sh"),
                "--base",
                str(root / "base.sh"),
                "--out",
                str(root / "candidate.sh"),
                "--agents-dir",
                str(root / "agents"),
                "--state-dir",
                str(root / "state"),
            ]
        )

    def test_plan_writes_the_candidate_and_reports_its_verdict(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out, _ = self._plan(
                tmp, [*_VENDOR, _LIVE_ONLY], _VENDOR, [*_VENDOR, _LIVE_ONLY]
            )
            self.assertEqual(code, rm.EXIT_OK)
            self.assertIn("verdict=ok", out)
            written = (Path(tmp) / "candidate.sh").read_text(encoding="utf-8")
            self.assertIn(_LIVE_ONLY, _shell_names(written))

    def test_plan_refuses_an_out_of_vocabulary_member_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, _, err = self._plan(tmp, [*_VENDOR, _LIVE_ONLY], _VENDOR, _VENDOR)
            self.assertEqual(code, rm.EXIT_VOCABULARY)
            self.assertIn(_LIVE_ONLY, err)
            self.assertFalse((Path(tmp) / "candidate.sh").exists())


@unittest.skipIf(rm is None, f"roster_merge import failed: {_IMPORT_ERROR}")
class WithholdTest(unittest.TestCase):
    """The backstop's reduction, driven across every shape."""

    _FAILED = "glass-atrium-dev-node"

    def test_the_withheld_name_leaves_the_slot_in_every_shape(self):
        for path, build, names_of, _strip in _SHAPES:
            with self.subTest(path=path):
                candidate = build([*_VENDOR, _LIVE_ONLY])
                text, removed = rm.withhold_members(path, candidate, [self._FAILED])
                self.assertEqual(removed, (self._FAILED,))
                self.assertNotIn(self._FAILED, names_of(text))

    def test_the_members_it_was_not_asked_about_stay(self):
        for path, build, names_of, _strip in _SHAPES:
            with self.subTest(path=path):
                candidate = build([*_VENDOR, _LIVE_ONLY])
                text, _ = rm.withhold_members(path, candidate, [self._FAILED])
                kept = [name for name in [*_VENDOR, _LIVE_ONLY] if name != self._FAILED]
                self.assertEqual(names_of(text), kept)

    def test_content_outside_the_slots_is_untouched(self):
        for path, build, _names, strip in _SHAPES:
            with self.subTest(path=path):
                candidate = build([*_VENDOR, _LIVE_ONLY])
                text, _ = rm.withhold_members(path, candidate, [self._FAILED])
                self.assertEqual(strip(text), strip(candidate))

    def test_a_name_no_slot_carries_reduces_nothing(self):
        for path, build, _names, _strip in _SHAPES:
            with self.subTest(path=path):
                candidate = build([*_VENDOR, _LIVE_ONLY])
                text, removed = rm.withhold_members(path, candidate, ["never-shipped"])
                self.assertEqual(removed, ())
                self.assertEqual(text, candidate)

    def test_every_array_of_a_multi_array_file_loses_the_name(self):
        candidate = (
            _SH_HEAD
            + 'readonly INJECT_AGENTS=" ' + " ".join([*_VENDOR, _LIVE_ONLY]) + ' "\n'
            + 'readonly STYLEREF_AGENTS=" ' + " ".join(_VENDOR) + ' "\n'
            + _SH_TAIL
        )
        text, removed = rm.withhold_members(
            "hooks/inject-scope-rules.sh", candidate, [self._FAILED]
        )
        self.assertEqual(removed, (self._FAILED,))
        for array in ("INJECT_AGENTS", "STYLEREF_AGENTS"):
            self.assertNotIn(self._FAILED, _shell_names(text, array))

    def test_a_candidate_whose_shape_does_not_read_refuses(self):
        with self.assertRaises(rm.ShapeError):
            rm.withhold_members("agent-registry.json", "not json", [self._FAILED])


@unittest.skipIf(rm is None, f"roster_merge import failed: {_IMPORT_ERROR}")
class WithholdCliTest(unittest.TestCase):
    """The seam the dispatch drives between candidate generation and apply."""

    def _run(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = rm.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_withhold_writes_the_reduced_candidate_and_names_what_it_dropped(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "candidate.sh").write_text(
                _shell_of([*_VENDOR, _LIVE_ONLY]), encoding="utf-8"
            )
            code, out, _ = self._run(
                [
                    "withhold",
                    "--target",
                    "hooks/lib/styleref-roster.sh",
                    "--candidate",
                    str(root / "candidate.sh"),
                    "--out",
                    str(root / "reduced.sh"),
                    "--name",
                    _LIVE_ONLY,
                ]
            )
            self.assertEqual(code, rm.EXIT_OK)
            self.assertIn(f"withheld={_LIVE_ONLY}", out)
            reduced = (root / "reduced.sh").read_text(encoding="utf-8")
            self.assertEqual(_shell_names(reduced), _VENDOR)
            # the generated candidate stays readable beside its reduction
            self.assertIn(_LIVE_ONLY, _shell_names((root / "candidate.sh").read_text()))

    def test_withhold_reports_an_empty_drop_set_when_no_name_was_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "candidate.sh").write_text(_shell_of(_VENDOR), encoding="utf-8")
            code, out, _ = self._run(
                [
                    "withhold",
                    "--target",
                    "hooks/lib/styleref-roster.sh",
                    "--candidate",
                    str(root / "candidate.sh"),
                    "--out",
                    str(root / "reduced.sh"),
                    "--name",
                    _LIVE_ONLY,
                ]
            )
            self.assertEqual(code, rm.EXIT_OK)
            self.assertIn("withheld= ", out)

    def test_withhold_refuses_an_unreadable_shape_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "candidate.json").write_text("not json", encoding="utf-8")
            code, _, err = self._run(
                [
                    "withhold",
                    "--target",
                    "agent-registry.json",
                    "--candidate",
                    str(root / "candidate.json"),
                    "--out",
                    str(root / "reduced.json"),
                    "--name",
                    _LIVE_ONLY,
                ]
            )
            self.assertEqual(code, rm.EXIT_SHAPE)
            self.assertIn("ROSTER WITHHOLD REFUSED", err)
            self.assertFalse((root / "reduced.json").exists())


if __name__ == "__main__":
    unittest.main()
