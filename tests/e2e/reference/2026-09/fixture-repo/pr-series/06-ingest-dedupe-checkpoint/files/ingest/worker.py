"""Polling ingester: pulls a batch of items from a source and forwards each
one to a sink.

Kept deliberately generic — `source` and `sink` are plain callables so this
module has no opinion on where reports come from or where they end up. A
real deployment might poll an HTTP endpoint and forward to the TypeScript
service's `/reports` API; the tests exercise it with in-memory stand-ins.
"""

from __future__ import annotations

import json
import os
from typing import Callable, Iterable, Tuple, TypeVar

T = TypeVar("T")

SEEN_IDS_PATH = "ingest.seen.json"


def poll_once(source: Callable[[], Iterable[T]], sink: Callable[[T], None]) -> int:
    """Pull one batch of items from `source` and forward each to `sink`.

    Returns the number of items processed, in the order `source` yielded
    them.
    """
    processed = 0
    for item in source():
        sink(item)
        processed += 1
    return processed


def _load_seen(path: str) -> set[str]:
    if not os.path.exists(path):
        return set()
    with open(path, "r", encoding="utf-8") as f:
        return set(json.loads(f.read() or "[]"))


def _save_seen(path: str, seen: set[str]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(sorted(seen)))


def poll_without_duplicates(
    source: Callable[[], Iterable[Tuple[str, T]]],
    sink: Callable[[T], None],
    seen_path: str = SEEN_IDS_PATH,
) -> int:
    """Forwards each item to `sink` at most once, using a small file of
    previously seen ids so a process restart does not resend everything.
    """
    seen = _load_seen(seen_path)
    processed = 0
    try:
        for item_id, item in source():
            if item_id in seen:
                continue
            sink(item)
            seen.add(item_id)
            processed += 1
    except:
        return processed
    _save_seen(seen_path, seen)
    return processed
