#!/usr/bin/env bash
# PreToolUse(Write|Edit|Bash) — block on secret-pattern detection.
#   Write|Edit channel: scan tool_input.content + tool_input.new_string.
#   Bash channel: scan tool_input.command for a HIGH-SIGNAL credential value
#     redirected/heredoc'd into a dotenv/secrets file (a secret can otherwise be
#     written via `echo KEY=... > .env`, fully bypassing the Write|Edit channel).
# One coherent secret-scan surface — branches on tool_name. Both invocations
# block with exit 2 on match (channel a: stderr emit_error JSON). Bind this hook to BOTH Write|Edit and Bash.
# SEC-013 classifier stage: Write|Edit only. The Bash channel's CRED_VALUE and the mirrors that point here
# (detect-secret-file-write.sh, advisory-egress-secret.sh, scripts/agent_lifecycle/secret_scan.py) apply the
# generic entry bare: stricter on references, blind to the quoted literals the added generator judges.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"
if [[ -r "${BASH_SOURCE%/*}/lib/pipe-drain.sh" ]]; then
  # shellcheck source=lib/pipe-drain.sh
  source "${BASH_SOURCE%/*}/lib/pipe-drain.sh"
else
  # Library missing or unreadable → the same drain_after in place, so the hook keeps its verdict.
  # A test, not a failed source: bash 3.2 exits on a missing sourced file even inside a condition.
  drain_after() {
    local rc=0
    "$@" || rc=$?
    cat >/dev/null || true # GA-ABSORB[benign]: the drain only empties the pipe after the verdict is taken
    return "${rc}"
  }
fi

# WHY fail-closed: field extraction degrades to EMPTY without python3 (tool_name
# mis-detects, content scans nothing), which would let a credential write through
# unscanned. A secret gate MUST refuse rather than silently allow — block here so
# no unscanned write can proceed on a python3-less PATH.
hook_require_python3 "SEC-017" \
  "Secret scan unavailable: python3 is required to parse hook input"

# Payload names: an inherited export would carry them into every child's environment, capped per string on Linux.
export -n INPUT CMD CONTENT input blob cmd
INPUT=$(hook_read_input)
TOOL_NAME=$(hook_get_field "${INPUT}" "tool_name")

# Structured + format secret patterns (Write|Edit content channel).
# High-signal patterns: structured-token shapes + the generic credential
# assignment (SEC-013: a candidate generator only, judged by the classifier
# below) + PEM private-key headers + cloud service-account JSON markers.
# NOTE: a literal-dash-leading pattern (PEM "-----BEGIN") MUST be matched with
# `grep -E --` so BSD grep does not parse it as an option flag.
PATTERNS=(
  'AKIA[0-9A-Z]{16}'
  'ghp_[a-zA-Z0-9]{36}'
  'sk-[a-zA-Z0-9]{20,}'
  'eyJ[a-zA-Z0-9_-]*\.eyJ'
  'postgres://[^ ]*@'
  'mongodb(\+srv)?://[^ ]*@'
  'AIza[0-9A-Za-z_-]{35}'
  'xox[bpoa]-[0-9a-zA-Z-]+'
  '(password|passwd|api[_-]?key|secret|token|access[_-]?key|aws_secret_access_key)["'"'"' ]*[:=][ ]*["'"'"']?[^[:space:]"'"'"']{8,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '"private_key"[ ]*:[ ]*"-----BEGIN'
  '"type"[ ]*:[ ]*"service_account"'
)
CODES=(SEC-001 SEC-002 SEC-003 SEC-004 SEC-005 SEC-006 SEC-007 SEC-008 SEC-013 SEC-014 SEC-015 SEC-015)
NAMES_EN=(
  "AWS Access Key"
  "GitHub Token"
  "API Key (sk-)"
  "JWT Token"
  "DB connection string"
  "MongoDB connection string"
  "Google API Key"
  "Slack Token"
  "Generic credential assignment"
  "PEM private key"
  "Service-account private key"
  "Service-account JSON marker"
)

# Scan a blob against every PATTERNS entry; exit 2 on the first match.
# SEC-013 goes through the classifier, so a cleared candidate lets the later structured rules run.
# Args: $1=blob to scan
scan_content() {
  local blob="${1}" i
  [[ -z "${blob}" ]] && return 0
  for i in "${!PATTERNS[@]}"; do
    if [[ "${CODES[${i}]}" == "SEC-013" ]]; then
      scan_generic_credential "${blob}" "${PATTERNS[${i}]}"
      continue
    fi
    # `-i` for case-insensitive credential keys · `--` so a dash-leading PEM
    # pattern is not parsed as a grep option flag.
    # shellcheck disable=SC2310  # the reader's status is the verdict; errexit has nothing else to catch
    if printf '%s\n' "${blob}" | drain_after grep -qiE -- "${PATTERNS[${i}]}"; then
      emit_error "${CODES[${i}]}" "block" \
        "Secret pattern detected: ${NAMES_EN[${i}]}" \
        "Replace the hardcoded secret with an environment-variable reference (core-security.md -> Secret Management)" \
        "{\"pattern\":\"${CODES[${i}]}\"}"
      exit 2
    fi
  done
}

# Block as "secret scan unavailable": any state the scan cannot judge refuses the write.
# Args: $1=message
block_unavailable() {
  emit_error "SEC-017" "block" "${1}" \
    "Report this to the orchestrator with the hook name validate-secret-scan; do not retry the write in another form" \
    '{"pattern":"SEC-017"}'
  exit 2
}

# SEC-013: grep with the unchanged PATTERNS entry is the existence gate and names the candidate lines;
# the classifier clears a candidate only through a named reference class and also judges the quoted
# literals after a key that the entry cannot reach. Any state other than an explicit "clear" blocks.
# Args: $1=blob $2=PATTERNS' generic entry
scan_generic_credential() {
  local blob="${1}" pattern="${2}" key_rc=0 flagged src out rc=0
  # The entry's key alternation (text before its first `["`) absent → neither generator has a candidate.
  # shellcheck disable=SC2310  # the reader's status is the verdict; errexit has nothing else to catch
  printf '%s\n' "${blob}" | drain_after grep -qiE -- "${pattern%%\[\"*}" || key_rc=$?
  ((key_rc == 1)) && return 0
  ((key_rc == 0)) || block_unavailable "Secret scan unavailable: the key-word gate failed"
  flagged="$(printf '%s\n' "${blob}" | { grep -niE -- "${pattern}" || (($? == 1)); } | cut -d: -f1)" \
    || block_unavailable "Secret scan unavailable: the candidate-line gate failed"
  src="$(get_classifier_src)"
  # Classifier stderr dropped: a traceback can quote the scanned text; its status alone decides.
  # GA-ABSORB[handled@scan_generic_credential-rc-branch]: a non-zero classifier status blocks as SEC-017 below
  out="$(python3 -c "${src}" "${pattern}" "${flagged}" <<<"${INPUT}" 2>/dev/null)" || rc=$?
  ((rc == 0)) || block_unavailable "Secret scan unavailable: the credential classifier failed"
  [[ "${out}" == "clear" ]] || block_generic_credential "${out}"
}

# Emit the SEC-013 block: rule code, line and key word, never the value.
# Args: $1=classifier verdict "block <line> <key> <0|1 test path>"
block_generic_credential() {
  local verdict line key in_test fixture_route=""
  IFS=' ' read -r verdict line key in_test <<<"${1}"
  [[ "${verdict}" == "block" && "${line}" =~ ^[0-9]+$ && "${key}" =~ ^[a-z_]+$ ]] \
    || block_unavailable "Secret scan unavailable: unreadable classifier verdict"
  [[ "${in_test}" == "1" ]] && fixture_route=" In this test path, a fixture value must be visibly fake."
  emit_error "SEC-013" "block" \
    "Secret pattern detected: Generic credential assignment (key ${key}, line ${line})" \
    "A real secret moves to an environment-variable reference (core-security.md -> Secret Management).${fixture_route} A suspected false positive goes to the orchestrator with the hook name validate-secret-scan and the code SEC-013; rewording the code to get past the hook is not a route." \
    "{\"pattern\":\"SEC-013\",\"line\":${line},\"key\":\"${key}\"}"
  exit 2
}

# Bash channel (HIGH SIGNAL ONLY).
# Block a credential VALUE written into a dotenv/secrets file via Bash.
# Anti-FP gate: require BOTH a secrets-file write target AND a credential value
# on the command — neither alone blocks (a benign `echo hello`, an `echo to
# app.log`, a `tee app.log`, a `dd of=backup.img`, or a placeholder `KEY=` →
# .env, all pass).
#   SECRET_TARGET — the secrets file (basename .env / .envrc / secrets* /
#                   credentials*) appearing as a write target across nine
#                   shell write methods, OR'd into one coherent alternation:
#                     (1) `>`/`>>` redirect   (2) heredoc → secrets file
#                     (3) `tee`/`tee -a` arg  (4) `dd of=` target
#                     (5) inline python/node `open('<secretsfile>','w'|'a')`
#                     (6) `cp`/`mv` whose DESTINATION (final positional arg) is a
#                         secrets-file name — a pre-staged file copied/moved INTO
#                         a .env/secrets name.
#                     (7) `sed -i`/`sed --in-place` whose terminal positional arg
#                         is a secrets file — an in-place stream edit that injects
#                         a credential without any `>`/`tee`/`cp` token.
#                     (8) `install` whose DESTINATION (final positional arg) is a
#                         secrets file — `install` copies stdin (`/dev/stdin`) or a
#                         source file to the target.
#                     (9) `ed` whose terminal positional arg is a secrets file — a
#                         line editor in-place write (`printf '...' | ed .env`).
#                   `tee`/`dd`/`cp`/`mv`/`sed`/`install`/`ed` are word-boundary-
#                   anchored (start | space | pipe | `;`/`&`) so `systee`/`scp`/
#                   `mvcmd`/`embed`/`uninstall` substrings do not match. The
#                   `cp`/`mv`/`sed -i`/`install`/`ed` destination is terminal-token-
#                   anchored (secrets file is the LAST positional arg, followed by a
#                   command terminator `;`/`&`/`|`, a `#` shell comment, a `<`
#                   redirect [the `install /dev/stdin .env <<<` here-string idiom],
#                   or end-of-line) so a SOURCE arg that merely looks like a secrets
#                   file (e.g. `cp config.env.example dist/`) does NOT match — only a
#                   true secrets DESTINATION does. `sed` additionally requires an
#                   in-place flag (`-i`/`--in-place`), so a benign
#                   `sed -i 's/x/y/' file.txt` to a non-secrets file never matches.
#   CRED_VALUE    — a structured secret token OR a generic credential assignment
#                   with a non-trivial (≥8 char) value (placeholders excluded).
# UNGUARDED residual (coverage boundary — a static command-string scan cannot see
#   runtime-resolved values): variable-expanded redirect target
#   (`F=.env; echo cred > $F`) · variable-indirected secret (`echo "$SECRET" >
#   .env`) · base64/hex-encoded value · bare `cp`/`mv`/`install`/`ed`/`sed -i` of a
#   pre-staged secret file with NO inline credential on the command line (the dual-
#   condition gate needs a visible CRED_VALUE; the pre-staged file's CONTENT is off
#   the command string, so `cp prestaged-secret .env` alone still PASSES — this
#   residual stays open and bounded). Further uncovered in-place channels: any tool
#   that takes a secrets file as a NON-terminal arg (e.g. `sed -i ... .env extra`),
#   `ex`/`vim -c`/`perl -i`/`awk -i inplace` editor variants, and a `tee`/`install`
#   whose target arrives via process substitution — these are additional channels
#   left open by this static heuristic. A PostToolUse filesystem-scan of the WRITTEN
#   file's content would be a SEPARATE detection layer (detection-AFTER-write, NOT
#   prevention) covering the runtime-value residuals above; this PreToolUse hook is a
#   high-signal first line, not a complete exfiltration barrier.
# SECRETS_FILE — reusable basename fragment shared by every method alternative.
SECRETS_FILE='[^ ]*(\.env(\.[a-z]+)?|\.envrc|secrets?(\.[a-z]+)?|credentials?(\.[a-z]+)?)'
SECRET_TARGET='(>>?[ ]*'"${SECRETS_FILE}"'|<<[-]?[ ]*[A-Za-z'"'"'"]*EOF[^ ]*[ ]*>>?[ ]*[^ ]*(\.env|\.envrc|secrets?|credentials?)|(^|[ |;&])tee( +-a)?( +-[^ ]+)* +'"${SECRETS_FILE}"'|(^|[ |;&])dd( +[^ ]+)* +of='"${SECRETS_FILE}"'|open\([ ]*["'"'"'][^"'"'"']*(\.env(\.[a-z]+)?|\.envrc|secrets?(\.[a-z]+)?|credentials?(\.[a-z]+)?)["'"'"'][ ]*,[ ]*["'"'"'](w|a)["'"'"']|(^|[ |;&])(cp|mv)( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#]|$)|(^|[ |;&])sed( +[^ ;&|]+)*( +(-i[^ ]*|--in-place[^ ]*))( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#<]|$)|(^|[ |;&])install( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#<]|$)|(^|[ |;&])ed( +[^ ;&|]+)* +'"${SECRETS_FILE}"'[ ]*([;&|#<]|$))'
CRED_VALUE='(AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|sk-[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|xox[bpoa]-[0-9a-zA-Z-]+|(password|passwd|api[_-]?key|secret|token|access[_-]?key|aws_secret_access_key)["'"'"' ]*[:=][ ]*["'"'"']?[^[:space:]"'"'"']{8,})'

# Inspect a Bash command for a high-signal secret write; exit 2 on match.
# Args: $1=command string
scan_bash_command() {
  local cmd="${1}"
  [[ -z "${cmd}" ]] && return 0
  # shellcheck disable=SC2310  # the reader's status is the verdict; errexit has nothing else to catch
  if printf '%s\n' "${cmd}" | drain_after grep -qiE -- "${SECRET_TARGET}" \
    && printf '%s\n' "${cmd}" | drain_after grep -qiE -- "${CRED_VALUE}"; then
    emit_error "SEC-016" "block" \
      "Secret written to a dotenv/secrets file via Bash" \
      "Do not write credentials into .env/secrets files (redirect/heredoc/tee/dd/open/cp/mv/sed-i/install/ed); use env vars or a secret manager" \
      "{\"channel\":\"bash\"}"
    exit 2
  fi
}

# SEC-013 classifier source (python3). argv: PATTERNS' generic entry, grep-flagged line numbers; stdin: the
# hook envelope. Prints "clear" or "block <line> <key word> <0|1 test path>"; any exception exits non-zero.
get_classifier_src() {
  cat <<'PY'
import bisect, json, os, re, sys

ERE = sys.argv[1]
FLAGGED = {int(n) for n in sys.argv[2].split()}
KEY_AT = re.compile("(?=" + ERE[:ERE.index('["')] + ")", re.I | re.A)
GREP_AT = re.compile("(?=" + ERE.replace("[:space:]", r"\s") + ")", re.I | re.A)
SEP = re.compile(r"""["'\s]*([:=])""")
RUN = re.compile(r"""[^\s"']+""")
LEAD_WS = re.compile(r"\s*")
TRAIL = r"[,;)\]}]*"
NAME = r"(?:[A-Z][A-Z0-9_]*|[a-z][a-z0-9_]*)"
PLACEHOLDER = re.compile(r"(?:\$\{" + NAME + r"\}|\{\{\s*" + NAME + r"\s*\}\})")
PLACEHOLDER_RUN = re.compile(PLACEHOLDER.pattern + TRAIL)
CALL = re.compile(r"[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*[(\[]", re.A)
MEMBER = re.compile(r"([A-Za-z_$][\w$]*)(?:\??\.[A-Za-z_$][\w$]*)+" + TRAIL, re.A)
IDENT = re.compile(r"([A-Za-z_$][\w$]*)" + TRAIL, re.A)
BIND = re.compile(r":[A-Za-z_]\w*" + TRAIL, re.A)
CAST = re.compile(r":(?:[a-z_]+|[A-Z_]+)[0-9]{0,2}(?:\([0-9, ]*\))?(?:\[\])?(?=[\s,;()\[\]]|$)")
WORD = re.compile(r"(?<![\w$])[A-Za-z_$][\w$]*", re.A)
KEY_NAME = re.compile(r"[A-Za-z_.\-]+")
LOOKUP = re.compile(r"(?:(?:\.get|\bgetenv|\bENV\.fetch)\s*\(|(?:\benviron|\bprocess\.env|\bENV|\benv|\bconfig|\bsettings)\s*\[)\s*[bBrRuUfF]{0,2}$")
QUOTED = re.compile(r"""(["'`])([^"'`\n]*?)\1""")
MARKER = re.compile(r"(?:fake|dummy|fixture)[-_][A-Za-z0-9_-]+", re.I)
TEST_SUFFIX = re.compile(r"[^.]+(?:\.[^.]+)*\.(?:test|spec)\.[A-Za-z0-9]+")
TEST_DIRS = {"test", "tests", "__tests__"}
CLIKE = {"ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "java", "kt", "kts", "rs", "swift", "cs",
         "scala", "dart", "c", "cc", "cpp", "h", "hpp"}
CODE = {"clike", "py", "rb", "php"}
REF_FAMILIES = CODE | {"sql"}
OPENER = {fam: re.compile(src) for fam, src in {
    "clike": r'//|/\*|"""|["\'`]',
    "py": r"#|\"\"\"|'''|[\"']",
    "rb": r'#|<<[-~]?([\'"]?)([A-Za-z_]\w*)\1|["\'`]',
    "php": r'//|#|/\*|<<<[ \t]*([\'"]?)([A-Za-z_]\w*)\1|["\'`]',
    "sql": r'--|/\*|["\']',
    "shell": r'<<-?[ \t]*([\'"]?)([A-Za-z_]\w*)\1|["\']',
    "plain": r'["\']',
}.items()}
LINE_COMMENTS = {"//", "#", "--"}
MAX_FILE = 1 << 20
QUOTE_BODY = {}


def get_family(path):
    base = os.path.basename(path).lower()
    _, dot, ext = base.lstrip(".").rpartition(".")
    if not dot:
        return "plain" if base.startswith(".") else "shell"
    if ext in CLIKE:
        return "clike"
    if ext in ("py", "pyi"):
        return "py"
    if ext in ("rb", "php", "sql"):
        return ext
    return "shell" if ext in ("sh", "bash", "zsh", "ksh") else "plain"


# Comment and string spans (start, end, kind, delimiter length, closed); everything outside is code.
def get_spans(text, fam):
    spans, i = [], 0
    while True:
        m = OPENER[fam].search(text, i)
        if not m:
            return spans
        end, closed = get_span_end(text, m, fam)
        kind = "c" if m.group(0) in LINE_COMMENTS or m.group(0) == "/*" else "s"
        spans.append((m.start(), end, kind, len(m.group(0)), closed))
        i = max(end, m.end())


def get_span_end(text, m, fam):
    tok, body = m.group(0), m.end()
    if tok in LINE_COMMENTS:
        return get_found(text.find("\n", body), 0, len(text))
    if tok in ("/*", '"""', "'''"):
        close = "*/" if tok == "/*" else tok
        return get_found(text.find(close, body), len(close), len(text))
    if tok.startswith("<<"):
        return get_heredoc_end(text, m)
    return get_quote_end(text, body, tok, tok == "`" or (fam == "sql" and tok == "'"))


def get_found(at, width, n):
    return (n, False) if at < 0 else (at + width, width > 0)


def get_heredoc_end(text, m):
    indent = r"[ \t]*" if m.group(0)[2:3] in ("-", "~", "<") else ""
    line_end = text.find("\n", m.end())
    close = None
    if line_end >= 0:
        close = re.compile("^" + indent + re.escape(m.group(2)) + r"\b.*$", re.M).search(text, line_end + 1)
    return (close.end(), True) if close else (len(text), False)


# A quote closes at its own character; a single-line one also ends, unclosed, at its line's end.
def get_quote_end(text, i, q, multi):
    if (q, multi) not in QUOTE_BODY:
        stop = re.escape(q) + ("" if multi else r"\n")
        QUOTE_BODY[q, multi] = re.compile(r"(?:\\[\s\S]|[^\\" + stop + "])*")
    e = QUOTE_BODY[q, multi].match(text, i).end()
    if e < len(text) and text[e] == q:
        return e + 1, True
    return e, False


def read_text(path):
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "rb") as f:
            raw = f.read(MAX_FILE + 1)
    except OSError:
        return None
    return raw.decode("utf-8", "replace") if len(raw) <= MAX_FILE else None


def get_hits(src, old, is_all):
    hits, at = [], src.find(old)
    while at >= 0 and len(hits) <= 50:
        hits.append(at)
        at = src.find(old, at + len(old))
    return hits if hits and len(hits) <= 50 and (len(hits) == 1 or is_all) else []


# Edit → the post-edit file text, the fragment's offset in it, and whether its string state is unknown.
def get_edit_text(scan, ti):
    if not scan.path or not os.path.lexists(scan.path):
        return scan.blob, 0, False  # no file → the Edit cannot land
    src, old = read_text(scan.path), ti.get("old_string")
    if src is None or not isinstance(old, str) or not old:
        return scan.blob, 0, True
    hits = get_hits(src, old, ti.get("replace_all") is True)
    if not hits:
        return scan.blob, 0, False  # no unique old_string → the Edit cannot land
    spans = get_spans(src, scan.fam)
    if any(s < h < e for h in hits for s, e, *_ in spans):
        return scan.blob, 0, True
    return src[:hits[0]] + scan.blob + src[hits[0] + len(old):], hits[0], False


def get_text(ti, key):
    value = ti.get(key, "")
    return value if isinstance(value, str) else ""


def get_below_root(path, cwd):
    d = os.path.dirname(path)
    while d not in ("/", ""):
        if os.path.exists(os.path.join(d, ".git")):
            return path[len(d) + 1:]
        d = os.path.dirname(d)
    root = cwd.rstrip("/")
    return path[len(root) + 1:] if root and path.startswith(root + "/") else path[1:]


# Closed test-path set on the path below the project root; dotenv, secrets and credentials names never qualify.
def get_is_test(path, cwd):
    if not path.startswith("/"):
        return False
    segs = get_below_root(path, cwd).split("/")
    base = segs[-1].lower()
    if any(s in ("", ".", "..") for s in segs) or base.startswith(".env") or base.endswith(".env"):
        return False
    if "secret" in base or "credential" in base:
        return False
    return any(s in TEST_DIRS for s in segs[:-1]) or bool(TEST_SUFFIX.fullmatch(segs[-1]))


class Scan:
    def __init__(self, env):
        ti = env.get("tool_input") or {}
        self.path, self.cwd = get_text(ti, "file_path"), get_text(env, "cwd")
        self.fam = get_family(self.path)
        self.blob = get_text(ti, "content") + get_text(ti, "new_string")
        is_edit = env.get("tool_name") == "Edit" and not get_text(ti, "content")
        self.text, self.offset, is_doubt = get_edit_text(self, ti) if is_edit else (self.blob, 0, False)
        self.spans = [(0, len(self.text), "s", 0, False)] if is_doubt else get_spans(self.text, self.fam)
        self.starts = [s[0] for s in self.spans]
        self.words = self.values = self.is_test = None

    def get_span_at(self, x):
        idx = bisect.bisect_right(self.starts, x) - 1
        return idx if idx >= 0 and x < self.spans[idx][1] else -1

    def get_is_test(self):
        if self.is_test is None:
            self.is_test = get_is_test(self.path, self.cwd)
        return self.is_test

    # C4: another occurrence in code, outside every candidate's value (a declaration or use site).
    def has_other(self, name, at):
        if self.words is None:
            self.words, self.values = {}, get_value_positions(self.text)
            for w in WORD.finditer(self.text):
                self.words.setdefault(w.group(0), []).append(w.start())
        return any(p != at and self.get_span_at(p) < 0 and p not in self.values for p in self.words.get(name, ()))


def get_value_positions(text):
    covered, pos = set(), 0
    for line in text.split("\n"):
        for m in KEY_AT.finditer(line):
            sep = SEP.match(line, m.start() + len(m.group(1)))
            run = sep and RUN.match(line, LEAD_WS.match(line, sep.end()).end())
            if run:
                covered.update(range(pos + run.start(), pos + run.end()))
        pos += len(line) + 1
    return covered


def merge(a, b):
    return "block" if "block" in (a, b) else ("clear" if "clear" in (a, b) else None)


def judge_literal(scan, value):
    value = value.rstrip(",;")
    is_marked = len(value) <= 24 and MARKER.fullmatch(value)
    return "clear" if is_marked and scan.get_is_test() else "block"


def judge_quoted(scan, idx):
    s, end, _, width, closed = scan.spans[idx]
    content = scan.text[s + width:end - width if closed else end]
    if len("".join(content.split())) < 8:
        return None
    line_start = scan.text.rfind("\n", 0, s) + 1
    if scan.fam in CODE and KEY_NAME.fullmatch(content) and LOOKUP.search(scan.text[line_start:s]):
        return "clear"  # C6: a lookup's first argument or subscript, key-name-shaped
    return "clear" if PLACEHOLDER.fullmatch(content.strip()) else judge_literal(scan, content)


def judge_comment(scan, idx, line_end):
    s, end = scan.spans[idx][:2]
    verdict = None
    for q in QUOTED.finditer(scan.text, s, min(end, line_end)):
        if len("".join(q.group(2).split())) >= 8:
            verdict = merge(verdict, judge_literal(scan, q.group(2)))
    return verdict


# C5: every quoted literal after the separator on the line, whatever precedes it.
def judge_tail(scan, line, pos, e):
    verdict, line_end = None, pos + len(line)
    for idx in range(bisect.bisect_left(scan.starts, pos + e), len(scan.spans)):
        if scan.spans[idx][0] >= line_end or verdict == "block":
            break
        kind = scan.spans[idx][2]
        verdict = merge(verdict, judge_quoted(scan, idx) if kind == "s" else judge_comment(scan, idx, line_end))
    return verdict


def is_reference(scan, value, at):
    if PLACEHOLDER_RUN.fullmatch(value):
        return True
    if scan.fam not in REF_FAMILIES:
        return False  # C3: config, shell, markdown and unknown types hold literals
    if CALL.match(value) or (scan.fam == "sql" and BIND.fullmatch(value)):
        return True
    m = MEMBER.fullmatch(value)
    if m:
        return not any(c.isdigit() for c in value) or scan.has_other(m.group(1), at)
    m = IDENT.fullmatch(value)
    return bool(m) and scan.has_other(m.group(1), at)


# The value at the separator: a cast (C2), a quoted literal, or an unquoted run classified by shape.
def judge_value(scan, line, pos, v, is_cast):
    run = RUN.match(line, v)
    value = run.group(0) if run else ""
    if is_cast and scan.fam in REF_FAMILIES and CAST.match(line, v):
        return "clear"
    idx = scan.get_span_at(pos + v)
    if idx >= 0:
        is_opened_here = scan.spans[idx][0] == pos + v and scan.spans[idx][2] == "s"
        return judge_quoted(scan, idx) if is_opened_here else None
    if len(value) < 8:
        return None
    if not is_cast and is_reference(scan, value, pos + v):
        return "clear"
    return judge_literal(scan, value)


# C7: a key in a comment, or a key and value inside one enclosing string, is judged as a literal.
def judge_enclosed(scan, line, v):
    q = 1 if line[v:v + 1] in ('"', "'") else 0
    run = RUN.match(line, v + q)
    return judge_literal(scan, run.group(0)) if run and len(run.group(0)) >= 8 else None


# One key position → (verdict over its value and later literals, whether the value itself was judged).
def judge_key(scan, line, pos, m):
    sep = SEP.match(line, m.start() + len(m.group(1)))
    if not sep:
        return None, False
    e = sep.end()
    is_cast = sep.group(1) == ":" and line[e:e + 1] == ":"
    while not is_cast and line[e:e + 1] in ("=", ">") and e < len(line):
        e += 1
    v = LEAD_WS.match(line, e).end()
    key_span = scan.get_span_at(pos + m.start())
    if key_span >= 0 and (scan.spans[key_span][2] == "c" or scan.get_span_at(pos + v) == key_span):
        verdict = judge_enclosed(scan, line, v)
        return verdict, verdict is not None
    value_verdict = judge_value(scan, line, pos, v, is_cast)
    return merge(value_verdict, judge_tail(scan, line, pos, e)), value_verdict is not None


# C9 + C1: every key on the line is judged; on a grep-flagged line every grep match must have been judged.
def get_line_verdict(scan, line, pos, is_flagged):
    judged = set()
    for m in KEY_AT.finditer(line):
        verdict, is_judged = judge_key(scan, line, pos, m)
        if verdict == "block":
            return m.group(1)
        if is_judged:
            judged.add(m.start())
    if not is_flagged:
        return None
    misses = [g.group(1) for g in GREP_AT.finditer(line) if g.start() not in judged]
    if misses:
        return misses[0]
    if line.isascii() and judged:
        return None
    return (KEY_AT.search(line) or [None, "credential"])[1]  # the two engines disagree → fail closed


def get_key_label(key):
    word = key.lower().replace("-", "_")
    return word[:-3] + "_key" if word in ("apikey", "accesskey") else word


def main():
    scan = Scan(json.load(sys.stdin))
    pos = scan.offset
    for no, line in enumerate(scan.blob.split("\n"), 1):
        key = get_line_verdict(scan, line, pos, no in FLAGGED)
        if key:
            print("block", no, get_key_label(key), int(scan.get_is_test()))
            return
        pos += len(line) + 1
    print("clear")


main()
PY
}

if [[ "${TOOL_NAME}" == "Bash" ]]; then
  CMD=$(hook_get_tool_input "${INPUT}" "command")
  scan_bash_command "${CMD}"
  exit 0
fi

# Default (Write|Edit): scan combined content + new_string. An envelope the scan cannot read exits 3 and
# blocks (fail-closed); only the degenerate-empty set passes: empty stdin ({}), an empty content or new_string.
EXTRACT_PY='
import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    sys.exit(3)
if not isinstance(d, dict):
    sys.exit(3)
if not d:
    sys.exit(0)
ti = d.get("tool_input")
need = {"Write": "content", "Edit": "new_string"}.get(d.get("tool_name"))
if not isinstance(ti, dict) or (need and not isinstance(ti.get(need), str)):
    sys.exit(3)
if any(k in ti and not isinstance(ti[k], str) for k in ("content", "new_string", "file_path")):
    sys.exit(3)
print(ti.get("content", "") + ti.get("new_string", ""))
'
extract_rc=0
# Extraction stderr dropped: a parse traceback can quote the envelope; its status alone decides.
# GA-ABSORB[handled@extract_rc-branch]: a non-zero status blocks as SEC-017 on the next line
CONTENT=$(printf '%s\n' "${INPUT}" | python3 -c "${EXTRACT_PY}" 2>/dev/null) || extract_rc=$?
((extract_rc == 0)) || block_unavailable "Secret scan unavailable: malformed Write|Edit hook input"

scan_content "${CONTENT}"
exit 0
