"""Tests for the verification stage.

The load-bearing one is `LoadHistoryTest`: leaving a trailing `reach` in the
prefix does not fail, it produces a *plausible wrong bank* — every position where
a riichi was actually declared quietly becomes a plain discard question, and the
only riichi puzzles that survive are ones where nobody declared. That shipped a
set of 13 riichi puzzles whose answer was "stay concealed" in all 13 cases.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from pipeline.verify import (
    _kyoku_history,
    build_riichi_actions,
    load_history,
    tags_for,
)


def write_log(events):
    handle = tempfile.NamedTemporaryFile("w", suffix=".mjson", delete=False, encoding="utf-8")
    for event in events:
        handle.write(json.dumps(event) + "\n")
    handle.close()
    return os.path.dirname(handle.name), os.path.basename(handle.name)


class LoadHistoryTest(unittest.TestCase):
    def setUp(self):
        self.events = [
            {"type": "start_game"},
            {"type": "start_kyoku", "kyoku": 1},
            {"type": "tsumo", "actor": 1, "pai": "E"},
            {"type": "reach", "actor": 1},
            {"type": "dahai", "actor": 1, "pai": "E"},
        ]
        self.dir, self.name = write_log(self.events)

    def test_drops_the_declaration_that_precedes_its_discard(self):
        # eventIndex points at the dahai (4). The naive prefix keeps the reach.
        history = load_history(self.dir, self.name, 4, seat=1)
        self.assertEqual(
            [event["type"] for event in history],
            ["start_game", "start_kyoku", "tsumo"],
        )

    def test_keeps_another_seats_declaration(self):
        # Only the acting seat's own pending declaration is removed; an opponent's
        # standing riichi is part of the position and must survive.
        events = list(self.events)
        events[3] = {"type": "reach", "actor": 2}
        directory, name = write_log(events)
        history = load_history(directory, name, 4, seat=1)
        self.assertEqual(history[-1]["type"], "reach")
        self.assertEqual(history[-1]["actor"], 2)

    def test_ordinary_prefix_is_untouched(self):
        events = [
            {"type": "start_game"},
            {"type": "start_kyoku", "kyoku": 1},
            {"type": "tsumo", "actor": 0, "pai": "1m"},
            {"type": "dahai", "actor": 0, "pai": "1m"},
        ]
        directory, name = write_log(events)
        self.assertEqual(len(load_history(directory, name, 3, seat=0)), 3)


class KyokuHistoryTest(unittest.TestCase):
    def test_slices_from_the_last_start_kyoku(self):
        history = [
            {"type": "start_game"},
            {"type": "start_kyoku", "kyoku": 1},
            {"type": "tsumo", "actor": 0},
            {"type": "start_kyoku", "kyoku": 2},
            {"type": "tsumo", "actor": 1},
        ]
        sliced = _kyoku_history(history)
        self.assertEqual(sliced[0]["kyoku"], 2)
        self.assertEqual(len(sliced), 2)


class RiichiActionsTest(unittest.TestCase):
    def setUp(self):
        self.candidate = {
            "ukeireActions": {
                "discard:8m": {"label": "Discard 8 characters", "tile": "8m", "shantenAfter": 0, "ukeire": 8},
                "discard:2p": {"label": "Discard 2 circles", "tile": "2p", "shantenAfter": 0, "ukeire": 6},
            }
        }

    def test_returns_none_without_a_declaration_option(self):
        ranked = [{"id": "discard:8m", "tile": "8m", "ev": 1.0, "moves": [], "kind": None}]
        self.assertIsNone(build_riichi_actions(ranked, self.candidate))

    def test_pairs_the_best_line_of_each_sort(self):
        ranked = [
            {"id": "riichi", "tile": "8m", "ev": 17.6, "moves": [], "kind": "reach"},
            {"id": "discard:2p", "tile": "2p", "ev": 14.8, "moves": [], "kind": None},
            {"id": "discard:8m", "tile": "8m", "ev": 12.0, "moves": [], "kind": None},
        ]
        actions = build_riichi_actions(ranked, self.candidate)
        self.assertIsNotNone(actions)
        assert actions is not None
        self.assertEqual([a["id"] for a in actions], ["riichi", "damaten"])
        # The concealed line keeps its own best tile rather than being forced onto
        # the tile the declaration wants.
        self.assertEqual(actions[1]["tile"], "2p")
        self.assertEqual(actions[0]["label"], "Declare riichi, discarding 8 characters")
        self.assertEqual(actions[1]["label"], "Stay concealed, discarding 2 circles")


class TagsTest(unittest.TestCase):
    def test_riichi_puzzles_are_tagged_by_what_the_player_did(self):
        candidate = {
            "kind": "riichi",
            "declaredRiichi": True,
            "position": {"seat": 0, "riichi": [False] * 4, "melds": [], "round": {}, "tilesLeft": 40},
            "bestShanten": 0,
        }
        tags = tags_for(candidate, [], 1.0)
        self.assertIn("riichi", tags)
        self.assertIn("declared", tags)
        self.assertNotIn("tenpai-choice", tags)

    def test_discard_puzzles_keep_their_kind(self):
        candidate = {
            "kind": "discard",
            "position": {"seat": 0, "riichi": [False] * 4, "melds": [], "round": {}, "tilesLeft": 40},
            "bestShanten": 0,
        }
        self.assertIn("discard", tags_for(candidate, [], 1.0))


if __name__ == "__main__":
    unittest.main()
