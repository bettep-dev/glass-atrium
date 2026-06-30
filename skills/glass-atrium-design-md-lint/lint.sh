#!/usr/bin/env bash
# lint.sh — deterministic structural lint for a DESIGN.md token graph.
# Usage: lint.sh <DESIGN.md> [design_tokens.json] [--json]
#
# Three rules against Atrium's real token model (Base/Semantic/Component
# alias graph + `var(--token)` + `{tier.token.path}` brace refs + DTCG JSON):
#   1. broken-ref    [error, exit 1] every alias resolves to a defined token;
#                    raw values are allowed only at the Base tier.
#   2. orphaned-token [warning]       a Base token referenced by no alias, EXCEPT
#                    dark / high-contrast multi-mode tokens (MD3-aware, not orphans).
#   3. section-order  [warning]       canonical DESIGN.md section order preserved.
#
# Output: structured findings (severity + path + message). Human-readable by
# default; --json emits a machine-readable findings array.
# Exit codes:
#   0 = no BLOCKING (error) findings (warnings may be present)
#   1 = at least one BLOCKING (error) finding (broken-ref)
#   2 = measurement failure (missing dep, file unreadable, malformed JSON)
set -Eeuo pipefail
IFS=$'\n\t'

trap 'printf "ERROR: line %s: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2' ERR

usage() {
  printf 'usage: %s <DESIGN.md> [design_tokens.json] [--json]\n' "${0##*/}" >&2
  exit 2
}

# 1. argument parse — positional DESIGN.md (required), optional tokens JSON,
#    optional --json flag (order-tolerant for the flag).
DESIGN_PATH=""
TOKENS_PATH=""
OUT_FORMAT="human"
for arg in "$@"; do
  case "${arg}" in
    --json) OUT_FORMAT="json" ;;
    --help | -h) usage ;;
    --*)
      printf 'ERROR: unknown flag %s\n' "${arg}" >&2
      exit 2
      ;;
    *)
      if [[ -z "${DESIGN_PATH}" ]]; then
        DESIGN_PATH="${arg}"
      elif [[ -z "${TOKENS_PATH}" ]]; then
        TOKENS_PATH="${arg}"
      else
        printf 'ERROR: too many positional arguments\n' >&2
        exit 2
      fi
      ;;
  esac
done

[[ -n "${DESIGN_PATH}" ]] || usage

# 2. precondition probe — loud-fail on missing dep / unreadable input.
if ! command -v python3 >/dev/null 2>&1; then
  printf 'ERROR: python3 not found (lint requires Python interpreter)\n' >&2
  exit 2
fi
if [[ ! -f "${DESIGN_PATH}" ]]; then
  printf 'ERROR: DESIGN file not found at %s\n' "${DESIGN_PATH}" >&2
  exit 2
fi
if [[ -n "${TOKENS_PATH}" && ! -f "${TOKENS_PATH}" ]]; then
  printf 'ERROR: tokens file not found at %s\n' "${TOKENS_PATH}" >&2
  exit 2
fi

# 3. lint engine — heredoc-stored to a var to avoid SC2259 (heredoc-vs-stdin
#    conflict); the DESIGN.md text is piped on stdin, paths passed via env.
py_src="$(
  cat <<'PY'
import json
import os
import re
import sys

DESIGN_PATH = os.environ["DML_DESIGN_PATH"]
TOKENS_PATH = os.environ.get("DML_TOKENS_PATH", "")
OUT_FORMAT = os.environ.get("DML_OUT_FORMAT", "human")

# Canonical DESIGN.md section order (template §1-§9 headings). The lint accepts
# the prefix-numbered template form ("## 2. Color") AND the example unnumbered
# form ("## Colors"); matching keys on a normalized token set so both pass.
CANONICAL_SECTIONS = [
    ("visual", "theme", "atmosphere", "brand", "style"),  # §1
    ("color",),                                            # §2
    ("typography",),                                       # §3
    ("spacing",),                                          # §4
    ("layout", "composition"),                             # §5
    ("component",),                                        # §6
    ("motion", "interaction"),                             # §7
    ("voice", "brand"),                                    # §8
    ("anti-pattern", "anti", "forbidden"),                 # §9
]

# A reference looks like `var(--token)` (CSS custom property), `{tier.token.path}`
# (DTCG brace alias / example brace form), or an explicit `→ {alias}` arrow.
RE_VAR = re.compile(r"var\(\s*(--[A-Za-z0-9_-]+)\s*\)")
RE_BRACE = re.compile(r"\{([A-Za-z0-9_.\-]+)\}")
RE_HEADING = re.compile(r"^##\s+(.*?)\s*$")
# A raw color/dimension literal (hex, rgb/rgba, bare px/rem) used OUTSIDE the
# Base tier signals a tier violation. Detect at the alias-position level only.
RE_RAW_COLOR = re.compile(r"#[0-9A-Fa-f]{3,8}\b|rgba?\(")

# Multi-mode token markers — dark / high-contrast / colorblind variants are NOT
# orphans even when no alias points at them (they are re-points of a semantic
# name, consumed by mode switching). Match as a substring on the token name.
MODE_MARKERS = ("dark", "high-contrast", "highcontrast", "hc-", "-hc",
                "colorblind", "tritanopia", "deuteranopia", "protanopia")


def add(findings, severity, path, message):
    findings.append({"severity": severity, "path": path, "message": message})


def norm(name):
    return name.strip().lower()


def load_design(text):
    """Split a DESIGN.md into (frontmatter_text, body_text, headings).

    Supports YAML frontmatter (--- fenced, the example form) and pure-body
    template form. Returns headings in document order.
    """
    fm = ""
    body = text
    if text.lstrip().startswith("---"):
        # strip leading whitespace lines, then split on the closing fence
        stripped = text.lstrip("\n")
        parts = stripped.split("\n---", 1)
        if len(parts) == 2:
            fm = parts[0].lstrip("-\n")
            body = parts[1]
    headings = []
    for line in body.splitlines():
        m = RE_HEADING.match(line)
        if m:
            headings.append(m.group(1))
    return fm, body, headings


def collect_defined_tokens(tokens_json, fm_text, body_text):
    """Build the set of DEFINED token names (the resolution targets).

    Sources, in order of authority:
      - design_tokens.json keys (flattened dotted paths + leaf names)
      - DESIGN.md frontmatter YAML keys (example form: colors/typography/...)
      - `:root { --token: value; }` CSS custom-property declarations (Atrium form)
    Defined names are stored in two indexes: dotted-path (for {a.b.c}) and the
    `--name` CSS form (for var(--name)).
    """
    dotted = set()   # e.g. "colors.primary", "rounded.lg"
    cssvars = set()  # e.g. "--color-brand-primary"
    base_tokens = {}  # name -> "is referenced" tracking key for orphan rule

    def walk(prefix, node):
        if isinstance(node, dict):
            # a DTCG token leaf carries $value; treat the leaf path as a token
            if "$value" in node:
                dotted.add(prefix)
                base_tokens[prefix] = False
                return
            for k, v in node.items():
                if k.startswith("$"):
                    continue
                child = f"{prefix}.{k}" if prefix else k
                walk(child, v)
        elif isinstance(node, list):
            # arrays do not define named tokens
            return
        else:
            # scalar leaf in the example YAML/JSON form (colors.primary: "#fff")
            if prefix:
                dotted.add(prefix)
                base_tokens[prefix] = False

    if tokens_json is not None:
        walk("", tokens_json)

    # frontmatter YAML — parse without a YAML lib (BSD-portable, no PyYAML dep):
    # capture `group:` headers and 2-space-indented `key:` leaves.
    cur_group = None
    for raw in fm_text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", raw.strip())
        if not m:
            continue
        key, val = m.group(1), m.group(2)
        if indent == 0:
            cur_group = key
            if val.strip():
                dotted.add(key)
                base_tokens[key] = False
        elif indent >= 2 and cur_group is not None:
            path = f"{cur_group}.{key}"
            dotted.add(path)
            # only leaf scalars (with a value) are base tokens; nested headers
            # (val empty) are containers, registered but not orphan-tracked.
            if val.strip() and not val.strip().endswith(":"):
                base_tokens[path] = False

    # CSS custom properties in :root { } blocks (Atrium consumption layer)
    for m in re.finditer(r"(--[A-Za-z0-9_-]+)\s*:\s*[^;]+;", body_text):
        cssvars.add(m.group(1))
        base_tokens[m.group(1)] = False

    return dotted, cssvars, base_tokens


def collect_references(fm_text, body_text, tokens_json):
    """Collect every alias reference (its target token + source location)."""
    refs = []  # (target_name, kind, location_label)

    def scan_text(text, label):
        for m in RE_VAR.finditer(text):
            refs.append((m.group(1), "var", label))
        for m in RE_BRACE.finditer(text):
            refs.append((m.group(1), "brace", label))

    scan_text(fm_text, "frontmatter")
    scan_text(body_text, "body")

    # references embedded as JSON string values ("{colors.primary}") — scan the
    # serialized JSON so component-alias values count as references.
    if tokens_json is not None:
        scan_text(json.dumps(tokens_json), "tokens.json")

    return refs


def detect_raw_in_aliases(tokens_json):
    """broken-ref helper: a component-tier value that is a raw color literal
    (not a {alias}) is a tier violation (raw allowed only at Base tier).

    Heuristic on the example/Atrium component shape: under a top-level
    `components` group, a string value that is a raw color OR a DTCG color leaf
    whose $value is a raw object — both are flagged ONLY when the SAME role
    could be expressed as an alias. We flag string raw-color leaves; structured
    DTCG `$value` objects are tolerated (explicit raw, author intent).
    """
    findings = []
    if not isinstance(tokens_json, dict):
        return findings
    comps = tokens_json.get("components")
    if not isinstance(comps, dict):
        return findings
    for cname, cval in comps.items():
        if not isinstance(cval, dict):
            continue
        for prop, pval in cval.items():
            if isinstance(pval, str) and RE_RAW_COLOR.search(pval) and "{" not in pval:
                findings.append((
                    f"components.{cname}.{prop}",
                    f"raw color literal '{pval}' at Component tier — "
                    f"raw values allowed only at Base tier; use an alias",
                ))
    return findings


def main():
    text = sys.stdin.read()

    tokens_json = None
    if TOKENS_PATH:
        try:
            with open(TOKENS_PATH, encoding="utf-8") as f:
                tokens_json = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f"ERROR: cannot parse tokens JSON {TOKENS_PATH}: {e}",
                  file=sys.stderr)
            sys.exit(2)

    fm_text, body_text, headings = load_design(text)
    dotted, cssvars, base_tokens = collect_defined_tokens(
        tokens_json, fm_text, body_text)
    refs = collect_references(fm_text, body_text, tokens_json)

    findings = []

    # --- Rule 1: broken-ref [error] -----------------------------------------
    # Every alias must resolve to a DEFINED token. var(--x) checks cssvars;
    # {a.b.c} checks dotted paths (exact, or as a leaf/suffix tolerance).
    defined_dotted = dotted.union(base_tokens.keys())
    for target, kind, where in refs:
        resolved = False
        if kind == "var":
            resolved = target in cssvars
        else:  # brace path
            if target in defined_dotted:
                resolved = True
            else:
                # tolerate a leaf-name match (the {group.leaf} where only the
                # leaf or a parent path was registered)
                leaf = target.split(".")[-1]
                resolved = any(d == target or d.endswith("." + leaf) or
                               d.split(".")[-1] == leaf for d in defined_dotted)
        if resolved:
            # mark the resolved base token as referenced (for orphan rule)
            for key in list(base_tokens.keys()):
                if key == target or key.endswith("." + target.split(".")[-1]):
                    base_tokens[key] = True
        else:
            add(findings, "error", f"{where}:{target}",
                f"broken-ref: alias '{target}' resolves to no defined token")

    # raw-literal-at-component-tier (broken-ref family)
    for path, msg in detect_raw_in_aliases(tokens_json):
        add(findings, "error", path, f"broken-ref: {msg}")

    # --- Rule 2: orphaned-token [warning] -----------------------------------
    # A base token referenced by no alias is an orphan, EXCEPT multi-mode
    # tokens (dark / high-contrast / colorblind) which are mode re-points.
    for name, referenced in sorted(base_tokens.items()):
        if referenced:
            continue
        low = name.lower()
        if any(mk in low for mk in MODE_MARKERS):
            continue  # multi-mode token — not an orphan
        add(findings, "warning", name,
            f"orphaned-token: base token '{name}' referenced by no alias")

    # --- Rule 3: section-order [warning] ------------------------------------
    # Verify present canonical sections appear in the canonical relative order.
    # Unrecognized sections are preserved (skipped), never flagged.
    matched_indices = []
    for h in headings:
        h_norm = re.sub(r"^\d+\.\s*", "", norm(h))
        for idx, keyset in enumerate(CANONICAL_SECTIONS):
            if any(k in h_norm for k in keyset):
                matched_indices.append((idx, h))
                break
    last = -1
    for idx, h in matched_indices:
        if idx < last:
            add(findings, "warning", f"section:{h}",
                f"section-order: '{h}' appears out of canonical DESIGN.md order")
        last = max(last, idx)

    # --- emit ---------------------------------------------------------------
    errors = [f for f in findings if f["severity"] == "error"]
    warnings = [f for f in findings if f["severity"] == "warning"]

    if OUT_FORMAT == "json":
        print(json.dumps({
            "design": DESIGN_PATH,
            "tokens": TOKENS_PATH or None,
            "summary": {
                "errors": len(errors),
                "warnings": len(warnings),
                "defined_tokens": len(defined_dotted) + len(cssvars),
                "references": len(refs),
            },
            "findings": findings,
        }, indent=2, ensure_ascii=False))
    else:
        print(f"design-md-lint -> {DESIGN_PATH}")
        if TOKENS_PATH:
            print(f"  tokens: {TOKENS_PATH}")
        print(f"  defined tokens: {len(defined_dotted) + len(cssvars)}  "
              f"references: {len(refs)}")
        if not findings:
            print("  OK — no findings")
        for f in findings:
            tag = "ERROR" if f["severity"] == "error" else "warn "
            print(f"  [{tag}] {f['path']} — {f['message']}")
        print(f"Verdict: {len(errors)} error(s), {len(warnings)} warning(s)")

    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
PY
)"

# 4. execute — env-pass paths (avoid arg quoting fragility), DESIGN.md via stdin.
#    The engine's exit 1 (blocking findings present) / 2 (measurement failure)
#    are DESIGNED return values, not errors — capture explicitly so the ERR
#    trap does not misreport an intentional non-zero exit, then propagate it.
export DML_DESIGN_PATH="${DESIGN_PATH}"
export DML_TOKENS_PATH="${TOKENS_PATH}"
export DML_OUT_FORMAT="${OUT_FORMAT}"
rc=0
python3 -c "${py_src}" <"${DESIGN_PATH}" || rc=$?
exit "${rc}"
