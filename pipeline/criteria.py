"""Publication criteria — the part of the pipeline that decides what becomes a
puzzle.

Kept separate from the engines on purpose: these rules are the actual editorial
policy of the site, they are the thing most likely to need tuning, and they are
testable without a model or an akochan build.

The adaptation from Lichess is spelled out in README.md. In short: a forced
unique answer becomes a margin test plus an accept set, and depth verification
becomes agreement between two independent evaluators.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

# Actions within this many placement points of the best are graded correct.
DEFAULT_EPSILON_PT = 0.15

# The best action must beat the best non-accepted action by at least this much,
# or the position is too close to call and is dropped.
DEFAULT_MIN_MARGIN_PT = 0.40

# Positions with more accepted answers than this teach nothing.
DEFAULT_MAX_ACCEPTED = 3

# akochan is documented as weak at kan decisions and numerically unstable in
# extreme situations, so those categories are never published on its say-so.
EXCLUDED_KINDS = frozenset({"kan"})

# Below this many live tiles the endgame gets sharp enough that akochan's
# instability and its loose defense both matter more than its EV is worth.
MIN_TILES_LEFT = 8


class Rejection(Exception):
    """Raised with a machine-readable reason when a candidate is not publishable."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _best(actions: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    return max(actions, key=lambda action: action["ev"])


def accept_set(
    actions: Sequence[Dict[str, Any]],
    epsilon: float = DEFAULT_EPSILON_PT,
) -> List[str]:
    """Ids of every action within `epsilon` of the best.

    Mahjong routinely has several defensible plays, so grading against a single
    answer would mark correct play wrong.
    """
    best_ev = _best(actions)["ev"]
    return [action["id"] for action in actions if best_ev - action["ev"] <= epsilon]


def margin(actions: Sequence[Dict[str, Any]], epsilon: float = DEFAULT_EPSILON_PT) -> float:
    """EV gap between the best action and the best action outside the accept set.

    Returns infinity when every action is accepted, which the caller treats as a
    rejection rather than a triumph.
    """
    best_ev = _best(actions)["ev"]
    rejected = [action for action in actions if best_ev - action["ev"] > epsilon]
    if not rejected:
        return float("inf")
    return best_ev - _best(rejected)["ev"]


def evaluators_agree(
    rankings: Sequence[Sequence[str]],
) -> bool:
    """True when every evaluator ranked the same action first.

    This is the stand-in for chess's depth verification. Two independently
    trained or constructed evaluators agreeing on the top action is far stronger
    evidence than either one's confidence, and disagreement is a signal to drop
    the position rather than to pick a winner.
    """
    if len(rankings) < 2:
        return False
    tops = {ranking[0] for ranking in rankings if ranking}
    return len(tops) == 1


def naive_disagreement(
    model_best: str,
    ukeire_best: Sequence[str],
) -> bool:
    """True when pure tile efficiency picks a different action than the model.

    This is the mahjong analogue of Lichess's shallow-vs-deep filter, and it is
    what separates an instructive puzzle from a position where the obvious play
    is simply correct.
    """
    return model_best not in set(ukeire_best)


def difficulty_score(
    margin_pt: float,
    policy_entropy: Optional[float],
    naive_fails: bool,
    accepted_count: int,
) -> int:
    """Model-derived difficulty proxy in 0..100.

    A stand-in for the Glicko-2 rating a server-backed build would learn from
    real solve attempts. Narrow margins, high policy entropy, and positions where
    naive efficiency misleads are all harder.
    """
    score = 50.0
    # A wide margin makes the answer obvious.
    score -= min(30.0, margin_pt * 12.0)
    if policy_entropy is not None:
        # Entropy over ~14 options tops out near ln(14) = 2.64.
        score += min(25.0, policy_entropy * 10.0)
    if naive_fails:
        score += 12.0
    score += min(9.0, (accepted_count - 1) * 3.0)
    return int(max(0, min(100, round(score))))


def screen_candidate(
    candidate: Dict[str, Any],
    epsilon: float = DEFAULT_EPSILON_PT,
    min_margin: float = DEFAULT_MIN_MARGIN_PT,
    max_accepted: int = DEFAULT_MAX_ACCEPTED,
) -> Dict[str, Any]:
    """Apply every publication rule. Raises Rejection with a reason, or returns
    the decorated candidate.

    Expects `candidate` to carry:
        kind             decision kind
        position         position dict matching the site schema
        actions          list of {id, ev, ...} from the primary evaluator
        rankings         list of per-evaluator action-id rankings, best first
        ukeireBest       action ids that pure efficiency would pick
        policyEntropy    optional entropy of the imitation policy, in nats
    """
    kind = candidate.get("kind")
    if kind in EXCLUDED_KINDS:
        raise Rejection("excluded_kind:{}".format(kind))

    position = candidate.get("position") or {}
    tiles_left = position.get("tilesLeft")
    if isinstance(tiles_left, int) and tiles_left < MIN_TILES_LEFT:
        raise Rejection("endgame_too_sharp")

    actions = candidate.get("actions") or []
    if len(actions) < 2:
        raise Rejection("no_choice")

    accepted = accept_set(actions, epsilon)
    if len(accepted) > max_accepted:
        raise Rejection("too_many_answers:{}".format(len(accepted)))

    gap = margin(actions, epsilon)
    if gap == float("inf"):
        raise Rejection("all_actions_equivalent")
    if gap < min_margin:
        raise Rejection("margin_too_small:{:.3f}".format(gap))

    rankings = candidate.get("rankings") or []
    if not evaluators_agree(rankings):
        raise Rejection("evaluators_disagree")

    best_id = _best(actions)["id"]
    naive_fails = naive_disagreement(best_id, candidate.get("ukeireBest") or [])

    decorated = dict(candidate)
    decorated["acceptedActionIds"] = accepted
    decorated["margin"] = gap
    decorated["naiveFails"] = naive_fails
    decorated["difficulty"] = difficulty_score(
        gap, candidate.get("policyEntropy"), naive_fails, len(accepted)
    )
    return decorated
