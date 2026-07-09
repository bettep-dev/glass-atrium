#!/usr/bin/env bats
# Tests for lint-workflow-template-literal.sh — PreToolUse(Workflow) bash-in-template lint.
# Exit-code contract: 0 = pass / fail-open · 2 = BLOCK (bash operator inside a template literal).

setup() {
  HOOK="${BATS_TEST_DIRNAME}/../lint-workflow-template-literal.sh"
}

# Build a PreToolUse(Workflow) envelope and pipe it to the hook.
# $1 = tool_name, $2 = JS script source. jq encodes the JSON so backticks / $ / quotes survive.
run_hook() {
  local tn="$1" src="$2" input
  input="$(jq -n --arg tn "$tn" --arg s "$src" '{tool_name:$tn, tool_input:{script:$s}}')"
  printf '%s' "$input" | "$HOOK"
}

# Pipe a raw JSON envelope straight to the hook (for the absent-key case).
run_raw() {
  printf '%s' "$1" | "$HOOK"
}

# core exit-code contract: in-scope breakers, out-of-scope + fail-open cases

@test "non-Workflow tool_name is out of scope -> exit 0" {
  run run_hook Edit 'const s = `${arr[@]}`;'
  [ "$status" -eq 0 ]
}

@test "array-length \${#STEP_FN[@]} in a template literal -> exit 2" {
  run run_hook Workflow 'const s = `n=${#STEP_FN[@]}`;'
  [ "$status" -eq 2 ]
}

@test "default operator \${opt:-default} in a template literal -> exit 2" {
  run run_hook Workflow 'const s = `v=${opt:-default}`;'
  [ "$status" -eq 2 ]
}

@test "array splat \${arr[@]} in a template literal -> exit 2" {
  run run_hook Workflow 'const s = `all ${arr[@]}`;'
  [ "$status" -eq 2 ]
}

@test "plain interpolation \${jsVar} -> exit 0" {
  run run_hook Workflow 'const s = `hi ${jsVar} there`;'
  [ "$status" -eq 0 ]
}

@test "ternary \${cond ? a : b} -> exit 0" {
  run run_hook Workflow 'const s = `${cond ? a : b}`;'
  [ "$status" -eq 0 ]
}

@test "modulo \${a % b} -> exit 0" {
  run run_hook Workflow 'const s = `${a % b}`;'
  [ "$status" -eq 0 ]
}

@test "\${VAR} inside a single-quoted JS string (not a template) -> exit 0" {
  run run_hook Workflow 'const s = '\''${VAR}'\''; f();'
  [ "$status" -eq 0 ]
}

@test "escaped backslash-\${VAR} in a template literal -> exit 0" {
  run run_hook Workflow 'const s = `x \${VAR} y`;'
  [ "$status" -eq 0 ]
}

@test "escape-hatch token present suppresses a real breaker -> exit 0" {
  run run_hook Workflow 'const s = `${arr[@]}`; /* [[JS-TEMPLATE-LINT-OK]] */'
  [ "$status" -eq 0 ]
}

@test "script with no backticks -> exit 0" {
  run run_hook Workflow 'const s = "plain"; const n = 5;'
  [ "$status" -eq 0 ]
}

@test "empty tool_input.script -> exit 0" {
  run run_hook Workflow ''
  [ "$status" -eq 0 ]
}

@test "absent tool_input.script key -> exit 0" {
  run run_raw '{"tool_name":"Workflow","tool_input":{}}'
  [ "$status" -eq 0 ]
}

# bonus coverage: remaining operator variants and Do-NOT-flag shapes

@test "assign operator \${opt:=x} -> exit 2" {
  run run_hook Workflow 'const s = `${opt:=x}`;'
  [ "$status" -eq 2 ]
}

@test "alt operator \${opt:+x} -> exit 2" {
  run run_hook Workflow 'const s = `${opt:+x}`;'
  [ "$status" -eq 2 ]
}

@test "error operator \${opt:?x} -> exit 2" {
  run run_hook Workflow 'const s = `${opt:?x}`;'
  [ "$status" -eq 2 ]
}

@test "star splat \${arr[*]} -> exit 2" {
  run run_hook Workflow 'const s = `${arr[*]}`;'
  [ "$status" -eq 2 ]
}

@test "ternary with a negative branch \${cond ? x :-y} is not flagged (question-mark precedes) -> exit 0" {
  run run_hook Workflow 'const s = `${cond ? x :-y}`;'
  [ "$status" -eq 0 ]
}

@test "logical NOT \${!ready} -> exit 0" {
  run run_hook Workflow 'const s = `${!ready}`;'
  [ "$status" -eq 0 ]
}

@test "computed member \${obj[key]} -> exit 0" {
  run run_hook Workflow 'const s = `${obj[key]}`;'
  [ "$status" -eq 0 ]
}

@test "backtick only inside a JS string, no real template -> exit 0" {
  run run_hook Workflow 'const s = "a backtick char ` and ${arr[@]} in a string";'
  [ "$status" -eq 0 ]
}

# block-message accuracy + line reporting

@test "block message asserts it is NOT a TypeScript syntax error" {
  run run_hook Workflow 'const s = `${arr[@]}`;'
  [ "$status" -eq 2 ]
  [[ "$output" == *"NOT a TypeScript syntax error"* ]]
}

@test "block message offers the three fixes and the escape hatch" {
  run run_hook Workflow 'const s = `${arr[@]}`;'
  [ "$status" -eq 2 ]
  [[ "$output" == *"HOW TO FIX"* ]]
  [[ "$output" == *"String.raw"* ]]
  [[ "$output" == *"[[JS-TEMPLATE-LINT-OK]]"* ]]
}

@test "block message reports the correct 1-based source line" {
  run run_hook Workflow $'const a = 1;\nconst s = `${arr[@]}`;'
  [ "$status" -eq 2 ]
  [[ "$output" == *"line 2:"* ]]
}

# scanner state-machine coverage: nested braces, nested template, block-comment skip

@test "nested object literal \${ {x:1} } (no bash shape) tracks brace depth -> exit 0" {
  run run_hook Workflow 'const s = `${ {x:1} }`;'
  [ "$status" -eq 0 ]
}

@test "inner template's \${arr[@]} across a nested backtick is flagged -> exit 2" {
  run run_hook Workflow 'const s = `${x + `n ${arr[@]}`}`;'
  [ "$status" -eq 2 ]
}

@test "backtick + \${arr[@]} inside a /* */ block comment does not open a template -> exit 0" {
  run run_hook Workflow 'const s = /* pseudo ` and ${arr[@]} */ 5;'
  [ "$status" -eq 0 ]
}

# false-positive regression: valid JS whose interpolation only CONTAINS shape chars -> exit 0
# The whole-body match rejects these because the shape chars sit AFTER other JS expression structure,
# so the body is not itself a bash parameter-expansion. Each source is 100% valid JavaScript.

@test "FP regex containing [@] \${text.replace(/[@]/g, '')} -> exit 0" {
  run run_hook Workflow 'const s = `${text.replace(/[@]/g, '\'''\'')}`;'
  [ "$status" -eq 0 ]
}

@test "FP string containing [@] \${x || '[@]'} -> exit 0" {
  run run_hook Workflow 'const s = `${x || '\''[@]'\''}`;'
  [ "$status" -eq 0 ]
}

@test "FP object literal with :- \${JSON.stringify({left:-1, top:-1})} -> exit 0" {
  run run_hook Workflow 'const s = `${JSON.stringify({left:-1, top:-1})}`;'
  [ "$status" -eq 0 ]
}

@test "FP emoticon :-) inside a string \${msg + ' :-)'} -> exit 0" {
  run run_hook Workflow 'const s = `${msg + '\'' :-)'\''}`;'
  [ "$status" -eq 0 ]
}

@test "FP division \${a / b} -> exit 0" {
  run run_hook Workflow 'const s = `${a / b}`;'
  [ "$status" -eq 0 ]
}

@test "FP nested-template TEXT only \${\`a:-b\`} (no inner substitution) -> exit 0" {
  run run_hook Workflow 'const s = `${`a:-b`}`;'
  [ "$status" -eq 0 ]
}

# CRLF line-counting guard: real breaker on line 3 -> exit 2 AND reports line 3

@test "CRLF 3-line script with \${arr[@]} on line 3 -> exit 2 and reports line 3" {
  run run_hook Workflow $'const a = 1;\r\nconst b = 2;\r\nconst s = `${arr[@]}`;'
  [ "$status" -eq 2 ]
  [[ "$output" == *"line 3:"* ]]
}
