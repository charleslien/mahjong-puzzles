# Mahjong Puzzles

Riichi mahjong decision drills, mined from real games and graded by evaluation
loss. A static site, deployable to GitHub Pages, with an offline generation
pipeline that never runs in the browser.

**Current state:** the site is complete and playable against 120 computed
tile-efficiency drills. The AI-evaluated puzzle bank is not built yet — two
pipeline stages need a trained model and an akochan build. See
[pipeline/TODO.md](pipeline/TODO.md) for exactly what remains.

## Quick start

```bash
npm install
npm run build:seed     # generate the puzzle bank into public/puzzles/
npm run dev            # http://localhost:5173/mahjong-puzzles/
npm test               # 45 tests
python3 -m unittest discover -s pipeline -t .   # 43 tests, stdlib only
```

## Deploying

Push to `main`. The workflow in `.github/workflows/deploy.yml` builds and
publishes automatically.

**One-time setup:** in **Settings → Pages**, set *Source* to **GitHub Actions**.
There is no `gh-pages` branch — the site is uploaded as a Pages artifact straight
from `main`, so nothing needs to be committed to a separate branch.

The Vite `base` is `/mahjong-puzzles/`, matching the repo name. For a custom
domain, build with `BASE_PATH=/`.

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
pipeline/          offline, Python, stdlib-only for the data stages
  extract.py       mjai logs -> decision records + placement labels   [done]
  criteria.py      publication rules: margin, accept set, exclusions  [done]
  mine.py          rank candidates with the offline model             [not implemented]
  verify.py        corroborate with akochan, drop disagreements       [not implemented]
  export.py        emit the site's puzzle bank JSON                   [done]

src/lib/           the mahjong core, shared by site and seed generator
  tiles.ts         mjai notation, 34-index conversion, dora
  shanten.ts       all three hand forms, brute-force cross-checked
  ukeire.ts        acceptance counting, the naive baseline
  grade.ts         loss -> grade buckets, per-unit thresholds
  puzzleBank.ts    bank loading, filtering, deterministic shuffle

src/components/    the trainer UI
public/puzzles/    the shipped bank (generated; safe to regenerate)
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

One consequence worth knowing: seed positions are synthetic, so a river may
contain tiles a real player holding that hand would not have discarded. They
drill tile efficiency honestly; they are not realistic game states. Mined
positions will be.

### Difficulty

Lichess learns difficulty from real solve attempts via Glicko-2, which needs a
server to aggregate across users. This site is static, so difficulty is a
model-derived proxy from evaluation margin, policy entropy, and whether the naive
baseline fails. The schema is shaped so real ratings can be added later without a
migration.

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
