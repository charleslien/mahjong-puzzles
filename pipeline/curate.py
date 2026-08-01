"""Stage 3c: choose which annotated candidates are worth verifying.

(Named `curate` and not the obvious `select` because `unittest discover` puts
this directory on `sys.path`, where a module called `select` shadows the stdlib
one that `subprocess` waits on — which broke the akochan tests with a
`TypeError` from inside `selectors.py` and nothing pointing at the cause.)


verify.py is the expensive stage — akochan runs a search per position, at about
4 positions/s — and it used to see whatever `--stride` happened to sample. That
made the bank's composition a side effect of a sampling parameter: the shipped
bank came out 79% discards and 6% riichi, so the site's Riichi filter repeated
itself inside a single session.

Mining density and bank composition are separate questions, and this stage is
what separates them. Mine densely, then spend the verification budget where the
bank is thin.

Three things happen here, in order:

  1. **Bucketing.** A candidate is labelled with the puzzle it would become, not
     the decision it was extracted as. akochan has the final say — a position
     only becomes a riichi puzzle if akochan offers a declaration — so the
     `riichi` bucket is a prefilter, and a false positive costs nothing: it is
     published as an ordinary discard puzzle instead. Measured against a full
     run, the prefilter caught 152 of the 154 positions akochan turned into
     riichi puzzles; the two it missed were hands holding a concealed kan, which
     is why `_concealed` counts ankan as closed.

  2. **Per-kyoku thinning.** A tenpai hand stays tenpai, so consecutive
     decisions in one hand are near-duplicates of each other — the same wait,
     one tile further on. Dense mining surfaces all of them. Keeping one
     decision per (game, hand, seat, bucket) is what makes a low stride safe.

     Which one survives is the first, which in principle biases toward the turn
     a hand *reaches* tenpai over the turns it sits there. Measured on a
     stride-30 pass over 6,000 games, 34 of 3,906 riichi-capable positions were
     in a group larger than one, so choosing more cleverly would move 0.9% of
     them and is not worth a hash.

  3. **Quotas.** Each bucket is capped, sampled at an even stride through the
     file rather than from the front, so a cap keeps the spread of games and
     rounds instead of taking the first N logs alphabetically.

Usage:
    python -m pipeline.curate --input annotated.jsonl --output selected.jsonl \\
        --quota riichi=9000 --quota call=2000 --quota discard=4000
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List, Optional, Sequence, Set

from pipeline.jsonl import iter_records

#: The minimum stick a declaration costs. A player below it cannot declare, so
#: the position is an ordinary discard however tenpai it looks.
RIICHI_COST = 1000

#: akochan is given no declaration to evaluate once the wall is this short,
#: since a riichi that cannot be drawn into is not a decision.
MIN_TILES_LEFT = 4


def _concealed(position: Dict[str, Any]) -> bool:
    """Whether the hand is still closed.

    A concealed kan is a meld in the position record but leaves the hand closed
    and riichi legal. Treating any meld as an open hand lost exactly those.
    """
    return all(
        (meld or {}).get("kind") == "ankan" for meld in (position.get("melds") or [])
    )


def riichi_capable(record: Dict[str, Any]) -> bool:
    """Whether a declaration is plausibly on offer at this position.

    Necessary conditions only. akochan decides whether a reach line actually
    exists; this exists to keep the verification budget off the 95% of discards
    where the question cannot arise.
    """
    if record.get("kind", "discard") != "discard":
        return False
    position = record.get("position") or {}
    seat = int(position.get("seat", 0))

    if not _concealed(position):
        return False
    riichi = position.get("riichi") or []
    if seat < len(riichi) and riichi[seat]:
        return False
    if int(position.get("tilesLeft") or 0) < MIN_TILES_LEFT:
        return False
    scores = position.get("scores") or []
    if seat < len(scores) and int(scores[seat]) < RIICHI_COST:
        return False

    # Tenpai, read off the annotation rather than recomputed: some discard
    # leaves the hand waiting. `ukeireActions` is written by
    # scripts/annotate-ukeire.ts, which is the only shanten implementation in
    # the project with a brute-force reference test.
    actions = record.get("ukeireActions") or {}
    return any((entry or {}).get("shantenAfter") == 0 for entry in actions.values())


def bucket_of(record: Dict[str, Any]) -> str:
    """Which puzzle this candidate is competing to become."""
    if riichi_capable(record):
        return "riichi"
    return record.get("kind", "discard")


def hand_key(record: Dict[str, Any]) -> tuple:
    """Identifies one player's turn in one hand of one game.

    Honba is part of it: an abortive draw replays the same seat and wind with a
    different wall, and those are genuinely different positions.
    """
    position = record.get("position") or {}
    round_info = position.get("round") or {}
    return (
        record.get("gameId"),
        round_info.get("wind"),
        round_info.get("kyoku"),
        round_info.get("honba"),
        position.get("seat"),
    )


def _even_sample(rows: List[Any], limit: int) -> List[Any]:
    """`limit` rows spread evenly through `rows`, keeping their order."""
    if limit <= 0 or len(rows) <= limit:
        return rows
    stride = len(rows) / limit
    return [rows[int(index * stride)] for index in range(limit)]


def select(
    records: Sequence[Dict[str, Any]],
    quotas: Dict[str, int],
    per_hand: int = 1,
) -> List[Dict[str, Any]]:
    """Thin and cap `records`, returning them in their original order.

    Order is preserved because verify.py writes as it goes: a run stopped early
    should still hold a spread of games rather than every candidate from the
    first few.
    """
    kept_per_hand: Dict[tuple, int] = {}
    by_bucket: Dict[str, List[int]] = {}

    for index, record in enumerate(records):
        bucket = bucket_of(record)
        key = hand_key(record) + (bucket,)
        if per_hand and kept_per_hand.get(key, 0) >= per_hand:
            continue
        kept_per_hand[key] = kept_per_hand.get(key, 0) + 1
        by_bucket.setdefault(bucket, []).append(index)

    chosen: Set[int] = set()
    for bucket, indices in sorted(by_bucket.items()):
        # Absent means "no cap"; a quota of 0 means "none of these", which is how
        # a run spends its whole budget on the bucket the bank is short of.
        if bucket in quotas:
            keep = _even_sample(indices, quotas[bucket]) if quotas[bucket] else []
        else:
            keep = indices
        chosen.update(keep)
        sys.stderr.write(
            "  {:<10} {} after thinning -> {} selected\n".format(
                bucket, len(indices), len(keep)
            )
        )

    return [record for index, record in enumerate(records) if index in chosen]


def parse_quota(values: Sequence[str]) -> Dict[str, int]:
    quotas: Dict[str, int] = {}
    for value in values or []:
        if "=" not in value:
            raise ValueError("quota must look like bucket=count, got {!r}".format(value))
        bucket, count = value.split("=", 1)
        quotas[bucket.strip()] = int(count)
    return quotas


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--input", required=True, help="annotated candidates JSONL")
    parser.add_argument("--output", required=True, help="selected candidates JSONL")
    parser.add_argument(
        "--quota",
        action="append",
        default=[],
        metavar="BUCKET=N",
        help=(
            "cap a bucket at N candidates (riichi, call, discard). Buckets with "
            "no quota are passed through in full."
        ),
    )
    parser.add_argument(
        "--per-hand",
        type=int,
        default=1,
        help=(
            "keep at most N candidates per (game, hand, seat, bucket). "
            "0 disables thinning."
        ),
    )
    args = parser.parse_args(argv)

    try:
        quotas = parse_quota(args.quota)
    except ValueError as exc:
        parser.error(str(exc))

    records = list(iter_records(args.input))
    sys.stderr.write("read {} annotated candidates\n".format(len(records)))
    kept = select(records, quotas, per_hand=args.per_hand)

    with open(args.output, "w", encoding="utf-8") as out:
        for record in kept:
            out.write(json.dumps(record, separators=(",", ":"), sort_keys=True))
            out.write("\n")

    sys.stderr.write("selected {} candidates -> {}\n".format(len(kept), args.output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
