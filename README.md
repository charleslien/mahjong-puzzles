# Mahjong Puzzles

[![CI](https://github.com/charleslien/mahjong-puzzles/actions/workflows/ci.yml/badge.svg)](https://github.com/charleslien/mahjong-puzzles/actions/workflows/ci.yml)

Riichi mahjong decision drills, mined from real games and graded by evaluation
loss. A static site, deployed on Vercel, with an offline generation pipeline that
never runs in the browser.

**Current state:** complete and playable, with 8,150 positions. The bank is
mined from real Tenhou houou-room hanchan held out of model training, and every
expected value comes
from [akochan](https://github.com/critter-mj/akochan)'s search in Tenhou
placement points — not from a tile-efficiency baseline. Discards, riichi
decisions and calls are all populated; riichi and call puzzles are played out as
whole lines rather than as binary questions. Each puzzle carries its hand history
so the position can be replayed in context. Remaining work is in
[pipeline/TODO.md](pipeline/TODO.md).

## Quick start

```bash
npm install
npm run dev     # http://localhost:5173/
npm test        # vitest, including audits of the bank on disk
python3 -m unittest discover -s pipeline -t .
```

The puzzle bank and tile artwork are both committed, so nothing has to be
generated to run the site. To rebuild the bank end to end — extract, mine,
annotate, verify with akochan, export, upload — use
[`scripts/run-pipeline.sh`](scripts/run-pipeline.sh); it needs a trained
checkpoint, an akochan build (`scripts/build-akochan.sh`) and a directory of mjai
logs, which you can grab from the
[tenhou-to-mjai releases](https://github.com/NikkeTryHard/tenhou-to-mjai/releases).
`build:tiles` takes the path to a clone of
[riichi-mahjong-tiles](https://github.com/FluffyStuff/riichi-mahjong-tiles).

## Deploying

Vercel builds from this repository. Import the repo once and it needs no further
setup: `vercel.json` pins the framework, build command and output directory, and
Vercel runs `npm run build` on every push to `main`.

The generated tile artwork and the fallback puzzle bank both live in `public/`
and are committed, so a deploy is a plain static build with no extra steps. The
database copy of the bank is uploaded separately, by the pipeline — see
**Two homes for the bank** below.

Vite's `base` defaults to `/` because Vercel serves from the domain root. Every
asset reference goes through `import.meta.env.BASE_URL`, so hosting under a
subpath only needs `BASE_PATH` set at build time — GitHub Pages, for instance,
would want `BASE_PATH=/mahjong-puzzles/`.

Routing is hash-based (`#/train`, `#/progress`, `#/about`, `#/p/<id>`,
`#/t/<theme>`), so no SPA rewrite rules are required.

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
  curate.py        spend the verification budget where it is wanted   [done]
  verify.py        corroborate with akochan, drop disagreements       [needs akochan]
  export.py        emit the site's puzzle bank JSON                   [done]

src/lib/           the mahjong core, shared by site and generators
  tiles.ts         mjai notation, 34-index conversion, dora
  shanten.ts       all three hand forms, brute-force cross-checked
  ukeire.ts        acceptance counting, the naive baseline
  replay.ts        mjai event stream -> steppable snapshots
  grade.ts         loss -> grade buckets, per-unit thresholds
  decision.ts      flat action list -> the steps a player meets
  weakness.ts      a history -> which themes cost the solver points
  puzzleSource.ts  the bank, from Supabase or from the committed JSON

src/components/
  GameBoard.tsx    four-sided table; each seat's block turned to face it
  PuzzleView.tsx   the drill, with the hand's history scrubbable in place
  DecisionSteps.tsx  one step of a multi-step decision
  Feedback.tsx     the option table, grouped by branch

public/tiles/      CC0 tile artwork, composited (generated)
public/puzzles/    the offline fallback bank (generated, capped, committed)
```

### No model in the browser

Every evaluation is precomputed offline and shipped as static JSON. Weights
delivered to a browser are trivially extractable, so shipping them would recreate
exactly the risk that keeps Mortal's weights private. This constrains the design
— it rules out an "evaluate any position" free-play mode — and that is an accepted
cost, not an oversight.

### Two homes for the bank

The bank exists twice, deliberately, and the two are not the same size:

- **Supabase** holds everything. The site asks for one session's worth at a time
  through an indexed `shuffle_key` sample, so bank size costs nothing per visit —
  a session is ~130 kB rather than the whole 50 MB. It holds 8,150 puzzles —
  4,380 discards, 2,150 riichi decisions and 1,620 calls.
- **`public/puzzles/`** is the offline fallback, served when `VITE_PUZZLE_SOURCE`
  is not `supabase` or the database is unreachable. It is fetched whole and it
  lives in git, so `run-pipeline.sh` caps it (`FALLBACK_SIZE`, default 1200).

They are expected to differ in size and to agree in content, with the bundle a
subset. The failure this creates is silent rather than loud: regenerating
`public/puzzles/` without uploading leaves the deployed site serving the previous
bank, working perfectly, showing puzzles that no longer exist on disk. The upload
is therefore a step of `run-pipeline.sh` rather than something to remember, and
`upload-bank.mjs` prunes rows the new bank no longer contains and then checks the
table count against it.

### What gets verified is chosen, not sampled

akochan is the expensive stage — a search per position, about 4/s — so it sets
how large a run can be. It used to see whatever `mine.py --stride` happened to
sample, which made the bank's composition a side effect of a sampling parameter:
79% discards and 6% riichi, so the site's Riichi filter repeated itself inside a
single session.

`curate.py` separates the two questions. Mine densely, then spend the budget
where the bank is thin:

    QUOTA="riichi=9000 call=0 discard=0" MAX_SHANTEN=0 \
      ./scripts/run-pipeline.sh 6000 30

`curate.py` labels each candidate with the puzzle it would *become* rather than
the decision it was extracted as. akochan still has the final say — a position is
only a riichi puzzle if akochan offers a declaration — so the label is a
prefilter, and a false positive costs nothing: it publishes as an ordinary
discard puzzle. Measured against a full run it caught 152 of the 154 positions
akochan turned into riichi puzzles, and the two it missed were hands holding a
concealed kan, which leaves the hand closed and riichi legal.

Dense mining also needs thinning, because a tenpai hand stays tenpai:
consecutive decisions in one hand are the same wait one tile further on. One
decision per (game, hand, seat, bucket) survives.

`MAX_SHANTEN=0` is the same idea one stage earlier. Annotation computes
acceptance over fourteen discards per hand, but decides from a single shanten
call whether the hand is tenpai at all — so a riichi-aimed pass can skip most of
that work. Measured on a 2,000-candidate slice: 21.7s to 3.7s, finding exactly
the same 57 riichi-capable positions.

Growing one kind alone skews the bank: a riichi-only pass took riichi from 6% of
the bank to 47%, which misrepresents the game — every turn is a discard and
riichi comes up once or twice a hand. Top the others up in a second pass and
export the runs together; `export.py` keeps a decision seen twice once.

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

Each seat's tiles face the seat they belong to, and the turn is applied to the
seat's whole block rather than to each tile. Rotating tiles individually reads
wrongly: the faces point the right way while the rows still run across the
screen, so a side seat's hand looks like tiles knocked over rather than a hand
seen from the side.

Turning the block turns the rows with it, which has a second effect worth having.
Every seat is built the same way — river, then melds, then the hand — and once
turned, each seat's discards land between that player and the centre, and their
melds sit to their own right. Both are what a table does, and neither is
expressible with one rule while the board is upright: the earlier version had to
mirror the meld rule per seat and could not put the far seat's river where it
belongs at all.

Inside a seat's own frame every tile is therefore upright, and the only rotations
left are the two that mean something at a table: the riichi declaration tile in a
river, and the claimed tile in a meld — a quarter turn *relative to the owner*,
which is a plain 90 once the block carries the orientation. The claimed tile also
sits on the side it came from, which is how a table shows who fed a call.

A CSS transform does not change an element's layout box, so a turned block would
still reserve its unturned width. The side seats reserve the swapped box
explicitly, from the same tile dimensions the rows inside are sized from.

Footprints on the felt are reserved rather than fitted: a hand is 14 tiles wide
while its owner holds a draw and 13 after discarding, a river grows from nothing
to four rows, and the meld row appears the moment a seat calls. Sizing any of
those to content made every control below the board jump on each step through a
hand's history. The meld row was the least obvious of the three and the largest —
it is rendered even when empty for exactly this reason.

The single-column breakpoint is set to what the table actually needs, measured,
rather than to a round number. Getting it wrong is invisible in code review and
loud in a browser: too high and it hides a table that would have fitted, too low
and the felt pushes the whole document sideways. Turning the blocks made the side
columns as narrow as a seat is deep, so what now binds is the viewer's own
14-tile hand across the bottom.

Keyboard: <kbd>←</kbd>/<kbd>→</kbd> step through the hand, <kbd>Home</kbd> jumps
to the deal, <kbd>End</kbd> returns to the decision, <kbd>Esc</kbd> or
<kbd>Backspace</kbd> undoes one step of a part-answered decision, <kbd>1</kbd>–
<kbd>9</kbd> take a numbered choice, and <kbd>Enter</kbd> advances — but only once
the puzzle is answered, so a stray press cannot skip one unsolved.

### Decisions are lines, not verbs

A riichi or call puzzle asks the whole decision, one step at a time: declare or
not and then which tile, or call or not, with which set, and what to throw
afterwards. Each complete line is its own action with its own expected value, so
calling correctly and then throwing the wrong tile is not the same answer as
calling correctly.

Each step stays on screen with its answer marked, and any of them can be changed
by picking a different option — choosing a different call clears the set that was
chosen for the old one, since it is not a set of the new one. The first version
replaced each step with the next and offered a Back button, which turned a
three-step call into a wizard: you could not see what you had committed to, and
revising the first choice meant unwinding the rest by hand.

**Nothing on the table moves as a decision is walked.** Every step a puzzle can
reach is on screen from the first frame — an unreached one is an empty outlined
row of the same height — and the space a called meld will occupy is held open
before the call is made. Growing the layout as it was walked moved the fork
buttons and the hand out from under the cursor between clicks, by 64px on the
click that committed to a call.

The chain stays after the answer, reading back the line played. Removing it took
its height out of the seat block at the moment of answering, which pulled the
hand — the thing the verdict stripes are on — up by 96px just as a solver looked
at it.

There are no prompts. "Do you call, or let it pass?" above two buttons reading
Chi and Pass, and "And which tile do you discard?" above a hand with the illegal
tiles greyed out, restated what the controls underneath already showed — and
each was a line of text that came and went as the decision was walked. They
survive as the accessible names of the button groups. What the buttons do carry
is a `›` when there is more to choose after them, because "does this click
submit my answer" is otherwise something you find out by clicking.

The legal tiles narrow with the branch, which is the most useful thing on the
screen: declaring restricts you to tiles that keep tenpai, and a sampled position
offers 3 ways to declare against 12 ways to play on. The illegal ones are dimmed
rather than removed — a tile that has vanished teaches nothing, and one dimmed by
`saturate(0.9) brightness(0.97)`, as these were, teaches nothing either: eleven
of fourteen tiles went out of play on declaring riichi and the hand looked
untouched. A branch whose one
line throws nothing at all (letting a discard pass, or an open kan, which is
followed by a draw from the dead wall) settles the puzzle outright; a branch with
a single *legal discard* does not, because clicking a fork and having the puzzle
answer itself is a jump, and watching the hand narrow to one tile is the clearest
statement the position makes.

The consumed set is part of an action's identity (`chi:2s+3s:5m`): chi-ing 4
bamboo with 2+3 leaves a different hand than with 3+5, and eating the red five
gives away a dora. Grouping in the feedback table follows the same rule, so two
ways to chi the same tile are two headings rather than one confusing list.

### A theme is not shown before it can be

Most tags describe the position — an open hand, an opponent's riichi, a short
wall — and a solver reads all of that off the board anyway. Three are computed
from the answer, and one of them was very nearly an answer key.

`efficiency-trap` marks the positions where the tile pure efficiency picks is
not the tile akochan picks. Measured over the 942 discard puzzles in the shipped
bank:

| | efficiency pick is an accepted answer |
| --- | --- |
| without the chip | 815 of 815 |
| with the chip | 21 of 127 |

Computing the efficiency pick is the baseline skill the site is for, so a chip
row rendered above an unanswered board turned "which tile is best" into "does
the row say trap". That is the same failure as the `declared` / `called` chips
that predicted the branch in 713 of 713 riichi and call puzzles — a fact about
the answer, shown before it.

They are still stored: they are how the theme drill finds positions, and after
an answer they are the framing a solver wants. `src/lib/tags.ts` decides which
may appear when, and `puzzleBank.test.ts` checks it against the bank on disk.
Choosing to drill traps is the solver's own hint to take; a chip they did not
ask for is not.

**The difficulty word carries some of the same information, and is left alone.**
Over the same 942 discard puzzles, 0.4% of Easy ones are traps against 32.6% of
Hard ones — so "Easy" says the efficiency pick is right with 99.6% confidence.
Some of that is what difficulty *means*: an easy puzzle is one where the obvious
play is correct, and the same is true of a 900-rated chess puzzle. Some of it is
definitional rather than emergent, because `difficulty_score` adds a flat +12
for an efficiency trap. Hiding the word would cost a real affordance to close a
much weaker leak than the chip's, so it stays — recorded here because it is a
judgement call and not an oversight.

### Difficulty

Lichess learns difficulty from real solve attempts via Glicko-2, which needs a
server to aggregate across users. This site is static, so difficulty is a
model-derived proxy from evaluation margin, policy entropy, and whether the naive
baseline fails. The schema is shaped so real ratings can be added later without a
migration.

### Where a solver loses points

The progress panel could say how often you were right and not what you were
wrong *about*, which is the only part of a history that says what to practise
next. Every puzzle carries its themes, so the data was there and unused.

Themes are ranked by mean placement points given up per position, not by the
share answered optimally: accuracy treats a 0.5-point inaccuracy and a 12-point
blunder as the same event, and placement points are the unit the whole bank is
built and graded in. Only a solver's first attempt at a position counts — a
review drill replays exactly the ones you got wrong, so counting every attempt
would score those themes twice.

Picking one starts a session drawn from the whole bank on that theme, through
the `any_tags` argument the sampling function has taken since it was written and
the site always passed `null`. The drill is a route — `#/t/endgame` — so it
survives a reload and can be bookmarked.

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
it is worth checking that the two actually disagree. Measured against a
220-puzzle bank (`python -m pipeline.compare_baseline`):

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
