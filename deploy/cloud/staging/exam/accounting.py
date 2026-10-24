"""Read native per-profile spend without double-counting API and DB counters."""
import sqlite3
from contextlib import closing
from pathlib import Path

COUNTERS = ("api_call_count", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
            "reasoning_tokens")
KEYS = ("session_id", "model", "billing_provider", "billing_base_url", "billing_mode", "task")


def read_usage(database):
    with closing(sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        # No provider URLs are exported: row identity is kept only while computing a delta.
        return {tuple(row[k] for k in KEYS): {k: row[k] for k in COUNTERS} for row in db.execute(
            "SELECT " + ",".join(KEYS + COUNTERS) + " FROM session_model_usage")}


def delta(before, after, sessions):
    rows = []
    for key, values in after.items():
        if key[0] not in sessions:
            continue
        previous = before.get(key, dict.fromkeys(COUNTERS, 0))
        difference = {k: values[k] - previous[k] for k in COUNTERS}
        if any(value < 0 for value in difference.values()):
            raise ValueError("Native usage counters reset during a task")
        rows.append({"session_id": key[0], "model": key[1], "task": key[5], **difference})
    if not rows:
        return None
    return {"totals": {k: sum(row[k] for row in rows) for k in COUNTERS}, "rows": rows}
