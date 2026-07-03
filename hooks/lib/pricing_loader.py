#!/usr/bin/env python3
"""Shared pricing loader — single SoT resolver for cost pricing.

CID 2026-07-02T1055_pricing-sot_e7b2 — P2 (shared loader).

Replaces the two hand-mirrored PRICING dict copies (the cost-tracker.sh
embedded heredoc + backfill-cost-events.py) with one resolver over the
pricing.json SoT (sibling of this lib's parent dir: hooks/pricing.json).

Public API (interface contract — implementation plan, clauded-docs/58328):
  normalize_model_key(model_key)              — suffix-stripping normalizer
  load_pricing(sot_path=None)                 — validated, memoized SoT load
  rate_for(model_key, effective_date=None, sot_path=None)
                                              — THE resolver (5-step chain)
  is_known(model_key, sot_path=None)          — SoT membership after normalize
  staleness_days(today=None, sot_path=None)   — age of last_verified vs today
  cost_usd(rate, input_tokens, output_tokens, cache_read_tokens,
           cache_creation_tokens)             — the 4-term per-MTok cost math
  BASE_RATE                                   — effective_date sentinel that
                                                selects the base (standard) row

Resolution chain (rate_for): sot -> overlay -> remote -> family_latest ->
fallback. The happy path (SoT hit) performs ZERO network I/O — the remote
step is reachable only after a SoT miss AND an overlay miss. The remote step
iterates the SoT's ordered remote_sources (own-repo #1 format=sot, litellm
#2 format=litellm); the first source returning a sane rate wins and
short-circuits the rest.

F3 own-repo self-refresh (inside step 3, format=sot sources only): when the
fetched document (a) passes full _validate_sot, (b) carries a last_verified
STRICTLY newer than the local SoT's AND within today + 1 day (far-future
lock-in defense [LLM04]), and (c) passes a rate-sanity sweep over EVERY
model base+tier row (_RATE_MAX_PER_MTOK ceiling), the local pricing.json is
atomically REPLACED whole-file (no merge; sibling temp + os.replace), the
load_pricing memo invalidated, and the lookup re-attempted in the refreshed
SoT with the caller's effective_date (windowed tiers honored). Manual local
edits MUST bump last_verified — a newer repo copy overwrites uncommitted
local edits by design. Recovery from a bad local stamp (e.g. a far-future
date that starves refresh): the strictly-newer gate compares against the
LOCAL stamp, so lower/restore the local last_verified (or restore the file
from the repo). A schema-invalid or rate-poisoned fetched doc is untrusted
ENTIRELY (loud reject, no write, no per-model use, chain continues); a
not-newer / future-bound / write-failed refresh degrades to per-model use +
overlay persist exactly as before. PRICING_REMOTE_DISABLE disables the
refresh along with all remote I/O; the happy path never rewrites anything.
Resolution records carry a `refreshed` bool (extra key, backward-safe) —
current callers (hook advisory / backfill) may surface or ignore it.

Env seams:
  PRICING_SOT_PATH        — overrides the SoT file path (test-injected).
  PRICING_REMOTE_DISABLE  — truthy (non-empty, not "0") disables ALL remote
                            sources at once and skips step 3 entirely (test
                            suite / offline operator override / backfill
                            batch default).

Side-effect posture: the loader emits NO per-model pricing advisory — the
resolution label in the returned record makes the CALLER own advisory
emission (hook: stderr + DATA-183; backfill: batch-quiet). The loader's own
stderr is reserved for loud-fail signals only (allowlist reject, remote
failure, sanity reject, overlay corruption / write failure).

Compatibility: Python 3 stdlib only.
"""

import collections
import datetime
import json
import os
import re
import sys
import urllib.parse


class PricingSotError(RuntimeError):
    """Raised when the pricing SoT is missing, unparseable, or schema-invalid.

    Loud-fail by design: pricing must never silently degrade to a partial or
    guessed rate table (shared-self-improve-hygiene Precondition Loud-Fail).
    """


SCHEMA_VERSION_SUPPORTED = 1

# First-class effective_date sentinel: rate_for(effective_date=BASE_RATE)
# selects the base (standard) row — bypassing the None->today default AND
# windowed tiers. The backfill passes it for dateless historical rows so the
# wall clock never leaks into them; the malformed-ISO -> base-row rule in
# _coerce_date remains a defensive fallback, no longer a caller contract.
BASE_RATE = object()

_RATE_FIELDS = ("input", "output", "cache_read", "cache_creation")
# Remote-rate sanity ceiling (per MTok, USD): a fetched rate at/above this is
# rejected as corrupt/poisoned, never persisted [LLM04 integrity validation].
_RATE_MAX_PER_MTOK = 1000.0

# Remote allowlist pin [LLM04] — enforcement lives HERE (code), not in the
# operator-editable SoT JSON: a tampered/typo'd remote_sources[].url must
# never redirect the fetch. Scheme + host + a PER-SOURCE path prefix (keyed
# by the source's name) are all pinned; the SoT url field is config, not the
# trust anchor. A source whose name is absent here is never fetched.
_REMOTE_ALLOWED_SCHEME = "https"
_REMOTE_ALLOWED_HOST = "raw.githubusercontent.com"
_REMOTE_ALLOWED_PATH_PREFIXES = {
    "own-repo": "/bettep-dev/glass-atrium/",
    "litellm": "/BerriAI/litellm/",
}

# litellm per-token field -> SoT per-MTok field (values multiplied by 1e6).
# Verified against the live litellm doc on 2026-07-02: bare "claude-*" keys
# (e.g. "claude-opus-4-8") carry exactly these four per-token cost fields.
_LITELLM_FIELD_MAP = {
    "input": "input_cost_per_token",
    "output": "output_cost_per_token",
    "cache_read": "cache_read_input_token_cost",
    "cache_creation": "cache_creation_input_token_cost",
}

_ENV_SOT_PATH = "PRICING_SOT_PATH"
_ENV_REMOTE_DISABLE = "PRICING_REMOTE_DISABLE"

# Default SoT path: hooks/pricing.json, one level above this lib/ dir. The
# loader is imported as a module (sys.path insert via PRICING_LIB_DIR), so
# __file__ is available even when the CALLER runs under `python3 -c`.
_DEFAULT_SOT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pricing.json"
)

# Model-id shape for family parsing: claude-<family>-<version[-version...]>.
_MODEL_KEY_RE = re.compile(r"^claude-([a-z]+)-(\d+(?:-\d+)*)$")

# Per-process memos. _SOT_CACHE: resolved path -> validated SoT doc.
# _OVERLAY_CACHE: overlay path -> (st_mtime_ns, parsed map) — see
# _read_overlay (one cheap stat per read instead of open+json.load; a batch
# over N unknown-model rows re-parses the overlay once, not N times).
# _REMOTE_FAILED_SOURCES: PER-SOURCE negative memo — a source's name is added
# by its FIRST failure (allowlist reject / timeout / HTTP error / sanity
# reject), which logs loudly once; THAT source is then skipped for the
# remainder of the process while the other sources stay consulted (own-repo's
# expected 404 never poisons litellm). Caps a batch over many unknown-model
# rows at ONE timeout per source instead of N.
_SOT_CACHE = {}
_OVERLAY_CACHE = {}
_REMOTE_FAILED_SOURCES = set()


# --------------------------------------------------------------------------- #
#  Public API                                                                  #
# --------------------------------------------------------------------------- #
def normalize_model_key(model_key):
    """Strip a trailing context-variant suffix (e.g. "[1m]") and a trailing
    -YYYYMMDD snapshot-date suffix so variant model ids resolve to their base
    SoT row. The 1M context window does NOT change the per-1M token rate
    (the bracket is a routing marker, not a price tier), and dated ids like
    "claude-haiku-4-5-20251001" are snapshot aliases of the same base rate.
    Idempotent for keys carrying neither suffix. Moved verbatim from the two
    former mirrors (cost-tracker.sh heredoc + backfill-cost-events.py)."""
    if not model_key:
        return model_key
    base = model_key.split("[", 1)[0]
    base = re.sub(r"-\d{8}$", "", base)
    return base or model_key


def load_pricing(sot_path=None):
    """Read + validate the pricing SoT JSON, memoized per resolved path.

    Path resolution: explicit sot_path arg -> PRICING_SOT_PATH env -> the
    default sibling hooks/pricing.json. Raises PricingSotError on a missing,
    unparseable, or schema-invalid file (loud-fail, never a partial load)."""
    path = _resolve_sot_path(sot_path)
    cached = _SOT_CACHE.get(path)
    if cached is not None:
        return cached
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except OSError as exc:
        raise PricingSotError(
            "pricing SoT unreadable: %s (%s)" % (path, exc)
        ) from exc
    except ValueError as exc:
        raise PricingSotError(
            "pricing SoT is not valid JSON: %s (%s)" % (path, exc)
        ) from exc
    _validate_sot(doc, path)
    _SOT_CACHE[path] = doc
    return doc


def rate_for(model_key, effective_date=None, sot_path=None):
    """Resolve the per-MTok rate for model_key via the 5-step chain.

    Returns a resolution record dict:
      rate           — {input, output, cache_read, cache_creation} per-MTok
      resolution     — one of sot|overlay|remote|family_latest|fallback
      normalized_key — model_key after normalize_model_key
      matched_model  — the model id that supplied the rate
      source         — the winning remote_sources name (remote resolutions,
                       and overlay entries that recorded one); else None
      refreshed      — True iff the local SoT file was F3-self-refreshed
                       during THIS resolution (extra key, backward-safe;
                       callers may surface or ignore it)

    effective_date (datetime.date | ISO str | BASE_RATE | None) keys
    windowed-tier selection; None defaults to today (the hook passes
    get_today(); backfill passes the per-row event_date); BASE_RATE selects
    the base (standard) row explicitly (dateless historical rows); a
    malformed ISO string degrades to the base row (defensive fallback). The
    CALLER owns advisory emission — every non-sot label means the SoT lacks
    a row for this model and an operator add is due."""
    resolved_path = _resolve_sot_path(sot_path)
    sot = load_pricing(resolved_path)
    models = sot["models"]
    key = normalize_model_key(model_key)
    if effective_date is None:
        eff = datetime.date.today()
    elif effective_date is BASE_RATE:
        # First-class base-row selection — _select_rate treats eff=None as
        # "the standard row" (no tier window can match).
        eff = None
    else:
        eff = _coerce_date(effective_date)

    # Step 1 — SoT row (the happy path: zero network I/O by construction).
    if key in models:
        return _build_record(_select_rate(models[key], eff), "sot", key, key)

    # Step 2 — fresh overlay entry (previously fetched remote rate within TTL).
    overlay_hit = _find_fresh_overlay_rate(sot, resolved_path, key)
    if overlay_hit is not None:
        overlay_rate, overlay_source = overlay_hit
        return _build_record(
            overlay_rate, "overlay", key, key, source=overlay_source
        )

    # Step 3 — ordered multi-source remote fetch (global kill-switch first;
    # then per source: failure memo -> allowlist pin, all gated before that
    # source's network I/O; first sane hit wins and short-circuits the rest).
    # format=sot sources may F3-self-refresh the local SoT (whole-file
    # replace) — eff rides along so a post-refresh re-lookup tier-selects on
    # the CALLER's date, not today (backfill passes historical event_dates).
    remote_hit, refreshed = _try_remote_rate(sot, resolved_path, key, eff)
    if refreshed:
        # Re-bind post-replace: steps 4-5 must consult the REFRESHED doc —
        # the pre-refresh sot/models bindings would serve stale
        # family_latest/fallback rows otherwise.
        sot = load_pricing(resolved_path)
        models = sot["models"]
    if remote_hit is not None:
        remote_rate, source_name = remote_hit
        return _build_record(
            remote_rate, "remote", key, key, source=source_name, refreshed=refreshed
        )

    # Step 4 — family-latest (highest same-family version present in the SoT).
    family_key = _find_family_latest(models, key)
    if family_key is not None:
        return _build_record(
            _select_rate(models[family_key], eff),
            "family_latest",
            key,
            family_key,
            refreshed=refreshed,
        )

    # Step 5 — conservative fallback (most-expensive SoT row by invariant).
    fallback_key = sot["fallback_model"]
    return _build_record(
        _select_rate(models[fallback_key], eff),
        "fallback",
        key,
        fallback_key,
        refreshed=refreshed,
    )


def is_known(model_key, sot_path=None):
    """SoT membership after normalization — Python-side parity with the
    monitor's isPricingKnown (both key on the same SoT models set)."""
    return normalize_model_key(model_key) in load_pricing(sot_path)["models"]


def staleness_days(today=None, sot_path=None):
    """Age in days of the SoT last_verified stamp vs today (negative when
    last_verified is in the future). The CALLER compares this against the SoT
    stale_after_days and owns the advisory — the loader never emits one."""
    sot = load_pricing(sot_path)
    if today is None:
        ref = datetime.date.today()
    else:
        ref = _coerce_date(today)
        if ref is None:
            raise ValueError("staleness_days: malformed today value: %r" % (today,))
    verified = datetime.date.fromisoformat(sot["last_verified"])
    return (ref - verified).days


def cost_usd(
    rate, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
):
    """USD cost of a token 4-tuple at a per-MTok rate dict (rate_for's
    record["rate"]). The ONE home of the cost arithmetic, next to
    _RATE_FIELDS — both consumers (cost-tracker heredoc + backfill) delegate
    here, so a rate-field or unit change is a single edit. The 1e6 divisor is
    the SoT unit contract (unit="per_mtok", enforced by _validate_sot)."""
    return (
        input_tokens * rate["input"]
        + output_tokens * rate["output"]
        + cache_read_tokens * rate["cache_read"]
        + cache_creation_tokens * rate["cache_creation"]
    ) / 1_000_000.0


# --------------------------------------------------------------------------- #
#  SoT resolution + validation                                                 #
# --------------------------------------------------------------------------- #
def _resolve_sot_path(sot_path=None):
    path = sot_path or os.environ.get(_ENV_SOT_PATH) or _DEFAULT_SOT_PATH
    return os.path.abspath(os.path.expanduser(path))


def _fail_invalid(path, msg):
    raise PricingSotError("pricing SoT invalid (%s): %s" % (path, msg))


def _validate_sot(doc, path):
    """Schema + value validation for the SoT doc. Raises PricingSotError with
    the offending field named — loud-fail, never a silent partial load."""
    if not isinstance(doc, dict):
        _fail_invalid(path, "top level must be an object")
    version = doc.get("schema_version")
    if version != SCHEMA_VERSION_SUPPORTED:
        _fail_invalid(
            path,
            "unsupported schema_version %r (loader supports %d)"
            % (version, SCHEMA_VERSION_SUPPORTED),
        )
    last_verified = doc.get("last_verified")
    if not isinstance(last_verified, str):
        _fail_invalid(path, "last_verified must be an ISO date string")
    try:
        datetime.date.fromisoformat(last_verified)
    except ValueError:
        _fail_invalid(path, "last_verified is not an ISO date: %r" % last_verified)
    stale_days = doc.get("stale_after_days")
    if isinstance(stale_days, bool) or not isinstance(stale_days, int) or stale_days <= 0:
        _fail_invalid(path, "stale_after_days must be a positive integer")
    # currency/unit are self-documenting guards: the cost math divides by 1e6
    # and reports USD — any other value means the file no longer matches the
    # arithmetic, so reject rather than mis-price silently.
    if doc.get("currency") != "USD":
        _fail_invalid(path, 'currency must be "USD" (cost math assumes USD)')
    if doc.get("unit") != "per_mtok":
        _fail_invalid(path, 'unit must be "per_mtok" (cost math divides by 1e6)')
    sources = doc.get("remote_sources")
    if not isinstance(sources, list) or not sources:
        _fail_invalid(path, "remote_sources must be a non-empty array")
    for idx, source in enumerate(sources):
        label = "remote_sources[%d]" % idx
        if not isinstance(source, dict):
            _fail_invalid(path, "%s must be an object" % label)
        if not isinstance(source.get("name"), str) or not source["name"]:
            _fail_invalid(path, "%s.name must be a non-empty string" % label)
        if not isinstance(source.get("url"), str) or not source["url"]:
            _fail_invalid(path, "%s.url must be a non-empty string" % label)
        # Membership against the single format registry — a format absent
        # from _SOURCE_FORMATS is rejected HERE, so the dispatch sites below
        # can never silently misparse it with another format's semantics.
        if source.get("format") not in _SOURCE_FORMATS:
            _fail_invalid(
                path,
                "%s.format must be one of: %s"
                % (label, ", ".join(sorted(_SOURCE_FORMATS))),
            )
        timeout = source.get("timeout_seconds")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
            _fail_invalid(path, "%s.timeout_seconds must be a positive number" % label)
    overlay_rel = doc.get("overlay_cache_path")
    if not isinstance(overlay_rel, str) or not overlay_rel:
        _fail_invalid(path, "overlay_cache_path must be a non-empty string")
    # SECURITY: overlay-path pin [LLM04] — the overlay is the loader's ONLY
    # write target and the SoT is operator-editable config; an absolute or
    # parent-escaping value would redirect the atomic JSON writes to an
    # arbitrary user-writable path. Resolution is pinned relative to the SoT
    # file's own directory (contract), so both escape shapes are rejected.
    if os.path.isabs(overlay_rel) or ".." in overlay_rel.split("/"):
        _fail_invalid(
            path,
            "overlay_cache_path must be a relative path without '..' segments "
            "(resolved against the SoT file's own directory)",
        )
    ttl = doc.get("overlay_ttl_hours")
    if isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or ttl <= 0:
        _fail_invalid(path, "overlay_ttl_hours must be a positive number")
    models = doc.get("models")
    if not isinstance(models, dict) or not models:
        _fail_invalid(path, "models must be a non-empty object")
    for key, entry in models.items():
        if normalize_model_key(key) != key:
            _fail_invalid(
                path,
                "model key %r is not in normalized form — the resolver looks up "
                "normalized keys, so this row would be unreachable" % key,
            )
        if not isinstance(entry, dict):
            _fail_invalid(path, "models.%s must be an object" % key)
        _validate_rate_fields(entry, "models.%s" % key, path)
        tiers = entry.get("tiers")
        if tiers is None:
            continue
        if not isinstance(tiers, list) or not tiers:
            _fail_invalid(
                path, "models.%s.tiers must be a non-empty array when present" % key
            )
        for idx, tier in enumerate(tiers):
            label = "models.%s.tiers[%d]" % (key, idx)
            if not isinstance(tier, dict):
                _fail_invalid(path, "%s must be an object" % label)
            until = tier.get("until")
            if not isinstance(until, str):
                _fail_invalid(path, "%s.until must be an ISO date string" % label)
            try:
                datetime.date.fromisoformat(until)
            except ValueError:
                _fail_invalid(path, "%s.until is not an ISO date: %r" % (label, until))
            _validate_rate_fields(tier, label, path)
    fallback = doc.get("fallback_model")
    if fallback not in models:
        _fail_invalid(path, "fallback_model %r is not a models key" % (fallback,))
    # Dominance advisory (non-fatal): the fallback row SHOULD dominate every
    # base row — the conservative most-expensive invariant. A violation
    # under-prices unknown models; surface it loudly but keep pricing
    # operational (fail-loud-but-degrade, same posture as the plan's D3).
    fb_rate = models[fallback]
    for key, entry in models.items():
        for field in _RATE_FIELDS:
            if entry[field] > fb_rate[field]:
                sys.stderr.write(
                    "[pricing-loader] WARNING: fallback_model %s does not dominate "
                    "models.%s.%s (%s < %s) — unknown-model pricing is no longer "
                    "conservative; update fallback_model in %s\n"
                    % (fallback, key, field, fb_rate[field], entry[field], path)
                )


def _validate_rate_fields(entry, label, path):
    for field in _RATE_FIELDS:
        value = entry.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            _fail_invalid(path, "%s.%s must be numeric" % (label, field))
        if value <= 0:
            _fail_invalid(path, "%s.%s must be positive" % (label, field))


# --------------------------------------------------------------------------- #
#  Rate selection (tiers + dates)                                              #
# --------------------------------------------------------------------------- #
def _coerce_date(value):
    """datetime.date -> as-is; datetime -> its date; ISO str -> parsed date;
    malformed str / anything else -> None (tier selection then uses the base
    row — a DEFENSIVE fallback; BASE_RATE is the first-class caller spelling
    for deliberate base-row selection)."""
    if isinstance(value, datetime.datetime):
        return value.date()
    if isinstance(value, datetime.date):
        return value
    if isinstance(value, str):
        try:
            return datetime.date.fromisoformat(value)
        except ValueError:
            return None
    return None


def _select_rate(entry, eff):
    """Rate dict (fresh copy) for a model entry, honoring windowed tiers.

    Contract: pick the first tier (ascending `until`) where eff <= until; no
    match OR eff is None -> the base row (the STANDARD post-intro rate)."""
    tiers = entry.get("tiers") or []
    if eff is not None:
        for tier in sorted(tiers, key=lambda t: t["until"]):
            if eff <= datetime.date.fromisoformat(tier["until"]):
                return {field: tier[field] for field in _RATE_FIELDS}
    return {field: entry[field] for field in _RATE_FIELDS}


def _build_record(
    rate, resolution, normalized_key, matched_model, source=None, refreshed=False
):
    return {
        "rate": rate,
        "resolution": resolution,
        "normalized_key": normalized_key,
        "matched_model": matched_model,
        "source": source,
        "refreshed": refreshed,
    }


# --------------------------------------------------------------------------- #
#  Family-latest (step 4)                                                      #
# --------------------------------------------------------------------------- #
def _parse_family(key):
    """(family, version_tuple) for keys like claude-opus-4-8; None on no
    match. Version compares as an int tuple, so (5,) > (4, 6) correctly."""
    if not isinstance(key, str):
        return None
    match = _MODEL_KEY_RE.match(key)
    if not match:
        return None
    return match.group(1), tuple(int(part) for part in match.group(2).split("-"))


def _find_family_latest(models, key):
    """The SoT model id sharing key's family with the highest version tuple,
    or None when no same-family member exists (chain proceeds to fallback)."""
    parsed = _parse_family(key)
    if parsed is None:
        return None
    family = parsed[0]
    best_key = None
    best_version = None
    for candidate in models:
        candidate_parsed = _parse_family(candidate)
        if candidate_parsed is None or candidate_parsed[0] != family:
            continue
        if best_version is None or candidate_parsed[1] > best_version:
            best_key, best_version = candidate, candidate_parsed[1]
    return best_key


# --------------------------------------------------------------------------- #
#  Atomic JSON write (shared by overlay persist + F3 SoT refresh)              #
# --------------------------------------------------------------------------- #
def _write_json_atomic(path, doc):
    """Atomic JSON write: sibling pid-suffixed temp + fsync + os.replace
    (same dir, same FS). On OSError the orphaned temp is best-effort unlinked
    before re-raising — the CALLER owns the error posture (overlay persist:
    loud non-fatal; F3 refresh: WRITE_FAILED outcome). The single home of the
    write discipline (tmp naming, dump kwargs, trailing newline, cleanup)."""
    tmp = "%s.tmp.%d" % (path, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)  # best-effort orphan cleanup; tmp may not exist
        except OSError:
            pass
        raise


# --------------------------------------------------------------------------- #
#  Overlay cache (step 2 read / step 3 persist)                                #
# --------------------------------------------------------------------------- #
def _get_now_utc():
    """UTC now — isolated seam so overlay-TTL tests can monkeypatch time."""
    return datetime.datetime.now(datetime.timezone.utc)


def _get_overlay_path(sot, sot_path):
    """overlay_cache_path resolved relative to the SoT file's own directory
    (contract). Absolute / parent-escaping values are rejected at load by
    _validate_sot [LLM04] — the loader's only write target stays pinned under
    the SoT dir, so a tampered SoT cannot redirect the overlay write."""
    return os.path.join(os.path.dirname(sot_path), sot["overlay_cache_path"])


def _read_overlay(overlay_path):
    """Parsed overlay map, memoized per (path, st_mtime_ns) — the overlay only
    changes via _persist_overlay_rate (which invalidates the memo), so a
    SoT-miss batch pays one cheap stat per call instead of a redundant
    open+json.load. Missing file -> {} (normal, not an error); a
    corrupt/non-object file -> {} with a loud stderr note, never memoized (the
    overlay is a cache — degrade loudly, never crash pricing on it). Callers
    MUST treat the returned map as read-only (shared memo) —
    _persist_overlay_rate copies before mutating."""
    if not os.path.isfile(overlay_path):
        _OVERLAY_CACHE.pop(overlay_path, None)
        return {}
    try:
        mtime_ns = os.stat(overlay_path).st_mtime_ns
    except OSError:
        # Vanished between the isfile check and the stat — treat as missing.
        _OVERLAY_CACHE.pop(overlay_path, None)
        return {}
    cached = _OVERLAY_CACHE.get(overlay_path)
    if cached is not None and cached[0] == mtime_ns:
        return cached[1]
    try:
        with open(overlay_path, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
    except (OSError, ValueError) as exc:
        sys.stderr.write(
            "[pricing-loader] overlay cache unreadable (%s): %s — treating as empty\n"
            % (overlay_path, exc)
        )
        return {}
    if not isinstance(loaded, dict):
        sys.stderr.write(
            "[pricing-loader] overlay cache is not an object (%s) — treating as empty\n"
            % overlay_path
        )
        return {}
    _OVERLAY_CACHE[overlay_path] = (mtime_ns, loaded)
    return loaded


def _find_fresh_overlay_rate(sot, sot_path, key):
    """Fresh (within overlay_ttl_hours) overlay (rate, source_name) for key,
    or None. A stale entry is a MISS by contract — the chain proceeds to
    remote; stale rates are never served. Entries failing rate sanity are
    ignored loudly. source_name is the recorded winning remote_sources name
    (None for entries persisted without one)."""
    overlay = _read_overlay(_get_overlay_path(sot, sot_path))
    entry = overlay.get(key)
    if not isinstance(entry, dict):
        return None
    fetched_raw = entry.get("fetched_at")
    if not isinstance(fetched_raw, str):
        return None
    try:
        fetched = datetime.datetime.fromisoformat(fetched_raw)
    except ValueError:
        sys.stderr.write(
            "[pricing-loader] overlay entry %s has malformed fetched_at %r — ignoring\n"
            % (key, fetched_raw)
        )
        return None
    if fetched.tzinfo is None:
        fetched = fetched.replace(tzinfo=datetime.timezone.utc)
    ttl = datetime.timedelta(hours=sot["overlay_ttl_hours"])
    if _get_now_utc() - fetched > ttl:
        return None
    rate = {field: entry.get(field) for field in _RATE_FIELDS}
    if not _is_rate_sane(rate):
        sys.stderr.write(
            "[pricing-loader] overlay entry %s failed rate sanity — ignoring\n" % key
        )
        return None
    source = entry.get("source")
    return rate, (source if isinstance(source, str) else None)


def _persist_overlay_rate(sot, sot_path, key, rate, source_name):
    """Persist a sanity-passed remote rate into the overlay cache with a
    fetched_at stamp + the winning remote_sources name. Atomic via
    _write_json_atomic; mkdir -p on first write. A write failure is loud but
    non-fatal — the overlay is a cache and the resolved rate has already been
    returned to the caller."""
    overlay_path = _get_overlay_path(sot, sot_path)
    try:
        os.makedirs(os.path.dirname(overlay_path), exist_ok=True)
        # Copy before mutating — _read_overlay may return the shared memo.
        overlay = dict(_read_overlay(overlay_path))
        entry = dict(rate)
        entry["fetched_at"] = _get_now_utc().isoformat()
        entry["source"] = source_name
        overlay[key] = entry
        _write_json_atomic(overlay_path, overlay)
        _OVERLAY_CACHE.pop(overlay_path, None)
    except OSError as exc:
        sys.stderr.write(
            "[pricing-loader] overlay write failed (%s): %s — rate still applied this run\n"
            % (overlay_path, exc)
        )


# --------------------------------------------------------------------------- #
#  Remote fetch (step 3)                                                       #
# --------------------------------------------------------------------------- #
def _is_remote_disabled():
    """PRICING_REMOTE_DISABLE truthy -> skip the remote step (the .bats suite
    sets it for network-free runs; backfill defaults it ON; operators use it
    as an offline override). "0" and empty mean enabled."""
    return os.environ.get(_ENV_REMOTE_DISABLE, "") not in ("", "0")


def _is_remote_url_allowed(url, source_name):
    """Loader-side allowlist pin [LLM04]: scheme + host + the SOURCE'S OWN
    path prefix (+ the default https port) must match the hardcoded constants
    — a litellm url on the own-repo source is as rejected as an evil host.
    Checked BEFORE any network I/O — a non-allowlisted URL is never fetched,
    never persisted. An unknown source name has no pin -> never fetched.
    SECURITY: dot-segment escapes are rejected too — urlsplit does NOT
    normalize '.'/'..' segments while the CDN normalizes server-side, so a
    prefix-passing '../' path (or its percent-encoded '%2e%2e' twin, which
    urlsplit leaves undecoded) would escape the pinned repo on the allowlisted
    host. Any '%' in the raw path is refused outright (neither pinned repo's
    raw path needs percent-escapes) + the segment check runs on the DECODED
    path with segment EQUALITY, so a dotted FILENAME ('pricing.json') still
    passes. Mirrors the overlay_cache_path escape-shape rejection in
    _validate_sot."""
    prefix = _REMOTE_ALLOWED_PATH_PREFIXES.get(source_name)
    if prefix is None:
        return False
    try:
        parts = urllib.parse.urlsplit(url)
    except (ValueError, AttributeError, TypeError):
        return False
    if "%" in parts.path:
        return False
    if any(
        segment in (".", "..")
        for segment in urllib.parse.unquote(parts.path).split("/")
    ):
        return False
    return (
        parts.scheme == _REMOTE_ALLOWED_SCHEME
        and parts.hostname == _REMOTE_ALLOWED_HOST
        and parts.port in (None, 443)
        and parts.path.startswith(prefix)
    )


def _fetch_remote_doc(url, timeout_seconds):
    """Fetch + parse a remote pricing doc (the whole map — SoT-format for
    own-repo, litellm map for litellm).

    Isolated module-level seam — monkeypatched in tests; NEVER invoked on a
    SoT or overlay hit, and never invoked when any step-3 gate (kill-switch /
    per-source failure memo / per-source allowlist pin) fails. Raises on any
    network/HTTP/JSON failure — the caller owns the failure memo + loud log."""
    # Local import: urllib.request pulls in http/email/ssl — keep that cost
    # off the zero-network happy path (hook completes <1s).
    import urllib.request

    # SECURITY: url is pre-validated by _is_remote_url_allowed (https + pinned
    # host/path) before this call — see _try_remote_rate gate order.
    with urllib.request.urlopen(url, timeout=timeout_seconds) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _extract_sot_entry(doc, key):
    """models[key] from a format=sot doc (the remote copy IS a pricing.json)."""
    models = doc.get("models")
    return models.get(key) if isinstance(models, dict) else None


def _extract_litellm_entry(doc, key):
    """doc[key] from a litellm flat map."""
    return doc.get(key)


def _extract_remote_entry(doc, key, source_format):
    """Model entry for key from a fetched doc, dispatched through the
    _SOURCE_FORMATS registry. None = plain miss (the model is absent from
    this source — NOT a failure; iteration proceeds to the next source)."""
    if not isinstance(doc, dict):
        return None
    return _SOURCE_FORMATS[source_format].extract(doc, key)


def _convert_sot_entry(entry):
    """Per-MTok rate dict from a SoT-format models entry — PASSTHROUGH, no
    per-token conversion (a format=sot payload already carries per-MTok
    rates). Base row only: the overlay stores a flat rate, so a remote tier
    window is not date-selected here (the base row IS the standard rate by
    the SoT contract). None when any of the 4 required fields is absent or
    non-numeric (missing-field sanity reject)."""
    if not isinstance(entry, dict):
        return None
    rate = {}
    for field in _RATE_FIELDS:
        value = entry.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        rate[field] = value
    return rate


def _convert_litellm_entry(entry):
    """Per-MTok rate dict from a litellm per-token entry; None when any of the
    4 required fields is absent or non-numeric (missing-field sanity reject).
    The x1e6 product is rounded to 9 decimals (nano-dollar per MTok) to absorb
    IEEE float noise (e.g. 4e-07 * 1e6 -> 0.39999999999999997) — far below any
    real pricing granularity, so cost math is unaffected."""
    if not isinstance(entry, dict):
        return None
    rate = {}
    for ours, theirs in _LITELLM_FIELD_MAP.items():
        value = entry.get(theirs)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        rate[ours] = round(value * 1_000_000.0, 9)
    return rate


# Single source-format registry — the ONE home of per-format semantics:
# extract (doc -> model entry), convert (entry -> per-MTok rate dict),
# self_refresh (format=sot sources may F3-replace the local SoT). _validate_sot
# checks format membership against these keys, so the dispatch lookups can
# never KeyError post-validation — and a format missing from the registry is
# REJECTED at load instead of silently parsed with another format's semantics
# (the latent mispricing hazard of the former scattered if/else defaults).
_SourceFormat = collections.namedtuple(
    "_SourceFormat", ("extract", "convert", "self_refresh")
)
_SOURCE_FORMATS = {
    "sot": _SourceFormat(_extract_sot_entry, _convert_sot_entry, True),
    "litellm": _SourceFormat(_extract_litellm_entry, _convert_litellm_entry, False),
}


def _is_rate_sane(rate):
    """True iff all 4 rate fields are numeric (bool excluded), positive, and
    below _RATE_MAX_PER_MTOK — the remote/overlay integrity gate [LLM04]."""
    for field in _RATE_FIELDS:
        value = rate.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False
        if not 0 < value < _RATE_MAX_PER_MTOK:
            return False
    return True


# _try_sot_refresh outcomes. REPLACED -> local file swapped + memo
# invalidated (caller reloads + re-looks-up); SKIPPED -> no write, per-model
# use proceeds (not-newer / future-bound); REJECTED -> whole doc UNTRUSTED,
# no write AND no per-model use (schema-invalid / rate-poisoned) [LLM04];
# WRITE_FAILED -> replace I/O failed, memo intact, per-model use proceeds.
_REFRESH_REPLACED = "replaced"
_REFRESH_SKIPPED = "skipped"
_REFRESH_REJECTED = "rejected"
_REFRESH_WRITE_FAILED = "write_failed"

# F3 last_verified acceptance bound [LLM04]: a fetched stamp beyond
# today + this many days is refused — a far-future stamp accepted once would
# permanently defeat the strictly-newer gate for every later legitimate
# refresh. 1 day absorbs timezone skew between the repo and this host.
_LAST_VERIFIED_MAX_FUTURE_DAYS = 1


def _find_insane_model_row(doc):
    """Label of the first model base/tier row failing _is_rate_sane, or None
    when every row passes. F3 replace gate [LLM04]: _validate_sot only checks
    numeric+positive — the _RATE_MAX_PER_MTOK ceiling must ALSO hold on every
    row before a whole-file replace durably rewrites all local rates."""
    for key, entry in doc["models"].items():
        if not _is_rate_sane(entry):
            return "models.%s" % key
        for idx, tier in enumerate(entry.get("tiers") or []):
            if not _is_rate_sane(tier):
                return "models.%s.tiers[%d]" % (key, idx)
    return None


def _try_sot_refresh(fetched_doc, local_sot, sot_path, source_name, url):
    """F3 whole-file self-refresh attempt from a fetched format=sot doc.

    Replace gates (ALL must pass, in order):
      1. _validate_sot on the FETCHED doc, labelled by source+url instead of
         a filesystem path — schema-invalid -> REJECTED (untrusted; its
         dominance advisory, if any, fires under the same label).
      2. strictly-newer: fetched last_verified > local last_verified —
         older/equal -> SKIPPED (quiet; the steady state).
      3. future bound: fetched last_verified <= today + skew — beyond ->
         SKIPPED with a loud advisory (lock-in defense [LLM04]).
      4. rate-sanity sweep over EVERY model base+tier row — a poisoned row
         -> REJECTED (never written) [LLM04].

    The replace is whole-file (no merge), atomic via _write_json_atomic (the
    write helper shared with _persist_overlay_rate), followed by a loud
    advisory naming BOTH last_verified values + memo invalidation for
    sot_path. A write OSError -> WRITE_FAILED (loud, memo NOT invalidated;
    the helper unlinks the orphaned temp).

    local_sot arrives pre-validated via load_pricing — an unreadable/invalid
    LOCAL SoT loud-fails in rate_for long before this point and is never
    "recovered" by a refresh (safety: no replace over an unknown local
    state)."""
    label = "remote:%s (%s)" % (source_name, url)
    try:
        _validate_sot(fetched_doc, label)
    except PricingSotError as exc:
        sys.stderr.write(
            "[pricing-loader] own-repo SoT refresh rejected: fetched doc "
            "failed validation — not written, no per-model use, chain "
            "continues (%s)\n" % exc
        )
        return _REFRESH_REJECTED
    local_verified = datetime.date.fromisoformat(local_sot["last_verified"])
    fetched_verified = datetime.date.fromisoformat(fetched_doc["last_verified"])
    if fetched_verified <= local_verified:
        # Steady state (repo copy not newer) — quiet skip, per-model use only.
        return _REFRESH_SKIPPED
    bound = datetime.date.today() + datetime.timedelta(
        days=_LAST_VERIFIED_MAX_FUTURE_DAYS
    )
    if fetched_verified > bound:
        sys.stderr.write(
            "[pricing-loader] own-repo SoT refresh refused: fetched "
            "last_verified %s is beyond today+%dd (%s) — not written; "
            "per-model use only [LLM04 lock-in defense]\n"
            % (fetched_doc["last_verified"], _LAST_VERIFIED_MAX_FUTURE_DAYS, bound)
        )
        return _REFRESH_SKIPPED
    insane_row = _find_insane_model_row(fetched_doc)
    if insane_row is not None:
        sys.stderr.write(
            "[pricing-loader] own-repo SoT refresh rejected: %s fails rate "
            "sanity (must be positive and < %s/MTok) — not written, no "
            "per-model use, chain continues\n" % (insane_row, _RATE_MAX_PER_MTOK)
        )
        return _REFRESH_REJECTED
    try:
        _write_json_atomic(sot_path, fetched_doc)
    except OSError as exc:
        sys.stderr.write(
            "[pricing-loader] own-repo SoT refresh write failed (%s): %s — "
            "local file untouched, continuing with per-model use\n"
            % (sot_path, exc)
        )
        return _REFRESH_WRITE_FAILED
    _SOT_CACHE.pop(_resolve_sot_path(sot_path), None)
    sys.stderr.write(
        "[pricing-loader] local pricing SoT refreshed from %s: last_verified "
        "%s -> %s (%s)\n"
        % (
            source_name,
            local_sot["last_verified"],
            fetched_doc["last_verified"],
            sot_path,
        )
    )
    return _REFRESH_REPLACED


def _try_remote_rate(sot, sot_path, key, eff):
    """Step-3 remote resolution over the ordered remote_sources. Gate order
    (plan contract): the global kill-switch FIRST (disables all sources AND
    the F3 self-refresh); then, per source in DECLARED order, that source's
    failed-fetch memo -> that source's URL allowlist pin — all evaluated
    before that source's network I/O.

    format=sot sources attempt the F3 self-refresh (_try_sot_refresh) BEFORE
    per-model use: a REPLACED local SoT is reloaded and key re-looked-up with
    the caller's eff (windowed tiers honored — sot-tier logic, no overlay
    persist since the row now lives in the SoT); a REJECTED doc is untrusted
    entirely (no per-model use, memo armed); SKIPPED/WRITE_FAILED degrade to
    per-model use exactly as before. A refreshed-but-still-missing key is a
    plain miss (fetched == refreshed doc): no memo, no second fetch, next
    source is consulted.

    Returns (hit, refreshed): hit is (rate, source_name) or None; refreshed
    is True iff the local SoT file was replaced during THIS call (the caller
    re-binds its doc for the rest of the chain). The FIRST source returning
    a sane rate wins, persists to the overlay with its name, and
    SHORT-CIRCUITS the remaining sources; a source failing any gate / fetch
    / sanity fails open to the NEXT source (loud + memoized per source). All
    sources exhausted -> (None, refreshed)."""
    if _is_remote_disabled():
        # Deliberate operator/test choice — silent skip, not a failure.
        return None, False
    refreshed = False
    # Rebound to the refreshed doc after a replace; iteration stays on the
    # PRE-refresh source list for this pass (a refreshed doc's remote_sources
    # applies from the next load — no mid-loop source mutation).
    active_sot = sot
    for source in sot["remote_sources"]:
        name = source["name"]
        if name in _REMOTE_FAILED_SOURCES:
            # Already failed (and logged) once this process — skip THIS source
            # quietly; the remaining sources are still consulted.
            continue
        url = source["url"]
        if not _is_remote_url_allowed(url, name):
            _REMOTE_FAILED_SOURCES.add(name)
            sys.stderr.write(
                "[pricing-loader] remote_sources[%s].url rejected by allowlist "
                "pin (%s) — fetch refused, no network I/O performed; source "
                "disabled for this process\n" % (name, url)
            )
            continue
        try:
            doc = _fetch_remote_doc(url, source["timeout_seconds"])
        except Exception as exc:  # noqa: BLE001 — any fetch failure arms the memo
            _REMOTE_FAILED_SOURCES.add(name)
            # "remote own-repo unavailable" is the plan's distinct advisory for
            # the expected pre-push 404 — same shape for every source.
            sys.stderr.write(
                "[pricing-loader] remote %s unavailable (%s) — source disabled "
                "for the remainder of this process\n" % (name, exc)
            )
            continue
        fmt = _SOURCE_FORMATS[source["format"]]
        if fmt.self_refresh:
            outcome = _try_sot_refresh(doc, active_sot, sot_path, name, url)
            if outcome == _REFRESH_REJECTED:
                # Untrusted whole doc [LLM04] — same memo posture as a
                # per-model sanity reject (loud once, source out for the
                # process).
                _REMOTE_FAILED_SOURCES.add(name)
                continue
            if outcome == _REFRESH_REPLACED:
                refreshed = True
                active_sot = load_pricing(sot_path)
                refreshed_entry = active_sot["models"].get(key)
                if refreshed_entry is not None:
                    # Normal sot-tier logic on the caller's eff; recorded
                    # distinctly by rate_for (resolution="remote",
                    # source=own-repo, refreshed=True). No overlay persist —
                    # the next lookup hits step 1 directly.
                    return (_select_rate(refreshed_entry, eff), name), True
                continue
            # _REFRESH_SKIPPED / _REFRESH_WRITE_FAILED -> per-model use below.
        entry = _extract_remote_entry(doc, key, source["format"])
        if entry is None:
            # Plain miss (model absent from THIS source's doc) — NOT a
            # failure: no memo, next source is consulted; an all-source miss
            # falls through to the caller's non-sot advisory.
            continue
        rate = fmt.convert(entry)
        if rate is None or not _is_rate_sane(rate):
            _REMOTE_FAILED_SOURCES.add(name)
            sys.stderr.write(
                "[pricing-loader] remote rate for %s from %s failed sanity "
                "validation — rejected (not persisted); source disabled for "
                "this process\n" % (key, name)
            )
            continue
        _persist_overlay_rate(active_sot, sot_path, key, rate, name)
        return (rate, name), refreshed
    return None, refreshed


# --------------------------------------------------------------------------- #
#  Test seam                                                                   #
# --------------------------------------------------------------------------- #
def _reset_for_tests():
    """Clear the per-process memos (SoT cache + overlay cache + per-source
    remote-failure memo) between test cases. Production code never calls
    this."""
    _SOT_CACHE.clear()
    _OVERLAY_CACHE.clear()
    _REMOTE_FAILED_SOURCES.clear()
