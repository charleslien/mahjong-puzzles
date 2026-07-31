"""Stage 3: mine candidate positions with the offline model.

STATUS: scoring works. Loads a checkpoint from pipeline.train, verifies its
feature-layout version, and ranks legal discards for a position, writing
candidates for verify.py.

What this stage deliberately does NOT do:

  - Apply the publication criteria. A single evaluator cannot corroborate
    itself, so criteria.py's agreement test would reject everything anyway.
  - Emit a per-action expected value. This network has a *state* value head,
    not a per-action Q, so it cannot price individual actions. Deriving a
    placement-point figure from the policy would be a fabricated number.
    akochan (verify.py) supplies both the second opinion and the EV.

So mining produces ranked candidates and a policy distribution; it does not
produce publishable puzzles on its own.

Mining does not need the model to be excellent. It needs the *ranking* to be
roughly right, because everything close is thrown away downstream by the margin
test in criteria.py and by akochan disagreement in verify.py.

Measured on the 2010 houou set: the 2.2M-parameter default reaches ~69%
agreement with the actual houou discard on held-out games, 95% top-3. Agreement
with a human is not correctness — it is a measure of how well the model predicts
houou-level play, which is exactly what a candidate *finder* needs.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List, Optional, Sequence

from pipeline.jsonl import iter_records

_HONORS = ("E", "S", "W", "N", "P", "F", "C")


def _index_to_tile(index: int) -> str:
    """0..33 -> mjai notation. Mirrors features.tile_to_index."""
    if index >= 27:
        return _HONORS[index - 27]
    suit = "mps"[index // 9]
    return "{}{}".format(index % 9 + 1, suit)


class ModelNotAvailable(NotImplementedError):
    """Raised when mining is attempted without a trained model."""


class OfflineModel:
    """Wraps the trained network.

    Loads a checkpoint once and scores legal actions for a position, so the
    weights are read a single time across millions of positions.
    """

    def __init__(self, checkpoint_path: str, device: Optional[str] = None) -> None:
        self.checkpoint_path = checkpoint_path
        try:
            import torch

            from pipeline.features import IN_CHANNELS, LAYOUT_VERSION, NUM_ACTIONS
            from pipeline.train import DiscardNet, pick_device
        except ImportError as exc:
            raise ModelNotAvailable(
                "scoring needs torch and numpy: pip install torch numpy"
            ) from exc

        try:
            checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
        except FileNotFoundError as exc:
            raise ModelNotAvailable(
                "no checkpoint at {}; train one first with pipeline.train".format(checkpoint_path)
            ) from exc

        config = checkpoint.get("config") or {}

        # A checkpoint is meaningless without the exact feature encoding it was
        # trained under. Refusing here beats silently scoring garbage: a layout
        # mismatch does not crash, it just quietly produces confident nonsense.
        stored_layout = config.get("layout_version")
        if stored_layout != LAYOUT_VERSION:
            raise ModelNotAvailable(
                "checkpoint feature layout v{} does not match this code's v{}; "
                "retrain or check out the matching revision".format(stored_layout, LAYOUT_VERSION)
            )
        if config.get("in_channels") != IN_CHANNELS or config.get("num_actions") != NUM_ACTIONS:
            raise ModelNotAvailable(
                "checkpoint shape {}x{} does not match this code's {}x{}".format(
                    config.get("in_channels"),
                    config.get("num_actions"),
                    IN_CHANNELS,
                    NUM_ACTIONS,
                )
            )

        self._torch = torch
        self.device = device or pick_device(None)
        self.has_value = bool(config.get("value_head", True))
        self.model = DiscardNet(
            channels=int(config.get("channels", 128)),
            blocks=int(config.get("blocks", 10)),
            value_head=self.has_value,
        )
        self.model.load_state_dict(checkpoint["model"])
        self.model.to(self.device).eval()
        self.samples_seen = int(checkpoint.get("samples_seen", 0))

    def rank_actions(self, position: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Score every legal action for `position`, best first.

        Returns {"id", "tile", "policy", "logit"} per legal discard, plus the
        state value under "value" on each entry when the checkpoint has a value
        head.

        Note what is deliberately absent: a per-action `ev` in placement points.
        This network has a *state* value head, not a per-action Q, so it cannot
        price individual actions. akochan supplies that number. Inventing one
        here from the policy would be a fabricated expected value.
        """
        torch = self._torch
        from pipeline.features import encode, legal_discard_mask, IN_CHANNELS, TILE_AXIS
        import numpy as np

        features = np.zeros((1, IN_CHANNELS, TILE_AXIS), dtype=np.float32)
        encode(position, features[0])
        mask = legal_discard_mask(position)

        with torch.no_grad():
            x = torch.from_numpy(features).to(self.device)
            logits, value = self.model(x)
            logits = logits[0].float().cpu()
            masked = logits.masked_fill(~torch.from_numpy(mask), float("-inf"))
            probabilities = torch.softmax(masked, dim=-1).numpy()
            state_value = float(value[0]) if value is not None else None

        from pipeline.features import TILE_AXIS as AXIS

        ranked: List[Dict[str, Any]] = []
        for index in range(AXIS):
            if not mask[index]:
                continue
            ranked.append(
                {
                    "id": "discard:{}".format(_index_to_tile(index)),
                    "tile": _index_to_tile(index),
                    "policy": float(probabilities[index]),
                    "logit": float(logits[index]),
                    "value": state_value,
                }
            )
        ranked.sort(key=lambda entry: -entry["policy"])
        return ranked

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
    parser.add_argument(
        "--stride",
        type=int,
        default=1,
        help=(
            "score only every Nth decision. Decisions arrive in game order and, "
            "within a game, in turn order, so taking a prefix would draw a whole "
            "bank from a handful of games and from the opening turns of each. An "
            "earlier bank built that way put 184 of 220 puzzles in East 1."
        ),
    )
    args = parser.parse_args(argv)
    if args.stride < 1:
        parser.error("--stride must be at least 1")

    try:
        model = OfflineModel(args.checkpoint)
    except ModelNotAvailable as exc:
        sys.stderr.write("cannot load a model: {}\n".format(exc))
        return 2

    sys.stderr.write(
        "loaded {} (trained on {} samples), scoring on {}\n".format(
            args.checkpoint, model.samples_seen, model.device
        )
    )

    written = 0
    with open(args.output, "w", encoding="utf-8") as out:
        # Gzip-aware: extract.py writes .jsonl.gz by default, and reading that
        # with a plain open() died on the first line.
        for index, record in enumerate(iter_records(args.input)):
            if args.limit and written >= args.limit:
                break
            if index % args.stride:
                continue
            position = record.get("position") or {}
            kind = record.get("kind", "discard")

            # Only discard decisions get a model opinion. A call is judged at an
            # opponent's discard, where the seat holds thirteen tiles and the
            # network — which ranks discards from a fourteen-tile hand — has
            # nothing to say. Scoring it anyway would produce a confident ranking
            # of the wrong question.
            if kind != "discard":
                out.write(
                    json.dumps(
                        {**record, "modelRanking": [], "policy": {}, "policyEntropy": None},
                        separators=(",", ":"),
                        sort_keys=True,
                    )
                )
                out.write("\n")
                written += 1
                continue

            ranked = model.rank_actions(position)
            if len(ranked) < 2:
                continue

            candidate = {
                "kind": record.get("kind", "discard"),
                "position": position,
                "gameId": record.get("gameId"),
                "decisionIndex": record.get("decisionIndex"),
                # Carried through for verify.py, which replays the original log
                # to this point so akochan sees a real game rather than an
                # invented one.
                "eventIndex": record.get("eventIndex"),
                "actor": record.get("actor"),
                # The second opinion for riichi puzzles, where the model has no
                # view on reach-versus-dama.
                "declaredRiichi": record.get("declaredRiichi", False),
                "modelRanking": [entry["id"] for entry in ranked],
                "policy": {entry["id"]: entry["policy"] for entry in ranked},
                "policyEntropy": model.policy_entropy(ranked),
                "actionTaken": record.get("actionTaken"),
            }
            out.write(json.dumps(candidate, separators=(",", ":"), sort_keys=True))
            out.write("\n")
            written += 1

    sys.stderr.write("wrote {} candidates to {}\n".format(written, args.output))
    # The publication criteria are NOT applied here. A single evaluator cannot
    # corroborate itself, and this network has no per-action EV, so verify.py
    # (akochan) still has to supply both the second opinion and the placement
    # numbers before anything is publishable.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
