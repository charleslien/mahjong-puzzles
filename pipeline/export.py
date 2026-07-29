"""Export verified candidates to the site's puzzle bank format.

Reads screened candidates as JSONL and writes sharded JSON under
public/puzzles/, matching the schema in src/types/puzzle.ts. Keeping this stage
separate means the schema contract lives in exactly one place on the Python side.

Usage:
    python -m pipeline.export --input data/verified.jsonl --output public/puzzles
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, Iterable, List, Optional, Sequence

SCHEMA_VERSION = 1
DEFAULT_SHARD_SIZE = 250

ATTRIBUTION = (
    "Positions mined from Tenhou houou-room logs redistributed by tenhou-to-mjai "
    "under CC BY 4.0. Evaluated offline by an imitation/offline-RL model and "
    "corroborated by akochan expected-value search; positions where the two "
    "evaluators disagreed on the best action were discarded rather than published."
)


def to_puzzle(candidate: Dict[str, Any], puzzle_id: str) -> Dict[str, Any]:
    """Convert one screened candidate into a site puzzle."""
    actions_in = candidate["actions"]
    best_ev = max(action["ev"] for action in actions_in)
    accepted = set(candidate["acceptedActionIds"])

    actions: List[Dict[str, Any]] = []
    for action in actions_in:
        entry: Dict[str, Any] = {
            "id": action["id"],
            "label": action["label"],
            "ev": action["ev"],
            "loss": max(0.0, best_ev - action["ev"]),
            "accepted": action["id"] in accepted,
        }
        for optional in ("tile", "policy", "shantenAfter", "ukeire"):
            if action.get(optional) is not None:
                entry[optional] = action[optional]
        actions.append(entry)

    tags = list(candidate.get("tags") or [])
    if candidate.get("naiveFails") and "efficiency-trap" not in tags:
        # The headline category: pure efficiency picks a different tile.
        tags.append("efficiency-trap")

    puzzle: Dict[str, Any] = {
        "id": puzzle_id,
        "schemaVersion": SCHEMA_VERSION,
        "kind": candidate["kind"],
        "position": candidate["position"],
        "actions": actions,
        "acceptedActionIds": sorted(accepted),
        "tags": tags,
        "difficulty": int(candidate["difficulty"]),
        "evaluation": {
            "evaluators": list(candidate["evaluators"]),
            "margin": float(candidate["margin"]),
            "agreement": bool(candidate.get("agreement", len(candidate["evaluators"]) >= 2)),
            "epsilon": float(candidate["epsilon"]),
            "unit": "placement_pt",
        },
        "source": {
            "dataset": candidate.get("dataset", "tenhou-houou-mjai"),
            "authored": False,
        },
    }

    if candidate.get("gameId"):
        puzzle["source"]["gameId"] = candidate["gameId"]
    if candidate.get("decisionIndex") is not None:
        puzzle["source"]["decisionIndex"] = int(candidate["decisionIndex"])
    if candidate.get("bestShanten") is not None:
        puzzle["bestShanten"] = int(candidate["bestShanten"])
    if candidate.get("explanation"):
        puzzle["explanation"] = candidate["explanation"]

    return puzzle


def write_bank(
    puzzles: Sequence[Dict[str, Any]],
    out_dir: str,
    generated_at: str,
    shard_size: int = DEFAULT_SHARD_SIZE,
    shard_prefix: str = "mined",
) -> Dict[str, Any]:
    """Write sharded puzzle JSON plus the index manifest. Returns the index."""
    os.makedirs(out_dir, exist_ok=True)

    shards = []
    for start in range(0, len(puzzles), shard_size):
        chunk = list(puzzles[start : start + shard_size])
        name = "{}-{:03d}.json".format(shard_prefix, start // shard_size)
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as handle:
            json.dump({"schemaVersion": SCHEMA_VERSION, "puzzles": chunk}, handle, indent=2)
            handle.write("\n")
        shards.append(
            {
                "file": name,
                "count": len(chunk),
                "kinds": sorted({puzzle["kind"] for puzzle in chunk}),
            }
        )

    index = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "provenance": ATTRIBUTION,
        "count": len(puzzles),
        "shards": shards,
    }
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as handle:
        json.dump(index, handle, indent=2)
        handle.write("\n")
    return index


def read_candidates(path: str) -> Iterable[Dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--input", required=True, help="verified candidates JSONL")
    parser.add_argument("--output", required=True, help="output directory for the bank")
    parser.add_argument("--shard-size", type=int, default=DEFAULT_SHARD_SIZE)
    parser.add_argument(
        "--generated-at",
        required=True,
        help="date stamp recorded in the index, e.g. 2026-07-29",
    )
    args = parser.parse_args(argv)

    candidates = list(read_candidates(args.input))
    puzzles = [
        to_puzzle(candidate, "mined-{:05d}".format(i + 1))
        for i, candidate in enumerate(candidates)
    ]
    index = write_bank(
        puzzles, args.output, args.generated_at, shard_size=args.shard_size
    )
    sys.stderr.write(
        "wrote {} puzzles across {} shards to {}\n".format(
            index["count"], len(index["shards"]), args.output
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
