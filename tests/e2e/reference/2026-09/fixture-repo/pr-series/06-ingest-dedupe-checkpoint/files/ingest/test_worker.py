import json

from worker import poll_once, poll_without_duplicates


def test_empty_source_processes_nothing():
    sunk: list[str] = []
    processed = poll_once(lambda: [], sunk.append)
    assert processed == 0
    assert sunk == []


def test_single_item_is_forwarded_to_sink_in_order():
    sunk: list[str] = []
    processed = poll_once(lambda: ["report-1"], sunk.append)
    assert processed == 1
    assert sunk == ["report-1"]


def test_forwards_each_new_item_once(tmp_path):
    seen_path = str(tmp_path / "seen.json")
    sunk: list[str] = []
    processed = poll_without_duplicates(lambda: [("1", "a"), ("2", "b")], sunk.append, seen_path)
    assert processed == 2
    assert sunk == ["a", "b"]


def test_skips_items_already_recorded_as_seen(tmp_path):
    seen_path = tmp_path / "seen.json"
    seen_path.write_text(json.dumps(["1"]))
    sunk: list[str] = []
    processed = poll_without_duplicates(lambda: [("1", "a"), ("2", "b")], sunk.append, str(seen_path))
    assert processed == 1
    assert sunk == ["b"]
