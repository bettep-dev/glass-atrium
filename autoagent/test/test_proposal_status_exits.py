"""Static exit pins for every ``ProposalStatus`` value — no PG, no pipeline imports.

A disposition registry kept as data must name exactly the ``schema.prisma`` enum:
each value is terminal, a drain, or a terminal sink with recovery routes, and each
named site is re-read by function anchor (shell ``name() {`` → ``^}``, Python
``ast``, TS ``function`` → ``^}``).

Run with either runner:
    python3 -m unittest autoagent.test.test_proposal_status_exits -v
    python3 -m pytest autoagent/test/test_proposal_status_exits.py -v
"""

from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path
from typing import NamedTuple

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

_SCHEMA_PRISMA = "monitor/prisma/schema.prisma"
_APPLY_SH = "autoagent/daemon-apply.sh"
_CYCLE_PY = "autoagent/daemon_cycle.py"
_ROUTE_TS = "monitor/src/server/routes/improvement.ts"

TERMINAL = "terminal"
DRAIN = "drain"
TERMINAL_SINK = "terminal-sink"
DISPOSITION_KINDS = (TERMINAL, DRAIN, TERMINAL_SINK)

SELECTED = "selected"  # status sits in the site's WHERE/AND status predicate
NOT_TERMINAL = "not-terminal"  # status absent from the site's exit-8 case arm


class Site(NamedTuple):
    role: str
    language: str
    path: str
    anchor: str
    check: str


_SINGLE_PATH = Site(
    "single path", "shell", _APPLY_SH, "select_single_proposal", NOT_TERMINAL
)
_APPLY_FLIP = Site("apply flip", "shell", _APPLY_SH, "update_db_status", SELECTED)
_REJECT_ROUTE = Site("monitor reject route", "ts", _ROUTE_TS, "handleReject", SELECTED)

STATUS_DISPOSITIONS = {
    "pending": {
        "kind": DRAIN,
        "sites": (
            Site(
                "backlog selector",
                "shell",
                _APPLY_SH,
                "extract_backlog_patches",
                SELECTED,
            ),
            _SINGLE_PATH,
            _APPLY_FLIP,
            Site(
                "supersede",
                "python",
                _CYCLE_PY,
                "supersede_prior_pending_for_agent",
                SELECTED,
            ),
            Site(
                "parked-guard reject",
                "python",
                _CYCLE_PY,
                "update_parked_proposal_status",
                SELECTED,
            ),
            Site("stale-drain", "shell", _APPLY_SH, "mark_stale_attempt", SELECTED),
            _REJECT_ROUTE,
        ),
    },
    "snoozed": {
        "kind": TERMINAL_SINK,
        "sites": (_SINGLE_PATH, _APPLY_FLIP, _REJECT_ROUTE),
    },
    "applied": {"kind": TERMINAL, "sites": ()},
    "rejected": {"kind": TERMINAL, "sites": ()},
    "reverted": {"kind": TERMINAL, "sites": ()},
    "approved": {"kind": TERMINAL, "sites": ()},  # no writer sets it
}

_STATUS_PREDICATE = re.compile(
    r"\b(?:WHERE|AND)\s+(?:\w+\.)?status\s*(?:=\s*'(\w+)'|IN\s*\(([^)]*)\))",
    re.IGNORECASE,
)
_CASE_ARM = re.compile(
    r"^\s*(\w+(?:\s*\|\s*\w+)*)\)\s*\n(.*?);;", re.MULTILINE | re.DOTALL
)


def get_source_or_fail(relative_path: str) -> str:
    path = _REPO_ROOT / relative_path
    if not path.is_file():
        raise AssertionError(f"{relative_path} is missing — registry path is stale")
    return path.read_text(encoding="utf-8")


def get_enum_values_or_fail(schema_text: str, enum_name: str) -> list[str]:
    match = re.search(
        rf"^enum {enum_name} \{{\n(.*?)^\}}", schema_text, re.MULTILINE | re.DOTALL
    )
    if match is None:
        raise AssertionError(f"enum {enum_name} not found in {_SCHEMA_PRISMA}")
    values = []
    for line in match.group(1).splitlines():
        word = line.split("//", 1)[0].strip()
        if word and not word.startswith("@@"):
            values.append(word.split()[0])
    return values


def _get_single_match_or_fail(pattern: str, text: str, anchor: str) -> str:
    matches = re.findall(pattern, text, re.MULTILINE | re.DOTALL)
    if len(matches) != 1:
        raise AssertionError(
            f"anchor {anchor!r} matched {len(matches)} definitions, expected 1"
        )
    return matches[0]


def _drop_comment_lines(body: str, prefixes: tuple[str, ...]) -> str:
    return "\n".join(
        line for line in body.splitlines() if not line.lstrip().startswith(prefixes)
    )


def get_shell_body_or_fail(text: str, name: str) -> str:
    body = _get_single_match_or_fail(
        rf"^{re.escape(name)}\(\) \{{\n(.*?)^\}}", text, name
    )
    return _drop_comment_lines(body, ("#", "--"))


def get_ts_body_or_fail(text: str, name: str) -> str:
    pattern = rf"^(?:export )?(?:async )?function {re.escape(name)}\b(.*?)^\}}"
    return _drop_comment_lines(
        _get_single_match_or_fail(pattern, text, name), ("//", "/*", "*")
    )


def get_python_strings_or_fail(text: str, name: str) -> str:
    kinds = (ast.FunctionDef, ast.AsyncFunctionDef)
    nodes = [
        node
        for node in ast.walk(ast.parse(text))
        if isinstance(node, kinds) and node.name == name
    ]
    if len(nodes) != 1:
        raise AssertionError(
            f"anchor {name!r} matched {len(nodes)} definitions, expected 1"
        )
    body = nodes[0].body
    if ast.get_docstring(nodes[0], clean=False) is not None:
        body = body[1:]
    strings = [
        node.value
        for statement in body
        for node in ast.walk(statement)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    ]
    return "\n".join(strings)


_EXTRACTORS = {
    "shell": get_shell_body_or_fail,
    "python": get_python_strings_or_fail,
    "ts": get_ts_body_or_fail,
}


def get_site_code_or_fail(site: Site) -> str:
    extractor = _EXTRACTORS.get(site.language)
    if extractor is None:
        raise AssertionError(
            f"site {site.role!r} has unknown language {site.language!r}"
        )
    return extractor(get_source_or_fail(site.path), site.anchor)


def get_predicate_statuses(code: str) -> set[str]:
    statuses = set()
    for equal_value, in_list in _STATUS_PREDICATE.findall(code):
        statuses.update(
            [equal_value] if equal_value else re.findall(r"'(\w+)'", in_list)
        )
    return statuses


def get_terminal_branch_or_fail(site: Site) -> set[str]:
    if site.language != "shell":
        raise AssertionError(
            f"site {site.role!r}: a terminal branch is a shell case arm"
        )
    arms = _CASE_ARM.findall(get_site_code_or_fail(site))
    exits = [
        pattern
        for pattern, arm in arms
        if re.search(r"^\s*exit 8\s*$", arm, re.MULTILINE)
    ]
    if len(exits) != 1:
        raise AssertionError(
            f"{site.anchor}: {len(exits)} case arms exit 8, expected 1"
        )
    return {status.strip() for status in exits[0].split("|")}


class ProposalStatusExitTest(unittest.TestCase):
    def test_registry_names_exactly_the_proposal_status_enum(self) -> None:
        enum_values = get_enum_values_or_fail(
            get_source_or_fail(_SCHEMA_PRISMA), "ProposalStatus"
        )
        unregistered = sorted(set(enum_values) - set(STATUS_DISPOSITIONS))
        stale = sorted(set(STATUS_DISPOSITIONS) - set(enum_values))
        self.assertEqual(
            (unregistered, stale),
            ([], []),
            "(enum values without a disposition, stale entries)",
        )

    def test_single_path_terminal_branch_is_exactly_the_terminal_dispositions(
        self,
    ) -> None:
        registered = {
            status
            for status, entry in STATUS_DISPOSITIONS.items()
            if entry["kind"] == TERMINAL
        }
        self.assertEqual(get_terminal_branch_or_fail(_SINGLE_PATH), registered)

    def test_every_non_final_status_names_sites_that_still_carry_it(self) -> None:
        for status, entry in STATUS_DISPOSITIONS.items():
            with self.subTest(status=status):
                self.assertIn(entry["kind"], DISPOSITION_KINDS)
                self.assertEqual(
                    entry["kind"] == TERMINAL,
                    not entry["sites"],
                    "terminal ⇔ no named site",
                )
                for site in entry["sites"]:
                    self.assert_site_carries(status, site)

    def assert_site_carries(self, status: str, site: Site) -> None:
        label = f"{status} @ {site.role} ({site.path} → {site.anchor})"
        if site.check == NOT_TERMINAL:
            self.assertNotIn(
                status,
                get_terminal_branch_or_fail(site),
                f"{label}: joined the exit-8 set",
            )
        elif site.check == SELECTED:
            statuses = get_predicate_statuses(get_site_code_or_fail(site))
            self.assertIn(
                status, statuses, f"{label}: status predicate no longer selects it"
            )
        else:
            self.fail(f"{label}: unknown check {site.check!r}")


if __name__ == "__main__":
    unittest.main()
