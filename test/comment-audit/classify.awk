# T0 line-classifier state machine (POSIX awk; macOS BSD /usr/bin/awk compatible).
# Invoked once per file via `awk -v path=... -v mode=shell|ts -f classify.awk FILE`,
# so cross-line state (heredoc queue, open strings, block comments, template literals)
# resets naturally between files. Emits one TSV row:
#   path  comment_lines  code_lines  ratio  shellcheck_count  security_count  extref_count  banner_count
# ratio is the "comment-only" sentinel when code_lines == 0 (no division performed).
function is_boundary(p) {
  return (p == "" || p == " " || p == "\t" || p == ";" || p == "|" || p == "&" || p == "(" || p == ")" || p == "<" || p == ">")
}
function is_all_deco(t,   tmp) {
  tmp = t
  gsub(/[=*~_+#.-]/, "", tmp)
  return (tmp == "")
}
function is_banner(ct,   t) {
  t = ct
  sub(/^[[:space:]]+/, "", t)
  sub(/[[:space:]]+$/, "", t)
  if (t == "") return 0
  # Exclude tooling pragmas / region markers / codegen sentinels so a banner_count=0
  # gate stays safe (§7 banner contract).
  if (t ~ /^(shellcheck|type:|noqa|region|endregion|<editor-fold|<\/editor-fold)/) return 0
  if (t ~ /GENERATED|DO NOT EDIT/) return 0
  # (a) pure decoration rule, or (b) symmetric titled divider / box header.
  if (is_all_deco(t)) { if (length(t) >= 3) return 1; return 0 }
  if (t ~ /^[=*~_+#.-][=*~_+#.-][=*~_+#.-]/ && t ~ /[=*~_+#.-][=*~_+#.-][=*~_+#.-]$/) return 1
  return 0
}
function is_extref(t) {
  # Runs only over the comment text, so a URL/A01-looking substring inside a code string
  # literal is never reached — string-awareness for free (§7 preserve floor).
  if (t ~ /https?:\/\//) return 1
  if (t ~ /RFC ?[0-9]+/) return 1
  if (t ~ /LLM[0-9][0-9]/) return 1
  if (t ~ /(^|[^A-Za-z])A[0-9][0-9]([^0-9]|$)/) return 1
  if (t ~ /[A-Za-z0-9_-]+\.md/) return 1
  return 0
}
function strip_ts_marker(t) {
  sub(/^[[:space:]]*\/\//, "", t)
  sub(/^[[:space:]]*\/\*/, "", t)
  sub(/\*\/[[:space:]]*$/, "", t)
  sub(/^[[:space:]]*\*+/, "", t)
  return t
}
function scan_str(line, i, q,   n, c) {
  n = length(line); i++
  while (i <= n) {
    c = substr(line, i, 1)
    if (c == "\\") { i += 2; continue }
    if (c == q) return i + 1
    i++
  }
  return n + 1
}
function scan_tmpl(line, i,   n, c, depth) {
  n = length(line)
  if (!t_tmpl) { t_tmpl = 1; i++ }
  depth = 0
  while (i <= n) {
    c = substr(line, i, 1)
    if (c == "\\") { i += 2; continue }
    if (depth == 0 && c == "`") { t_tmpl = 0; return i + 1 }
    if (c == "$" && substr(line, i + 1, 1) == "{") { depth++; i += 2; continue }
    if (depth > 0 && c == "}") { depth--; i++; continue }
    i++
  }
  return n + 1
}
function scan_shell(line,   n, i, c, c2, c3, prevc, strip, delim, first, depth, pdepth, wasq) {
  L_hascomment = 0; L_commentcol = 0; L_commenttext = ""
  n = length(line); i = 1; prevc = ""
  # Resume a single- or double-quoted string left open by a previous physical line.
  if (s_sq) {
    while (i <= n) { if (substr(line, i, 1) == "'") { s_sq = 0; i++; prevc = "'"; break } i++ }
    if (s_sq) return
  }
  if (s_dq) {
    while (i <= n) { c = substr(line, i, 1); if (c == "\\") { i += 2; continue } if (c == "\"") { s_dq = 0; i++; prevc = "\""; break } i++ }
    if (s_dq) return
  }
  while (i <= n) {
    c = substr(line, i, 1)
    if (c == "'") {
      i++; while (i <= n && substr(line, i, 1) != "'") i++
      if (i > n) { s_sq = 1; return }
      i++; prevc = "'"; continue
    }
    if (c == "\"") {
      i++
      while (i <= n) { c2 = substr(line, i, 1); if (c2 == "\\") { i += 2; continue } if (c2 == "\"") break; i++ }
      if (i > n) { s_dq = 1; return }
      i++; prevc = "\""; continue
    }
    if (c == "`") {
      i++
      while (i <= n) { c2 = substr(line, i, 1); if (c2 == "\\") { i += 2; continue } if (c2 == "`") break; i++ }
      if (i <= n) i++
      prevc = "`"; continue
    }
    if (c == "\\") { i += 2; prevc = "x"; continue }
    if (c == "$") {
      c2 = substr(line, i + 1, 1)
      if (c2 == "'") {
        i += 2; while (i <= n) { c3 = substr(line, i, 1); if (c3 == "\\") { i += 2; continue } if (c3 == "'") break; i++ }
        if (i <= n) i++; prevc = "'"; continue
      }
      if (c2 == "\"") {
        i += 2; while (i <= n) { c3 = substr(line, i, 1); if (c3 == "\\") { i += 2; continue } if (c3 == "\"") break; i++ }
        if (i <= n) i++; prevc = "\""; continue
      }
      if (c2 == "{") {
        # ${var#pat} / ${#var} — the # inside is an operator, never a comment (D1).
        i += 2; depth = 1
        while (i <= n && depth > 0) { c3 = substr(line, i, 1); if (c3 == "{") depth++; else if (c3 == "}") depth--; i++ }
        prevc = "}"; continue
      }
      if (c2 == "(") {
        i += 2; pdepth = 1
        while (i <= n && pdepth > 0) { c3 = substr(line, i, 1); if (c3 == "(") pdepth++; else if (c3 == ")") pdepth--; i++ }
        prevc = ")"; continue
      }
      if (c2 == "#") { i += 2; prevc = "v"; continue }
      i++; prevc = "$"; continue
    }
    if (c == "<" && substr(line, i + 1, 1) == "<") {
      if (substr(line, i + 2, 1) == "<") { i += 3; prevc = "<"; continue }
      # Heredoc operator (D2). Queue the delimiter; body lines on following physical lines
      # are code/body, never comments, until the closing delimiter is matched.
      i += 2; strip = 0
      if (substr(line, i, 1) == "-") { strip = 1; i++ }
      while (i <= n && (substr(line, i, 1) == " " || substr(line, i, 1) == "\t")) i++
      delim = ""; first = substr(line, i, 1); wasq = 0
      if (first == "'") { wasq = 1; i++; while (i <= n && substr(line, i, 1) != "'") { delim = delim substr(line, i, 1); i++ } if (i <= n) i++ }
      else if (first == "\"") { wasq = 1; i++; while (i <= n && substr(line, i, 1) != "\"") { delim = delim substr(line, i, 1); i++ } if (i <= n) i++ }
      else if (first == "\\") { wasq = 1; i++; while (i <= n && substr(line, i, 1) ~ /[A-Za-z0-9_]/) { delim = delim substr(line, i, 1); i++ } }
      else { while (i <= n && substr(line, i, 1) ~ /[A-Za-z0-9_]/) { delim = delim substr(line, i, 1); i++ } }
      # A numeric leading token means arithmetic shift (1<<4), not a heredoc.
      if (delim != "" && (wasq == 1 || delim ~ /^[A-Za-z_]/)) { hq_delim[hq_end] = delim; hq_strip[hq_end] = strip; hq_end++ }
      prevc = "D"; continue
    }
    if (c == "#") {
      if (is_boundary(prevc)) {
        L_hascomment = 1; L_commentcol = i; L_commenttext = substr(line, i + 1)
        return
      }
      i++; prevc = "#"; continue
    }
    prevc = c; i++
  }
}
function scan_ts(line,   n, i, c, c2, p, code_seen, comment_any, ctext) {
  L_hascomment = 0; L_hascode = 0; L_commenttext = ""; L_commentcol = 0
  n = length(line); i = 1; code_seen = 0; comment_any = 0; ctext = ""
  if (t_block) {
    p = index(line, "*/")
    if (p == 0) {
      if (line ~ /^[[:space:]]*$/) return
      L_hascomment = 1; L_commenttext = line; return
    }
    ctext = substr(line, 1, p + 1); comment_any = 1
    t_block = 0; i = p + 2
  }
  if (t_tmpl) {
    i = scan_tmpl(line, i); code_seen = 1
    if (t_tmpl) { L_hascode = 1; return }
  }
  while (i <= n) {
    c = substr(line, i, 1); c2 = substr(line, i + 1, 1)
    if (c == "/" && c2 == "/") { comment_any = 1; ctext = ctext substr(line, i); break }
    if (c == "/" && c2 == "*") {
      p = index(substr(line, i + 2), "*/")
      if (p == 0) { t_block = 1; comment_any = 1; ctext = ctext substr(line, i); break }
      ctext = ctext substr(line, i, p + 3); comment_any = 1; i = i + p + 3; continue
    }
    if (c == "'") { i = scan_str(line, i, "'"); code_seen = 1; continue }
    if (c == "\"") { i = scan_str(line, i, "\""); code_seen = 1; continue }
    if (c == "`") { i = scan_tmpl(line, i); code_seen = 1; if (t_tmpl) break; continue }
    if (c != " " && c != "\t") code_seen = 1
    i++
  }
  L_hascomment = comment_any; L_hascode = code_seen; L_commenttext = ctext
}
function tag_preserve_shell(ct,   t) {
  t = ct
  sub(/^[[:space:]]+/, "", t)
  if (t ~ /^shellcheck([[:space:]]|:|$)/) SC++
  if (ct ~ /SECURITY:/) SEC++
  if (is_extref(ct)) XR++
  if (is_banner(ct)) BN++
}
function tag_preserve_ts(ct) {
  if (ct ~ /SECURITY:/) SEC++
  if (is_extref(ct)) XR++
  if (is_banner(strip_ts_marker(ct))) BN++
}
function process_shell_line(line,   lm, pre) {
  # Heredoc body / closing delimiter — never a comment (D2).
  if (hq_head < hq_end) {
    lm = line
    if (hq_strip[hq_head]) sub(/^\t+/, "", lm)
    if (lm == hq_delim[hq_head]) { K++; hq_head++; return }
    if (line ~ /^[[:space:]]*$/) B++; else K++
    return
  }
  if (line ~ /^[[:space:]]*$/) { B++; return }
  if (FNR == 1 && line ~ /^#!/) { K++; return }
  scan_shell(line)
  if (L_hascomment) {
    C++
    # Mixed line (code + trailing comment) counts in BOTH tallies (§7 fx-param-plus-comment).
    pre = substr(line, 1, L_commentcol - 1)
    if (pre ~ /[^[:space:]]/) K++
    tag_preserve_shell(L_commenttext)
  } else {
    K++
  }
}
function process_ts_line(line) {
  if (!t_block && !t_tmpl && line ~ /^[[:space:]]*$/) { B++; return }
  scan_ts(line)
  if (L_hascomment && L_hascode) { C++; K++; tag_preserve_ts(L_commenttext) }
  else if (L_hascomment) { C++; tag_preserve_ts(L_commenttext) }
  else if (L_hascode) { K++ }
  else { B++ }
}
{
  if (mode == "ts") process_ts_line($0)
  else process_shell_line($0)
}
END {
  if (K == 0) ratio = "comment-only"
  else ratio = sprintf("%.4f", C / K)
  printf "%s\t%d\t%d\t%s\t%d\t%d\t%d\t%d\n", path, C, K, ratio, SC, SEC, XR, BN
}
