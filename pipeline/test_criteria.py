"""Tests for the publication criteria and the bank exporter.

These rules are the site's editorial policy, so they are tested directly rather
than only through an end-to-end run.

Run with: python -m unittest discover pipeline
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest

from pipeline.criteria import (
    Rejection,
    accept_set,
    difficulty_score,
    evaluators_agree,
    margin,
    naive_disagreement,
    screen_candidate,
)
from pipeline.export import to_puzzle, write_bank


def actions(*pairs):
    return [
        {"id": name, "label": "Discard {}".format(name), "ev": ev} for name, ev in pairs
    ]


def candidate(**overrides):
    base = {
        "kind": "discard",
        "position": {"tilesLeft": 40},
        "actions": actions(("a", 1.0), ("b", 0.2), ("c", -0.5)),
        "rankings": [["a", "b", "c"], ["a", "c", "b"]],
        "ukeireBest": ["b"],
        "policyEntropy": 1.2,
        "evaluators": ["offline-model", "akochan"],
        "epsilon": 0.15,
    }
    base.update(overrides)
    return base


class AcceptSetTest(unittest.TestCase):
    def test_only_the_best_when_others_trail(self):
        self.assertEqual(accept_set(actions(("a", 1.0), ("b", 0.2))), ["a"])

    def test_near_ties_are_all_accepted(self):
        # 0.10 apart is inside the 0.15 epsilon, so both are correct answers.
        self.assertEqual(accept_set(actions(("a", 1.0), ("b", 0.9))), ["a", "b"])


class MarginTest(unittest.TestCase):
    def test_measures_gap_to_the_first_rejected_action(self):
        self.assertAlmostEqual(margin(actions(("a", 1.0), ("b", 0.2))), 0.8)

    def test_skips_over_accepted_ties(self):
        # b is accepted, so the margin is measured against c.
        result = margin(actions(("a", 1.0), ("b", 0.95), ("c", 0.3)))
        self.assertAlmostEqual(result, 0.7)

    def test_infinite_when_everything_ties(self):
        self.assertEqual(margin(actions(("a", 1.0), ("b", 1.0))), float("inf"))


class AgreementTest(unittest.TestCase):
    def test_agrees_when_tops_match(self):
        self.assertTrue(evaluators_agree([["a", "b"], ["a", "c"]]))

    def test_disagrees_when_tops_differ(self):
        self.assertFalse(evaluators_agree([["a", "b"], ["b", "a"]]))

    def test_a_single_evaluator_cannot_corroborate_itself(self):
        self.assertFalse(evaluators_agree([["a", "b"]]))


class NaiveDisagreementTest(unittest.TestCase):
    def test_flags_when_efficiency_picks_differently(self):
        self.assertTrue(naive_disagreement("a", ["b", "c"]))

    def test_quiet_when_efficiency_agrees(self):
        self.assertFalse(naive_disagreement("a", ["a", "b"]))


class DifficultyTest(unittest.TestCase):
    def test_stays_in_range(self):
        for margin_pt in (0.0, 0.5, 3.0, 40.0):
            for entropy in (None, 0.0, 2.6):
                for naive in (True, False):
                    score = difficulty_score(margin_pt, entropy, naive, 1)
                    self.assertGreaterEqual(score, 0)
                    self.assertLessEqual(score, 100)

    def test_wide_margins_are_easier_than_narrow_ones(self):
        narrow = difficulty_score(0.4, 1.0, False, 1)
        wide = difficulty_score(3.0, 1.0, False, 1)
        self.assertGreater(narrow, wide)

    def test_efficiency_traps_are_harder(self):
        self.assertGreater(
            difficulty_score(1.0, 1.0, True, 1),
            difficulty_score(1.0, 1.0, False, 1),
        )


class ScreenCandidateTest(unittest.TestCase):
    def test_accepts_a_clean_candidate(self):
        result = screen_candidate(candidate())
        self.assertEqual(result["acceptedActionIds"], ["a"])
        self.assertAlmostEqual(result["margin"], 0.8)
        self.assertTrue(result["naiveFails"])
        self.assertIn("difficulty", result)

    def test_rejects_kan_decisions(self):
        # akochan is documented as weak at kan, so these are never published.
        with self.assertRaises(Rejection) as caught:
            screen_candidate(candidate(kind="kan"))
        self.assertIn("excluded_kind", caught.exception.reason)

    def test_rejects_sharp_endgames(self):
        with self.assertRaises(Rejection) as caught:
            screen_candidate(candidate(position={"tilesLeft": 3}))
        self.assertEqual(caught.exception.reason, "endgame_too_sharp")

    def test_rejects_narrow_margins(self):
        with self.assertRaises(Rejection) as caught:
            screen_candidate(candidate(actions=actions(("a", 1.0), ("b", 0.75))))
        self.assertIn("margin_too_small", caught.exception.reason)

    def test_rejects_evaluator_disagreement(self):
        with self.assertRaises(Rejection) as caught:
            screen_candidate(candidate(rankings=[["a", "b"], ["b", "a"]]))
        self.assertEqual(caught.exception.reason, "evaluators_disagree")

    def test_rejects_a_lone_evaluator(self):
        with self.assertRaises(Rejection) as caught:
            screen_candidate(candidate(rankings=[["a", "b", "c"]]))
        self.assertEqual(caught.exception.reason, "evaluators_disagree")

    def test_rejects_positions_with_no_choice(self):
        with self.assertRaises(Rejection) as caught:
            screen_candidate(candidate(actions=actions(("a", 1.0))))
        self.assertEqual(caught.exception.reason, "no_choice")

    def test_rejects_when_everything_is_equivalent(self):
        with self.assertRaises(Rejection) as caught:
            screen_candidate(candidate(actions=actions(("a", 1.0), ("b", 1.0))))
        self.assertEqual(caught.exception.reason, "all_actions_equivalent")

    def test_rejects_too_many_accepted_answers(self):
        many = actions(("a", 1.0), ("b", 1.0), ("c", 1.0), ("d", 1.0), ("e", 0.1))
        with self.assertRaises(Rejection) as caught:
            screen_candidate(candidate(actions=many))
        self.assertIn("too_many_answers", caught.exception.reason)


class ExportTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.screened = screen_candidate(candidate())
        self.screened["position"] = {
            "seat": 0,
            "round": {"wind": "E", "kyoku": 1, "honba": 0, "riichiSticks": 0},
            "scores": [25000, 25000, 25000, 25000],
            "doraIndicators": ["1s"],
            "hand": ["1m"] * 14,
            "drawnTile": "1m",
            "melds": [],
            "rivers": [[], [], [], []],
            "opponentMelds": [[], [], [], []],
            "riichi": [False, False, False, False],
            "tilesLeft": 40,
        }

    def test_loss_is_non_negative_and_matches_ev(self):
        puzzle = to_puzzle(self.screened, "mined-00001")
        best_ev = max(action["ev"] for action in puzzle["actions"])
        for action in puzzle["actions"]:
            self.assertGreaterEqual(action["loss"], 0.0)
            self.assertAlmostEqual(action["loss"], best_ev - action["ev"])

    def test_accepted_flags_match_the_accept_set(self):
        puzzle = to_puzzle(self.screened, "mined-00001")
        for action in puzzle["actions"]:
            self.assertEqual(
                action["accepted"], action["id"] in puzzle["acceptedActionIds"]
            )

    def test_tags_an_efficiency_trap(self):
        puzzle = to_puzzle(self.screened, "mined-00001")
        self.assertIn("efficiency-trap", puzzle["tags"])

    def test_uses_placement_points(self):
        puzzle = to_puzzle(self.screened, "mined-00001")
        self.assertEqual(puzzle["evaluation"]["unit"], "placement_pt")

    def test_writes_shards_and_an_index(self):
        puzzles = [
            to_puzzle(self.screened, "mined-{:05d}".format(i)) for i in range(1, 6)
        ]
        index = write_bank(puzzles, self.dir, "2026-07-29", shard_size=2)

        self.assertEqual(index["count"], 5)
        self.assertEqual(len(index["shards"]), 3)
        self.assertIn("CC BY 4.0", index["provenance"])

        with open(os.path.join(self.dir, "index.json"), encoding="utf-8") as handle:
            on_disk = json.load(handle)
        self.assertEqual(on_disk["count"], 5)

        total = 0
        for shard in on_disk["shards"]:
            with open(os.path.join(self.dir, shard["file"]), encoding="utf-8") as handle:
                payload = json.load(handle)
            self.assertEqual(payload["schemaVersion"], 1)
            self.assertEqual(len(payload["puzzles"]), shard["count"])
            total += shard["count"]
        self.assertEqual(total, 5)


if __name__ == "__main__":
    unittest.main()
