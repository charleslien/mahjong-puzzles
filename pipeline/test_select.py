"""Tests for the verification-budget selector.

The two rules worth pinning are the ones that were found by measuring a real
run rather than by reasoning: a concealed kan leaves a hand riichi-capable, and
consecutive decisions in one tenpai hand are near-duplicates.

Run with: python -m unittest discover pipeline
"""

from __future__ import annotations

import unittest

from pipeline.select import bucket_of, hand_key, parse_quota, riichi_capable, select


def record(**overrides):
    """A tenpai, concealed, mid-hand discard candidate."""
    position = {
        "seat": 0,
        "melds": [],
        "riichi": [False, False, False, False],
        "scores": [25000, 25000, 25000, 25000],
        "tilesLeft": 40,
        "round": {"wind": "E", "kyoku": 1, "honba": 0},
    }
    position.update(overrides.pop("position", {}))
    base = {
        "kind": "discard",
        "gameId": "g.mjson",
        "decisionIndex": 1,
        "position": position,
        "ukeireActions": {"discard:1m": {"shantenAfter": 0, "ukeire": 4}},
    }
    base.update(overrides)
    return base


class RiichiCapable(unittest.TestCase):
    def test_a_closed_tenpai_hand_is_capable(self):
        self.assertTrue(riichi_capable(record()))

    def test_a_concealed_kan_leaves_the_hand_closed(self):
        # The two positions the first version of this filter missed. An ankan is
        # a meld in the position record but does not open the hand.
        hand = record(position={"melds": [{"kind": "ankan", "tiles": ["S"] * 4}]})
        self.assertTrue(riichi_capable(hand))

    def test_an_open_meld_is_not(self):
        hand = record(position={"melds": [{"kind": "pon", "tiles": ["S"] * 3}]})
        self.assertFalse(riichi_capable(hand))

    def test_a_hand_already_declared_is_not(self):
        self.assertFalse(riichi_capable(record(position={"riichi": [True] * 4})))

    def test_a_player_who_cannot_pay_the_stick_is_not(self):
        self.assertFalse(riichi_capable(record(position={"scores": [900, 0, 0, 0]})))

    def test_a_dead_wall_is_not(self):
        self.assertFalse(riichi_capable(record(position={"tilesLeft": 3})))

    def test_a_hand_short_of_tenpai_is_not(self):
        away = record(ukeireActions={"discard:1m": {"shantenAfter": 1, "ukeire": 12}})
        self.assertFalse(riichi_capable(away))

    def test_a_call_is_never_capable(self):
        # A call is judged at an opponent's discard, where the seat holds
        # thirteen tiles and has nothing to declare.
        self.assertFalse(riichi_capable(record(kind="call")))

    def test_the_bucket_is_the_puzzle_it_would_become(self):
        self.assertEqual(bucket_of(record()), "riichi")
        self.assertEqual(bucket_of(record(kind="call")), "call")
        self.assertEqual(
            bucket_of(record(ukeireActions={"discard:1m": {"shantenAfter": 2}})),
            "discard",
        )


class HandKey(unittest.TestCase):
    def test_the_same_hand_and_seat_share_a_key(self):
        first = record(decisionIndex=1)
        second = record(decisionIndex=2)
        self.assertEqual(hand_key(first), hand_key(second))

    def test_a_repeat_of_the_same_kyoku_does_not(self):
        # An abortive draw replays the wind and seat over a different wall.
        replayed = record(position={"round": {"wind": "E", "kyoku": 1, "honba": 1}})
        self.assertNotEqual(hand_key(record()), hand_key(replayed))

    def test_seats_in_one_hand_do_not(self):
        self.assertNotEqual(hand_key(record()), hand_key(record(position={"seat": 2})))


class Select(unittest.TestCase):
    def test_one_decision_survives_per_hand(self):
        # Three turns of the same tenpai hand: the same wait, one tile further
        # on each time.
        turns = [record(decisionIndex=index) for index in range(3)]
        kept = select(turns, quotas={}, per_hand=1)
        self.assertEqual([row["decisionIndex"] for row in kept], [0])

    def test_thinning_is_per_bucket(self):
        # A player can face a call and a riichi decision in one hand, and they
        # are different puzzles.
        rows = [record(decisionIndex=0), record(decisionIndex=1, kind="call")]
        self.assertEqual(len(select(rows, quotas={}, per_hand=1)), 2)

    def test_a_quota_samples_across_the_file(self):
        rows = [
            record(gameId="g{}.mjson".format(index), decisionIndex=index)
            for index in range(10)
        ]
        kept = select(rows, quotas={"riichi": 3}, per_hand=1)
        self.assertEqual([row["decisionIndex"] for row in kept], [0, 3, 6])

    def test_a_quota_of_zero_drops_the_bucket(self):
        # Distinct from naming no quota at all, which passes the bucket through.
        rows = [record(), record(gameId="h.mjson", kind="call")]
        kept = select(rows, quotas={"discard": 0, "call": 0}, per_hand=1)
        self.assertEqual([row["kind"] for row in kept], ["discard"])  # the riichi one

    def test_an_unquotaed_bucket_passes_through(self):
        rows = [
            record(gameId="g{}.mjson".format(index), kind="call") for index in range(5)
        ]
        self.assertEqual(len(select(rows, quotas={"riichi": 2}, per_hand=1)), 5)

    def test_input_order_is_kept(self):
        # verify.py writes as it goes, so a run stopped early should still hold a
        # spread of games rather than every candidate from the first few.
        rows = [
            record(gameId="g{}.mjson".format(index), decisionIndex=index, kind="call")
            for index in range(4)
        ] + [record(gameId="h.mjson", decisionIndex=9)]
        kept = select(rows, quotas={}, per_hand=1)
        self.assertEqual([row["decisionIndex"] for row in kept], [0, 1, 2, 3, 9])


class Quotas(unittest.TestCase):
    def test_parsing(self):
        self.assertEqual(parse_quota(["riichi=10", "call=2"]), {"riichi": 10, "call": 2})

    def test_a_malformed_quota_is_refused(self):
        with self.assertRaises(ValueError):
            parse_quota(["riichi"])


if __name__ == "__main__":
    unittest.main()
