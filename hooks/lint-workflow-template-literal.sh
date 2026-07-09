#!/usr/bin/env bash
# lint-workflow-template-literal.sh — PreToolUse(Workflow) static bash-in-template lint.
#
# WHY: a bash ${...} parameter-expansion OPERATOR (${#a[@]}, ${arr[@]}, ${opt:-x}, ...) placed
# inside a JS backtick template literal is read by the JS parser as a ${ } interpolation and fails
# to parse; the Workflow engine surfaces this as a misleading "TypeScript syntax" error. This hook
# scans tool_input.script BEFORE the engine parses and BLOCKS (exit 2) with the accurate diagnosis.
#
# ZERO false positives is the primary requirement — a false block breaks every workflow in the
# session — so detection is scoped to three UNAMBIGUOUS bash-only shapes and is fail-open dominant:
# missing jq/python3, empty/undecodable input, wrong tool_name, or no backtick → exit 0.
#
# Exit codes: 0 = pass / fail-open (default) · 2 = BLOCK. Escape hatch: the literal token
# [[JS-TEMPLATE-LINT-OK]] anywhere in the script skips the lint (rare intentional bash-in-template).

set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — a lint that errors MUST NOT block a legitimate workflow.
trap 'printf "[lint-workflow-template-literal] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# stdin non-interactive → drain once, else fail-open.
input=""
if [[ ! -t 0 ]]; then
  input="$(cat 2>/dev/null)" || input=""
fi
[[ -z "${input}" ]] && exit 0

# Absent jq is a system misconfiguration — fail-open (never block on a tooling gap).
if ! command -v jq >/dev/null 2>&1; then
  printf '[lint-workflow-template-literal] jq not found on PATH; skipping (fail-open)\n' >&2
  exit 0
fi

# tool_name gate — only the Workflow tool is in scope. In-pipe `|| true` absorbs jq failure on
# corrupted JSON so the ERR trap fires only on genuine errors.
tool_name=""
tool_name="$(printf '%s' "${input}" | jq -r '.tool_name // ""' 2>/dev/null || true)" || tool_name=""
[[ "${tool_name}" != "Workflow" ]] && exit 0

# Extract tool_input.script via base64 so a multi-line JS body with backticks / $ / { / control
# chars survives intact (the script body is the scan target).
script_b64=""
script_b64="$(printf '%s' "${input}" | jq -r '(.tool_input.script // "") | @base64' 2>/dev/null || true)" || script_b64=""
[[ -z "${script_b64}" ]] && exit 0

script_src=""
script_src="$(printf '%s' "${script_b64}" | base64 --decode 2>/dev/null)" || script_src=""
[[ -z "${script_src}" ]] && exit 0

# Absent python3 is a system misconfiguration — fail-open.
if ! command -v python3 >/dev/null 2>&1; then
  printf '[lint-workflow-template-literal] python3 not found on PATH; skipping (fail-open)\n' >&2
  exit 0
fi

# Scanner. Reads the JS script on stdin, prints PASS (no violation / fail-open) OR a BLOCK block:
# line 1 = "BLOCK", then one pre-formatted "  line N: ${...}" per offending interpolation. The
# heredoc is captured into a var first, then run via `python3 -c "${scanner_py}"` with the script on
# stdin — never inline `python3 -c "$(cat <<'PY')"` (SC2259: a heredoc would overwrite stdin).
# bash-3.2 $(...)-scan constraint: this heredoc must contain NO bare apostrophe and NO bare backtick
# char, or the outer command substitution mis-parses on stock macOS bash (comments use words, not
# quote chars; char literals mirror the proven idiom in enforce-workflow-verify-stage.sh).
scanner_py="$(
  cat <<'PY'
import sys, re


def skip_string(src, i, q, n):
    # i points at the opening quote q; return the index just past the matching close (backslash
    # escapes honored). Strings are terminal, so a backtick or dollar-brace inside them is inert.
    j = i + 1
    while j < n:
        c = src[j]
        if c == '\\':
            j += 2
            continue
        if c == q:
            return j + 1
        j += 1
    return n


def is_bash_shape(body):
    # Flag ONLY when the WHOLE substitution body IS one of three bash parameter-expansion shapes.
    # A valid JS interpolation that merely CONTAINS these characters carries other expression
    # structure around them, so an anchored whole-body match rejects it while every real bash
    # breaker still fires: the operator spans the whole body in shapes 1 and 2, or the body start
    # in shape 3. re.match anchors at the body start; the trailing whitespace-end anchor on shapes
    # 1 and 2 keeps the match whole-body. Comments here deliberately spell out chars as words, not
    # sample glyphs, to stay parse-safe inside the bash-3.2 dollar-paren heredoc scan.
    # shape 1 array-length: pound then identifier, optionally array-indexed by splat.
    if re.match(r'\s*#[A-Za-z_][A-Za-z0-9_]*(\[[@*]\])?\s*$', body):
        return True
    # shape 2 array splat: identifier array-indexed by splat as the entire body.
    if re.match(r'\s*[A-Za-z_][A-Za-z0-9_]*\[[@*]\]\s*$', body):
        return True
    # shape 3 default/alt/err/assign: identifier immediately followed by colon then dash, equals,
    # plus or question. Anchoring at the body start excludes a JS ternary and an object literal,
    # whose colon-operator never sits at the identifier-start of the whole body.
    if re.match(r'\s*[A-Za-z_][A-Za-z0-9_]*:[-=+?]', body):
        return True
    return False


def scan(src):
    # Walk the source with a small context stack. A frame is one of:
    #   (T,)              inside a backtick template-literal body
    #   (S, depth, start) inside a dollar-brace substitution; start = index of the dollar char.
    # Strings and line/block comments are skipped inline so a backtick or dollar-brace inside them
    # is never treated as a template. Backslash escapes inside a template are honored, so an escaped
    # backslash-dollar-brace is NOT a substitution.
    results = []
    n = len(src)
    i = 0
    stack = []
    while i < n:
        frame = stack[-1] if stack else None
        if frame is not None and frame[0] == 'T':
            c = src[i]
            if c == '\\':
                i += 2
                continue
            if c == '`':
                stack.pop()
                i += 1
                continue
            if c == '$' and i + 1 < n and src[i + 1] == '{':
                stack.append(('S', 1, i))
                i += 2
                continue
            i += 1
            continue
        # normal JS context — top level OR inside a substitution (S frame)
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ''
        if c == '/' and nxt == '/':
            j = src.find('\n', i)
            i = n if j == -1 else j
            continue
        if c == '/' and nxt == '*':
            j = src.find('*/', i + 2)
            i = n if j == -1 else j + 2
            continue
        if c == "'" or c == '"':
            i = skip_string(src, i, c, n)
            continue
        if c == '`':
            stack.append(('T',))
            i += 1
            continue
        if frame is not None and frame[0] == 'S':
            if c == '{':
                stack[-1] = ('S', frame[1] + 1, frame[2])
                i += 1
                continue
            if c == '}':
                depth = frame[1] - 1
                if depth == 0:
                    start = frame[2]
                    stack.pop()
                    body = src[start + 2:i]
                    if is_bash_shape(body):
                        ln = src.count('\n', 0, start) + 1
                        results.append((ln, src[start:i + 1]))
                    i += 1
                    continue
                stack[-1] = ('S', depth, frame[2])
                i += 1
                continue
        i += 1
    return results


def main():
    src = sys.stdin.read()
    # Escape hatch: a deliberate bash-in-template case opts out with this literal token anywhere.
    if '[[JS-TEMPLATE-LINT-OK]]' in src:
        print('PASS')
        return
    # No backtick means no template literal, nothing to scan, fail-open PASS.
    if '`' not in src:
        print('PASS')
        return
    hits = scan(src)
    if not hits:
        print('PASS')
        return
    print('BLOCK')
    for ln, expr in hits:
        print('  line {0}: {1}'.format(ln, expr))


try:
    main()
except Exception:
    # Belt-and-suspenders fail-open: any scanner error PASSes; bash also treats non-BLOCK as pass.
    print('PASS')
PY
)"

helper_out="$(printf '%s' "${script_src}" | python3 -c "${scanner_py}" 2>/dev/null)" || helper_out="PASS"

# Verdict = FIRST line only. Pure parameter expansion — cannot trip the ERR trap.
verdict="${helper_out%%$'\n'*}"
[[ "${verdict}" != "BLOCK" ]] && exit 0

# findings = every line after the verdict token (pre-formatted "  line N: ${...}" by the scanner).
findings="${helper_out#*$'\n'}"

# Block reason on STDERR (PreToolUse block surface), then exit 2. Printed via a command group (NOT a
# captured $(...) heredoc) so the backticks / \$ in the body are parse-safe on bash 3.2.
{
  printf '%s\n\n' "[lint-workflow-template-literal] BLOCKED (bash parameter-expansion inside a JS template literal):"
  printf 'Offending expressions (source line -> expression):\n%s\n\n' "${findings}"
  cat <<'EOF'
WHY: This is NOT a TypeScript syntax error. A bash ${...} operator inside a JS backtick template
literal is read by the JavaScript parser as a ${ } interpolation and fails to parse (for example
"Missing } in template expression", "Unexpected token", or "Private field must be declared").

HOW TO FIX (choose one):
  1. Escape the dollar so it is a literal, not an interpolation: write \${...} instead of ${...}.
  2. Use a single- or double-quoted JS string instead of a backtick template (no interpolation).
  3. Concatenate the string pieces, or wrap the literal with String.raw so ${...} is not expanded.

ESCAPE HATCH (rare, intentional bash-in-template case): add the literal token [[JS-TEMPLATE-LINT-OK]]
anywhere in the script (for example in a comment) to skip this lint.
EOF
} >&2
exit 2
