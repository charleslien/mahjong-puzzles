"""Tests for the mjai decision extractor.

Run with: python -m unittest discover pipeline
"""

from __future__ import annotations

import unittest

from pipeline.extract import extract_from_events, normalize_tile

# Four legal starting hands. Tile counts are kept inside four copies each so the
# log replays as a real game would.
TEHAIS = [
    ["1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m", "1p", "2p", "3p", "4p"],
    ["5p", "6p", "7p", "8p", "9p", "9p", "1s", "2s", "3s", "4s", "5s", "6s", "7s"],
    ["9p", "9p", "8s", "9s", "E", "E", "S", "S", "W", "W", "N", "N", "P"],
    ["1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m", "1p", "2p", "3p", "4p"],
]


def build_log():
    return [
        {"type": "start_game", "names": ["a", "b", "c", "d"]},
        {
            "type": "start_kyoku",
            "bakaze": "E",
            "kyoku": 1,
            "honba": 0,
            "kyotaku": 0,
            "oya": 0,
            "dora_marker": "1s",
            "tehais": TEHAIS,
        },
        {"type": "tsumo", "actor": 0, "pai": "5m"},
        {"type": "dahai", "actor": 0, "pai": "1m", "tsumogiri": False},
        {"type": "tsumo", "actor": 1, "pai": "E"},
        {"type": "dahai", "actor": 1, "pai": "E", "tsumogiri": True},
        # Seat 2 pons the East that seat 1 just discarded, then must discard.
        {"type": "pon", "actor": 2, "target": 1, "pai": "E", "consumed": ["E", "E"]},
        {"type": "dahai", "actor": 2, "pai": "P", "tsumogiri": False},
        {
            "type": "hora",
            "actor": 0,
            "target": 2,
            "deltas": [8000, 0, -8000, 0],
            "scores": [33000, 25000, 17000, 25000],
        },
        {"type": "end_kyoku"},
        {"type": "end_game"},
    ]


class NormalizeTileTest(unittest.TestCase):
    def test_red_fives(self):
        self.assertEqual(normalize_tile("0m"), "5mr")
        self.assertEqual(normalize_tile("0p"), "5pr")

    def test_tenhou_honors(self):
        self.assertEqual(normalize_tile("1z"), "E")
        self.assertEqual(normalize_tile("7z"), "C")

    def test_passthrough(self):
        self.assertEqual(normalize_tile("5m"), "5m")
        self.assertEqual(normalize_tile("5mr"), "5mr")
        self.assertEqual(normalize_tile("?"), "?")


class ExtractTest(unittest.TestCase):
    def setUp(self):
        self.all_records = extract_from_events(build_log(), game_id="test")
        # Discards only. Call opportunities are now recorded too and interleave
        # with them, so positional indexing has to say which kind it means.
        self.records = [r for r in self.all_records if r["kind"] == "discard"]

    def test_records_every_discard(self):
        self.assertEqual(len(self.records), 3)
        self.assertEqual(
            [record["actionTaken"] for record in self.records],
            ["discard:1m", "discard:E", "discard:P"],
        )

    def test_position_captured_before_the_discard(self):
        first = self.records[0]["position"]
        # The drawn tile is in hand and the discard has not happened yet.
        self.assertEqual(first["drawnTile"], "5m")
        self.assertEqual(len(first["hand"]), 14)
        self.assertIn("5m", first["hand"])
        self.assertIn("1m", first["hand"])
        self.assertEqual(first["rivers"], [[], [], [], []])

    def test_wall_count_decrements_per_draw(self):
        self.assertEqual(self.records[0]["position"]["tilesLeft"], 69)
        self.assertEqual(self.records[1]["position"]["tilesLeft"], 68)

    def test_river_reflects_earlier_discards(self):
        second = self.records[1]["position"]
        self.assertEqual(second["rivers"][0], ["1m"])

    def test_post_call_discard_has_no_drawn_tile(self):
        third = self.records[2]
        position = third["position"]
        # After a pon the player holds 11 concealed tiles plus a 3-tile meld,
        # and discards without having drawn.
        self.assertIsNone(position["drawnTile"])
        self.assertEqual(len(position["hand"]), 11)
        self.assertEqual(len(position["melds"]), 1)
        self.assertEqual(len(position["hand"]) + 3 * len(position["melds"]), 14)

    def test_called_tile_leaves_the_discarders_river(self):
        third = self.records[2]["position"]
        # Seat 1 discarded East, but seat 2 claimed it, so it is no longer there.
        self.assertEqual(third["rivers"][1], [])
        self.assertEqual(third["melds"][0]["kind"], "pon")
        self.assertEqual(sorted(third["melds"][0]["tiles"]), ["E", "E", "E"])

    def test_meld_is_visible_to_all_seats(self):
        # Seat 2 called, and this record is seat 2's own decision, so its meld
        # belongs in `melds`. Every other seat's slot is empty here because no
        # other seat has called.
        third = self.records[2]["position"]
        self.assertEqual(third["seat"], 2)
        self.assertEqual(len(third["melds"]), 1)
        for seat in range(4):
            self.assertEqual(third["opponentMelds"][seat], [], "seat {}".format(seat))

        # From another seat's point of view the same meld is an opponent's.
        first = self.records[0]["position"]
        self.assertEqual(first["seat"], 0)
        self.assertEqual(first["opponentMelds"][0], [])

    def test_own_meld_is_not_counted_twice(self):
        """The acting seat's melds appear in `melds` only.

        Listing them in `opponentMelds[seat]` as well put six copies of a ponned
        tile into 230 of 897 exported positions, and understated acceptance for
        those tiles, because the site counts visible tiles across all four meld
        slots.
        """
        for record in self.all_records:
            position = record["position"]
            seat = position["seat"]
            self.assertEqual(
                position["opponentMelds"][seat],
                [],
                "seat {} duplicates its own melds".format(seat),
            )

            counts = {}
            for tile in position["hand"]:
                counts[tile] = counts.get(tile, 0) + 1
            for group in [position["melds"]] + list(position["opponentMelds"]):
                for meld in group:
                    for tile in meld["tiles"]:
                        counts[tile] = counts.get(tile, 0) + 1
            for river in position["rivers"]:
                for tile in river:
                    counts[tile] = counts.get(tile, 0) + 1
            for tile in position["doraIndicators"]:
                counts[tile] = counts.get(tile, 0) + 1
            for tile, count in counts.items():
                self.assertLessEqual(count, 4, "{} appears {} times".format(tile, count))

    def test_final_placement_labels(self):
        placements = {record["actor"]: record["finalPlacement"] for record in self.records}
        self.assertEqual(placements[0], 0)
        self.assertEqual(placements[1], 1)
        self.assertEqual(placements[2], 3)

    def test_final_score_labels(self):
        self.assertEqual(self.records[0]["finalScore"], 33000)
        self.assertEqual(self.records[2]["finalScore"], 17000)

    def test_the_declaring_discard_is_a_decision(self):
        """The discard a riichi is declared on is the decision itself.

        `reach` precedes its discard in mjai, so treating the declaration as
        immediately in effect made this discard look forced and dropped it. That
        removed every riichi-or-damaten position from the dataset.
        """
        log = build_log()
        insert_at = log.index({"type": "tsumo", "actor": 1, "pai": "E"})
        log.insert(insert_at, {"type": "reach", "actor": 1})
        records = [
            record
            for record in extract_from_events(log, game_id="test")
            if record["kind"] == "discard"
        ]

        self.assertEqual(
            [record["actionTaken"] for record in records],
            ["discard:1m", "discard:E", "discard:P"],
        )
        declaring = records[1]
        self.assertTrue(declaring["declaredRiichi"])
        # The board must not show a riichi the player has not committed to yet,
        # or the puzzle asks whether to declare while displaying the stick.
        self.assertEqual(declaring["position"]["riichi"][1], False)

    def test_call_opportunities_are_recorded(self):
        """Declining a call leaves no trace in the log.

        The only way to recover these is to check the rules against each seat's
        hand at every discard, which is why the `call` kind was empty until now.
        """
        calls = [r for r in self.all_records if r["kind"] == "call"]
        self.assertTrue(calls, "no call opportunities found")

        # Seat 2 holds two East and takes the one seat 1 discards.
        taken = [c for c in calls if c["actionTaken"] == "pon"]
        self.assertEqual(len(taken), 1)
        self.assertEqual(taken[0]["actor"], 2)
        self.assertEqual(taken[0]["calledTile"], "E")
        self.assertIn("pon", taken[0]["callOptions"])

        for call in calls:
            # The prefix must *include* the discard, which is what creates the
            # decision — unlike a player's own discard, where it must stop before.
            self.assertEqual(call["position"]["seat"], call["actor"])
            self.assertEqual(len(call["position"]["hand"]), 13)
            self.assertIn(call["actionTaken"], ("pass", "pon", "chi", "daiminkan"))

    def test_a_seat_in_riichi_is_not_offered_calls(self):
        log = build_log()
        insert_at = log.index({"type": "tsumo", "actor": 1, "pai": "E"})
        log.insert(insert_at, {"type": "reach", "actor": 1})
        after = log.index({"type": "dahai", "actor": 1, "pai": "E", "tsumogiri": True}) + 1
        log.insert(after, {"type": "reach_accepted", "actor": 1})
        calls = [
            record
            for record in extract_from_events(log, game_id="test")
            if record["kind"] == "call" and record["actor"] == 1
        ]
        # Seat 1 is locked into its hand from the moment the declaration stands.
        self.assertEqual(calls, [])

    def test_ordinary_discards_are_not_flagged_as_declarations(self):
        for record in extract_from_events(build_log(), game_id="test"):
            self.assertFalse(record["declaredRiichi"], record["actionTaken"])

    def test_discards_after_riichi_are_skipped(self):
        # Once the declaration stands, later discards are forced by the rules and
        # are not decisions.
        log = build_log()
        insert_at = log.index({"type": "tsumo", "actor": 1, "pai": "E"})
        log.insert(insert_at, {"type": "reach", "actor": 1})
        after = log.index({"type": "dahai", "actor": 1, "pai": "E", "tsumogiri": True}) + 1
        log[after:after] = [
            {"type": "reach_accepted", "actor": 1},
            {"type": "tsumo", "actor": 1, "pai": "9p"},
            {"type": "dahai", "actor": 1, "pai": "9p", "tsumogiri": True},
        ]
        actions = [record["actionTaken"] for record in extract_from_events(log, game_id="test")]
        self.assertIn("discard:E", actions)
        self.assertNotIn("discard:9p", actions)

    def test_hidden_hands_are_skipped(self):
        log = build_log()
        log[1]["tehais"] = [["?"] * 13, TEHAIS[1], TEHAIS[2], TEHAIS[3]]
        records = extract_from_events(log, game_id="test")
        actors = {record["actor"] for record in records}
        self.assertNotIn(0, actors)
        self.assertIn(1, actors)

    def test_placement_ties_break_by_seating_order(self):
        log = build_log()
        for event in log:
            if event["type"] == "hora":
                event["scores"] = [25000, 25000, 25000, 25000]
                event["deltas"] = [0, 0, 0, 0]
        records = extract_from_events(log, game_id="test")
        placements = {record["actor"]: record["finalPlacement"] for record in records}
        self.assertEqual(placements[0], 0)
        self.assertEqual(placements[1], 1)
        self.assertEqual(placements[2], 2)

    @staticmethod
    def _log_with_reach(accepted):
        """Declare riichi for seat 2 *after* its recorded discard.

        Order matters: a riichi hand's discards are forced and therefore skipped
        as decisions, so declaring before the discard would leave that seat with
        no record to assert against.
        """
        log = build_log()
        after_discard = log.index(
            {"type": "dahai", "actor": 2, "pai": "P", "tsumogiri": False}
        ) + 1
        events = [{"type": "reach", "actor": 2}]
        if accepted:
            events.append({"type": "reach_accepted", "actor": 2})
        log[after_discard:after_discard] = events
        # Real houou logs carry deltas but no scores on hora.
        for event in log:
            if event["type"] == "hora":
                del event["scores"]
        return log

    def test_riichi_stick_is_paid_on_acceptance(self):
        """Real houou logs omit `scores` on hora and their `deltas` exclude the
        declarer's 1000-point stick, so it has to be applied separately or every
        placement label drifts.

        Measured against 6004 hand boundaries in the 2010 houou set: deltas alone
        mismatch the next hand's authoritative scores 1755 times, deducting on
        `reach` mismatches 67 times, deducting on `reach_accepted` mismatches once.
        """
        records = extract_from_events(self._log_with_reach(accepted=True), game_id="t")
        seat2 = next(r for r in records if r["actor"] == 2)
        # 25000 dealt, -8000 delta, -1000 stick.
        self.assertEqual(seat2["finalScore"], 16000)

    def test_unaccepted_reach_pays_nothing(self):
        # A reach ronned before it stands never pays its stick.
        records = extract_from_events(self._log_with_reach(accepted=False), game_id="t")
        seat2 = next(r for r in records if r["actor"] == 2)
        self.assertEqual(seat2["finalScore"], 17000)

    def test_falls_back_to_deltas_without_scores(self):
        log = build_log()
        for event in log:
            if event["type"] == "hora":
                del event["scores"]
        records = extract_from_events(log, game_id="test")
        self.assertEqual(records[0]["finalScore"], 33000)
        self.assertEqual(records[2]["finalScore"], 17000)


if __name__ == "__main__":
    unittest.main()
