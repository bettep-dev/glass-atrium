# shellcheck shell=bash
# shellcheck disable=SC2034  # assigns the shared C_*/G_*/SPIN_*/PROG_*/USE_* UI globals (declared as stubs in the glass-atrium loader) — read by the render primitives + menu at runtime after the loader sources every TUI module, unresolvable when linted standalone
# Glass Atrium launcher — capability-detection module. SOURCED by the glass-atrium
# entry point (never executed): the shebang, strict mode, IFS, traps and the
# C_*/G_*/SPIN_*/PROG_* global stubs stay loader-owned so re-sourcing never re-arms
# them. Decides the color + glyph tiers once at startup (detect_capabilities ->
# resolve_palette / resolve_glyphs), reading + assigning the loader's file-scope UI
# globals at call time in the same sourced shell.

# === capability detection ==================================================
# Decide the color + glyph tiers ONCE at startup. Order of precedence:
#   --ascii / NO_COLOR / non-TTY  ->  force mono + ASCII
#   COLORTERM=truecolor|24bit     ->  truecolor (tput colors caps at 256, so the
#                                     env var is the only reliable 24-bit signal)
#   tput colors >= 256            ->  256
#   tput colors >= 8              ->  16
#   else                          ->  mono
detect_capabilities() {
  local force_ascii="$1"
  USE_UTF8=false
  USE_COLOR=false
  COLOR_TIER="mono"

  # locale charmap gate for UTF-8 glyphs (box-drawing, caret).
  local charmap=""
  charmap="$(locale charmap 2>/dev/null || true)"
  if [[ "${force_ascii}" != "true" && "${charmap}" == "UTF-8" ]]; then
    USE_UTF8=true
  fi

  # color is OFF on a non-TTY, under NO_COLOR, or with --ascii.
  if [[ "${force_ascii}" == "true" ]]; then return 0; fi
  if [[ -n "${NO_COLOR:-}" ]]; then return 0; fi
  if [[ ! -t 1 ]]; then return 0; fi

  local ncolors=0
  ncolors="$(tput colors 2>/dev/null || printf '0')"
  [[ "${ncolors}" =~ ^[0-9]+$ ]] || ncolors=0

  if [[ "${COLORTERM:-}" == "truecolor" || "${COLORTERM:-}" == "24bit" ]]; then
    USE_COLOR=true
    COLOR_TIER="truecolor"
  elif [[ "${ncolors}" -ge 256 ]]; then
    USE_COLOR=true
    COLOR_TIER="256"
  elif [[ "${ncolors}" -ge 8 ]]; then
    USE_COLOR=true
    COLOR_TIER="16"
  fi
}

# Populate the C_* SGR parameter strings for the active tier. Each role maps to
# its closest representation; mono leaves them empty so c() is a no-op.
resolve_palette() {
  C_ACCENT=""
  C_ALERT=""
  C_INFO=""
  C_OK=""
  C_STRONG=""
  C_DIM=""
  C_FRAME=""
  C_DANGER=""
  case "${COLOR_TIER}" in
    truecolor)
      C_ACCENT="38;2;96;165;250"
      C_ALERT="38;2;251;191;36"
      C_INFO="38;2;106;155;204"
      C_OK="38;2;120;140;93"
      C_STRONG="38;2;250;249;245"
      C_DIM="38;2;176;174;165"
      C_FRAME="38;2;232;230;220"
      C_DANGER="38;2;239;68;68"
      ;;
    256)
      C_ACCENT="38;5;111"
      C_ALERT="38;5;221"
      C_INFO="38;5;68"
      C_OK="38;5;101"
      C_STRONG="38;5;231"
      C_DIM="38;5;145"
      C_FRAME="38;5;254"
      C_DANGER="38;5;203"
      ;;
    16)
      C_ACCENT="94"   # bright blue
      C_ALERT="93"    # bright yellow
      C_INFO="34"     # blue
      C_OK="32"       # green
      C_STRONG="97"   # bright white
      C_DIM="90"      # bright black (gray)
      C_FRAME="37"    # white
      C_DANGER="91"   # bright red
      ;;
    *) : ;; # mono — all empty
  esac
}

# Populate the G_* glyph set for the active glyph tier. UTF-8 gets the rounded box +
# incised status marks; ASCII gets pure-7-bit equivalents (every glyph degrades, no
# UTF-8 ever leaks under --ascii / a non-UTF-8 locale). Width note: the ASCII step
# marks are bracketed words ([ok]/[x]) by deliberate design so a status column stays
# legible without color — the run-plan stamp logic accounts for both widths.
resolve_glyphs() {
  if [[ "${USE_UTF8}" == "true" ]]; then
    G_TL="╭"
    G_TR="╮"
    G_BL="╰"
    G_BR="╯"
    G_H="─"
    G_V="│"
    G_DOT="·"
    G_CARET="✦"
    G_OK="✓"
    G_FAIL="✗"
    G_ARROW_U="↑"
    G_ARROW_D="↓"
    G_ENTER="↵"
    # braille 8-frame spinner (one fixed-width cell per frame) + sub-char block ladder.
    SPIN_FRAMES='⣾ ⢿ ⡿ ⣷ ⣯ ⢟ ⡻ ⣽'
    PROG_FULL="█"
    PROG_EMPTY="░"
  else
    G_TL="+"
    G_TR="+"
    G_BL="+"
    G_BR="+"
    G_H="-"
    G_V="|"
    G_DOT="."
    G_CARET="*"
    G_OK="[ok]"
    G_FAIL="[x]"
    G_ARROW_U="^"
    G_ARROW_D="v"
    G_ENTER="enter"
    SPIN_FRAMES='- \ | /'
    PROG_FULL="#"
    PROG_EMPTY="."
  fi
}
