#!/usr/bin/env bats
# style-ref-readcache.bats — per-session INCREMENTAL Read-path cache for the shared
# style_ref matcher (hooks/lib/style_ref_match.py collect_read_paths).
#
# collect_read_paths formerly full-read the WHOLE session transcript on every fire. It
# now reuses a per-session on-disk cache of the Read-path set accumulated from earlier
# bytes, re-scanning only the [consumed, EOF) tail. A bounded TAIL-read accessor was
# deliberately NOT used — it would drop early-session Reads and raise FALSE
# Gaming-the-Judge WARNs. This suite pins the correctness + optimization contract:
#   (1) the resolved Read-path list + the style_ref match verdict are byte-IDENTICAL
#       to the full-scan baseline — INCLUDING an early read placed beyond any 64KB
#       tail window (a tail-read would miss it; the cache does not).
#   (2) cross-fire accumulation: append a new Read, re-fire → the set grows to the
#       new full-scan baseline while the early read stays counted.
#   (3) cache-hit reuse is genuinely tail-only: a repeat fire on an unchanged
#       transcript reads only the fingerprint header, NOT the whole file (byte tally).
#   (4) a corrupt cache falls OPEN to a full scan (no false miss).
#   (5) the STYLE_REF_READCACHE_OFF kill switch forces a full scan, identical result.
#
# Hermetic: a fixture transcript + a driver.py (exec's the lib exactly as the two
# consumers do) live under mktemp; the cache dir is redirected via
# STYLE_REF_READCACHE_DIR, so no ~/.claude write. Byte-count observability is via an
# `open` shim injected into the lib's exec namespace (counts transcript reads only).

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
LIB="${GA}/hooks/lib/style_ref_match.py"

setup() {
  [[ -f "${LIB}" ]] || skip "lib not found: ${LIB}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"

  WORK="$(mktemp -d -t style-ref-readcache.XXXXXX)"
  export STYLE_REF_MATCH_LIB="${LIB}"
  export TPATH="${WORK}/agent-x.jsonl"
  CACHE_DIR="${WORK}/cache"
  DRIVER="${WORK}/driver.py"

  cat >"${DRIVER}" <<'PY'
import json
import os
import sys

LIB = os.environ["STYLE_REF_MATCH_LIB"]
TPATH = os.environ["TPATH"]


def read_line(name):
    return json.dumps(
        {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": name}}]}
    ) + "\n"


def noise_line(i):
    return json.dumps({"content": [{"type": "text", "text": "x" * 4000, "i": i}]}) + "\n"


def load_ns():
    ns = {}
    with open(LIB, "r", encoding="utf-8") as fh:
        code = fh.read()
    exec(compile(code, LIB, "exec"), ns)  # noqa: S102 — in-repo lib, same as the two consumers
    return ns


def counting_open_factory(counter):
    real_open = open

    def counting_open(path, mode="r", *a, **k):
        fh = real_open(path, mode, *a, **k)
        try:
            same = os.path.samefile(path, TPATH)
        except OSError:
            same = os.path.abspath(path) == os.path.abspath(TPATH)
        if not same:
            return fh

        class _Proxy:
            def __init__(self, f):
                self._f = f

            def read(self, *ra):
                data = self._f.read(*ra)
                counter[0] += len(data)
                return data

            def __enter__(self):
                self._f.__enter__()
                return self

            def __exit__(self, *exc):
                return self._f.__exit__(*exc)

            def __getattr__(self, name):
                return getattr(self._f, name)

        return _Proxy(fh)

    return counting_open


def main():
    cmd = sys.argv[1]

    if cmd == "build":
        with open(TPATH, "w", encoding="utf-8") as fh:
            fh.write(read_line("/abs/EARLY/style-early.ts"))
            for i in range(40):  # ~160KB — safely past any 64KB tail window
                fh.write(noise_line(i))
            fh.write(read_line("/abs/late/style-late.ts"))
        print("OK")
        return

    if cmd == "append":
        with open(TPATH, "a", encoding="utf-8") as fh:
            fh.write(read_line(sys.argv[2]))
        print("OK")
        return

    if cmd == "corrupt-cache":
        cdir = os.environ.get("STYLE_REF_READCACHE_DIR", "")
        for name in os.listdir(cdir):
            fp = os.path.join(cdir, name)
            if os.path.isfile(fp):
                with open(fp, "w", encoding="utf-8") as fh:
                    fh.write("}{ not valid json")
        print("OK")
        return

    if cmd in ("collect", "verdict"):
        ns = load_ns()
        counter = [0]
        ns["open"] = counting_open_factory(counter)
        paths = ns["collect_read_paths"](TPATH)
        if cmd == "collect":
            print("PATHS:" + ",".join(paths))
            print("BYTES:" + str(counter[0]))
        else:
            ref = sys.argv[2]
            print("VERDICT:" + ("true" if ns["style_ref_matches"](ref, paths) else "false"))
        return

    sys.stderr.write("unknown command: %s\n" % cmd)
    sys.exit(2)


main()
PY
}

teardown() {
  [[ -n "${WORK:-}" ]] && rm -rf "${WORK}"
}

# Extract a PREFIX:<value> line emitted by the driver from the captured $output.
field() {
  printf '%s\n' "${output}" | sed -n "s/^${1}://p" | head -1
}

@test "incremental result + verdict are byte-identical to the full-scan baseline (early read beyond a 64KB tail window is still counted)" {
  run python3 "${DRIVER}" build
  [[ "${status}" -eq 0 ]] || return 1

  # Baseline: caching OFF → pure full scan.
  run env STYLE_REF_READCACHE_OFF=1 python3 "${DRIVER}" collect
  [[ "${status}" -eq 0 ]] || return 1
  local base_paths
  base_paths="$(field PATHS)"

  # Incremental: caching ON.
  run env STYLE_REF_READCACHE_DIR="${CACHE_DIR}" python3 "${DRIVER}" collect
  [[ "${status}" -eq 0 ]] || return 1
  local incr_paths
  incr_paths="$(field PATHS)"

  # Order + duplicates identical, not merely set-equal.
  [[ "${base_paths}" == "${incr_paths}" ]] || return 1
  # The early read (offset 0, ~160KB before EOF) survives — a tail-read would drop it.
  [[ "${incr_paths}" == *"style-early.ts"* ]] || return 1
  [[ "${incr_paths}" == *"style-late.ts"* ]] || return 1

  # Verdict parity on the early read (the tail-read false-negative case).
  run env STYLE_REF_READCACHE_OFF=1 python3 "${DRIVER}" verdict "style-early.ts"
  [[ "${status}" -eq 0 ]] || return 1
  local base_verdict
  base_verdict="$(field VERDICT)"
  run env STYLE_REF_READCACHE_DIR="${CACHE_DIR}" python3 "${DRIVER}" verdict "style-early.ts"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(field VERDICT)" == "${base_verdict}" ]] || return 1
  [[ "${base_verdict}" == "true" ]] || return 1
}

@test "cross-fire accumulation: append a new read then re-fire → new full-scan baseline, early read retained" {
  run python3 "${DRIVER}" build
  [[ "${status}" -eq 0 ]] || return 1

  # Fire 1 populates the cache.
  run env STYLE_REF_READCACHE_DIR="${CACHE_DIR}" python3 "${DRIVER}" collect
  [[ "${status}" -eq 0 ]] || return 1

  # Session grows.
  run python3 "${DRIVER}" append "/abs/new/style-new.ts"
  [[ "${status}" -eq 0 ]] || return 1

  # Fire 2 reuses the cached prefix + scans the new tail.
  run env STYLE_REF_READCACHE_DIR="${CACHE_DIR}" python3 "${DRIVER}" collect
  [[ "${status}" -eq 0 ]] || return 1
  local fire2
  fire2="$(field PATHS)"

  # Grown full-scan baseline (caching OFF) for comparison.
  run env STYLE_REF_READCACHE_OFF=1 python3 "${DRIVER}" collect
  [[ "${status}" -eq 0 ]] || return 1
  local grown_base
  grown_base="$(field PATHS)"

  [[ "${fire2}" == "${grown_base}" ]] || return 1
  [[ "${fire2}" == *"style-early.ts"* ]] || return 1
  [[ "${fire2}" == *"style-new.ts"* ]] || return 1
}

@test "cache-hit reuse is tail-only: a repeat fire on an unchanged transcript does not re-read the whole file" {
  run python3 "${DRIVER}" build
  [[ "${status}" -eq 0 ]] || return 1

  # Fire 1: full scan → reads the whole ~160KB fixture.
  run env STYLE_REF_READCACHE_DIR="${CACHE_DIR}" python3 "${DRIVER}" collect
  [[ "${status}" -eq 0 ]] || return 1
  local bytes1
  bytes1="$(field BYTES)"

  # Fire 2 (separate process, unchanged file): reuses cache → reads only the header.
  run env STYLE_REF_READCACHE_DIR="${CACHE_DIR}" python3 "${DRIVER}" collect
  [[ "${status}" -eq 0 ]] || return 1
  local bytes2 paths2
  bytes2="$(field BYTES)"
  paths2="$(field PATHS)"

  # Fire 1 saw the full file; fire 2 the fingerprint header only (<= 1KB).
  [[ "${bytes1}" -gt 100000 ]] || return 1
  [[ "${bytes2}" -le 1024 ]] || return 1
  # Reuse did NOT drop coverage.
  [[ "${paths2}" == *"style-early.ts"* ]] || return 1
  [[ "${paths2}" == *"style-late.ts"* ]] || return 1
}

@test "corrupt cache falls open to a full scan (no false miss)" {
  run python3 "${DRIVER}" build
  [[ "${status}" -eq 0 ]] || return 1

  # Populate then corrupt the cache file.
  run env STYLE_REF_READCACHE_DIR="${CACHE_DIR}" python3 "${DRIVER}" collect
  [[ "${status}" -eq 0 ]] || return 1
  run env STYLE_REF_READCACHE_DIR="${CACHE_DIR}" python3 "${DRIVER}" corrupt-cache
  [[ "${status}" -eq 0 ]] || return 1

  # Baseline for comparison.
  run env STYLE_REF_READCACHE_OFF=1 python3 "${DRIVER}" collect
  [[ "${status}" -eq 0 ]] || return 1
  local base_paths
  base_paths="$(field PATHS)"

  # Fire against the corrupt cache → identical full result.
  run env STYLE_REF_READCACHE_DIR="${CACHE_DIR}" python3 "${DRIVER}" collect
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(field PATHS)" == "${base_paths}" ]] || return 1
  [[ "$(field PATHS)" == *"style-early.ts"* ]] || return 1
}

@test "kill switch STYLE_REF_READCACHE_OFF forces a full scan with an identical result" {
  run python3 "${DRIVER}" build
  [[ "${status}" -eq 0 ]] || return 1

  run env STYLE_REF_READCACHE_DIR="${CACHE_DIR}" python3 "${DRIVER}" collect
  [[ "${status}" -eq 0 ]] || return 1
  local incr_paths
  incr_paths="$(field PATHS)"

  run env STYLE_REF_READCACHE_OFF=1 STYLE_REF_READCACHE_DIR="${CACHE_DIR}" python3 "${DRIVER}" collect
  [[ "${status}" -eq 0 ]] || return 1
  # Full read every time under the switch.
  [[ "$(field BYTES)" -gt 100000 ]] || return 1
  [[ "$(field PATHS)" == "${incr_paths}" ]] || return 1
}
