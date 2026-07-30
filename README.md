# Mahjong Puzzles

Riichi mahjong decision drills, mined from real games and graded by evaluation
loss. A static site, deployed on Vercel, with an offline generation pipeline that
never runs in the browser.

**Current state:** the site is complete and playable against 220 puzzles mined
from real Tenhou houou-room hanchan, each with its hand history replayable in
context. The *positions* are real; the *evaluation* is still the tile-efficiency
baseline rather than an AI eval. A discard model now trains on real data and
reaches 66.8% agreement with houou play on held-out games — wiring it in as the
evaluator is the remaining step. See [pipeline/TODO.md](pipeline/TODO.md).

## Quick start

```bash
npm install
npm run build:puzzles -- pipeline/data/2010 220   # mine the bank from real logs
npm run build:replays  # generate simulated replay logs into public/replays/
npm run dev            # http://localhost:5173/
npm test               # 65 tests
python3 -m unittest discover -s pipeline -t .   # 65 tests
```

The puzzle bank and tile artwork are both committed, so those build steps are
only needed to regenerate them. `build:puzzles` wants a directory of mjai logs —
grab a year from the
[tenhou-to-mjai releases](https://github.com/NikkeTryHard/tenhou-to-mjai/releases).
`build:tiles` takes the path to a clone of
[riichi-mahjong-tiles](https://github.com/FluffyStuff/riichi-mahjong-tiles).

## Deploying

Vercel builds from this repository. Import the repo once and it needs no further
setup: `vercel.json` pins the framework, build command and output directory, and
Vercel runs `npm run build` on every push to `main`.

The generated tile artwork, puzzle bank and replay logs all live in `public/` and
are committed, so a deploy is a plain static build with no extra steps.

Vite's `base` defaults to `/` because Vercel serves from the domain root. Every
asset reference goes through `import.meta.env.BASE_URL`, so hosting under a
subpath only needs `BASE_PATH` set at build time — GitHub Pages, for instance,
would want `BASE_PATH=/mahjong-puzzles/`.

Routing is hash-based (`#/train`, `#/replay`), so no SPA rewrite rules are
required.

`.github/workflows/ci.yml` only runs types, tests and a build. Deployment is
Vercel's job.

## How puzzle generation works

Lichess mines ~600M games with Stockfish, keeping positions where shallow and
deep analysis disagree and where exactly one move holds the win — over 100 years
of CPU time. That recipe leans on three things mahjong lacks: a single best move,
a forced line to verify it, and an engine eval that is effectively ground truth.

Mahjong is imperfect-information and stochastic, so each ingredient needs a
statistical replacement:

| Chess | Mahjong |
| --- | --- |
| centipawn loss | loss in expected placement points |
| one move holds the win | margin test + an accept set within epsilon |
| depth-verified principal variation | agreement between two independent evaluators |
| shallow-vs-deep disagreement | naive-ukeire-vs-model disagreement |

That last row is the one that makes puzzles worth solving: a position where pure
tile efficiency says one thing and the model says another is instructive by
construction, and both sides are computable.

Evaluation error concentrates in close calls, and the margin test discards those
by construction. Coverage is traded for trustworthiness — and coverage is not the
binding constraint when 2.5M games are available.

## Why the pipeline trains its own model

The strongest riichi AI, [Mortal](https://github.com/Equim-chan/Mortal), does not
publish its trained weights. Its author
[decided in 2022](https://gist.github.com/Equim-chan/cf3f01735d5d98f1e7be02e94b288c56)
to withhold them so they could not be used to cheat on ranked ladders. The
training *code* is fully open — `train.py`, `train_grp.py`, `one_vs_three.py`,
`model.py` are all there — but every training page in the docs is an unwritten
stub, so the recipe has to be read out of `config.example.toml` and source.
[Kanachan](https://github.com/Cryolite/kanachan) likewise ships a framework with
"no training data, nor any trained models".

Weights circulating in autoplay-bot forks are downstream of that decision and are
not used here.

So: train our own for mining, and corroborate with a fully-open engine that needs
no weights at all.

**On akochan being weak** — it isn't, particularly. Mortal's own
[strength benchmarks](https://mortal.ekyu.moe/perf/strength.html) put it 0.09
average placement behind Mortal across ~110k games (2.57 vs 2.48), with a worse
deal-in rate (13.0% vs 11.3%). A real gap, and consistent, but far smaller than
its reputation suggests. Its weaknesses are specific — poor at kan, unstable in
extreme spots, loose defense — and the pipeline encodes those as hard exclusions
rather than hoping they average out.

**On matching Mortal** — mostly unnecessary. Mortal's own version history shows
4.1c vs 4.0 at 2.49 vs 2.50 average placement over 1M games each, and 3.1 vs 3.0
at 2.48 vs 2.51. Whatever the weeks-long online RL phase bought, it was not
placement. The offline phase alone is ~1-3 days on one consumer GPU, and mining
only needs the *ranking* to be roughly right, since everything close gets thrown
away downstream.

## Architecture

```
pipeline/          offline; the data stages are stdlib-only by design
  extract.py       mjai logs -> decision records + placement labels   [done]
  features.py      position -> dense planes; the training contract    [done]
  train.py         policy + value heads, MPS/CUDA/CPU                 [done]
  criteria.py      publication rules: margin, accept set, exclusions  [done]
  mine.py          rank candidates with a trained model               [needs a checkpoint]
  verify.py        corroborate with akochan, drop disagreements       [needs akochan]
  export.py        emit the site's puzzle bank JSON                   [done]

src/lib/           the mahjong core, shared by site and generators
  tiles.ts         mjai notation, 34-index conversion, dora
  shanten.ts       all three hand forms, brute-force cross-checked
  ukeire.ts        acceptance counting, the naive baseline
  replay.ts        mjai event stream -> steppable snapshots
  grade.ts         loss -> grade buckets, per-unit thresholds
  puzzleBank.ts    bank loading, filtering, deterministic shuffle

src/components/
  GameBoard.tsx    four-sided table; per-seat tile rotation
  ReplayView.tsx   step/scrub/play through a hand
  PuzzleView.tsx   the drill, on the same board

public/tiles/      CC0 tile artwork, composited (generated)
public/puzzles/    the shipped bank (generated)
public/replays/    simulated demo logs (generated)
```

### No model in the browser

Every evaluation is precomputed offline and shipped as static JSON. Weights
delivered to a browser are trivially extractable, so shipping them would recreate
exactly the risk that keeps Mortal's weights private. This constrains the design
— it rules out an "evaluate any position" free-play mode — and that is an accepted
cost, not an oversight.

### Two evaluation units, never mixed

`placement_pt` is expected final placement points, produced by the AI evaluators.
`ukeire_tiles` is tiles of acceptance, computed directly from `src/lib/ukeire.ts`.
Grade thresholds are per-unit and the UI labels which is which, because an
efficiency drill must not masquerade as an AI evaluation — the two disagree
precisely where the game is interesting.

The seed bank is `ukeire_tiles`. Its answers are *computed*, not authored: hands
are dealt from a shuffled wall under a fixed seed and scored by the shanten/ukeire
library, so nothing in the shipped bank claims an evaluation it did not perform.

Positions are real, which matters more than it sounds. The first version of this
bank dealt synthetic hands from a shuffled wall, and it showed a random round
number against flat 25000 scores — a board that cannot exist, since by East-3 the
points have moved. Real positions carry the real round, the real scores, and the
real hand history.

### Replaying a hand

Every mined puzzle ships the mjai events for its hand up to the decision, so the
trainer can step back through how the position arose without leaving the puzzle.
Opponents' hands stay concealed until the answer is given.

One honest caveat: real logs record every seat's tiles, so those events do contain
opponents' hands. The board never renders them before you answer, but a
determined reader could pull them from the JSON. Redacting properly means
rewriting deals and draws to placeholders and teaching the replay engine to track
them — worth doing, not done.

### Tile orientation and layout

Every seat's tiles are upright, in horizontal rows reading left to right, top to
bottom. An earlier version turned each seat's tiles to face it, the way a real
table does, and it read worse on both counts: rotated faces are harder to
identify at a glance, and a river that grows away from its owner scrambles the
discard order for three of the four seats.

The one rotation kept is the riichi declaration tile, laid sideways in the river.
That is not an orientation preference — it records *when* riichi was called, so
it carries information the board would otherwise lose.

Footprints on the felt are reserved rather than fitted: a hand is 14 tiles wide
while its owner holds a draw and 13 after discarding, a river grows from nothing
to four rows, and the meld row appears the moment a seat calls. Sizing any of
those to content made every control below the board jump on each step through a
hand's history. The meld row was the least obvious of the three and the largest —
it is rendered even when empty for exactly this reason.

Keyboard: <kbd>←</kbd>/<kbd>→</kbd> step through the hand, <kbd>Home</kbd> jumps
to the deal, <kbd>Esc</kbd> or <kbd>End</kbd> returns to the decision, and
<kbd>Enter</kbd> advances — but only once the puzzle is answered, so a stray
press cannot skip one unsolved.

### Difficulty

Lichess learns difficulty from real solve attempts via Glicko-2, which needs a
server to aggregate across users. This site is static, so difficulty is a
model-derived proxy from evaluation margin, policy entropy, and whether the naive
baseline fails. The schema is shaped so real ratings can be added later without a
migration.

## Training

Measured on an Apple M5, fp32, forward+backward:

| model | params | CPU/s | MPS/s | 20M samples |
| --- | --- | --- | --- | --- |
| 192ch x 40 (Mortal-scale) | 10.2M | 45 | 802 | 7.1h MPS / 121h CPU |
| 128ch x 10 (default) | 2.3M | 292 | 6310 | 0.9h MPS / 20h CPU |
| 96ch x 6 | 1.6M | 604 | 13168 | 0.4h MPS / 10h CPU |

**Use MPS.** It is 18-22x faster than CPU on the same machine, so no rented GPU is
needed: even the Mortal-scale network over 100M samples is ~35 hours locally
against 25 days on CPU. `--device` picks the best backend available.

```bash
# Disjoint splits, by game: two decisions from one hand must never straddle them.
python3 -m pipeline.extract --input pipeline/data/2010 \
    --output pipeline/data/train.jsonl.gz --limit 14000
python3 -m pipeline.extract --input pipeline/data/2010 \
    --output pipeline/data/holdout.jsonl.gz --skip 14000 --limit 2000

python3 -m pipeline.train --input pipeline/data/train.jsonl.gz \
    --holdout pipeline/data/holdout.jsonl.gz --out pipeline/data/model.pt \
    --samples 20000000
```

**Result on real data.** 6.7M decisions from 14,000 hanchan of the 2010 houou
set; holdout of 959k decisions from 2,000 *different* games. The 2.18M-parameter
default, 20M samples in **1.38 hours** at 4,023 samples/sec on MPS:

| metric | held-out games |
| --- | --- |
| top-1 agreement with the houou discard | **72.9%** |
| top-3 agreement | **96.0%** |
| cross-entropy | 0.735 |

4,023 samples/sec is below the 6,310 pure-compute benchmark because JSON parsing
is in the loop. Still an hour-scale run rather than a day-scale one, and no
rented GPU.

Worth being clear what that number is not: agreement with a human is not
correctness. It measures how well the model predicts houou-level play, which is
what makes it useful for *mining* candidate positions — not for declaring an
answer right.

**The mining premise holds.** The design borrows Lichess's shallow-vs-deep filter
by treating naive-ukeire-vs-model disagreement as the instructiveness signal, so
it is worth checking that the two actually disagree. Against the 220 shipped
puzzles (`python -m pipeline.compare_baseline`):

```
model top-1 matches the ukeire baseline: 168/220 = 76.4%
=> disagreement rate (the mining signal):        23.6%
mean policy entropy:                       0.631 nats
```

Roughly one position in four, houou-trained play picks a different tile than pure
efficiency. That is a rich seam — plenty to mine, while 76% agreement shows the
model has learned efficiency as a floor rather than ignoring it.

One caveat on that 23.6%: this bank was *selected* by the efficiency criteria, so
these are positions where ukeire has a clear-cut answer. Disagreement on
efficiency-obvious positions should run lower than on positions at large, which
makes 23.6% a floor rather than an estimate.

Two facts that shaped the data path, both measured rather than assumed. Dense
features are never written to disk — 20M decisions would be ~700GB dense against
~3.4GB for the compact records — so encoding happens per batch. And the encoder
runs ~50x faster than the model, so it stays pure numpy and single-threaded.

The **policy head** is the one to trust: its target is the tile a houou-level
player actually discarded. The **value head** regresses realised final placement,
which learns the value of houou-*average* play rather than optimal play and is
least reliable exactly where humans rarely act. That is what Conservative
Q-Learning exists to fix. Until it is implemented here, the value head is a weak
prior and akochan carries the expected-value figure the site displays;
`--no-value` trains policy only.

## Testing

The shanten implementation is cross-checked against an independent brute-force
reference that derives shanten from an exact completion predicate and shares no
logic with the fast path. The generated puzzle bank is audited in CI for tile
legality, hand sizes, accept-set integrity, EV/loss consistency, and a full
recomputation of every seed answer — data ships without review, so it gets checked
like code.

## Attribution

- Tenhou houou logs in mjai format, **CC BY 4.0** —
  [tenhou-to-mjai](https://github.com/NikkeTryHard/tenhou-to-mjai)
  (every 4-player hanchan 2009–2026, ~2.5M games)
- [akochan](https://github.com/critter-mj/akochan) — open expected-value engine
- [Mortal](https://github.com/Equim-chan/Mortal) — architecture reference and the
  source of the akochan comparison
- [Lichess open database](https://database.lichess.org/) — the puzzle-generation
  model this borrows from
- [mjai format specification](https://github.com/Cryolite/mjai)
