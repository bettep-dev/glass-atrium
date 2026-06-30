#!/usr/bin/env python3
"""Claude Code cost summary — aggregates last 7 days from PG core.cost_events.

Source migrated from the removed ${LOGS_DIR}/costs-{date}.jsonl sink to the live
PG sink (core.cost_events), which cost-tracker.sh now writes as its single store.
The aggregation/output contract is unchanged — only the SOURCE moved.
"""

from datetime import datetime, timedelta
from collections import defaultdict

DAILY_THRESHOLD_USD = 5.0
DAYS = 7
SEPARATOR_WIDTH = 40  # WHY: matches main daily-table width (10+6+13+13+10+separators)


class CostSourceUnavailable(RuntimeError):
    """PG cost source could not be reached (psycopg absent or DB unreachable).

    Distinct from an empty-but-healthy result: surfaced as an explicit message so
    an unavailable source never masquerades as a real "$0 spent" / "No data" run.
    """


def load_records(target_dates: list[str]) -> list[dict]:
    """Load cost rows for the given date strings from PG core.cost_events.

    Returns the same per-event dict shape the JSONL sink used (keys: date, model,
    session_id, input_tokens, output_tokens, cost_usd) so the downstream
    aggregation/output is byte-for-byte unchanged. One row per cost_events row.

    Raises CostSourceUnavailable when psycopg is missing or the DB is unreachable,
    so the caller can degrade gracefully instead of printing a misleading "$0".
    """
    try:
        import psycopg
    except ImportError as exc:
        raise CostSourceUnavailable(f"psycopg not installed: {exc}") from exc

    if not target_dates:
        return []

    # Bound the scan to the requested window via the date range (cost_events has a
    # date+time index). model NULL → "unknown" mirrors the JSONL catch-all so the
    # per-model table guard (`any(k != "unknown")`) behaves identically.
    start_date = min(target_dates)
    end_date = max(target_dates)
    records: list[dict] = []
    try:
        # Unix-socket only (Const-16, matching _pg_dual_write.py / advisory hooks).
        # Double-capped (connect 1s + statement 1500ms) — read is bounded.
        with psycopg.connect(
            "dbname=glass_atrium", connect_timeout=1, options="-c statement_timeout=1500"
        ) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT event_date, COALESCE(model, 'unknown'), session_id, "
                    "input_tokens, output_tokens, cost_usd "
                    "FROM core.cost_events "
                    "WHERE event_date >= %s AND event_date <= %s",
                    (start_date, end_date),
                )
                for row in cur:
                    event_date, model, session_id, in_tok, out_tok, cost = row
                    records.append(
                        {
                            # event_date is a datetime.date → isoformat matches the
                            # "YYYY-MM-DD" strings target_dates is built from.
                            "date": event_date.isoformat(),
                            "model": model,
                            "session_id": session_id,
                            "input_tokens": int(in_tok or 0),
                            "output_tokens": int(out_tok or 0),
                            # cost_usd is Decimal → float for the existing arithmetic.
                            "cost_usd": float(cost or 0),
                        }
                    )
    except psycopg.Error as exc:
        raise CostSourceUnavailable(f"cost DB unreachable: {exc}") from exc

    return records


def _new_bucket() -> dict:
    """Create a fresh aggregation bucket."""
    return {"sessions": set(), "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}


def aggregate(records: list[dict]) -> tuple[defaultdict, defaultdict]:
    """Aggregate records by date and by model."""
    daily: defaultdict = defaultdict(_new_bucket)
    model_agg: defaultdict = defaultdict(_new_bucket)

    for r in records:
        date = r.get("date", "unknown")
        model = r.get("model", "unknown")
        session_id = r.get("session_id", "unknown")

        for agg, key in [(daily, date), (model_agg, model)]:
            agg[key]["sessions"].add(session_id)
            agg[key]["input_tokens"] += r.get("input_tokens", 0)
            agg[key]["output_tokens"] += r.get("output_tokens", 0)
            agg[key]["cost_usd"] += r.get("cost_usd", 0.0)

    return daily, model_agg


def fmt_tokens(n: int) -> str:
    """Format token count with comma separator."""
    return f"{n:>11,}"


def fmt_cost(c: float) -> str:
    """Format USD cost."""
    return f"${c:>8.2f}"


def main() -> None:
    today = datetime.now().date()
    target_dates = [
        (today - timedelta(days=i)).isoformat() for i in range(DAYS)
    ]

    print("═══ Claude Code cost summary (last 7 days) ═══")

    try:
        records = load_records(target_dates)
    except CostSourceUnavailable as exc:
        # Explicit unavailable signal — never render an empty table that reads as
        # a real "$0 spent". Non-crash exit so callers/cron see a clean message.
        print(f"\n⚠️  cost source unavailable: {exc}")
        print("(PG core.cost_events could not be read — summary is NOT $0)")
        return

    if not records:
        print("\nNo data")
        return

    daily, model_agg = aggregate(records)

    # -- Daily table (fixed-width header aligned to the separator below) --
    print()
    print("Date       │ Sess │ Input tokens │ Output token │ Cost(USD)")
    sep = "───────────┼──────┼─────────────┼─────────────┼──────────"
    print(sep)

    warnings = []
    total_sessions = set()
    total_input = 0
    total_output = 0
    total_cost = 0.0

    for date_str in sorted(target_dates, reverse=True):
        d = daily.get(date_str)
        if not d:
            continue
        sessions_count = len(d["sessions"])
        row = " │ ".join([
            f"{date_str:<10}",
            f"{sessions_count:>4}",
            fmt_tokens(d["input_tokens"]),
            fmt_tokens(d["output_tokens"]),
            fmt_cost(d["cost_usd"]),
        ])
        print(row)

        total_sessions.update(d["sessions"])
        total_input += d["input_tokens"]
        total_output += d["output_tokens"]
        total_cost += d["cost_usd"]

        if d["cost_usd"] > DAILY_THRESHOLD_USD:
            warnings.append((date_str, d["cost_usd"]))

    print(sep)
    # "Total" left-padded to 10 display cols to match the date column width
    totals = " │ ".join([
        f"{'Total':<10}",
        f"{len(total_sessions):>4}",
        fmt_tokens(total_input),
        fmt_tokens(total_output),
        fmt_cost(total_cost),
    ])
    print(totals)

    # -- Model table (only if model field exists) --
    if any(k != "unknown" for k in model_agg):
        print(f"\n{'─' * SEPARATOR_WIDTH}")
        print("Per-model aggregation:")
        for model in sorted(model_agg):
            m = model_agg[model]
            print(f"  {model}: {len(m['sessions'])} sessions, "
                  f"input {m['input_tokens']:,}, "
                  f"output {m['output_tokens']:,}, "
                  f"{fmt_cost(m['cost_usd']).strip()}")

    # -- Threshold warnings --
    if warnings:
        print()
        for date_str, cost in warnings:
            print(f"⚠️  {date_str}: exceeds daily ${DAILY_THRESHOLD_USD:.0f} (${cost:.2f})")


if __name__ == "__main__":
    main()
