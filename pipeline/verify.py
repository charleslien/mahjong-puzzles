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
    seat: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Events of the log up to and including `event_index - 1`.

    `eventIndex` points at the `dahai` the player actually made, so the prefix
    that *creates* the decision excludes it. The result starts with
    `start_game`, which akochan requires: `pipe_detailed` truncates its record to
    `begin() + 1` on every `start_kyoku`, which on an empty record is undefined
    behaviour rather than a clean error.

    A trailing `reach` by `seat` is dropped. In mjai the declaration precedes the
    discard it is declared on, so a prefix cut at the discard still contains it —
    and akochan, seeing a player already committed, offers no declaration to
    evaluate. Left in, every position where a riichi was actually declared
    silently became a plain discard question, and the only riichi puzzles that
    survived were ones where nobody declared. The bank would have taught that
    the answer is always damaten.
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

    while (
        events
        and events[-1].get("type") == "reach"
        and (seat is None or int(events[-1].get("actor", -1)) == seat)
    ):
        events.pop()
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

    # Matched exactly, not through a red-five-collapsing normal form. akochan
    # prices `discard:5p` and `discard:5pr` separately — the red one is a dora,
    # and in one sampled position the gap was 1.59 placement points — so merging
    # them dropped a real play from every hand holding both copies.
    actions: List[Dict[str, Any]] = []
    seen = set()
    for entry in akochan_ranked:
        if entry.get("tile") is None:
            # Non-discard options (riichi declarations, calls, tsumo) carry an EV
            # but no tile. Out of scope for a discard puzzle.
            continue
        key = entry["id"]
        if key in seen:
            continue
        annotation = annotations.get(key)
        if annotation is None:
            raise Rejection("akochan_action_not_in_hand:{}".format(key))
        seen.add(key)
        actions.append(
            {
                "id": key,
                "label": annotation["label"],
                "tile": annotation["tile"],
                "ev": entry["ev"],
                "shantenAfter": annotation["shantenAfter"],
                "ukeire": annotation["ukeire"],
                # The network's action space is 34 tile indices, so its
                # probability is for the tile type, shared by both copies.
                "policy": policy.get(_normalise_id(key)) or policy.get(key),
            }
        )

    missing = set(annotations) - seen
    if missing:
        raise Rejection("akochan_missing_actions:{}".format(len(missing)))
    if len(actions) < 2:
        raise Rejection("no_choice")
    return actions


CALL_LABELS = {
    "pon": "Call pon",
    "chi": "Call chi",
    "daiminkan": "Call kan",
    "none": "Let it pass",
}


def build_call_actions(
    akochan_ranked: Sequence[Dict[str, Any]],
    candidate: Dict[str, Any],
) -> Optional[List[Dict[str, Any]]]:
    """Turn akochan's options at an opponent's discard into call-or-pass.

    akochan returns one entry per call *line* — a pon paired with each tile you
    might discard after it — plus a single `none` for letting it go. The puzzle
    asks whether to call at all, so each kind is reduced to its best line and the
    follow-up discard is named in the label rather than made a separate question.
    """
    passing = next((entry for entry in akochan_ranked if entry["id"] == "none"), None)
    if passing is None:
        return None

    best_of_kind: Dict[str, Dict[str, Any]] = {}
    for entry in akochan_ranked:
        kind = entry.get("kind")
        if kind not in ("pon", "chi", "daiminkan"):
            continue
        if kind not in best_of_kind or entry["ev"] > best_of_kind[kind]["ev"]:
            best_of_kind[kind] = entry

    if not best_of_kind:
        return None

    names = candidate.get("tileLabels") or {}

    def follow_up(entry: Dict[str, Any]) -> str:
        tile = next(
            (move.get("pai") for move in entry.get("moves", []) if move.get("type") == "dahai"),
            None,
        )
        if not tile:
            return ""
        return ", then discard {}".format(names.get(tile, tile))

    actions: List[Dict[str, Any]] = [
        {
            "id": "pass",
            "label": CALL_LABELS["none"],
            "tile": None,
            "ev": passing["ev"],
        }
    ]
    for kind, entry in sorted(best_of_kind.items()):
        actions.append(
            {
                "id": kind,
                "label": CALL_LABELS[kind] + follow_up(entry),
                "tile": entry.get("tile"),
                "ev": entry["ev"],
            }
        )
    return actions


def build_riichi_actions(
    akochan_ranked: Sequence[Dict[str, Any]],
    candidate: Dict[str, Any],
) -> Optional[List[Dict[str, Any]]]:
    """Turn akochan's option list into a riichi-or-damaten pair, or None.

    Returns None when the position offers no declaration — the overwhelming
    majority, since riichi needs a closed tenpai hand, a 1000-point stick and
    live wall.

    The comparison is between the best line of each sort, not between two ways of
    playing the same tile: staying concealed may well want a different discard
    than declaring would, and forcing them onto the same tile would be a
    different, easier question than the one players actually face.
    """
    reach = next((entry for entry in akochan_ranked if entry.get("kind") == "reach"), None)
    if reach is None:
        return None

    dama = next((entry for entry in akochan_ranked if entry["id"].startswith("discard:")), None)
    if dama is None:
        return None

    annotations = candidate.get("ukeireActions") or {}
    reach_tile = reach.get("tile")
    reach_annotation = annotations.get("discard:{}".format(reach_tile), {})
    dama_annotation = annotations.get(dama["id"], {})

    def label(prefix: str, tile: Optional[str], annotation: Dict[str, Any]) -> str:
        name = annotation.get("label", "").replace("Discard ", "")
        return "{}, discarding {}".format(prefix, name or tile)

    # The best concealed line does not always keep the hand together: akochan
    # sometimes prefers giving up tenpai to declaring. Calling that "stay
    # concealed" would describe a fold as a quiet wait, so the label follows what
    # the tile actually does.
    dama_shanten = dama_annotation.get("shantenAfter")
    dama_prefix = "Back off" if dama_shanten not in (None, 0) else "Stay concealed"

    return [
        {
            "id": "riichi",
            "label": label("Declare riichi", reach_tile, reach_annotation),
            "tile": reach_tile,
            "ev": reach["ev"],
            "shantenAfter": reach_annotation.get("shantenAfter"),
            "ukeire": reach_annotation.get("ukeire"),
        },
        {
            "id": "damaten",
            "label": label(dama_prefix, dama.get("tile"), dama_annotation),
            "tile": dama.get("tile"),
            "ev": dama["ev"],
            "shantenAfter": dama_shanten,
            "ukeire": dama_annotation.get("ukeire"),
        },
    ]


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

    seat = int((candidate.get("position") or {}).get("seat", candidate.get("actor", 0)))

    try:
        history = load_history(log_dir, str(game_id), int(event_index), seat)
    except FileNotFoundError:
        raise Rejection("log_missing")
    if not history:
        raise Rejection("empty_history")

    try:
        ranked = engine.evaluate(history, seat)
    except NoEvaluationPoint:
        # Post-call discards have no akochan decision point; see pipeline/akochan.py.
        raise Rejection("no_akochan_decision_point")

    if not ranked:
        raise Rejection("akochan_returned_nothing")

    if candidate.get("kind") == "call":
        call_actions = build_call_actions(ranked, candidate)
        if call_actions is None:
            raise Rejection("akochan_offered_no_call")
        kind = "call"
        actions = call_actions
        # Neither the network nor tile efficiency has a view on whether to call,
        # so the second opinion is again the houou player's own choice.
        took = str(candidate.get("actionTaken") or "pass")
        best_call = max(
            (a for a in actions if a["id"] != "pass"), key=lambda a: a["ev"], default=None
        )
        human_first = "pass" if took == "pass" else took
        order = [human_first] + [a["id"] for a in actions if a["id"] != human_first]
        rankings = [
            [a["id"] for a in sorted(actions, key=lambda a: -a["ev"])],
            order,
        ]
        evaluators = ["akochan", "houou-player"]
        if best_call is None:
            raise Rejection("no_choice")
        enriched = dict(candidate)
        enriched["kind"] = kind
        enriched["actions"] = actions
        enriched["rankings"] = rankings
        enriched["evaluators"] = evaluators
        enriched["epsilon"] = epsilon
        enriched["history"] = _kyoku_history(history)
        enriched["akochanBest"] = max(actions, key=lambda a: a["ev"])["id"]
        screened = screen_candidate(
            enriched, epsilon=epsilon, min_margin=min_margin, max_accepted=max_accepted
        )
        screened["agreement"] = True
        screened["tags"] = tags_for(screened, actions, float(screened["margin"]))
        return screened

    riichi_actions = build_riichi_actions(ranked, candidate)
    if riichi_actions is not None:
        # A declaration is available, so ask the more interesting question. The
        # tile choice is subsumed: each option already names the discard its own
        # line wants.
        kind = "riichi"
        actions = riichi_actions
        # The imitation network ranks discards only and has no view on
        # reach-versus-dama, so it cannot be the second evaluator here. The
        # houou player's own choice stands in: a single strong human rather than
        # a panel, and labelled as such — but genuinely independent of a search,
        # which is what the agreement gate is for.
        declared = bool(candidate.get("declaredRiichi"))
        rankings = [
            [action["id"] for action in sorted(actions, key=lambda a: -a["ev"])],
            ["riichi", "damaten"] if declared else ["damaten", "riichi"],
        ]
        evaluators = ["akochan", "houou-player"]
    else:
        kind = candidate.get("kind", "discard")
        actions = build_actions(ranked, candidate)
        # Compared in normalised form. The network ranks 34 tile *indices* and
        # cannot express "the red one", so asking it to agree about which copy of
        # a five to discard would manufacture disagreements it has no view on.
        rankings = [
            [_normalise_id(action["id"]) for action in actions],  # akochan, EV-sorted
            [_normalise_id(action_id) for action_id in model_ranking(candidate, actions)],
        ]
        evaluators = EVALUATORS

    enriched = dict(candidate)
    enriched["kind"] = kind
    enriched["actions"] = actions
    enriched["rankings"] = rankings
    enriched["evaluators"] = evaluators
    enriched["epsilon"] = epsilon
    # Only the events needed to replay the hand in the trainer. `history` is
    # sliced from start_kyoku because that is what the site's replay expects; the
    # start_game event akochan needs is not part of the puzzle.
    enriched["history"] = _kyoku_history(history)
    # Not actions[0]: riichi actions are emitted in a fixed order for display,
    # so the best is whichever has the highest EV.
    enriched["akochanBest"] = max(actions, key=lambda action: action["ev"])["id"]

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
    kind = candidate.get("kind", "discard")
    tags = [kind]

    if kind == "call":
        tags.append("called" if candidate.get("actionTaken") != "pass" else "let-it-pass")
    elif kind == "riichi":
        # Every riichi position is tenpai by definition, so "tenpai-choice" adds
        # nothing; whether the declaration was actually made is the useful axis.
        tags.append("declared" if candidate.get("declaredRiichi") else "stayed-concealed")
    elif best_shanten == 0:
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
