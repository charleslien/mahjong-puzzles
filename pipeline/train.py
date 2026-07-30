"""Train the discard model.

Targets the configuration measured on an Apple M5, fp32, forward+backward:

    model                params   CPU/s   MPS/s   20M samples
    192ch x 40 (Mortal)   10.2M      45     802      7.1h MPS / 121h CPU
    128ch x 10 (default)   2.3M     292    6310      0.9h MPS /  20h CPU
     96ch x 6              1.6M     604   13168      0.4h MPS /  10h CPU

So: use MPS. It is ~18-22x faster than CPU on the same machine, and even the
Mortal-scale network over 100M samples is about 35 hours locally rather than the
25 days CPU would take. `--device` defaults to the best available.

Two heads:

  policy  cross-entropy against the tile a houou-level player actually discarded.
          This is what mining needs, and it is the only head whose target is
          unambiguous.

  value   regression on the actor's realised final placement. Useful but
          biased in a way worth stating plainly: it learns the value of
          houou-*average* play, not optimal play, and it is least reliable
          exactly where humans rarely act. Mortal spends Conservative
          Q-Learning on this problem. Until that is done here, treat the value
          head as a weak prior and let akochan carry the expected-value number
          the site displays. `--no-value` trains policy only.

Usage:
    python -m pipeline.train --input data/decisions.jsonl --out data/model.pt
    python -m pipeline.train --input data/decisions.jsonl --out data/model.pt \
        --channels 192 --blocks 40 --samples 100000000
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time
from typing import Any, Dict, Iterator, List, Optional, Sequence

try:
    import numpy as np
    import torch
    import torch.nn as nn
except ImportError as exc:  # pragma: no cover - dependency guidance
    sys.stderr.write(
        "training needs torch and numpy:\n"
        "  pip install torch numpy\n"
        "(the data stages in this pipeline stay stdlib-only on purpose)\n"
    )
    raise SystemExit(2) from exc

from pipeline.features import (
    IN_CHANNELS,
    LAYOUT_VERSION,
    NUM_ACTIONS,
    TILE_AXIS,
    action_to_index,
    encode,
    legal_discard_mask,
)

# Placement points, in the same units the site reports. Standard uma with the
# 4th-place penalty folded in, so the value head learns something interpretable.
PLACEMENT_POINTS = (90.0, 45.0, 0.0, -135.0)


def pick_device(requested: Optional[str]) -> str:
    if requested:
        return requested
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


class ResBlock(nn.Module):
    def __init__(self, channels: int) -> None:
        super().__init__()
        self.c1 = nn.Conv1d(channels, channels, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm1d(channels)
        self.c2 = nn.Conv1d(channels, channels, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm1d(channels)
        self.act = nn.Mish()

    def forward(self, x):
        y = self.act(self.b1(self.c1(x)))
        y = self.b2(self.c2(y))
        return self.act(x + y)


class DiscardNet(nn.Module):
    """ResNet-1D over the 34-long tile axis, with policy and value heads.

    The tile axis is the natural convolution domain here: neighbouring indices
    are neighbouring ranks within a suit, so a 3-wide kernel sees exactly the
    runs that matter. Honours sit at the end where that adjacency is meaningless,
    which is a known wart of the layout and one the network learns around.
    """

    def __init__(self, channels: int = 128, blocks: int = 10, value_head: bool = True) -> None:
        super().__init__()
        self.channels = channels
        self.blocks = blocks
        self.has_value = value_head

        self.stem = nn.Sequential(
            nn.Conv1d(IN_CHANNELS, channels, 3, padding=1, bias=False),
            nn.BatchNorm1d(channels),
            nn.Mish(),
        )
        self.body = nn.Sequential(*[ResBlock(channels) for _ in range(blocks)])
        self.neck = nn.Sequential(nn.Conv1d(channels, 32, 1, bias=False), nn.Mish(), nn.Flatten())
        self.trunk = nn.Sequential(nn.Linear(32 * TILE_AXIS, 1024), nn.Mish())
        self.policy = nn.Linear(1024, NUM_ACTIONS)
        self.value = nn.Linear(1024, 1) if value_head else None

    def forward(self, x):
        h = self.trunk(self.neck(self.body(self.stem(x))))
        value = self.value(h).squeeze(-1) if self.value is not None else None
        return self.policy(h), value


def iter_records(path: str, repeat: bool) -> Iterator[Dict[str, Any]]:
    """Stream decision records, optionally looping forever."""
    while True:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line:
                    yield json.loads(line)
        if not repeat:
            return


class Batcher:
    """Encodes streamed records into training batches.

    Reservoir-shuffles within a window so consecutive decisions from one hand do
    not land in the same batch — they are highly correlated, and batching them
    together makes gradients noisier than the batch size suggests.
    """

    def __init__(self, path: str, batch_size: int, shuffle_window: int, repeat: bool) -> None:
        self.records = iter_records(path, repeat)
        self.batch_size = batch_size
        self.window: List[Dict[str, Any]] = []
        self.shuffle_window = max(batch_size, shuffle_window)
        self.exhausted = False

    def _fill(self) -> None:
        while len(self.window) < self.shuffle_window and not self.exhausted:
            try:
                self.window.append(next(self.records))
            except StopIteration:
                self.exhausted = True

    def next_batch(self) -> Optional[Dict[str, Any]]:
        self._fill()
        if len(self.window) < self.batch_size:
            return None

        chosen: List[Dict[str, Any]] = []
        for _ in range(self.batch_size):
            index = random.randrange(len(self.window))
            self.window[index], self.window[-1] = self.window[-1], self.window[index]
            chosen.append(self.window.pop())

        features = np.zeros((len(chosen), IN_CHANNELS, TILE_AXIS), dtype=np.float32)
        actions = np.zeros(len(chosen), dtype=np.int64)
        values = np.zeros(len(chosen), dtype=np.float32)
        masks = np.zeros((len(chosen), NUM_ACTIONS), dtype=bool)

        keep = 0
        for record in chosen:
            position = record.get("position") or {}
            try:
                action = action_to_index(record["actionTaken"])
            except (KeyError, ValueError):
                continue
            encode(position, features[keep])
            actions[keep] = action
            placement = record.get("finalPlacement")
            values[keep] = (
                PLACEMENT_POINTS[int(placement)] if placement is not None else 0.0
            )
            masks[keep] = legal_discard_mask(position)
            keep += 1

        if keep == 0:
            return None
        return {
            "features": features[:keep],
            "actions": actions[:keep],
            "values": values[:keep],
            "masks": masks[:keep],
        }


def evaluate(model: DiscardNet, batcher: Batcher, device: str, batches: int) -> Dict[str, float]:
    model.eval()
    total = 0
    correct = 0
    top3 = 0
    loss_sum = 0.0
    ce = nn.CrossEntropyLoss()

    with torch.no_grad():
        for _ in range(batches):
            batch = batcher.next_batch()
            if batch is None:
                break
            x = torch.from_numpy(batch["features"]).to(device)
            y = torch.from_numpy(batch["actions"]).to(device)
            logits, _ = model(x)
            # Illegal discards are masked out before scoring, matching inference.
            mask = torch.from_numpy(batch["masks"]).to(device)
            logits = logits.masked_fill(~mask, float("-inf"))

            loss_sum += float(ce(logits, y)) * y.numel()
            ranked = logits.topk(min(3, logits.shape[-1]), dim=-1).indices
            correct += int((ranked[:, 0] == y).sum())
            top3 += int((ranked == y.unsqueeze(-1)).any(dim=-1).sum())
            total += y.numel()

    model.train()
    if total == 0:
        return {}
    return {
        "agreement": correct / total,
        "top3": top3 / total,
        "cross_entropy": loss_sum / total,
        "samples": total,
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--input", required=True, help="decisions JSONL from extract.py")
    parser.add_argument("--out", required=True, help="checkpoint path")
    parser.add_argument("--holdout", default=None, help="separate JSONL for evaluation")
    parser.add_argument("--device", default=None, help="mps, cuda, cpu (default: best available)")
    parser.add_argument("--channels", type=int, default=128)
    parser.add_argument("--blocks", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--samples", type=int, default=5_000_000, help="training samples to consume")
    parser.add_argument("--shuffle-window", type=int, default=20_000)
    parser.add_argument("--value-weight", type=float, default=0.05)
    parser.add_argument("--no-value", action="store_true", help="train the policy head only")
    parser.add_argument("--log-every", type=int, default=200, help="batches between log lines")
    parser.add_argument("--eval-every", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=20260729)
    args = parser.parse_args(argv)

    random.seed(args.seed)
    torch.manual_seed(args.seed)

    device = pick_device(args.device)
    if device == "cpu":
        sys.stderr.write(
            "warning: training on CPU. On this class of machine MPS is roughly 20x "
            "faster; pass --device mps if it is available.\n"
        )

    model = DiscardNet(args.channels, args.blocks, value_head=not args.no_value).to(device)
    params = sum(p.numel() for p in model.parameters())
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)

    total_batches = max(1, args.samples // args.batch_size)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=args.lr, total_steps=total_batches, pct_start=0.05
    )

    train = Batcher(args.input, args.batch_size, args.shuffle_window, repeat=True)
    holdout = (
        Batcher(args.holdout, args.batch_size, args.shuffle_window, repeat=True)
        if args.holdout
        else None
    )

    ce = nn.CrossEntropyLoss()
    mse = nn.MSELoss()

    sys.stderr.write(
        "device={} params={:.2f}M channels={} blocks={} batch={} target_samples={}\n".format(
            device, params / 1e6, args.channels, args.blocks, args.batch_size, args.samples
        )
    )

    start = time.perf_counter()
    seen = 0
    window_loss = 0.0
    window_correct = 0
    window_total = 0

    for step in range(1, total_batches + 1):
        batch = train.next_batch()
        if batch is None:
            sys.stderr.write("input exhausted after {} samples\n".format(seen))
            break

        x = torch.from_numpy(batch["features"]).to(device)
        y = torch.from_numpy(batch["actions"]).to(device)
        mask = torch.from_numpy(batch["masks"]).to(device)

        optimizer.zero_grad(set_to_none=True)
        logits, value = model(x)
        masked = logits.masked_fill(~mask, float("-inf"))
        loss = ce(masked, y)

        if value is not None:
            target = torch.from_numpy(batch["values"]).to(device)
            # Scaled so the value loss cannot dominate the policy objective.
            loss = loss + args.value_weight * mse(value / 100.0, target / 100.0)

        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        scheduler.step()

        seen += y.numel()
        window_loss += float(loss.detach())
        window_correct += int((masked.argmax(dim=-1) == y).sum())
        window_total += y.numel()

        if step % args.log_every == 0:
            elapsed = time.perf_counter() - start
            rate = seen / elapsed
            sys.stderr.write(
                "step {:>7} samples {:>10} loss {:.4f} agreement {:.3f} "
                "{:.0f} samples/s eta {:.1f}h\n".format(
                    step,
                    seen,
                    window_loss / args.log_every,
                    window_correct / max(1, window_total),
                    rate,
                    max(0.0, (args.samples - seen) / rate / 3600.0),
                )
            )
            window_loss = 0.0
            window_correct = 0
            window_total = 0

        if holdout is not None and step % args.eval_every == 0:
            metrics = evaluate(model, holdout, device, batches=20)
            if metrics:
                sys.stderr.write(
                    "  holdout agreement {agreement:.3f} top3 {top3:.3f} "
                    "ce {cross_entropy:.4f} over {samples} samples\n".format(**metrics)
                )

    checkpoint = {
        "model": model.state_dict(),
        "config": {
            "channels": args.channels,
            "blocks": args.blocks,
            "value_head": not args.no_value,
            "in_channels": IN_CHANNELS,
            "num_actions": NUM_ACTIONS,
            # The feature layout is a contract; a checkpoint is meaningless
            # without the exact encoding it was trained under.
            "layout_version": LAYOUT_VERSION,
            "placement_points": PLACEMENT_POINTS,
        },
        "samples_seen": seen,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    torch.save(checkpoint, args.out)

    elapsed = time.perf_counter() - start
    sys.stderr.write(
        "saved {} after {} samples in {:.2f}h ({:.0f} samples/s)\n".format(
            args.out, seen, elapsed / 3600.0, seen / max(1e-9, elapsed)
        )
    )

    if holdout is not None:
        metrics = evaluate(model, holdout, device, batches=40)
        if metrics:
            sys.stderr.write(
                "final holdout agreement {agreement:.3f} top3 {top3:.3f} "
                "ce {cross_entropy:.4f}\n".format(**metrics)
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
