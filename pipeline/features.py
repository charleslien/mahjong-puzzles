"""Feature encoding: position dict -> dense planes for the model.

Two hard constraints shape this, both measured rather than assumed:

1. Dense features must never be precomputed to disk. At 20M decisions a dense
   fp32 array is ~700GB, so encoding happens per batch, at training time.

   For scale: the records extract.py emits measure ~650 bytes each, so 20M
   decisions is ~13GB of JSON, or roughly 2GB gzipped. Both extract.py and
   train.py handle gzip, which is what makes a multi-million-decision corpus
   practical on a laptop. (An earlier version of this note claimed ~3.4GB for
   20M records; that described a compact binary format that was never built.)

2. Encoding must stay well ahead of the model. Measured on an M5: the reduced
   model trains at ~6.3k samples/sec on MPS, and a numpy encoder of this shape
   runs at ~350k samples/sec single-process. Roughly 50x headroom, so this can
   stay pure numpy and single-threaded.

Anything expensive belongs in the compact record, not in here. Shanten in
particular must not be computed during encoding — it would move the bottleneck
to exactly the wrong place. Let the network learn shape from the tile planes.

The exact plane layout is a contract between training and inference. Changing it
invalidates every checkpoint, so PLANE_LAYOUT is versioned and written into the
checkpoint.
"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence

import numpy as np

TILE_AXIS = 34
LAYOUT_VERSION = 1

HONORS = ("E", "S", "W", "N", "P", "F", "C")
SUIT_BASE = {"m": 0, "p": 9, "s": 18}


def tile_to_index(tile: str) -> int:
    """mjai tile notation -> 0..33. Red fives share their plain counterpart."""
    if tile in HONORS:
        return 27 + HONORS.index(tile)
    if len(tile) >= 2 and tile[1] in SUIT_BASE:
        rank = int(tile[0])
        if rank == 0:
            rank = 5
        return SUIT_BASE[tile[1]] + rank - 1
    if len(tile) == 2 and tile[1] == "z":
        return 27 + int(tile[0]) - 1
    raise ValueError("unparseable tile: {}".format(tile))


def _counts(tiles: Sequence[str]) -> np.ndarray:
    out = np.zeros(TILE_AXIS, dtype=np.float32)
    for tile in tiles:
        out[tile_to_index(tile)] += 1
    return out


# Plane groups, in order. Each entry is (name, count) and the total is IN_CHANNELS.
PLANE_LAYOUT: List[tuple] = [
    ("hand_threshold", 4),      # own hand: >=1, >=2, >=3, >=4 copies
    ("hand_red", 1),            # own red fives
    ("drawn", 1),               # the tile just drawn
    ("own_melds", 4),           # own melds by kind
    ("dora", 1),                # dora tiles (from indicators)
    ("dora_indicator", 1),      # the indicators themselves
    ("rivers", 4 * 4),          # per seat: >=1..>=4 copies discarded
    ("river_recent", 4),        # per seat: the last three discards
    ("opp_melds", 3 * 4),       # three opponents, meld kinds
    ("riichi", 4),              # per seat riichi flag, broadcast
    ("seat_wind", 4),           # own seat wind, broadcast
    ("round_wind", 4),          # round wind, broadcast
    ("scalars", 8),             # wall count, scores, honba, sticks — broadcast
]

IN_CHANNELS = sum(count for _name, count in PLANE_LAYOUT)

MELD_KINDS = ("chi", "pon", "daiminkan", "shouminkan", "ankan")
# daiminkan/shouminkan/ankan collapse into one "kan" plane per owner.
MELD_PLANE = {"chi": 0, "pon": 1, "daiminkan": 2, "shouminkan": 2, "ankan": 3}


def encode(position: Dict[str, Any], out: np.ndarray) -> np.ndarray:
    """Fill `out` (IN_CHANNELS x 34) for a single position. Zeroes it first."""
    out.fill(0.0)
    plane = 0

    hand = position.get("hand") or []
    hand_counts = _counts(hand)
    for level in range(4):
        out[plane + level] = (hand_counts > level).astype(np.float32)
    plane += 4

    for tile in hand:
        if tile.endswith("r"):
            out[plane, tile_to_index(tile)] = 1.0
    plane += 1

    drawn = position.get("drawnTile")
    if drawn:
        out[plane, tile_to_index(drawn)] = 1.0
    plane += 1

    for meld in position.get("melds") or []:
        slot = MELD_PLANE.get(meld.get("kind", "pon"), 1)
        for tile in meld.get("tiles", []):
            out[plane + slot, tile_to_index(tile)] = 1.0
    plane += 4

    indicators = position.get("doraIndicators") or []
    for indicator in indicators:
        out[plane, _dora_from_indicator_index(tile_to_index(indicator))] = 1.0
    plane += 1
    for indicator in indicators:
        out[plane, tile_to_index(indicator)] = 1.0
    plane += 1

    rivers = position.get("rivers") or [[], [], [], []]
    seat = int(position.get("seat", 0))
    # Rivers are stored absolutely; rotate so index 0 is always the acting player.
    for offset in range(4):
        river = rivers[(seat + offset) % 4] if len(rivers) == 4 else []
        river_counts = _counts(river)
        for level in range(4):
            out[plane + offset * 4 + level] = (river_counts > level).astype(np.float32)
    plane += 16

    for offset in range(4):
        river = rivers[(seat + offset) % 4] if len(rivers) == 4 else []
        for tile in river[-3:]:
            out[plane + offset, tile_to_index(tile)] = 1.0
    plane += 4

    opponent_melds = position.get("opponentMelds") or [[], [], [], []]
    for offset in range(1, 4):
        melds = opponent_melds[(seat + offset) % 4] if len(opponent_melds) == 4 else []
        for meld in melds:
            slot = MELD_PLANE.get(meld.get("kind", "pon"), 1)
            for tile in meld.get("tiles", []):
                out[plane + (offset - 1) * 4 + slot, tile_to_index(tile)] = 1.0
    plane += 12

    riichi = position.get("riichi") or [False] * 4
    for offset in range(4):
        if riichi[(seat + offset) % 4]:
            out[plane + offset] = 1.0
    plane += 4

    round_info = position.get("round") or {}
    # Seat wind depends on the dealer, which puzzle positions do not record;
    # oya 0 is assumed, matching snapshotFromPosition on the site.
    out[plane + (seat % 4)] = 1.0
    plane += 4

    wind = round_info.get("wind", "E")
    out[plane + (HONORS.index(wind) if wind in HONORS[:4] else 0)] = 1.0
    plane += 4

    scores = position.get("scores") or [25000] * 4
    out[plane + 0] = float(position.get("tilesLeft", 0)) / 70.0
    for offset in range(4):
        out[plane + 1 + offset] = float(scores[(seat + offset) % 4]) / 50000.0
    out[plane + 5] = float(round_info.get("honba", 0)) / 5.0
    out[plane + 6] = float(round_info.get("riichiSticks", 0)) / 5.0
    out[plane + 7] = float(len(position.get("melds") or [])) / 4.0
    plane += 8

    assert plane == IN_CHANNELS, "plane layout drift: {} != {}".format(plane, IN_CHANNELS)
    return out


def _dora_from_indicator_index(index: int) -> int:
    if index >= 31:
        return 31 + ((index - 31 + 1) % 3)
    if index >= 27:
        return 27 + ((index - 27 + 1) % 4)
    base = (index // 9) * 9
    return base + ((index % 9 + 1) % 9)


def encode_batch(positions: Sequence[Dict[str, Any]]) -> np.ndarray:
    """Encode a list of positions into a (batch, IN_CHANNELS, 34) array."""
    batch = np.zeros((len(positions), IN_CHANNELS, TILE_AXIS), dtype=np.float32)
    for i, position in enumerate(positions):
        encode(position, batch[i])
    return batch


# Action space: 34 discards, then the non-discard verbs.
VERBS = ("riichi", "pass", "pon", "chi", "kan", "tsumo", "ron")
NUM_ACTIONS = TILE_AXIS + len(VERBS)


def action_to_index(action_id: str) -> int:
    """Map a stored action id (`discard:5m`, `riichi`, …) to its output index."""
    if action_id.startswith("discard:"):
        return tile_to_index(action_id.split(":", 1)[1])
    verb = action_id.split(":", 1)[0]
    if verb in VERBS:
        return TILE_AXIS + VERBS.index(verb)
    raise ValueError("unknown action id: {}".format(action_id))


def legal_discard_mask(position: Dict[str, Any]) -> np.ndarray:
    """True where a discard is legal, i.e. the tile is in hand."""
    mask = np.zeros(NUM_ACTIONS, dtype=bool)
    for tile in position.get("hand") or []:
        mask[tile_to_index(tile)] = True
    return mask
