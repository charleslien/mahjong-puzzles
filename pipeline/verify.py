"""Stage 4: verify candidates with akochan.

STATUS: NOT IMPLEMENTED. The mjai bridge is specified below but not built, and
`AkochanEngine.evaluate` raises rather than returning invented numbers.

Why akochan is the verifier:

It is fully open, needs no trained weights, and computes expected value by
search rather than by learned approximation — so its errors are uncorrelated with
the offline model's. Two evaluators with uncorrelated errors agreeing on a top
action is much stronger evidence than either one alone, which is the whole point
of this stage.

On Mortal's own published benchmarks akochan trails Mortal by 0.09 average
placement over ~110k games (2.57 vs 2.48), with a worse deal-in rate (13.0% vs
11.3%). Close behind the strongest AI in existence, and far closer than its
reputation suggests.

Its weaknesses are specific, and criteria.py encodes them as hard exclusions
rather than trusting them to average out:

  - poor at kan decisions            -> `kind == "kan"` is never published
  - unstable in extreme situations   -> sharp endgames are dropped
  - loose defense (worse deal-in)    -> pure push/fold is the least trustworthy
                                        category on its say-so alone

It is also slow: mjai-reviewer reports 10-60 minutes per game against under 10
seconds for Mortal. That is fine here — verification is an offline batch over a
few tens of thousands of positions, not an interactive path — but it is the
reason mining runs first and only survivors reach this stage.

What has to be built:

1. An akochan build (`make` with libboost_system; see the upstream repo).
2. A subprocess bridge speaking mjai over stdin/stdout. akochan ships
   `mjai_client.cpp` and `setup_mjai.json` for exactly this.
3. Reconstruction of a synthetic mjai event stream from a stored `position`
   dict, since akochan expects a game in progress rather than a bare position.
   This is the fiddly part: the stream has to be legal enough for akochan to
   accept it, which means replaying from `start_kyoku` rather than injecting a
   mid-hand state.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List, Optional, Sequence

from pipeline.criteria import Rejection, screen_candidate


class AkochanNotAvailable(NotImplementedError):
    """Raised when verification is attempted without a working akochan build."""


class AkochanEngine:
    """Subprocess bridge to akochan over the mjai protocol."""

    def __init__(self, binary_path: str, tactics_path: Optional[str] = None) -> None:
        self.binary_path = binary_path
        self.tactics_path = tactics_path

    def evaluate(self, position: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Return {"id", "ev"} per legal action, ordered best-first.

        `ev` must be in the same placement-point unit the offline model reports,
        or the margin comparison downstream is meaningless.
        """
        raise AkochanNotAvailable(
            "no akochan bridge available; see the module docstring in pipeline/verify.py"
        )


def verify_candidate(
    candidate: Dict[str, Any],
    engine: AkochanEngine,
    epsilon: float,
    min_margin: float,
) -> Dict[str, Any]:
    """Re-score one candidate and apply the publication criteria.

    The candidate keeps the *model's* EV numbers for display — they are the ones
    trained on human placement outcomes — while akochan's ranking is used solely
    to corroborate the top action. Raises Rejection when unpublishable.
    """
    akochan_ranked = engine.evaluate(candidate["position"])
    if not akochan_ranked:
        raise Rejection("akochan_returned_nothing")

    model_ranking = [action["id"] for action in candidate["actions"]]
    model_ranking.sort(
        key=lambda action_id: -next(
            action["ev"] for action in candidate["actions"] if action["id"] == action_id
        )
    )

    enriched = dict(candidate)
    enriched["rankings"] = [
        model_ranking,
        [action["id"] for action in akochan_ranked],
    ]
    enriched["evaluators"] = ["offline-model", "akochan"]
    enriched["epsilon"] = epsilon
    enriched["agreement"] = True  # screen_candidate re-checks and may reject.

    screened = screen_candidate(enriched, epsilon=epsilon, min_margin=min_margin)
    screened["agreement"] = True
    return screened


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--input", required=True, help="candidates JSONL from mine.py")
    parser.add_argument("--output", required=True, help="verified candidates JSONL")
    parser.add_argument("--akochan", required=True, help="path to the akochan binary")
    parser.add_argument("--epsilon", type=float, default=0.15)
    parser.add_argument("--min-margin", type=float, default=0.40)
    parser.add_argument(
        "--reject-log",
        default=None,
        help="optional JSONL of rejected candidates with reasons, for tuning",
    )
    args = parser.parse_args(argv)

    engine = AkochanEngine(args.akochan)
    try:
        engine.evaluate({})
    except AkochanNotAvailable as exc:
        sys.stderr.write("verify.py is not runnable yet: {}\n".format(exc))
        return 2

    raise AssertionError("unreachable")


if __name__ == "__main__":
    raise SystemExit(main())
