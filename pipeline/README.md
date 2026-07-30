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
extract.py                  mjai logs -> decision records (position + action taken)
train.py                    fit the candidate-finding network on those records
mine.py                     rank legal discards with the model
../scripts/annotate-ukeire  attach the tile-efficiency baseline (TypeScript)
akochan.py / verify.py      re-score with akochan; drop disagreements
export.py                   emit public/puzzles/*.json against the site schema
```

Run the whole chain with `../scripts/run-pipeline.sh`, which is also the record of
the exact invocations. Each stage reads and writes JSONL under `data/`, so stages
are independently resumable and inspectable. `data/` is gitignored — the full dump
is ~12GB.

One stage is TypeScript in an otherwise Python pipeline. The shanten and ukeire
implementations live in `src/lib`, are covered by a brute-force reference test,
and are checked against the shipped bank; porting them would mean maintaining a
second copy of the subtlest code in the project and hoping the two never diverge.

## Status

Complete and shipping. The bank in `public/puzzles/` is mined from games held out
of training, scored by akochan in Tenhou houou placement points, and corroborated
by the model.

Measured: **~5 positions/s** through akochan, and of 2,113 annotated candidates
897 were published — 31% rejected for too small a margin, **14% because the two
evaluators disagreed on the best action**, 5% for having no akochan decision
point, 5% for too many equally good answers, and 2% for being too deep in the
endgame.

`TODO.md` covers what remains: post-call discards have no akochan decision point,
call and push/fold kinds are still unpopulated, and shipped history is
unredacted.

## A warning about akochan

Three of its behaviours produce plausible wrong numbers rather than errors, so
nothing here trusts an exit code. See the docstring in `akochan.py`; the short
version is that it reads `params/` relative to the working directory, its EVs are
denominated in whatever `jun_pt` its tactics declare, and its `mjai_log` mode
ignores the tactics path you pass it.

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
