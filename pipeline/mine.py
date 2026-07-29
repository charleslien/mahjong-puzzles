"""Stage 3: mine candidate positions with the offline model.

STATUS: NOT IMPLEMENTED. The interface, the feature contract and the selection
criteria are settled; the model itself is not trained yet. `rank_actions` raises
NotImplementedError rather than returning plausible-looking numbers, because a
puzzle bank built on invented evaluations would be worse than no bank at all.

What has to exist before this runs:

1. A trained model. Mortal's weights are deliberately unpublished, so this
   trains its own on the CC BY 4.0 houou dump. Mortal's own recipe is the
   reference: a ResNet-1D over a 34-long tile axis (`conv_channels = 192`,
   `num_blocks = 40`, roughly 10-12M parameters), a dueling-DQN head over legal
   actions, and Conservative Q-Learning for the offline phase
   (`min_q_weight = 5`). A GRU side-network predicts the distribution over all
   24 final-rank permutations, which is what converts raw game state into
   expected placement.

   Budget ~1-3 days on one consumer GPU for the offline phase. The online
   self-play phase that took Mortal from good to strongest needs ~10M hanchan
   at ~40K/hour, so 2-4 weeks — skippable, since Mortal's own strength page
   shows late versions separated by only 0.01-0.03 average placement.

2. A feature encoder shared with training, turning `position` dicts into model
   input. It must be the identical transform used at training time; a mismatch
   here produces confident nonsense.

Mining does not need the model to be excellent. It needs the *ranking* to be
roughly right, because everything close is thrown away downstream by the margin
test in criteria.py and by akochan disagreement in verify.py.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List, Optional, Sequence


class ModelNotAvailable(NotImplementedError):
    """Raised when mining is attempted without a trained model."""


class OfflineModel:
    """Wraps the trained Q-network.

    Loads a checkpoint and scores legal actions for a position. Kept as a class
    so the checkpoint is read once and reused across millions of positions.
    """

    def __init__(self, checkpoint_path: str) -> None:
        self.checkpoint_path = checkpoint_path

    def rank_actions(self, position: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Score every legal action for `position`.

        Returns a list of {"id", "label", "ev", "policy"} ordered best-first,
        where `ev` is expected final placement points and `policy` is the
        softmax-over-Q probability used for the entropy-based difficulty proxy
        and for the session cross-entropy diagnostic.
        """
        raise ModelNotAvailable(
            "no trained model available; see the module docstring in pipeline/mine.py "
            "for what has to be built first"
        )

    def policy_entropy(self, ranked: Sequence[Dict[str, Any]]) -> float:
        """Entropy of the action distribution, in nats. High entropy means the
        model finds the position genuinely unclear, which correlates with
        difficulty."""
        import math

        total = 0.0
        for action in ranked:
            probability = action.get("policy")
            if probability:
                total -= probability * math.log(probability)
        return total


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--input", required=True, help="decisions JSONL from extract.py")
    parser.add_argument("--output", required=True, help="candidates JSONL")
    parser.add_argument("--checkpoint", required=True, help="trained model checkpoint")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args(argv)

    model = OfflineModel(args.checkpoint)
    try:
        model.rank_actions({})
    except ModelNotAvailable as exc:
        sys.stderr.write("mine.py is not runnable yet: {}\n".format(exc))
        return 2

    # Once a model exists: read decisions, rank actions, attach the ukeire
    # baseline for the naive-disagreement filter, and write candidates for
    # verify.py. Unreachable until then, so left unwritten rather than guessed.
    raise AssertionError("unreachable")


if __name__ == "__main__":
    raise SystemExit(main())
