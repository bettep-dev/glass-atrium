# shellcheck shell=bash
# shellcheck disable=SC2154,SC2312  # SC2154: reads shared globals (TTY/PLATE_*/C_*/G_*/PROG_*/USE_*) assigned by the glass-atrium loader + caps module, present at runtime after the loader sources every TUI module; SC2312: c()/hrule are deliberately invoked inside command substitutions (always succeed via printf, so the masked return carries no signal) — mirrors the loader's file-wide SC2312 disable
# Glass Atrium launcher — render primitives module. SOURCED by the glass-atrium
# entry point (never executed): the shebang, strict mode, IFS, traps and every
# interleaved top-level const/stub (the readonly PLATE_* band, the TTY sink) stay
# loader-owned so re-sourcing never re-arms them. Pure, side-effect-free helpers —
# the fill-math + counter/progress bars, the term-size accessors, the one-plate box
# emitter trio, the CSI width helpers, and the low-level /dev/tty output sinks — all
# reading the loader's file-scope globals (TTY, PLATE_*, C_*/G_*, USE_*) at call time.

# Repeat a single glyph N times into stdout (the horizontal-rule builder). bash-3.2
# safe (no `printf '%0*d' | tr`, which mangles multibyte UTF-8 box chars). Cheap N is
# small (frame widths ≤ ~50), so the append loop cost is negligible.
hrule() {
  local glyph="$1" n="$2" out="" i=0
  while [[ "${i}" -lt "${n}" ]]; do
    out="${out}${glyph}"
    i=$((i + 1))
  done
  printf '%s' "${out}"
}

# _bar_fill — the shared fill-math SoT for build_counter_str + build_progress_bar. (i, n, width)
# → the clamped filled-cell count [0,width], round-not-floor `(i*width + n/2)/n`. Validates the
# DIVISOR only (a non-numeric/empty or non-positive n → 1); width is the caller's already-defaulted
# gauge (counter defaults 8 unvalidated, progress validates to 16 — kept in each caller, by design).
_bar_fill() {
  local i="$1" denom="$2" w="$3" filled=0
  [[ "${denom}" =~ ^[0-9]+$ ]] && [[ "${denom}" -gt 0 ]] || denom=1
  filled=$(((i * w + denom / 2) / denom))
  [[ "${filled}" -gt "${w}" ]] && filled="${w}"
  [[ "${filled}" -lt 0 ]] && filled=0
  printf '%s' "${filled}"
}

# build_counter_str — render an X-of-Y step counter as a fixed-width sub-char block
# bar (evilmartians X-of-Y idiom; mike42 sub-char block resolution). $1=i (1-based)
# $2=N (total). The bar is a constant CELLS-wide gauge: `(i*CELLS)/N` filled PROG_FULL
# cells + the remainder PROG_EMPTY, so the column never jitters as i advances. Glyphs
# come from the shared PROG_FULL/PROG_EMPTY SoT (resolve_glyphs), so --ascii degrades
# the bar to `#`/`.` automatically. Output is the colorless `[bar] i/N ` string; the
# caller wraps it in C_DIM. Both i and N are integers from run_plan (never user input).
build_counter_str() {
  local i="$1" n="$2"
  # $3 (optional) = bar cell width; defaults to the historic narrow 8-cell gauge.
  local cells="${3:-8}" filled empty
  # Round-not-floor fill via the shared _bar_fill SoT (divisor-validated, clamped 0..cells). n stays
  # verbatim for the X/N label. The 8-cell default is unvalidated by design (callers pass integers).
  filled="$(_bar_fill "${i}" "${n}" "${cells}")"
  empty=$((cells - filled))
  printf '%s%s %s/%s ' "$(hrule "${PROG_FULL}" "${filled}")" "$(hrule "${PROG_EMPTY}" "${empty}")" "${i}" "${n}"
}

# build_progress_bar — the DOMINANT run-state progress bar (ITEM 4). Renders ` [<filled><empty>]`
# as TWO colorized runs (filled = full-strength accent, empty = dim) + a small dim ` i/N` suffix.
# Fill = round(i/N * width) (the same round-not-floor as build_counter_str), clamped 0..width.
# $1=i (1-based) · $2=N (total) · $3=bar cell width · $4=filled-run SGR (C_OK / C_ALERT). The
# bar is the visual; the i/N is the secondary numeric readout. Glyphs are the shared PROG_FULL/
# PROG_EMPTY SoT, so --ascii degrades to `#`/`.` automatically.
build_progress_bar() {
  local i="$1" n="$2" width="$3" fill_sgr="${4:-${C_OK}}"
  local filled empty
  # Width validated/defaulted to 16 HERE (caller may pass a bad/empty $3); the shared _bar_fill
  # SoT then does the divisor-validated round-not-floor fill clamped 0..width (identical arithmetic).
  [[ "${width}" =~ ^[0-9]+$ ]] && [[ "${width}" -gt 0 ]] || width=16
  filled="$(_bar_fill "${i}" "${n}" "${width}")"
  empty=$((width - filled))
  printf '%s%s %s' \
    "$(c "${fill_sgr}" "$(hrule "${PROG_FULL}" "${filled}")")" \
    "$(c "${C_DIM}" "$(hrule "${PROG_EMPTY}" "${empty}")")" \
    "$(c "${C_DIM}" "${i}/${n}")"
}

# term_cols — the single COLUMNS accessor: read $COLUMNS, default 80, and reject a
# non-integer value (a stale/garbage COLUMNS must not poison the width math). One SoT
# for the parse+validate idiom shared by draw_menu and the panel-width helper below.
# Drives the INLINE-RUN / panel path only — the fullscreen menu geometry routes through
# the TTY-sourced term_size below ($COLUMNS is 0/unreliable in this non-interactive
# bash-3.2 process; proven under pty).
term_cols() {
  local cols="${COLUMNS:-80}"
  [[ "${cols}" =~ ^[0-9]+$ ]] || cols=80
  printf '%s' "${cols}"
}

# term_size — the TTY-sourced size SoT: emit `cols rows` read from the LIVE terminal
# winsize, not the unreliable $COLUMNS/$LINES env (those are 0 in this non-interactive
# process). PRIMARY: `stty size` queries its stdin fd's winsize directly (so we feed it
# ${TTY}'s fd via <). FALLBACK (per-dimension, when stty yields a bad int): `tput cols`/
# `tput lines` — but tput reads winsize off its STDERR/curses fd, so we point fd 2 at
# the TTY (2>"${TTY}"), NOT stdin (<"${TTY}" returns the stale size). Each int is
# validated ^[0-9]+$ && >0, else defaults cols=80 rows=24.
term_size() {
  local cols=0 rows=0 sz=""
  if [[ -n "${TTY}" ]]; then
    sz="$(stty size <"${TTY}" 2>/dev/null || true)"
  fi
  # stty size prints "rows cols" — split on the single space (IFS is \n\t, so the
  # space-split needs an explicit read with a space IFS).
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

# plate_inner — the single inner-width SoT (was frame_width). 52-cell band,
# narrowing to (cols - 2*margin - 2 rails) on a sub-58-col terminal, floored at
# 24. The wordmark AND the menu now consume this too (they did not before), so
# one width drives every plate. When MENU_INNER_OVERRIDE is set (fullscreen menu),
# it returns that verbatim so every plate in the centered block shares one inner.
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

# strip_csi — the SINGLE CSI-stripper shared by visible_len (width math) and
# sanitize_setup_token (token scrub) so the two cannot drift. Removes ANY CSI run —
# ESC '[' then zero-or-more param/intermediate bytes then a final letter [A-Za-z] —
# not just SGR ('m'); a cursor op (ESC[2J / ESC[K / ESC[u) or a truncated ESC[ with
# no final letter is handled too. TERMINATION-GUARANTEED: each pass either removes a
# complete run (string strictly shortens) or hits the no-final-letter branch and
# breaks — the unmatched tail is NEVER re-appended, so the loop cannot diverge.
# Pure bash 3.2 glob-stripping (no GNU sed); the value stays in a var → never on argv.
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

# visible_len — the COLORLESS display width of a string: strip every CSI sequence
# (via strip_csi), then print the surviving character count. SGR codes are zero-width,
# so byte/char-counting an SGR-wrapped string overcounts; this is the only correct
# width input for the pad math. Every G_* glyph is exactly 1 display column, so
# char-count == display-column here. RULE: double-width CJK / emoji are FORBIDDEN
# in any framed content — they would break the 1-char==1-column equivalence this
# helper relies on, desyncing the right rail.
visible_len() {
  local stripped
  stripped="$(strip_csi "$1")"
  printf '%s' "${#stripped}"
}

# plate_truncate — CSI-aware over-wide-content clamp: bound the VISIBLE width of
# content to `budget` cells, walking char-by-char so an SGR run (zero visible
# cells) is copied verbatim while every other char consumes one cell. Reserves
# the ellipsis width (UTF-8 `…` = 1 cell, ASCII `..` = 2) and appends it, mirroring
# the descw idiom. When color is active, a trailing `\033[0m` is appended so a run
# severed mid-budget cannot bleed past the right rail. Value stays in a var → never
# on argv. Pure bash 3.2 (no GNU tools). Only called by plate_row on `vis > inner`.
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
      # Copy the whole CSI run verbatim (zero visible cells): ESC '[' + params up
      # to and including the final [A-Za-z] letter.
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
  # Trim trailing whitespace before the glyph → always `word…`, never a floating
  # space (mirrors the menu descw ellipsis style).
  out="${out%"${out##*[![:space:]]}"}"
  out="${out}${ell}"
  [[ "${USE_COLOR}" == "true" ]] && out="${out}${esc}[0m"
  printf '%s' "${out}"
}

# plate_row — emit ONE framed content row: margin + left rail + content +
# right-pad to `inner` visible cells + right rail. THE single place a right
# border is computed; no box hand-rolls its own right wall. pad keys on the
# colorless visible_len so SGR-wrapped content still aligns. Over-wide content
# (vis > inner) is clamped via plate_truncate so the right rail always lands on
# the plate column — a no-op at the 80-col target where every row's vis <= inner.
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

# plate_top — emit a box top rail: margin + accent(TL + tab + hrule + TR). The
# tab INCLUDES its own surrounding spaces (e.g. " menu "); empty tab = a full
# rail. The hrule fills (inner - visible tab width) so top spans inner+2 exactly.
plate_top() {
  local inner="$1" tab="${2:-}" accent="${3:-${C_FRAME}}" fill
  fill=$((inner - $(visible_len "${tab}")))
  [[ "${fill}" -lt 0 ]] && fill=0
  tty_out "$(printf '%*s' "${PLATE_LEFT}" "")"
  tty_line "$(c "${accent}" "${G_TL}${tab}$(hrule "${G_H}" "${fill}")${G_TR}")"
}

# plate_bot — emit a box bottom rail: margin + accent(BL + hrule inner + BR).
# Provably spans the SAME width as plate_top = inner+2.
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

# tput wrappers — degrade to a no-op when the capability is absent so a dumb
# terminal never receives a literal escape. Guarded by USE_UTF8/USE_COLOR is not
# right here (cursor moves work on any vt100); guard on tput availability only.
tp() { tput "$@" 2>/dev/null || true; }

# cup_to — move the cursor to an absolute 1-based (row, col) on the TTY. Pure vt100
# CUP (\033[row;colH) — tier/ASCII-independent (the file already emits raw cursor
# control unguarded in redraw_menu), so it needs no USE_COLOR/UTF8 guard. Used by the
# fullscreen menu to anchor the centered block + the bottom-pinned keyhint.
cup_to() { printf '\033[%s;%sH' "$1" "$2" >"${TTY}"; }
