"""Export verified candidates to the site's puzzle bank format.

Reads screened candidates as JSONL and writes sharded JSON under
public/puzzles/, matching the schema in src/types/puzzle.ts. Keeping this stage
separate means the schema contract lives in exactly one place on the Python side.

Usage:
    python -m pipeline.export --input data/verified.jsonl --output public/puzzles
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from typing import Any, Dict, Iterable, List, Optional, Sequence

SCHEMA_VERSION = 1
DEFAULT_SHARD_SIZE = 250

ATTRIBUTION = (
    "Positions mined from Tenhou houou-room logs redistributed by tenhou-to-mjai "
    "under CC BY 4.0, from games held out of model training. Expected values are "
    "computed by akochan's expected-value search in Tenhou houou placement points "
    "(+90/+45/0/-135); candidates are found by a 2.2M-parameter imitation network "
    "trained on 20M houou decisions, which also supplies the corroborating "
    "ranking. Positions where the two evaluators disagreed on the best action "
    "were discarded rather than adjudicated."
)


def puzzle_id(candidate: Dict[str, Any]) -> str:
    """A stable identity for a position: the decision it is, not where it landed.

    Ids used to be `mined-00001` by position in the output, which meant every
    regeneration silently reattached every id to a different hand. Four things
    went wrong at once, none of them visibly:

      - permalinks pointed at a different position than the one shared;
      - a solver's history listed hands they had never played;
      - `puzzle_ratings` is keyed by puzzle id, so the difficulty learned for one
        position was carried onto whatever inherited its number;
      - `attempts.puzzle_id` cascades on delete, so pruning positions that had
        genuinely gone deleted the attempt history of positions that had not.

    And because the full bank and the capped offline bundle were numbered
    independently, the same id named two different puzzles depending on which
    source a visitor was served — so offline progress synced on sign-in landed on
    the wrong rows.

    (gameId, decisionIndex) identifies the decision, and extract.py assigns
    decisionIndex in log order within a game, independent of any mining
    parameter. So the same position keeps its id across regenerations, and a
    position that really has gone takes its attempts with it.
    """
    game = str(candidate.get("gameId") or "").replace(".mjson", "")
    index = candidate.get("decisionIndex")
    if game and index is not None:
        seed = "{}#{}".format(game, index)
    else:
        # Hand-authored positions point at no log. The position itself is the
        # next most stable thing available.
        seed = json.dumps(candidate.get("position"), sort_keys=True)
    return "p" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:12]


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
        # `branch` and `consumed` are what let the site ask the decision as a
        # sequence — declare or not, then which tile; call or not, then with
        # which set, then what to throw — instead of as a flat list of lines
        # the player would have to read to find the one they meant.
        for optional in ("branch", "consumed", "tile", "policy", "shantenAfter", "ukeire"):
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
        # The stored id is the log's filename; the extension is noise on the site.
        puzzle["source"]["gameId"] = str(candidate["gameId"]).replace(".mjson", "")
    if candidate.get("decisionIndex") is not None:
        puzzle["source"]["decisionIndex"] = int(candidate["decisionIndex"])
    if candidate.get("bestShanten") is not None:
        puzzle["bestShanten"] = int(candidate["bestShanten"])

    # The hand's events, so the trainer can step back through how the position
    # arose. Omitting this silently disables the replay controls, which is a
    # feature regression rather than a missing nicety.
    if candidate.get("history"):
        puzzle["history"] = candidate["history"]

    explanation = candidate.get("explanation") or explain(candidate, actions, accepted)
    if explanation:
        puzzle["explanation"] = explanation

    return puzzle


def explain(
    candidate: Dict[str, Any],
    actions: Sequence[Dict[str, Any]],
    accepted: Iterable[str],
) -> str:
    """A sentence about why the best action wins, from the numbers already on it.

    Deliberately mechanical. Anything that reads as insight would be invented:
    akochan reports an expected value, not a reason.
    """
    accepted_ids = set(accepted)
    best = max(actions, key=lambda action: action["ev"])
    runner_up = min(
        (action for action in actions if action["id"] not in accepted_ids),
        key=lambda action: best["ev"] - action["ev"],
        default=None,
    )

    def phrase(action: Dict[str, Any]) -> str:
        """The action as a verb phrase, so it reads inside a sentence.

        Discards say "Discard 5 circles"; riichi options say "Declare riichi,
        discarding ...". Both need their leading capital dropped, and only the
        first also needs its verb inflected.
        """
        text = action.get("label") or action["id"]
        if text.startswith("Discard "):
            return text.replace("Discard ", "discarding ", 1)
        return text[:1].lower() + text[1:]

    parts = ["akochan puts {} ahead at {:+.2f} placement points".format(phrase(best), best["ev"])]
    if runner_up is not None:
        parts.append("{:.2f} clear of {}".format(best["ev"] - runner_up["ev"], phrase(runner_up)))
    if best.get("shantenAfter") is not None and best.get("ukeire") is not None:
        parts.append(
            "leaving {} with {} tiles of acceptance".format(
                "tenpai" if best["shantenAfter"] == 0 else "{}-shanten".format(best["shantenAfter"]),
                best["ukeire"],
            )
        )
    sentence = ", ".join(parts) + "."

    if candidate.get("naiveFails"):
        sentence += (
            " Pure tile efficiency would play something else here, which is what makes"
            " the position worth studying."
        )
    return sentence


def write_bank(
    puzzles: Sequence[Dict[str, Any]],
    out_dir: str,
    generated_at: str,
    shard_size: int = DEFAULT_SHARD_SIZE,
    shard_prefix: str = "mined",
) -> Dict[str, Any]:
    """Write sharded puzzle JSON plus the index manifest. Returns the index."""
    os.makedirs(out_dir, exist_ok=True)

    # Clear shards from a previous, larger run. The index only names the current
    # ones so the site is unaffected, but the leftovers stay on disk looking like
    # part of the bank — which is exactly how an audit script came to report 990
    # puzzles for a 740-puzzle export.
    for existing in os.listdir(out_dir):
        if existing.startswith(shard_prefix + "-") and existing.endswith(".json"):
            os.remove(os.path.join(out_dir, existing))

    shards = []
    for start in range(0, len(puzzles), shard_size):
        chunk = list(puzzles[start : start + shard_size])
        name = "{}-{:03d}.json".format(shard_prefix, start // shard_size)
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as handle:
            # Compact: shards are fetched and parsed by the browser, never read by
            # a person, and the whole bank is loaded at once. Pretty-printing cost
            # 6.9 MB of indentation across 897 puzzles — more than the puzzles.
            json.dump(
                {"schemaVersion": SCHEMA_VERSION, "puzzles": chunk},
                handle,
                separators=(",", ":"),
            )
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


# No single answer may hold more than this share of a decision kind.
MAX_ANSWER_SHARE = 0.6


def balance_by_answer(
    candidates: Sequence[Dict[str, Any]],
    max_share: float = MAX_ANSWER_SHARE,
) -> List[Dict[str, Any]]:
    """Cap how often one answer can be the right one within a kind.

    Call decisions come out 84% "let it pass", which is not a mining artefact —
    most call opportunities genuinely should be declined, and the houou players
    decline them too. But a bank in that proportion can be beaten 84% of the time
    by never calling, which trains a reflex rather than a decision, and a solver
    learns nothing from being right by default.

    So the majority answer is thinned until it holds no more than `max_share` of
    its kind. The positions dropped are real and correctly judged; they are simply
    redundant. Selection is evenly spaced through the list rather than taken from
    the front, so the survivors keep the spread of rounds and difficulty.
    """
    by_kind: Dict[str, List[Dict[str, Any]]] = {}
    for candidate in candidates:
        by_kind.setdefault(candidate.get("kind", "discard"), []).append(candidate)

    kept: List[Dict[str, Any]] = []
    for kind, group in by_kind.items():
        by_answer: Dict[str, List[Dict[str, Any]]] = {}
        for candidate in group:
            best = max(candidate["actions"], key=lambda action: action["ev"])
            # By branch where there is one. The reflex a bank of calls can teach
            # is "never call", not "never chi with 2s+3s and throw the 5m" — and
            # grouping by the full line would put every call in a bucket of one,
            # leaving `pass` a majority against nothing.
            by_answer.setdefault(best.get("branch") or best["id"], []).append(candidate)

        minority = sum(len(rows) for answer, rows in by_answer.items()
                       if len(rows) != max(len(other) for other in by_answer.values()))
        majority_answer = max(by_answer, key=lambda answer: len(by_answer[answer]))
        majority = by_answer[majority_answer]

        # n / (n + minority) <= max_share  =>  n <= minority * share / (1 - share)
        if minority and max_share < 1.0:
            allowed = int(minority * max_share / (1.0 - max_share))
        else:
            allowed = len(majority)

        if len(majority) > allowed and allowed > 0:
            stride = len(majority) / allowed
            majority = [majority[int(i * stride)] for i in range(allowed)]

        for answer, rows in by_answer.items():
            kept.extend(majority if answer == majority_answer else rows)

    return kept


def read_candidates(path: str) -> Iterable[Dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                yield json.loads(line)


def dedupe(candidates: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One row per decision, keeping the first.

    A bank is grown by verifying a fresh slice and exporting it alongside the
    previous run's output, and the two overlap wherever the mining passes did.
    Since `puzzle_id` is derived from (gameId, decisionIndex), a duplicate
    decision is the same puzzle twice — the upload upserts, so it would quietly
    keep one and the export's own uniqueness guard would refuse the whole run
    over what is a normal consequence of merging.

    Deliberately keyed on the identity the id is built from rather than on the
    id: two *different* decisions hashing alike is a real collision and must
    still fail loudly, which is what the guard downstream is for.
    """
    seen: set = set()
    kept: List[Dict[str, Any]] = []
    for candidate in candidates:
        game = str(candidate.get("gameId") or "")
        index = candidate.get("decisionIndex")
        key = (game, index) if game and index is not None else None
        if key is not None:
            if key in seen:
                continue
            seen.add(key)
        kept.append(candidate)
    return kept


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--input",
        required=True,
        nargs="+",
        help=(
            "verified candidates JSONL. Several may be given, which is how a "
            "bank is grown: verify a fresh slice and export it alongside the "
            "previous run. Decisions present in more than one are kept once."
        ),
    )
    parser.add_argument("--output", required=True, help="output directory for the bank")
    parser.add_argument("--shard-size", type=int, default=DEFAULT_SHARD_SIZE)
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help=(
            "cap the published bank at N puzzles, sampled evenly. The database "
            "serves a page per session so its size is free, but public/puzzles is "
            "the offline fallback and is loaded whole — and it lives in git. "
            "Verified puzzles beyond the cap stay in the verified JSONL for a "
            "later run rather than being thrown away."
        ),
    )
    parser.add_argument(
        "--generated-at",
        required=True,
        help="date stamp recorded in the index, e.g. 2026-07-29",
    )
    args = parser.parse_args(argv)

    read = [row for path in args.input for row in read_candidates(path)]
    candidates = dedupe(read)
    if len(candidates) != len(read):
        sys.stderr.write(
            "read {} rows from {} files, {} distinct decisions\n".format(
                len(read), len(args.input), len(candidates)
            )
        )
    candidates = balance_by_answer(candidates)

    if args.limit and len(candidates) > args.limit:
        # Evenly spaced, so the cap keeps the spread of rounds, kinds and
        # difficulty rather than taking whatever happens to be at the front.
        stride = len(candidates) / args.limit
        kept = [candidates[int(i * stride)] for i in range(args.limit)]
        sys.stderr.write(
            "capping {} puzzles to {}\n".format(len(candidates), len(kept))
        )
        candidates = kept
    puzzles = [to_puzzle(candidate, puzzle_id(candidate)) for candidate in candidates]
    ids = {puzzle["id"] for puzzle in puzzles}
    if len(ids) != len(puzzles):
        # Two positions hashing alike, or the same decision exported twice.
        # Either way the bank would silently lose one on upload, since the table
        # is keyed by id and the upload upserts.
        sys.stderr.write(
            "{} puzzles but only {} distinct ids\n".format(len(puzzles), len(ids))
        )
        return 1
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
