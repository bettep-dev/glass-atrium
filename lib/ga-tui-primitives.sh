# shellcheck shell=bash
# shellcheck disable=SC2154,SC2312  # SC2154: reads shared loader globals (TTY/PLATE_*/C_*/G_*/PROG_*/USE_*) present at runtime; SC2312: c()/hrule run inside command subs (always succeed via printf → masked return no signal), mirrors loader-wide disable
# Glass Atrium launcher — render primitives module. SOURCED (never executed):
# shebang/strict-mode/IFS/traps + readonly PLATE_* band + TTY sink stay loader-owned so
# re-sourcing never re-arms. Pure, side-effect-free helpers (fill-math, bars, term-size
# accessors, plate box emitters, CSI width helpers, /dev/tty sinks).

# Repeat a glyph N times (horizontal-rule builder). bash-3.2-safe: no `printf '%0*d' | tr`,
# which mangles multibyte UTF-8 box chars.
hrule() {
  local glyph="$1" n="$2" out="" i=0
  while [[ "${i}" -lt "${n}" ]]; do
    out="${out}${glyph}"
    i=$((i + 1))
  done
  printf '%s' "${out}"
}

# _bar_fill — shared fill-math SoT (build_counter_str + build_progress_bar). (i,n,width) →
# clamped filled-cell count [0,width], round-not-floor `(i*width + n/2)/n`. Validates the
# DIVISOR only (non-numeric/empty/non-positive n → 1); width is the caller's pre-defaulted gauge.
_bar_fill() {
  local i="$1" denom="$2" w="$3" filled=0
  [[ "${denom}" =~ ^[0-9]+$ ]] && [[ "${denom}" -gt 0 ]] || denom=1
  filled=$(((i * w + denom / 2) / denom))
  [[ "${filled}" -gt "${w}" ]] && filled="${w}"
  [[ "${filled}" -lt 0 ]] && filled=0
  printf '%s' "${filled}"
}

# plate_center_pad — shared centered-pad SoT for the wordmark + bulldog art (both mirror this
# math). $1=content width · $2=out-var name. Sets the out-var to a spaces string centering a
# width-cell block inside the current plate inner: PLATE_LEFT + (plate_inner - width)/2, clamped
# to the PLATE_LEFT floor so a sub-width plate stays flush — the clamp is LIVE for the wordmark
# (no horizontal-fit gate) and a harmless no-op for the art (ART_OK guarantees inner >= width).
# One plate_inner fork per call; the pad string is set via printf -v (no subshell). bash-3.2-safe.
plate_center_pad() {
  local width="$1" out_var="$2" inner pad_n
  inner="$(plate_inner)"
  pad_n=$((PLATE_LEFT + (inner - width) / 2))
  [[ "${pad_n}" -lt "${PLATE_LEFT}" ]] && pad_n="${PLATE_LEFT}"
  printf -v "${out_var}" '%*s' "${pad_n}" ""
}

# build_counter_str — X-of-Y step counter as a fixed-width sub-char block bar. $1=i
# (1-based) $2=N. Constant CELLS-wide gauge so the column never jitters as i advances;
# glyphs from the shared PROG_FULL/PROG_EMPTY SoT (--ascii degrades to `#`/`.`). i,N are
# integers from run_plan (never user input).
build_counter_str() {
  local i="$1" n="$2"
  # $3 (optional) = bar cell width; defaults to the narrow 8-cell gauge.
  local cells="${3:-8}" filled empty
  # Fill via the shared _bar_fill SoT; n stays verbatim for the X/N label. The 8-cell
  # default is unvalidated by design (callers pass integers).
  filled="$(_bar_fill "${i}" "${n}" "${cells}")"
  empty=$((cells - filled))
  printf '%s%s %s/%s ' "$(hrule "${PROG_FULL}" "${filled}")" "$(hrule "${PROG_EMPTY}" "${empty}")" "${i}" "${n}"
}

# build_progress_bar — run-state progress bar. Renders ` [<filled><empty>]` as two
# colorized runs (filled=accent, empty=dim) + a dim ` i/N` suffix. Fill = round-not-floor
# (same as build_counter_str), clamped 0..width. $1=i · $2=N · $3=width · $4=filled SGR.
# Glyphs from the shared PROG_FULL/PROG_EMPTY SoT (--ascii degrades to `#`/`.`).
build_progress_bar() {
  local i="$1" n="$2" width="$3" fill_sgr="${4:-${C_OK}}"
  local filled empty
  # Width validated/defaulted to 16 HERE (caller may pass a bad/empty $3); _bar_fill then
  # does the divisor-validated round-not-floor fill clamped 0..width.
  [[ "${width}" =~ ^[0-9]+$ ]] && [[ "${width}" -gt 0 ]] || width=16
  filled="$(_bar_fill "${i}" "${n}" "${width}")"
  empty=$((width - filled))
  printf '%s%s %s' \
    "$(c "${fill_sgr}" "$(hrule "${PROG_FULL}" "${filled}")")" \
    "$(c "${C_DIM}" "$(hrule "${PROG_EMPTY}" "${empty}")")" \
    "$(c "${C_DIM}" "${i}/${n}")"
}

# term_cols — single COLUMNS accessor: read $COLUMNS, default 80, reject a non-integer
# (stale/garbage COLUMNS must not poison width math). INLINE-RUN / panel path only —
# fullscreen menu geometry uses term_size below ($COLUMNS is 0/unreliable in this
# non-interactive bash-3.2 process, proven under pty).
term_cols() {
  local cols="${COLUMNS:-80}"
  [[ "${cols}" =~ ^[0-9]+$ ]] || cols=80
  printf '%s' "${cols}"
}

# term_size — TTY-sourced size SoT: emit `cols rows` from the LIVE winsize ($COLUMNS/$LINES
# are 0 here). PRIMARY: `stty size` reads its STDIN fd winsize (feed ${TTY} via <). FALLBACK
# (per-dimension): `tput cols`/`tput lines` — tput reads its STDERR/curses fd, so point fd 2
# at the TTY (2>"${TTY}"), NOT stdin (<"${TTY}" returns the stale size). Ints validated >0,
# else cols=80 rows=24.
term_size() {
  local cols=0 rows=0 sz=""
  if [[ -n "${TTY}" ]]; then
    sz="$(stty size <"${TTY}" 2>/dev/null || true)"
  fi
  # stty size prints "rows cols"; explicit space-IFS read needed (IFS is \n\t).
  if [[ -n "${sz}" ]]; then
    local r c
    IFS=' ' read -r r c <<<"${sz}"
    [[ "${r}" =~ ^[0-9]+$ && "${r}" -gt 0 ]] && rows="${r}"
    [[ "${c}" =~ ^[0-9]+$ && "${c}" -gt 0 ]] && cols="${c}"
  fi
  # Per-dimension tput fallback (stderr → TTY so curses reads the live winsize).
  if [[ "${cols}" -le 0 && -n "${TTY}" ]]; then
    local tc
    tc="$(tput cols 2>"${TTY}" || true)"
    [[ "${tc}" =~ ^[0-9]+$ && "${tc}" -gt 0 ]] && cols="${tc}"
  fi
  if [[ "${rows}" -le 0 && -n "${TTY}" ]]; then
    local tl
    tl="$(tput lines 2>"${TTY}" || true)"
    [[ "${tl}" =~ ^[0-9]+$ && "${tl}" -gt 0 ]] && rows="${tl}"
  fi
  [[ "${cols}" -gt 0 ]] || cols=80
  [[ "${rows}" -gt 0 ]] || rows=24
  printf '%s %s' "${cols}" "${rows}"
}

# plate_inner — single inner-width SoT: 52-cell band, narrowing to (cols - 2*margin - 2
# rails) below 58 cols, floored at 24. One width drives every plate. MENU_INNER_OVERRIDE
# set (fullscreen menu) → returned verbatim so every plate in the centered block shares one inner.
plate_inner() {
  if [[ -n "${MENU_INNER_OVERRIDE}" ]]; then
    printf '%s' "${MENU_INNER_OVERRIDE}"
    return 0
  fi
  local cols inner=52
  cols="$(term_cols)"
  [[ "${cols}" -lt 58 ]] && inner=$((cols - (PLATE_MARGIN * 2) - 2))
  [[ "${inner}" -lt 24 ]] && inner=24
  printf '%s' "${inner}"
}

# strip_csi — the SINGLE CSI-stripper shared by visible_len + sanitize_setup_token (so
# they cannot drift). Removes ANY CSI run (ESC '[' + params + final [A-Za-z]), not just
# SGR 'm'. TERMINATION-GUARANTEED: each pass either strictly shortens the string or hits
# the no-final-letter branch and breaks — the unmatched tail is NEVER re-appended, so the
# loop cannot diverge. Pure bash 3.2 glob-strip; value stays in a var → never on argv.
strip_csi() {
  local s="$1" esc before rest mid
  esc=$(printf '\033')
  while [[ "${s}" == *"${esc}["* ]]; do
    before="${s%%"${esc}["*}" # text before the first ESC[ (cannot contain ESC[)
    rest="${s#*"${esc}["}"    # everything after the first ESC[
    mid="${rest%%[A-Za-z]*}"  # params/intermediates up to (not incl.) the final letter
    if [[ "${mid}" == "${rest}" ]]; then
      # No final letter in the tail → truncated/garbage CSI: drop it + stop.
      s="${before}"
      break
    fi
    rest="${rest#"${mid}"}" # rest now begins at the final letter
    s="${before}${rest#?}"  # drop the single final letter, splice the halves
  done
  printf '%s' "${s}"
}

# visible_len — COLORLESS display width: strip every CSI (via strip_csi), then count
# the surviving chars. SGR is zero-width so counting an SGR-wrapped string overcounts;
# every G_* glyph is exactly 1 display column, so char-count == display-column. RULE:
# double-width CJK / emoji are FORBIDDEN in framed content — they break 1-char==1-column
# and desync the right rail.
visible_len() {
  local stripped
  stripped="$(strip_csi "$1")"
  printf '%s' "${#stripped}"
}

# plate_truncate — CSI-aware over-wide clamp: bound VISIBLE width to `budget`, walking
# char-by-char so an SGR run (zero cells) is copied verbatim, every other char = one cell.
# Reserves the ellipsis width (UTF-8 `…`=1, ASCII `..`=2). When color is active a trailing
# `\033[0m` is appended so a run severed mid-budget cannot bleed past the right rail. Value
# stays in a var → never on argv. Called by plate_row on `vis > inner`.
plate_truncate() {
  local content="$1" budget="$2"
  local ell ell_w out="" cells=0 i ch esc
  esc=$(printf '\033')
  if [[ "${USE_UTF8}" == "true" ]]; then
    ell="…"
    ell_w=1
  else
    ell=".."
    ell_w=2
  fi
  local cap=$((budget - ell_w))
  [[ "${cap}" -lt 0 ]] && cap=0
  i=0
  while [[ "${i}" -lt "${#content}" ]]; do
    ch="${content:${i}:1}"
    if [[ "${ch}" == "${esc}" && "${content:$((i + 1)):1}" == "[" ]]; then
      # Copy the whole CSI run verbatim (zero cells): ESC '[' + params + final [A-Za-z].
      out="${out}${ch}["
      i=$((i + 2))
      while [[ "${i}" -lt "${#content}" ]]; do
        ch="${content:${i}:1}"
        out="${out}${ch}"
        i=$((i + 1))
        [[ "${ch}" == [A-Za-z] ]] && break
      done
      continue
    fi
    [[ "${cells}" -ge "${cap}" ]] && break
    out="${out}${ch}"
    cells=$((cells + 1))
    i=$((i + 1))
  done
  # Trim trailing whitespace before the glyph → always `word…`, never a floating space.
  out="${out%"${out##*[![:space:]]}"}"
  out="${out}${ell}"
  [[ "${USE_COLOR}" == "true" ]] && out="${out}${esc}[0m"
  printf '%s' "${out}"
}

# plate_row — emit ONE framed row: margin + left rail + content + right-pad to `inner`
# cells + right rail. THE single place a right border is computed (no box hand-rolls its
# own right wall). pad keys on colorless visible_len so SGR content still aligns. Over-wide
# (vis > inner) clamped via plate_truncate so the right rail always lands on the plate column.
plate_row() {
  local inner="$1" content="$2" vis pad
  vis="$(visible_len "${content}")"
  if [[ "${vis}" -gt "${inner}" ]]; then
    content="$(plate_truncate "${content}" "${inner}")"
    vis="$(visible_len "${content}")"
  fi
  pad=$((inner - vis))
  [[ "${pad}" -lt 0 ]] && pad=0
  printf '%*s%s%s%*s%s\n' \
    "${PLATE_LEFT}" "" \
    "$(c "${C_FRAME}" "${G_V}")" \
    "${content}" \
    "${pad}" "" \
    "$(c "${C_FRAME}" "${G_V}")" >"${TTY}"
}

# plate_top — box top rail: margin + accent(TL + tab + hrule + TR). tab INCLUDES its own
# surrounding spaces (empty tab = full rail); hrule fills (inner - visible tab) so top spans inner+2.
plate_top() {
  local inner="$1" tab="${2:-}" accent="${3:-${C_FRAME}}" fill
  fill=$((inner - $(visible_len "${tab}")))
  [[ "${fill}" -lt 0 ]] && fill=0
  tty_out "$(printf '%*s' "${PLATE_LEFT}" "")"
  tty_line "$(c "${accent}" "${G_TL}${tab}$(hrule "${G_H}" "${fill}")${G_TR}")"
}

# plate_bot — box bottom rail: margin + accent(BL + hrule inner + BR); spans inner+2, same as plate_top.
plate_bot() {
  local inner="$1" accent="${2:-${C_FRAME}}"
  tty_out "$(printf '%*s' "${PLATE_LEFT}" "")"
  tty_line "$(c "${accent}" "${G_BL}$(hrule "${G_H}" "${inner}")${G_BR}")"
}

tty_out() { printf '%s' "$*" >"${TTY}"; }

tty_line() { printf '%s\n' "$*" >"${TTY}"; }

# Wrap text in an SGR color when color is active; otherwise emit text verbatim.
c() {
  local sgr="$1"
  shift
  if [[ "${USE_COLOR}" == "true" && -n "${sgr}" ]]; then
    printf '\033[%sm%s\033[0m' "${sgr}" "$*"
  else
    printf '%s' "$*"
  fi
}

# tput wrappers — no-op when the capability is absent so a dumb terminal never receives a
# literal escape. Do NOT guard on USE_UTF8/USE_COLOR (cursor moves work on any vt100); guard
# on tput availability only.
tp() { tput "$@" 2>/dev/null || true; }

# cup_to — move the cursor to an absolute 1-based (row, col) on the TTY. Pure vt100 CUP
# (\033[row;colH) — tier/ASCII-independent, so no USE_COLOR/UTF8 guard. Used by the
# fullscreen menu to anchor the centered block + bottom-pinned keyhint.
cup_to() { printf '\033[%s;%sH' "$1" "$2" >"${TTY}"; }
