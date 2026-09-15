from worker import poll_once


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
