"""Extract decision records from mjai game logs.

Reads mjai-format logs (one JSON event per line, as distributed by
tenhou-to-mjai) and replays them, emitting one record per decision point along
with the position as the acting player could see it.

Each record also carries the actor's final placement in the hanchan, which is
the training label the offline model regresses against and the basis for the
placement-point EV the site reports.

Deliberately dependency-free so it can run over a 12GB dump without a build
step. Target: Python 3.9+.

Usage:
    python -m pipeline.extract --input data/logs/2024 --output data/decisions.jsonl
    python -m pipeline.extract --input one.mjson --output - --limit 5
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence

from pipeline.jsonl import open_text

# mjai tile notation. Red fives carry an "r" suffix; honors are single letters.
HONORS = ("E", "S", "W", "N", "P", "F", "C")

# A full wall is 136 tiles; 14 go to the dead wall and 13*4 to starting hands.
LIVE_WALL_AT_START = 70


class UnsupportedLog(Exception):
    """Raised when a log cannot be replayed faithfully."""


def normalize_tile(tile: str) -> str:
    """Map Tenhou-style spellings onto canonical mjai notation."""
    if tile in HONORS or tile == "?":
        return tile
    if len(tile) >= 2 and tile[0] == "0" and tile[1] in "mps":
        return "5" + tile[1] + "r"
    if len(tile) == 2 and tile[1] == "z":
        index = int(tile[0]) - 1
        if 0 <= index < len(HONORS):
            return HONORS[index]
    return tile


class GameState:
    """Replays one hanchan, tracking everything a seated player can observe."""

    def __init__(self, num_players: int = 4) -> None:
        self.num_players = num_players
        self.scores: List[int] = [25000] * num_players
        self.reset_kyoku()

    def reset_kyoku(self) -> None:
        self.bakaze = "E"
        self.kyoku = 1
        self.honba = 0
        self.kyotaku = 0
        self.oya = 0
        self.dora_markers: List[str] = []
        self.hands: List[List[str]] = [[] for _ in range(self.num_players)]
        self.rivers: List[List[str]] = [[] for _ in range(self.num_players)]
        self.melds: List[List[Dict[str, Any]]] = [[] for _ in range(self.num_players)]
        self.riichi: List[bool] = [False] * self.num_players
        self.last_draw: List[Optional[str]] = [None] * self.num_players
        self.tiles_left = LIVE_WALL_AT_START
        self.in_kyoku = False

    # -- event handlers ----------------------------------------------------

    def start_kyoku(self, event: Dict[str, Any]) -> None:
        self.reset_kyoku()
        self.in_kyoku = True
        self.bakaze = event.get("bakaze", "E")
        self.kyoku = int(event.get("kyoku", 1))
        self.honba = int(event.get("honba", 0))
        self.kyotaku = int(event.get("kyotaku", 0))
        self.oya = int(event.get("oya", 0))
        marker = event.get("dora_marker")
        if marker:
            self.dora_markers = [normalize_tile(marker)]

        tehais = event.get("tehais") or []
        for seat, hand in enumerate(tehais[: self.num_players]):
            self.hands[seat] = [normalize_tile(tile) for tile in hand]

        scores = event.get("scores")
        if isinstance(scores, list) and len(scores) == self.num_players:
            self.scores = [int(value) for value in scores]

    def tsumo(self, event: Dict[str, Any]) -> None:
        actor = int(event["actor"])
        tile = normalize_tile(event["pai"])
        self.tiles_left = max(0, self.tiles_left - 1)
        self.last_draw[actor] = tile
        if tile != "?":
            self.hands[actor].append(tile)

    def dahai(self, event: Dict[str, Any]) -> None:
        actor = int(event["actor"])
        tile = normalize_tile(event["pai"])
        self._remove_from_hand(actor, tile)
        self.rivers[actor].append(tile)
        self.last_draw[actor] = None

    def call(self, event: Dict[str, Any]) -> None:
        kind = event["type"]
        actor = int(event["actor"])
        consumed = [normalize_tile(tile) for tile in event.get("consumed", [])]
        called = normalize_tile(event["pai"]) if event.get("pai") else None

        for tile in consumed:
            self._remove_from_hand(actor, tile)

        # The called tile leaves the discarder's river.
        target = event.get("target")
        if called is not None and target is not None:
            river = self.rivers[int(target)]
            if river and river[-1] == called:
                river.pop()

        tiles = list(consumed)
        if called is not None:
            tiles.append(called)

        if kind == "kakan":
            # Upgrades an existing pon rather than forming a new meld.
            for meld in self.melds[actor]:
                if meld["kind"] == "pon" and called is not None and called in meld["tiles"]:
                    meld["kind"] = "shouminkan"
                    meld["tiles"] = meld["tiles"] + [called]
                    break
        else:
            self.melds[actor].append(
                {"kind": kind, "tiles": tiles, "from": target if target is None else int(target)}
            )

        self.last_draw[actor] = None

    def reach(self, event: Dict[str, Any]) -> None:
        # The declaration is visible to everyone immediately, even though the
        # 1000-point stick is not paid until the reach stands.
        self.riichi[int(event["actor"])] = True

    def reach_accepted(self, event: Dict[str, Any]) -> None:
        """Pay the riichi stick.

        This matters for the placement labels and is easy to get wrong. The
        `deltas` on hora/ryukyoku do *not* include the declarer's 1000-point
        stick — only the winner collecting the pot. Verified against 6004 hand
        boundaries in the 2010 houou set: accumulating deltas alone mismatches
        the next hand's authoritative `scores` 1755 times, deducting on `reach`
        still mismatches 67 times (reaches that were ronned before they stood),
        and deducting on `reach_accepted` mismatches once.
        """
        self.scores[int(event["actor"])] -= 1000

    def dora(self, event: Dict[str, Any]) -> None:
        marker = event.get("dora_marker")
        if marker:
            self.dora_markers.append(normalize_tile(marker))

    def _remove_from_hand(self, actor: int, tile: str) -> None:
        hand = self.hands[actor]
        if tile in hand:
            hand.remove(tile)
        elif "?" in hand:
            # Hands hidden behind "?" cannot be tracked; drop a placeholder so
            # the count stays right.
            hand.remove("?")

    # -- observation -------------------------------------------------------

    def hand_is_known(self, seat: int) -> bool:
        return "?" not in self.hands[seat]

    def observe(self, seat: int) -> Dict[str, Any]:
        """The position from `seat`'s point of view, matching the site schema."""
        return {
            "seat": seat,
            "round": {
                "wind": self.bakaze,
                "kyoku": self.kyoku,
                "honba": self.honba,
                "riichiSticks": self.kyotaku,
            },
            "scores": list(self.scores),
            "doraIndicators": list(self.dora_markers),
            "hand": sorted(self.hands[seat]),
            "drawnTile": self.last_draw[seat],
            "melds": [dict(meld) for meld in self.melds[seat]],
            "rivers": [list(river) for river in self.rivers],
            # The acting seat's own melds live in `melds`; its slot here stays
            # empty so the same physical tiles are never counted twice. Filling
            # it put six copies of a ponned tile into 230 of 897 exported
            # positions, and understated acceptance for those tiles because the
            # site's visibility count sums all four slots. The training encoder
            # reads only offsets 1-3, so the model was unaffected.
            "opponentMelds": [
                [] if other == seat else [dict(m) for m in melds]
                for other, melds in enumerate(self.melds)
            ],
            "riichi": list(self.riichi),
            "tilesLeft": self.tiles_left,
        }


def _final_placements(final_scores: Sequence[int], oya_order: Sequence[int]) -> List[int]:
    """Placement (0 = first) per seat, breaking ties by seating order.

    Ties are broken the way Tenhou does it: the player closer to the starting
    dealer in turn order places higher.
    """
    ranking = sorted(
        range(len(final_scores)),
        key=lambda seat: (-final_scores[seat], oya_order.index(seat)),
    )
    placements = [0] * len(final_scores)
    for placement, seat in enumerate(ranking):
        placements[seat] = placement
    return placements


def iter_events(path: str) -> Iterator[Dict[str, Any]]:
    """Yield events from a plain or gzipped mjai log.

    Compression is detected by magic bytes rather than extension: the published
    dumps keep the .mjson extension on gzipped payloads.
    """
    try:
        handle = open_text(path)
    except OSError as exc:
        raise UnsupportedLog("cannot open {}: {}".format(path, exc))

    with handle:
        for line_number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise UnsupportedLog("{}:{}: {}".format(path, line_number, exc))


def extract_from_events(
    events: Iterable[Dict[str, Any]],
    game_id: str,
) -> List[Dict[str, Any]]:
    """Replay one log and return its decision records.

    Records are buffered until the game ends, because the placement label is
    only known then.
    """
    state = GameState()
    pending: List[Dict[str, Any]] = []
    decision_index = 0
    final_scores: Optional[List[int]] = None

    for event_index, event in enumerate(events):
        kind = event.get("type")

        if kind == "start_kyoku":
            state.start_kyoku(event)
            continue

        if kind == "tsumo":
            state.tsumo(event)
            continue

        if kind == "dahai":
            actor = int(event["actor"])
            # Record the decision *before* applying it, and only when the hand
            # is fully known and the player actually had a choice.
            if state.in_kyoku and state.hand_is_known(actor) and not state.riichi[actor]:
                pending.append(
                    {
                        "gameId": game_id,
                        "decisionIndex": decision_index,
                        # Index of this `dahai` in the log's event sequence.
                        # decisionIndex counts *recorded decisions*, so it cannot
                        # locate the event; verify.py needs the event index to
                        # replay the log up to the decision for akochan, and
                        # recomputing it there would duplicate the filter
                        # conditions above and be free to drift from them.
                        "eventIndex": event_index,
                        "kind": "discard",
                        "actor": actor,
                        "position": state.observe(actor),
                        "actionTaken": "discard:{}".format(normalize_tile(event["pai"])),
                        "tsumogiri": bool(event.get("tsumogiri", False)),
                    }
                )
                decision_index += 1
            state.dahai(event)
            continue

        if kind in ("chi", "pon", "daiminkan", "kakan", "ankan"):
            state.call(event)
            continue

        if kind == "reach":
            state.reach(event)
            continue

        if kind == "reach_accepted":
            state.reach_accepted(event)
            continue

        if kind == "dora":
            state.dora(event)
            continue

        if kind in ("hora", "ryukyoku"):
            scores = event.get("scores")
            if isinstance(scores, list) and len(scores) == state.num_players:
                state.scores = [int(value) for value in scores]
            else:
                deltas = event.get("deltas")
                if isinstance(deltas, list) and len(deltas) == state.num_players:
                    state.scores = [
                        state.scores[i] + int(deltas[i]) for i in range(state.num_players)
                    ]
            final_scores = list(state.scores)
            continue

        if kind == "end_kyoku":
            state.in_kyoku = False
            continue

    if final_scores is None:
        final_scores = list(state.scores)

    placements = _final_placements(final_scores, list(range(state.num_players)))
    for record in pending:
        record["finalPlacement"] = placements[record["actor"]]
        record["finalScore"] = final_scores[record["actor"]]

    return pending


def iter_log_paths(root: str) -> Iterator[str]:
    if os.path.isfile(root):
        yield root
        return
    for directory, _subdirs, files in os.walk(root):
        for name in sorted(files):
            if name.endswith((".mjson", ".mjson.gz", ".json", ".jsonl", ".gz")):
                yield os.path.join(directory, name)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--input", required=True, help="log file or directory of logs")
    parser.add_argument("--output", required=True, help="output JSONL path, or - for stdout")
    parser.add_argument("--limit", type=int, default=0, help="stop after N games (0 = all)")
    parser.add_argument(
        "--skip",
        type=int,
        default=0,
        help="skip the first N games, for carving a disjoint holdout split",
    )
    parser.add_argument(
        "--skip-errors",
        action="store_true",
        help="log and continue past unreadable files instead of failing",
    )
    args = parser.parse_args(argv)

    # Records average ~650 bytes, so a multi-million-decision extract is worth
    # gzipping: roughly 6x smaller, and train.py reads either form.
    if args.output == "-":
        out = sys.stdout
    elif args.output.endswith(".gz"):
        out = gzip.open(args.output, "wt", encoding="utf-8")
    else:
        out = open(args.output, "w", encoding="utf-8")
    games = 0
    records = 0
    failures = 0

    try:
        seen_files = 0
        for path in iter_log_paths(args.input):
            if args.limit and games >= args.limit:
                break
            # Skipping by file keeps splits disjoint at game granularity; two
            # decisions from one hand must never straddle train and holdout.
            seen_files += 1
            if seen_files <= args.skip:
                continue
            try:
                extracted = extract_from_events(
                    iter_events(path), game_id=os.path.basename(path)
                )
            except (UnsupportedLog, OSError, ValueError) as exc:
                failures += 1
                if not args.skip_errors:
                    raise
                sys.stderr.write("skipped {}: {}\n".format(path, exc))
                continue

            for record in extracted:
                out.write(json.dumps(record, separators=(",", ":"), sort_keys=True))
                out.write("\n")
            games += 1
            records += len(extracted)
    finally:
        if out is not sys.stdout:
            out.close()

    sys.stderr.write(
        "extracted {} decisions from {} games ({} files skipped)\n".format(records, games, failures)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
