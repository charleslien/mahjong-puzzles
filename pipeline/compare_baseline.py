"""Measure how often the model disagrees with the tile-efficiency baseline.

This tests the premise the whole mining design rests on. Adapting Lichess's
shallow-vs-deep filter to mahjong means treating naive-ukeire-vs-model
disagreement as the instructiveness signal — but that only works if the two
actually disagree often enough to be worth mining, and not so often that the
model looks unmoored from basic efficiency.

Run against the shipped bank, whose answers are the ukeire baseline:

    python -m pipeline.compare_baseline --bank public/puzzles \
        --checkpoint pipeline/data/model.pt
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional, Sequence

from pipeline.mine import ModelNotAvailable, OfflineModel


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--bank", required=True, help="directory holding index.json")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args(argv)

    with open(os.path.join(args.bank, "index.json"), encoding="utf-8") as handle:
        index = json.load(handle)
    puzzles = []
    for shard in index["shards"]:
        with open(os.path.join(args.bank, shard["file"]), encoding="utf-8") as handle:
            puzzles.extend(json.load(handle)["puzzles"])
    if args.limit:
        puzzles = puzzles[: args.limit]

    try:
        model = OfflineModel(args.checkpoint)
    except ModelNotAvailable as exc:
        sys.stderr.write("cannot load a model: {}\n".format(exc))
        return 2

    agree = 0
    top3 = 0
    matched_human = 0
    have_human = 0
    total = 0
    entropies = []

    for puzzle in puzzles:
        ranked = model.rank_actions(puzzle["position"])
        if len(ranked) < 2:
            continue
        total += 1
        accepted = set(puzzle["acceptedActionIds"])

        # Compare by tile index so a red five matches its plain twin.
        def norm(action_id: str) -> str:
            tile = action_id.split(":", 1)[1]
            return tile[:2] if tile.endswith("r") else tile

        accepted_norm = {norm(a) for a in accepted}
        if norm(ranked[0]["id"]) in accepted_norm:
            agree += 1
        if any(norm(entry["id"]) in accepted_norm for entry in ranked[:3]):
            top3 += 1
        entropies.append(model.policy_entropy(ranked))

    print("positions scored: {}".format(total))
    if total:
        print(
            "model top-1 matches the ukeire baseline: {}/{} = {:.1%}".format(
                agree, total, agree / total
            )
        )
        print(
            "model top-3 contains a baseline answer:  {}/{} = {:.1%}".format(
                top3, total, top3 / total
            )
        )
        print(
            "=> disagreement rate (the mining signal): {:.1%}".format(1 - agree / total)
        )
        print("mean policy entropy: {:.3f} nats".format(sum(entropies) / len(entropies)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
