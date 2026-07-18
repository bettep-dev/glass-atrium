#!/usr/bin/env bash
# validate-edit-syntax.sh — PreToolUse(Write|Edit) syntax gate. Runs a language-native parse-only check
# (bash -n / node --check / py_compile, by extension allowlist) on the post-write content, catching a
# malformed edit BEFORE it lands rather than at the next run.
#
# ADVISORY-FIRST rollout: an invalid-syntax write WARNS on stderr and allows (exit 0) by default. The
# exit-2 block arms only behind the burn-in flag SYNTAX_GATE_BLOCK=1, so it cannot wall off real work
# during rollout. Instant kill switch: SYNTAX_GATE_OFF (non-empty) → exit 0.
#
# Extension allowlist (anything else → allow): .sh/.bash → bash -n · .js/.mjs/.cjs → node --check ·
# .py → py_compile. Templates are EXEMPT (a path under templates/ or a template-suffixed basename holds
# placeholder syntax that is not valid source) — the SWE-agent ACI edit-lint precedent lints real source,
# not scaffolds.
#
# Content source: Write → the full new content; Edit → the file reconstructed with the old→new substitution
# applied, so a fragment is never checked in isolation (a partial fragment is not a complete program).
# Un-reconstructable Edit (file absent / old_string not found) → allow (fail-open, no false positive).
#
# Fail-open on EVERYTHING (absent python3/node, unreadable file, parse/internal error) → exit 0. A gate
# that walls off every edit on its own bug has system-wide blast radius; the worst default case is a
# missing or spurious advisory line.

set -Eeuo pipefail
IFS=$'\n\t'

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

# Diagnostic ERR trap — fail-open. An internal error must never block an edit.
trap 'printf "[edit-syntax] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# Instant kill switch.
[[ -n "${SYNTAX_GATE_OFF:-}" ]] && exit 0

# Burn-in arm: block (exit 2) on an invalid write only when explicitly enabled.
BLOCK_ARMED=0
[[ "${SYNTAX_GATE_BLOCK:-}" == "1" ]] && BLOCK_ARMED=1

INPUT="$(hook_read_input)"
TOOL_NAME="$(hook_get_field "${INPUT}" "tool_name")"

# Belt-and-suspenders for the matcher scope — anything other than Write/Edit → allow.
case "${TOOL_NAME:-}" in
  Write | Edit) : ;;
  *) exit 0 ;;
esac

FILE_PATH="$(hook_get_tool_input "${INPUT}" "file_path")"
[[ -z "${FILE_PATH}" ]] && exit 0

# Template exemption — a scaffold holds placeholder syntax that is not valid source.
basename_only="${FILE_PATH##*/}"
case "${FILE_PATH}" in
  */templates/* | */template/*) exit 0 ;;
  *) : ;;
esac
case "${basename_only}" in
  *.template | *.template.* | *.tmpl | *.tpl | *.j2 | *.jinja | *.jinja2 | *.mustache | *.hbs | *.handlebars)
    exit 0
    ;;
  *) : ;;
esac

# Extension → checker. No extension (basename has no dot) or an unlisted extension → allow.
[[ "${basename_only}" == *.* ]] || exit 0
ext="${basename_only##*.}"
ext="$(printf '%s' "${ext}" | tr '[:upper:]' '[:lower:]')"

checker=()
case "${ext}" in
  sh | bash) checker=(bash -n) ;;
  js | mjs | cjs)
    command -v node >/dev/null 2>&1 || exit 0
    checker=(node --check)
    ;;
  py) checker=(python3 -m py_compile) ;;
  *) exit 0 ;;
esac

# python3 is required to extract/reconstruct the effective content (and IS the py checker). Absent → allow.
command -v python3 >/dev/null 2>&1 || {
  printf '[edit-syntax] python3 not found — fail-open (exit 0)\n' >&2
  exit 0
}

# Sandbox for the reconstructed source + any py_compile bytecode artifact; trap-cleaned.
# Cleanup preserves the pending exit status (no exit in the trap) so the block path's exit 2 survives.
work_dir="$(mktemp -d 2>/dev/null)" || exit 0
trap 'rm -rf -- "${work_dir}" 2>/dev/null || true' EXIT
# Preserve the real extension — node --check picks CJS vs ESM module mode by it, so an
# extensionless temp file false-fails a valid .mjs / type:module import/export as CJS.
src_file="${work_dir}/src.${ext}"

# Emit the effective post-write content into src_file. Exit codes: 0 = written (check it) · 3 = skip
# (un-reconstructable Edit → allow) · other = internal failure (fail-open allow). json.load reads the
# hook envelope from stdin; the PY source is captured first so the heredoc never collides with that stdin.
EFFECTIVE_PY="$(
  cat <<'PY'
import sys, json

OUT = sys.argv[1]


def main():
    d = json.load(sys.stdin)
    if not isinstance(d, dict):
        return 3
    tool = str(d.get("tool_name", ""))
    ti = d.get("tool_input", {}) or {}

    if tool == "Write":
        content = ti.get("content", "")
        if not isinstance(content, str):
            return 3
        with open(OUT, "w", encoding="utf-8") as f:
            f.write(content)
        return 0

    if tool == "Edit":
        path = ti.get("file_path", "")
        old = ti.get("old_string", "")
        new = ti.get("new_string", "")
        replace_all = bool(ti.get("replace_all", False))
        if not isinstance(path, str) or not isinstance(old, str) or not isinstance(new, str):
            return 3
        try:
            with open(path, "r", encoding="utf-8") as f:
                current = f.read()
        except Exception:
            return 3  # file absent / unreadable → cannot reconstruct
        if old == "" or old not in current:
            return 3  # nothing to anchor the substitution → skip
        rebuilt = current.replace(old, new) if replace_all else current.replace(old, new, 1)
        with open(OUT, "w", encoding="utf-8") as f:
            f.write(rebuilt)
        return 0

    return 3


try:
    sys.exit(main())
except SystemExit:
    raise
except Exception:
    sys.exit(4)  # fail-open — never block on a reconstruction bug
PY
)"

rc=0
printf '%s' "${INPUT}" | python3 -c "${EFFECTIVE_PY}" "${src_file}" || rc=$?
# Skip (3) or any internal failure → allow.
[[ "${rc}" -eq 0 ]] || exit 0
[[ -f "${src_file}" ]] || exit 0

# Parse-only check. Valid syntax → allow.
if "${checker[@]}" "${src_file}" >/dev/null 2>&1; then
  exit 0
fi

# Invalid syntax. Armed → block; else a non-blocking advisory.
if [[ "${BLOCK_ARMED}" -eq 1 ]]; then
  # DF-21: escape FILE_PATH before the ctx embed — a raw quote/backslash in the path
  # would otherwise yield invalid JSON and degrade the context to {} in hook_emit_error.
  esc_path="$(_hook_json_escape "${FILE_PATH}")"
  esc_ext="$(_hook_json_escape "${ext}")"
  emit_error "SYNTAX-001" "block" \
    "Invalid ${ext} syntax blocked on write to ${basename_only}" \
    "Fix the syntax error, or unset SYNTAX_GATE_BLOCK to downgrade to advisory-only" \
    "{\"file_path\":\"${esc_path}\",\"ext\":\"${esc_ext}\"}"
  exit 2
fi
printf '[edit-syntax] %s\n' \
  "SYNTAX advisory: the ${ext} write to ${basename_only} has a syntax error (${checker[*]} failed). Non-blocking (advisory-first rollout; set SYNTAX_GATE_BLOCK=1 to enforce)." >&2
exit 0
