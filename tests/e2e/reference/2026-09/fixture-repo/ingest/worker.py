"""Polling ingester: pulls a batch of items from a source and forwards each
one to a sink.

Kept deliberately generic — `source` and `sink` are plain callables so this
module has no opinion on where reports come from or where they end up. A
real deployment might poll an HTTP endpoint and forward to the TypeScript
service's `/reports` API; the tests exercise it with in-memory stand-ins.
"""

from __future__ import annotations

from typing import Callable, Iterable, TypeVar

T = TypeVar("T")


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
