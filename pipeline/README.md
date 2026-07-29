# Offline puzzle generation pipeline

Turns Tenhou houou game logs into an AI-evaluated puzzle bank. Nothing here runs
in the browser; the site consumes only the static JSON this emits.

## Why it is shaped like this

The strongest riichi AI, [Mortal](https://github.com/Equim-chan/Mortal), does not
publish its trained weights — its author
[decided in 2022](https://gist.github.com/Equim-chan/cf3f01735d5d98f1e7be02e94b288c56)
to withhold them so they could not be used to cheat on ranked ladders.
[Kanachan](https://github.com/Cryolite/kanachan) likewise ships a framework with
"no training data, nor any trained models". Weights circulating in autoplay-bot
forks are downstream of that decision and are not used here.

So the pipeline trains its own model, and corroborates it against a second,
fully-open engine.

| Stage | Engine | Cost | Role |
| --- | --- | --- | --- |
| Mine | own offline-RL model | ~1–3 days one GPU, once | rank actions over millions of positions cheaply |
| Verify | [akochan](https://github.com/critter-mj/akochan) | minutes per position | independent EV search, no weights needed |

Mortal's own [benchmarks](https://mortal.ekyu.moe/perf/strength.html) put akochan
0.09 average placement behind it across ~110k games (2.57 vs 2.48), with a
notably worse deal-in rate (13.0% vs 11.3%). That is a real gap but a much
smaller one than its reputation suggests — good enough to corroborate a second
opinion, and it needs no weights at all.

Its documented weak points drive the exclusions in `config.yaml`: it is poor at
kan decisions and numerically unstable in extreme situations, and its loose
defense makes pure push-fold calls the least trustworthy category to score with
it alone.

## The generation criteria

Adapted from Lichess, which mines ~600M games for positions where shallow and
deep analysis disagree, then keeps only those with a forced unique answer.
Mahjong has no forced lines, so each criterion gets a statistical replacement:

1. **Gap** — the best action must beat the alternatives by a real EV margin.
2. **Uniqueness → margin + accept set** — publish only when the margin clears
   `min_margin_pt`; everything within `epsilon_pt` of the best is accepted as
   correct, because there is frequently no single best play.
3. **Depth verification → cross-evaluator agreement** — both evaluators must rank
   the same action first, or the position is dropped rather than published.
4. **Instructiveness** — prefer positions where the naive ukeire baseline
   disagrees with the model. That is the mahjong analogue of shallow-vs-deep
   disagreement, and it is what makes a puzzle worth solving.

Evaluation error concentrates in close calls, and criterion 2 discards those by
construction. That is the point: coverage is sacrificed for trustworthiness, and
coverage is not the binding constraint when 2.5M games are available.

## Stages

```
fetch_dataset.py   download houou mjai logs (CC BY 4.0) for a year range
extract.py         mjai logs -> decision records (position + action taken)
mine.py            rank candidates by disagreement and margin, using the model
verify.py          re-score survivors with akochan; drop disagreements
export.py          emit public/puzzles/*.json against the site schema
```

Each stage reads and writes JSONL under `data/`, so stages are independently
resumable and inspectable. `data/` is gitignored — the full dump is ~12GB.

## Status

`extract.py` and `export.py` are implemented and tested. `mine.py` and
`verify.py` define their interfaces and scoring criteria but the model training
and the akochan subprocess bridge are **not yet built** — they are the next piece
of work, and they are what the site needs before it can ship anything beyond
efficiency drills.

See `TODO.md` for exactly what remains.

## Data

Logs come from
[tenhou-to-mjai](https://github.com/NikkeTryHard/tenhou-to-mjai), which
redistributes every Tenhou houou 4-player hanchan from 2009–2026 in mjai format
under **CC BY 4.0** (~2.5M games, ~12GB gzipped). Attribution is carried into the
generated bank's `provenance` field, which the site displays on its method page.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m pipeline.extract --help
```
