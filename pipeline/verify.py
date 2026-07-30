"""Stage 4: verify candidates with akochan, and attach real expected values.

The model finds candidates; akochan decides whether they are publishable. Two
things make that worth doing rather than just trusting the model:

  - **Corroboration.** akochan computes expected value by search over its own
    trained estimators, so its errors are not correlated with an imitation
    network's. Two evaluators with uncorrelated errors agreeing on the top action
    is far stronger evidence than either one's confidence. Disagreement means the
    position gets dropped, not adjudicated.

  - **Numbers.** The offline model has a *state* value head, not a per-action Q,
    so it cannot price individual discards. akochan can, in placement points.
    Every EV the site displays comes from here.

Note that this inverts the original plan recorded in this file, which had the
model's EVs displayed and akochan merely corroborating. The model has no
per-action EV to display, so the roles are the other way round: akochan supplies
the numbers, the model supplies the second opinion.

Why the original logs are re-read
---------------------------------
akochan expects a game in progress, not a bare position — and a position record
deliberately omits opponents' concealed hands, which `start_kyoku` requires.
Reconstructing a synthetic stream would mean inventing three hands and a wall,
which changes the number of unseen tiles and therefore changes the EV. So this
stage replays the actual log up to the decision, using the `eventIndex` that
extract.py records. Nothing is invented.

Usage:
    python -m pipeline.verify --input annotated.jsonl --output verified.jsonl \\
        --logs pipeline/data/2010 --akochan vendor/akochan/system.exe
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional, Sequence

from pipeline.akochan import (
    AkochanEngine,
    AkochanError,
    AkochanNotAvailable,
    NoEvaluationPoint,
)
from pipeline.criteria import (
    DEFAULT_EPSILON_PT,
    DEFAULT_MAX_ACCEPTED,
    DEFAULT_MIN_MARGIN_PT,
    Rejection,
    screen_candidate,
)
from pipeline.jsonl import iter_records, open_text

EVALUATORS = ["akochan", "offline-model"]


def _normalise_tile(tile: str) -> str:
    """Collapse a red five onto its plain twin, for comparing action ids."""
    return tile[:2] if tile.endswith("r") and len(tile) == 3 else tile


def _normalise_id(action_id: str) -> str:
    if ":" not in action_id:
        return action_id
    kind, tile = action_id.split(":", 1)
    return "{}:{}".format(kind, _normalise_tile(tile))


def load_history(
    log_dir: str,
    game_id: str,
    event_index: int,
) -> List[Dict[str, Any]]:
    """Events of the log up to and including `event_index - 1`.

    `eventIndex` points at the `dahai` the player actually made, so the prefix
    that *creates* the decision excludes it. The result starts with
    `start_game`, which akochan requires: `pipe_detailed` truncates its record to
    `begin() + 1` on every `start_kyoku`, which on an empty record is undefined
    behaviour rather than a clean error.
    """
    path = os.path.join(log_dir, game_id)
    if not os.path.exists(path):
        raise FileNotFoundError(path)

    events: List[Dict[str, Any]] = []
    with open_text(path) as handle:
        for index, line in enumerate(handle):
            if index >= event_index:
                break
            line = line.strip()
            if line:
                events.append(json.loads(line))
    return events


def build_actions(
    akochan_ranked: Sequence[Dict[str, Any]],
    candidate: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Merge akochan's EVs with the model's policy and the ukeire annotation.

    Only discards akochan and the annotator both know about survive. A mismatch
    means the two disagree about what is legal, which is a bug rather than a
    close call, so the position is rejected instead of being published with a
    partial action list.
    """
    annotations = candidate.get("ukeireActions") or {}
    policy = candidate.get("policy") or {}

    # akochan names the tile it would discard; the annotation is keyed by the
    # hand tile. Match through the normalised form so a red five lines up.
    by_normalised = {_normalise_id(key): (key, value) for key, value in annotations.items()}

    actions: List[Dict[str, Any]] = []
    seen = set()
    for entry in akochan_ranked:
        if entry.get("tile") is None:
            # Non-discard options (riichi declarations, calls, tsumo) carry an EV
            # but no tile. Out of scope for a discard puzzle.
            continue
        key = _normalise_id(entry["id"])
        if key in seen:
            continue
        match = by_normalised.get(key)
        if match is None:
            raise Rejection("akochan_action_not_in_hand:{}".format(entry["id"]))
        seen.add(key)
        annotation_id, annotation = match
        actions.append(
            {
                "id": annotation_id,
                "label": annotation["label"],
                "tile": annotation["tile"],
                "ev": entry["ev"],
                "shantenAfter": annotation["shantenAfter"],
                "ukeire": annotation["ukeire"],
                "policy": policy.get(annotation_id, policy.get(entry["id"])),
            }
        )

    missing = set(by_normalised) - seen
    if missing:
        raise Rejection("akochan_missing_actions:{}".format(len(missing)))
    if len(actions) < 2:
        raise Rejection("no_choice")
    return actions


def model_ranking(candidate: Dict[str, Any], actions: Sequence[Dict[str, Any]]) -> List[str]:
    """The model's preference order over the actions that survived.

    Restricted to those actions, because a ranking that names an action the
    published puzzle does not contain cannot be compared for agreement.
    """
    available = {action["id"] for action in actions}
    normalised = {_normalise_id(action["id"]): action["id"] for action in actions}

    ranking: List[str] = []
    for action_id in candidate.get("modelRanking") or []:
        resolved = action_id if action_id in available else normalised.get(_normalise_id(action_id))
        if resolved and resolved not in ranking:
            ranking.append(resolved)
    return ranking


def verify_candidate(
    candidate: Dict[str, Any],
    engine: AkochanEngine,
    log_dir: str,
    epsilon: float,
    min_margin: float,
    max_accepted: int,
) -> Dict[str, Any]:
    """Evaluate and screen one candidate. Raises Rejection when unpublishable."""
    game_id = candidate.get("gameId")
    event_index = candidate.get("eventIndex")
    if not game_id or event_index is None:
        raise Rejection("no_log_reference")

    try:
        history = load_history(log_dir, str(game_id), int(event_index))
    except FileNotFoundError:
        raise Rejection("log_missing")
    if not history:
        raise Rejection("empty_history")

    seat = int((candidate.get("position") or {}).get("seat", candidate.get("actor", 0)))

    try:
        ranked = engine.evaluate(history, seat)
    except NoEvaluationPoint:
        # Post-call discards have no akochan decision point; see pipeline/akochan.py.
        raise Rejection("no_akochan_decision_point")

    if not ranked:
        raise Rejection("akochan_returned_nothing")

    actions = build_actions(ranked, candidate)
    rankings = [
        [action["id"] for action in actions],  # akochan, already EV-sorted
        model_ranking(candidate, actions),
    ]

    enriched = dict(candidate)
    enriched["actions"] = actions
    enriched["rankings"] = rankings
    enriched["evaluators"] = EVALUATORS
    enriched["epsilon"] = epsilon
    # Only the events needed to replay the hand in the trainer. `history` is
    # sliced from start_kyoku because that is what the site's replay expects; the
    # start_game event akochan needs is not part of the puzzle.
    enriched["history"] = _kyoku_history(history)
    enriched["akochanBest"] = actions[0]["id"]

    screened = screen_candidate(
        enriched,
        epsilon=epsilon,
        min_margin=min_margin,
        max_accepted=max_accepted,
    )
    # screen_candidate raises unless both evaluators put the same action first.
    screened["agreement"] = True
    screened["tags"] = tags_for(screened, actions, float(screened["margin"]))
    return screened


def tags_for(
    candidate: Dict[str, Any],
    actions: Sequence[Dict[str, Any]],
    margin: float,
) -> List[str]:
    """Themes for filtering and for the chips shown above a puzzle.

    Every one is read off the position or the evaluation. `efficiency-trap` is
    added by export.py from `naiveFails`, since that is where the flag is
    resolved.
    """
    position = candidate.get("position") or {}
    seat = int(position.get("seat", 0))
    best_shanten = candidate.get("bestShanten")
    tags = ["discard"]

    if best_shanten == 0:
        tags.append("tenpai-choice")
    elif candidate.get("currentShanten") == 2:
        tags.append("two-shanten")

    # How many discards keep the best shanten: a wide choice is a harder read.
    if best_shanten is not None:
        tier = [
            action
            for action in actions
            if action.get("shantenAfter") == best_shanten
        ]
        if len(tier) >= 5:
            tags.append("wide-choice")

    if position.get("melds"):
        tags.append("open-hand")
    riichi = position.get("riichi") or []
    if any(flag for index, flag in enumerate(riichi) if flag and index != seat):
        tags.append("opponent-riichi")

    round_info = position.get("round") or {}
    if round_info.get("wind") == "S" and round_info.get("kyoku") == 4:
        tags.append("all-last")

    tiles_left = position.get("tilesLeft")
    if isinstance(tiles_left, int) and tiles_left <= 20:
        tags.append("endgame")

    # How decisive the answer is, in the unit the site displays.
    if margin < 0.6:
        tags.append("close-call")
    elif margin >= 3.0:
        tags.append("big-swing")

    return tags


def _kyoku_history(history: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The current hand's events, from its `start_kyoku`."""
    start = 0
    for index, event in enumerate(history):
        if event.get("type") == "start_kyoku":
            start = index
    return list(history[start:])


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--input", required=True, help="annotated candidates JSONL")
    parser.add_argument("--output", required=True, help="verified candidates JSONL")
    parser.add_argument("--logs", required=True, help="directory of the original mjai logs")
    parser.add_argument(
        "--akochan",
        default=os.path.join("vendor", "akochan", "system.exe"),
        help="path to the akochan binary",
    )
    parser.add_argument("--epsilon", type=float, default=DEFAULT_EPSILON_PT)
    parser.add_argument("--min-margin", type=float, default=DEFAULT_MIN_MARGIN_PT)
    parser.add_argument("--max-accepted", type=int, default=DEFAULT_MAX_ACCEPTED)
    parser.add_argument("--limit", type=int, default=0, help="stop after this many published")
    parser.add_argument(
        "--reject-log",
        default=None,
        help="optional JSONL of rejected candidates with reasons, for tuning",
    )
    parser.add_argument(
        "--progress-every",
        type=int,
        default=200,
        help="log a progress line every N candidates",
    )
    args = parser.parse_args(argv)

    try:
        engine = AkochanEngine(args.akochan)
        probe = engine.probe()
    except AkochanNotAvailable as exc:
        sys.stderr.write("akochan is not usable: {}\n".format(exc))
        return 2

    sys.stderr.write(
        "akochan ready ({} actions on the probe position, top {} at {:+.3f} pt)\n".format(
            len(probe), probe[0]["id"], probe[0]["ev"]
        )
    )

    rejections: Dict[str, int] = {}
    published = 0
    seen = 0
    started = time.time()

    # Line-buffered: rejection records are short, and a full write buffer means a
    # run interrupted partway through appears to have rejected nothing.
    reject_handle = (
        open(args.reject_log, "w", encoding="utf-8", buffering=1) if args.reject_log else None
    )

    try:
        with open(args.output, "w", encoding="utf-8") as out:
            for candidate in iter_records(args.input):
                if args.limit and published >= args.limit:
                    break
                seen += 1
                try:
                    verified = verify_candidate(
                        candidate,
                        engine,
                        args.logs,
                        args.epsilon,
                        args.min_margin,
                        args.max_accepted,
                    )
                except Rejection as exc:
                    reason = exc.reason.split(":")[0]
                    rejections[reason] = rejections.get(reason, 0) + 1
                    if reject_handle:
                        reject_handle.write(
                            json.dumps(
                                {
                                    "gameId": candidate.get("gameId"),
                                    "decisionIndex": candidate.get("decisionIndex"),
                                    "reason": exc.reason,
                                },
                                separators=(",", ":"),
                            )
                            + "\n"
                        )
                    continue
                except AkochanError as exc:
                    sys.stderr.write("akochan failed: {}\n".format(exc))
                    rejections["akochan_error"] = rejections.get("akochan_error", 0) + 1
                    continue

                out.write(json.dumps(verified, separators=(",", ":"), sort_keys=True))
                out.write("\n")
                published += 1

                if args.progress_every and seen % args.progress_every == 0:
                    elapsed = time.time() - started
                    sys.stderr.write(
                        "{} seen, {} published, {:.1f}/s\n".format(
                            seen, published, seen / elapsed if elapsed else 0.0
                        )
                    )
    finally:
        engine.close()
        if reject_handle:
            reject_handle.close()

    elapsed = time.time() - started
    sys.stderr.write(
        "\nverified {} of {} candidates in {:.1f}s ({:.1f} positions/s)\n".format(
            published, seen, elapsed, seen / elapsed if elapsed else 0.0
        )
    )
    if rejections:
        sys.stderr.write("rejections by reason:\n")
        for reason, count in sorted(rejections.items(), key=lambda item: -item[1]):
            sys.stderr.write("  {:<32} {}\n".format(reason, count))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
