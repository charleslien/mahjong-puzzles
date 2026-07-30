"""Tests for the akochan bridge.

The pure logic is tested unconditionally. The tests that need a compiled akochan
skip when the binary is absent, so CI stays green on a machine that has not built
it — but they are real tests, not placeholders, and they are the only thing
standing between the fast evaluation path and a silent disagreement with the
authoritative one.
"""

from __future__ import annotations

import json
import os
import unittest

from pipeline.akochan import (
    JUN_PT,
    PROBE_HISTORY,
    TACTICS,
    AkochanEngine,
    AkochanNotAvailable,
    NoEvaluationPoint,
    kyoku_prefix,
    triggers_evaluation,
)

BINARY = os.path.join("vendor", "akochan", "system.exe")
HAVE_AKOCHAN = os.path.exists(BINARY)
SKIP_REASON = "no akochan build at {} (scripts/build-akochan.sh)".format(BINARY)


class TriggerTest(unittest.TestCase):
    def test_own_tsumo_triggers(self):
        self.assertTrue(triggers_evaluation({"type": "tsumo", "actor": 1}, 1))

    def test_other_seats_tsumo_does_not(self):
        self.assertFalse(triggers_evaluation({"type": "tsumo", "actor": 2}, 1))

    def test_other_seats_discard_triggers_a_call_decision(self):
        self.assertTrue(triggers_evaluation({"type": "dahai", "actor": 2}, 1))

    def test_own_discard_does_not(self):
        # This is the post-call gap: akochan offers no decision point here.
        self.assertFalse(triggers_evaluation({"type": "dahai", "actor": 1}, 1))

    def test_actorless_and_error_events_do_not(self):
        self.assertFalse(triggers_evaluation({"type": "start_kyoku"}, 0))
        self.assertFalse(triggers_evaluation({"type": "error", "actor": 0}, 0))

    def test_kakan_by_another_seat_triggers(self):
        self.assertTrue(triggers_evaluation({"type": "kakan", "actor": 3}, 0))


class KyokuPrefixTest(unittest.TestCase):
    def test_keeps_start_game_and_the_current_hand(self):
        history = [
            {"type": "start_game"},
            {"type": "start_kyoku", "kyoku": 1},
            {"type": "tsumo", "actor": 0, "pai": "1m"},
            {"type": "start_kyoku", "kyoku": 2},
            {"type": "tsumo", "actor": 0, "pai": "2m"},
        ]
        prefix = kyoku_prefix(history)
        self.assertEqual(
            [event["type"] for event in prefix],
            ["start_game", "start_kyoku", "tsumo"],
        )
        # The *current* hand, not the first one.
        self.assertEqual(prefix[1]["kyoku"], 2)

    def test_does_not_duplicate_start_game_in_the_first_hand(self):
        history = [
            {"type": "start_game"},
            {"type": "start_kyoku", "kyoku": 1},
            {"type": "tsumo", "actor": 0, "pai": "1m"},
        ]
        self.assertEqual(
            [event["type"] for event in kyoku_prefix(history)],
            ["start_game", "start_kyoku", "tsumo"],
        )

    def test_empty(self):
        self.assertEqual(kyoku_prefix([]), [])


class TacticsTest(unittest.TestCase):
    def test_placement_scale_matches_the_trained_one(self):
        # The value head was regressed on these points; akochan's EV has to be in
        # the same unit or the margin thresholds in criteria.py are meaningless.
        from pipeline.train import PLACEMENT_POINTS

        self.assertEqual(tuple(float(pt) for pt in JUN_PT), tuple(PLACEMENT_POINTS))

    def test_tactics_declares_jun_pt(self):
        self.assertEqual(TACTICS["tactics"]["jun_pt"], JUN_PT)


@unittest.skipUnless(HAVE_AKOCHAN, SKIP_REASON)
class EngineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = AkochanEngine(BINARY)

    @classmethod
    def tearDownClass(cls):
        cls.engine.close()

    def test_probe_returns_a_spread_of_expected_values(self):
        actions = self.engine.probe()
        self.assertGreaterEqual(len(actions), 2)
        # Best first.
        self.assertEqual(actions, sorted(actions, key=lambda a: -a["ev"]))
        for action in actions:
            self.assertIsInstance(action["ev"], float)

    def test_installs_its_tactics_where_mjai_log_reads_them(self):
        # mjai_log ignores its command line and loads this path, so the file has
        # to carry our placement scale or the fast path silently uses akochan's.
        path = os.path.join(os.path.dirname(os.path.abspath(BINARY)), "setup_mjai.json")
        with open(path, encoding="utf-8") as handle:
            installed = json.load(handle)
        self.assertEqual(installed["tactics"]["jun_pt"], JUN_PT)

    def test_preserves_upstream_tactics(self):
        path = os.path.join(
            os.path.dirname(os.path.abspath(BINARY)), "setup_mjai.upstream.json"
        )
        self.assertTrue(os.path.exists(path), "upstream tactics should be kept alongside")

    def test_post_call_discard_has_no_decision_point(self):
        history = list(PROBE_HISTORY) + [{"type": "dahai", "actor": 0, "pai": "8p"}]
        with self.assertRaises(NoEvaluationPoint):
            self.engine.evaluate(history, 0)

    def test_fast_path_matches_the_streaming_reference(self):
        """The load-bearing test for this module.

        mjai_log is ~200x faster than the mode akochan actually plays with, and is
        used for every evaluation. It is only safe while it agrees exactly. Two
        distinct bugs made it disagree while still returning plausible numbers:
        a whole-hanchan record instead of the current hand, and a different
        jun_pt via the hardcoded tactics path.
        """
        fast = self.engine.evaluate(PROBE_HISTORY, 0)
        reference = self.engine.evaluate_streaming(PROBE_HISTORY, 0)
        self.assertEqual(
            [(a["id"], round(a["ev"], 6)) for a in fast],
            [(a["id"], round(a["ev"], 6)) for a in reference],
        )

    def test_rejects_a_missing_binary(self):
        with self.assertRaises(AkochanNotAvailable):
            AkochanEngine(os.path.join("vendor", "akochan", "does-not-exist"))


if __name__ == "__main__":
    unittest.main()
