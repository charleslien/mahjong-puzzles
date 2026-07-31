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
    branch_rankings,
    build_call_actions,
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
        ranked = [{"id": "discard:8m", "tile": "8m", "ev": 1.0, "moves": [], "kind": "dahai"}]
        self.assertIsNone(build_riichi_actions(ranked, self.candidate))

    def test_publishes_every_line_of_both_branches(self):
        ranked = [
            {"id": "riichi:8m", "tile": "8m", "ev": 17.6, "moves": [], "kind": "reach"},
            {"id": "discard:2p", "tile": "2p", "ev": 14.8, "moves": [], "kind": "dahai"},
            {"id": "discard:8m", "tile": "8m", "ev": 12.0, "moves": [], "kind": "dahai"},
        ]
        actions = build_riichi_actions(ranked, self.candidate)
        assert actions is not None
        self.assertEqual(
            [(a["id"], a["branch"]) for a in actions],
            [("riichi:8m", "riichi"), ("discard:2p", "dama"), ("discard:8m", "dama")],
        )
        # The tile choice survives the declaration rather than being subsumed by
        # it: declaring on the 8 and playing on with the 8 are separate lines and
        # akochan prices them 5.6 apart.
        self.assertEqual(actions[0]["label"], "Declare riichi, discarding 8 characters")
        self.assertEqual(actions[2]["label"], "Discard 8 characters")
        self.assertEqual(actions[0]["shantenAfter"], 0)


class CallActionsTest(unittest.TestCase):
    """A chi's identity is the set it eats and the tile it throws afterwards.

    Collapsing to one option per call kind — which is what this used to do — threw
    away both, and with them the only parts of a call decision that are hard.
    """

    def setUp(self):
        self.ranked = [
            {"id": "pass", "kind": "none", "tile": None, "consumed": None, "ev": 5.8, "moves": []},
            {
                "id": "chi:2s+3s:5m",
                "kind": "chi",
                "tile": "5m",
                "consumed": ["2s", "3s"],
                "ev": 3.4,
                "moves": [],
            },
            {
                "id": "chi:2s+3s:9s",
                "kind": "chi",
                "tile": "9s",
                "consumed": ["2s", "3s"],
                "ev": 2.4,
                "moves": [],
            },
        ]
        self.candidate = {"tileLabels": {"2s": "2 bamboo", "3s": "3 bamboo", "5m": "5 characters"}}

    def test_every_line_survives_with_its_consumed_set(self):
        actions = build_call_actions(self.ranked, self.candidate)
        assert actions is not None
        self.assertEqual([a["id"] for a in actions], ["pass", "chi:2s+3s:5m", "chi:2s+3s:9s"])
        self.assertEqual(actions[1]["consumed"], ["2s", "3s"])
        self.assertEqual(actions[1]["branch"], "chi")
        self.assertEqual(
            actions[1]["label"], "Call chi with 2 bamboo and 3 bamboo, then discard 5 characters"
        )

    def test_returns_none_when_nothing_can_be_called(self):
        self.assertIsNone(build_call_actions(self.ranked[:1], self.candidate))


class BranchRankingsTest(unittest.TestCase):
    """The human evaluator only ever expressed a branch, so only branches are
    compared. Asking them to have ranked five riichi discards they never saw
    would drop good positions over a disagreement neither party had."""

    def test_agreement_is_judged_on_the_fork_not_the_tile(self):
        actions = [
            {"branch": "riichi", "ev": 10.0},
            {"branch": "riichi", "ev": 9.0},
            {"branch": "dama", "ev": 4.0},
        ]
        rankings = branch_rankings(actions, "riichi", ("riichi", "dama"))
        self.assertEqual(rankings, [["riichi", "dama"], ["riichi", "dama"]])

    def test_a_branch_is_worth_its_best_line(self):
        actions = [
            {"branch": "riichi", "ev": 1.0},
            {"branch": "dama", "ev": 0.5},
            {"branch": "dama", "ev": 9.0},
        ]
        self.assertEqual(branch_rankings(actions, "dama", ("riichi", "dama"))[0][0], "dama")


class TagsTest(unittest.TestCase):
    def test_tags_never_reveal_what_the_player_chose(self):
        # `declared` / `stayed-concealed` were shown as chips above the board
        # before the puzzle was answered, and since a position is only published
        # when akochan and the houou player agree on the branch, the chip was the
        # answer: it predicted it in 169 of 169 riichi puzzles in the shipped bank.
        for declared in (True, False):
            candidate = {
                "kind": "riichi",
                "declaredRiichi": declared,
                "position": {
                    "seat": 0,
                    "riichi": [False] * 4,
                    "melds": [],
                    "round": {},
                    "tilesLeft": 40,
                },
                "bestShanten": 0,
            }
            tags = tags_for(candidate, [], 1.0)
            self.assertIn("riichi", tags)
            self.assertNotIn("declared", tags)
            self.assertNotIn("stayed-concealed", tags)
            self.assertNotIn("tenpai-choice", tags)

    def test_call_tags_never_reveal_it_either(self):
        for taken in ("pass", "chi"):
            candidate = {
                "kind": "call",
                "actionTaken": taken,
                "position": {
                    "seat": 0,
                    "riichi": [False] * 4,
                    "melds": [],
                    "round": {},
                    "tilesLeft": 40,
                },
            }
            tags = tags_for(candidate, [], 1.0)
            self.assertNotIn("called", tags)
            self.assertNotIn("let-it-pass", tags)

    def test_discard_puzzles_keep_their_kind(self):
        candidate = {
            "kind": "discard",
            "position": {"seat": 0, "riichi": [False] * 4, "melds": [], "round": {}, "tilesLeft": 40},
            "bestShanten": 0,
        }
        self.assertIn("discard", tags_for(candidate, [], 1.0))


if __name__ == "__main__":
    unittest.main()
