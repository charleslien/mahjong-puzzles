"""Tests for the feature encoder.

The plane layout is a contract between training and inference: a checkpoint is
worthless if the encoding drifts, and the failure is silent — the model just gets
quietly worse. So the layout is pinned here.

Run with: python -m unittest discover pipeline
"""

from __future__ import annotations

import unittest

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

if np is not None:
    from pipeline.features import (
        IN_CHANNELS,
        NUM_ACTIONS,
        PLANE_LAYOUT,
        TILE_AXIS,
        action_to_index,
        encode,
        encode_batch,
        legal_discard_mask,
        tile_to_index,
    )


def position(**overrides):
    base = {
        "seat": 0,
        "round": {"wind": "E", "kyoku": 1, "honba": 0, "riichiSticks": 0},
        "scores": [25000, 25000, 25000, 25000],
        "doraIndicators": ["1s"],
        "hand": ["1m", "1m", "2m", "3m", "4m", "5mr", "6m", "7m", "8m", "9m", "E", "E", "E", "S"],
        "drawnTile": "S",
        "melds": [],
        "rivers": [[], [], [], []],
        "opponentMelds": [[], [], [], []],
        "riichi": [False, False, False, False],
        "tilesLeft": 42,
    }
    base.update(overrides)
    return base


@unittest.skipIf(np is None, "numpy not installed")
class LayoutTest(unittest.TestCase):
    def test_channel_count_matches_the_layout(self):
        self.assertEqual(IN_CHANNELS, sum(count for _name, count in PLANE_LAYOUT))

    def test_layout_is_pinned(self):
        # If this fails you have changed the feature contract. That is allowed,
        # but every existing checkpoint is now invalid — bump LAYOUT_VERSION.
        self.assertEqual(IN_CHANNELS, 64)
        self.assertEqual(NUM_ACTIONS, 41)

    def test_encode_fills_the_declared_shape(self):
        out = np.zeros((IN_CHANNELS, TILE_AXIS), dtype=np.float32)
        encode(position(), out)
        self.assertEqual(out.shape, (IN_CHANNELS, TILE_AXIS))


@unittest.skipIf(np is None, "numpy not installed")
class TileIndexTest(unittest.TestCase):
    def test_suits_and_honors(self):
        self.assertEqual(tile_to_index("1m"), 0)
        self.assertEqual(tile_to_index("9m"), 8)
        self.assertEqual(tile_to_index("1p"), 9)
        self.assertEqual(tile_to_index("1s"), 18)
        self.assertEqual(tile_to_index("E"), 27)
        self.assertEqual(tile_to_index("C"), 33)

    def test_red_five_shares_its_plain_index(self):
        self.assertEqual(tile_to_index("5mr"), tile_to_index("5m"))
        self.assertEqual(tile_to_index("0m"), tile_to_index("5m"))


@unittest.skipIf(np is None, "numpy not installed")
class EncodeTest(unittest.TestCase):
    def setUp(self):
        self.out = np.zeros((IN_CHANNELS, TILE_AXIS), dtype=np.float32)
        encode(position(), self.out)

    def test_hand_threshold_planes(self):
        # 1m appears twice: the >=1 and >=2 planes are set, >=3 is not.
        self.assertEqual(self.out[0, tile_to_index("1m")], 1.0)
        self.assertEqual(self.out[1, tile_to_index("1m")], 1.0)
        self.assertEqual(self.out[2, tile_to_index("1m")], 0.0)
        # East appears three times.
        self.assertEqual(self.out[2, tile_to_index("E")], 1.0)
        self.assertEqual(self.out[3, tile_to_index("E")], 0.0)

    def test_red_five_plane(self):
        self.assertEqual(self.out[4, tile_to_index("5m")], 1.0)
        self.assertEqual(self.out[4, tile_to_index("6m")], 0.0)

    def test_drawn_plane(self):
        self.assertEqual(self.out[5, tile_to_index("S")], 1.0)
        self.assertEqual(self.out[5, tile_to_index("1m")], 0.0)

    def test_dora_is_derived_from_the_indicator(self):
        # Indicator 1s means the dora is 2s, and both are recorded separately.
        dora_plane = 4 + 1 + 1 + 4
        self.assertEqual(self.out[dora_plane, tile_to_index("2s")], 1.0)
        self.assertEqual(self.out[dora_plane, tile_to_index("1s")], 0.0)
        self.assertEqual(self.out[dora_plane + 1, tile_to_index("1s")], 1.0)

    def test_dora_wraps_within_its_suit(self):
        out = np.zeros((IN_CHANNELS, TILE_AXIS), dtype=np.float32)
        encode(position(doraIndicators=["9m"]), out)
        dora_plane = 10
        self.assertEqual(out[dora_plane, tile_to_index("1m")], 1.0)

    def test_dragon_dora_cycles_among_dragons(self):
        out = np.zeros((IN_CHANNELS, TILE_AXIS), dtype=np.float32)
        encode(position(doraIndicators=["C"]), out)
        self.assertEqual(out[10, tile_to_index("P")], 1.0)

    def test_rivers_are_rotated_to_the_acting_seat(self):
        # Seat 2 acting; its own river must land in the first river slot.
        out = np.zeros((IN_CHANNELS, TILE_AXIS), dtype=np.float32)
        encode(
            position(seat=2, rivers=[["1p"], ["2p"], ["3p"], ["4p"]], drawnTile=None),
            out,
        )
        river_plane = 12
        self.assertEqual(out[river_plane, tile_to_index("3p")], 1.0)
        self.assertEqual(out[river_plane, tile_to_index("1p")], 0.0)
        # The seat one to its left follows.
        self.assertEqual(out[river_plane + 4, tile_to_index("4p")], 1.0)

    def test_riichi_flags_are_rotated_and_broadcast(self):
        out = np.zeros((IN_CHANNELS, TILE_AXIS), dtype=np.float32)
        encode(position(seat=1, riichi=[False, False, True, False]), out)
        riichi_plane = 12 + 16 + 4 + 12
        # Seat 2 is one to the acting seat's left.
        self.assertTrue(bool(out[riichi_plane + 1].all()))
        self.assertFalse(bool(out[riichi_plane].any()))

    def test_scalars_are_normalised(self):
        scalar_plane = IN_CHANNELS - 8
        # 42 of 70 tiles left.
        self.assertAlmostEqual(float(self.out[scalar_plane, 0]), 42.0 / 70.0, places=5)
        self.assertAlmostEqual(float(self.out[scalar_plane + 1, 0]), 0.5, places=5)

    def test_encoding_is_deterministic(self):
        again = np.zeros((IN_CHANNELS, TILE_AXIS), dtype=np.float32)
        encode(position(), again)
        self.assertTrue(np.array_equal(self.out, again))

    def test_reused_buffer_is_cleared(self):
        # A stale plane from a previous position would leak without the fill.
        encode(position(hand=["1p"], drawnTile=None, doraIndicators=[]), self.out)
        self.assertEqual(self.out[0, tile_to_index("1m")], 0.0)
        self.assertEqual(self.out[0, tile_to_index("1p")], 1.0)

    def test_batch_encoding_matches_single(self):
        batch = encode_batch([position(), position(seat=1)])
        single = np.zeros((IN_CHANNELS, TILE_AXIS), dtype=np.float32)
        encode(position(), single)
        self.assertTrue(np.array_equal(batch[0], single))
        self.assertFalse(np.array_equal(batch[0], batch[1]))


@unittest.skipIf(np is None, "numpy not installed")
class ActionTest(unittest.TestCase):
    def test_discard_actions_map_to_tile_indices(self):
        self.assertEqual(action_to_index("discard:1m"), 0)
        self.assertEqual(action_to_index("discard:C"), 33)

    def test_red_five_discard_shares_its_index(self):
        self.assertEqual(action_to_index("discard:5mr"), action_to_index("discard:5m"))

    def test_verbs_follow_the_discards(self):
        self.assertEqual(action_to_index("riichi"), TILE_AXIS)
        self.assertGreater(action_to_index("ron"), TILE_AXIS)

    def test_unknown_action_raises(self):
        with self.assertRaises(ValueError):
            action_to_index("teleport")

    def test_legal_mask_covers_exactly_the_hand(self):
        mask = legal_discard_mask(position())
        self.assertTrue(mask[tile_to_index("1m")])
        self.assertTrue(mask[tile_to_index("E")])
        self.assertFalse(mask[tile_to_index("9p")])
        # Verbs are not discards.
        self.assertFalse(mask[TILE_AXIS:].any())


if __name__ == "__main__":
    unittest.main()
