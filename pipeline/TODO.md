# Remaining work

Ordered by what blocks what. Stages 1, 2 and 5 are done and tested; 3 and 4 are
the real work left.

## 1. Dataset fetch — done by hand for now

Grab a year from the [tenhou-to-mjai releases](https://github.com/NikkeTryHard/tenhou-to-mjai/releases)
(CC BY 4.0). 2024 is ~335k games / 1.3GB. `fetch_dataset.py` is not written;
downloading a release asset by hand is a one-liner and not worth automating until
the rest works.

## 2. `extract.py` — done

Replays mjai logs into decision records with final-placement labels. 16 tests.
Handles post-call discards, hidden hands, called tiles leaving the river, and
placement ties.

**Known gap:** only discard decisions are extracted. Call opportunities are
invisible in mjai logs when declined — the log shows nothing where a player chose
not to pon. Recovering those requires detecting legal call chances during replay
and synthesising a `pass` action. That is how the `call` and `push_fold` puzzle
kinds get populated, and it is worth doing: binary decisions make the cleanest
puzzles.

## 3. `mine.py` — not implemented

Blocked on training a model. See the module docstring for the architecture and
compute estimate (~1-3 days on one consumer GPU for the offline phase).

- [ ] Feature encoder: `position` dict -> model input tensor. Must be byte-identical
      to the transform used in training.
- [ ] Training script: CQL offline RL over extracted decisions, GRU rank-predictor
      for the placement reward.
- [ ] `OfflineModel.rank_actions` — load checkpoint, score legal actions.
- [ ] Attach the ukeire baseline per position for the naive-disagreement filter.
      The TS implementation in `src/lib/ukeire.ts` is the reference; either port
      it or shell out to `vite-node`.

## 4. `verify.py` — not implemented

Blocked on an akochan build and an mjai bridge.

- [ ] Build akochan (`make`, needs libboost_system).
- [ ] Subprocess bridge over mjai stdin/stdout using `mjai_client.cpp`.
- [ ] Reconstruct a legal mjai event stream from a stored position. Replay from
      `start_kyoku` — akochan expects a game in progress, not an injected
      mid-hand state. This is the fiddly part.
- [ ] Measure throughput before committing to a target bank size. mjai-reviewer
      quotes 10-60 min per *game*; the per-*position* cost is unknown and decides
      whether verifying 50k positions is a weekend or a month.

## 5. `export.py` — done

Emits sharded JSON against the site schema, carries CC BY attribution into
`provenance`. Tested for loss/EV consistency, accept-set flags, sharding and
index integrity.

## 6. Wiring

- [ ] Replace the synthetic seed bank in `public/puzzles/` with the mined bank.
      The site reads whatever `index.json` points at, so this is a data swap, not
      a code change. Keep the unit tag correct: mined puzzles are
      `placement_pt`, seed drills are `ukeire_tiles`.
- [ ] Consider keeping both banks and letting users pick, since efficiency drills
      are useful in their own right.

## Deliberately not planned

- **Shipping model weights to the browser.** Weights delivered to a browser are
  trivially extractable, which would recreate exactly the cheating risk that
  keeps Mortal's weights private. Evaluations stay precomputed.
- **Using leaked or bot-fork Mortal weights.** Against the author's explicit
  wishes, and it would poison the project's standing with the community it is for.
- **Server-side Glicko-2 difficulty.** Needs a backend; GitHub Pages is static.
  The schema is shaped so it can be added later without a migration.
