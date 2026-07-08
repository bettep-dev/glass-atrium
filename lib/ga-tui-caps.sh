# shellcheck shell=bash
# shellcheck disable=SC2034  # assigns shared C_*/G_*/SPIN_*/PROG_*/USE_* loader-stub globals, read at runtime; unresolvable standalone
# Glass Atrium launcher — capability-detection module. SOURCED (never executed):
# shebang/strict-mode/IFS/traps/C_*/G_*/SPIN_* stubs stay loader-owned so re-sourcing
# never re-arms. Decides color + glyph tiers once at startup (resolve_palette/glyphs).

# capability detection
# Color + glyph tiers decided ONCE at startup. tput colors caps at 256, so COLORTERM
# is the only reliable 24-bit signal (else precedence by tput colors: 256/16/mono).
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

# Populate C_* SGR strings for the active tier; mono leaves them empty so c() is a no-op.
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

# Populate the G_* glyph set for the active tier; ASCII degrades every glyph (no UTF-8
# leak under --ascii). ASCII step marks are variable-width bracketed words ([ok]/[x]) by
# design — the run-plan stamp logic accounts for both widths.
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
    # braille 8-frame spinner: one fixed-width cell per frame (anti-jitter).
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
