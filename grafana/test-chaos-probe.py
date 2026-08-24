#!/usr/bin/env python3
"""Assertions for chaos-probe's per-series presence logic.

The distinction under test is the one the boards exist to draw and the one a Grafana
legend cannot express: a series that STOPS is a replica that left; a series sitting at
zero beside working peers is a replica that stopped working. Pooled values cannot tell
them apart, which is how a working panel was once reported as broken.

    python grafana/test-chaos-probe.py
"""

import importlib.util
import pathlib
import sys

_spec = importlib.util.spec_from_file_location(
    "chaos_probe", pathlib.Path(__file__).parent / "chaos-probe.py")
cp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cp)


def series(instance, points):
    return {"metric": {"__name__": "x", "service_instance_id": instance},
            "values": [[float(t), str(v)] for t, v in points]}


def test_fingerprint_ignores_metric_name():
    a = cp.fingerprint({"__name__": "one", "service_instance_id": "a", "queue": "q"})
    b = cp.fingerprint({"__name__": "other", "queue": "q", "service_instance_id": "a"})
    assert a == b, (a, b)
    assert a == "queue=q,service_instance_id=a", a


def test_a_series_that_stops_is_reported_as_left():
    gone = series("a", [(0, 1), (10, 1), (20, 1)])
    stays = series("b", [(0, 1), (10, 1), (20, 1), (30, 1), (40, 1)])
    before = cp.present([gone, stays], 0, 25)
    during = cp.present([gone, stays], 25, 50)
    assert before - during == {"service_instance_id=a"}, (before, during)


def test_a_series_flat_at_zero_is_not_reported_as_left():
    """The false-positive direction. An idle replica is present, not departed --
    telling these apart is the entire point, so zero must count as a sample."""
    idle = series("a", [(0, 1), (10, 1), (30, 0), (40, 0)])
    before = cp.present([idle], 0, 25)
    during = cp.present([idle], 25, 50)
    assert before - during == set(), (before, during)
    assert during == {"service_instance_id=a"}, during


def test_a_new_series_is_reported_as_arrived():
    replacement = series("c", [(30, 1), (40, 1)])
    before = cp.present([replacement], 0, 25)
    during = cp.present([replacement], 25, 50)
    assert during - before == {"service_instance_id=c"}, (before, during)


def test_nan_only_samples_are_not_presence():
    """NaN renders blank, not zero -- seg() already drops it and presence must agree,
    or a panel that went blank would read as a panel that kept working."""
    blank = series("a", [(30, "NaN"), (40, "NaN")])
    assert cp.present([blank], 25, 50) == set()


def test_samples_outside_the_window_do_not_count():
    s = series("a", [(0, 1), (60, 1)])
    assert cp.present([s], 25, 50) == set()


def test_spans_reports_where_each_line_ends():
    """The reading present() cannot give, and the one that settles a departure: where a
    line ends is a property of the series, not of the window it is judged in."""
    gone = series("a", [(0, 1), (10, 1), (20, 1)])
    stays = series("b", [(0, 1), (20, 1), (40, 1)])
    sp = cp.spans([gone, stays], 0, 40)
    assert sp["service_instance_id=a"] == (0.0, 20.0), sp
    assert sp["service_instance_id=b"] == (0.0, 40.0), sp


def test_spans_ignores_nan_when_finding_the_end():
    """A line that goes blank has ended, whatever timestamps the NaNs carry."""
    fading = series("a", [(0, 1), (10, 1), (20, "NaN"), (30, "NaN")])
    assert cp.spans([fading], 0, 30)["service_instance_id=a"] == (0.0, 10.0)


def test_spans_omits_a_series_with_no_samples_in_range():
    assert cp.spans([series("a", [(90, 1)])], 0, 40) == {}


def test_spans_merges_two_series_sharing_a_fingerprint():
    """An expression can emit the same label set twice -- one span, not two."""
    early = series("a", [(0, 1), (10, 1)])
    late = series("a", [(30, 1), (40, 1)])
    assert cp.spans([early, late], 0, 40)["service_instance_id=a"] == (0.0, 40.0)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  ok    {t.__name__}")
        except AssertionError as e:
            print(f"  FAIL  {t.__name__}: {e}")
            failed += 1
    print()
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
