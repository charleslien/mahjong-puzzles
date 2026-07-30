# Remaining work

Ordered by what blocks what. Stages 1, 2 and 5 are done and tested; 3 and 4 are
the real work left.

## 1. Dataset fetch — done by hand for now

Grab a year from the [tenhou-to-mjai releases](https://github.com/NikkeTryHard/tenhou-to-mjai/releases)
(CC BY 4.0). 2024 is ~335k games / 1.3GB. `fetch_dataset.py` is not written;
downloading a release asset by hand is a one-liner and not worth automating until
the rest works.

## 2. `extract.py` — done

Replays mjai logs into decision records with final-placement labels. 18 tests.
Handles post-call discards, hidden hands, called tiles leaving the river, and
placement ties.

**Correctness note that cost real debugging.** Houou logs carry `deltas` on
hora/ryukyoku but no `scores`, and those deltas exclude the declarer's 1000-point
riichi stick. Accumulating deltas alone disagreed with the next hand's
authoritative `scores` at 1755 of 3064 boundaries. Deducting on `reach` still
missed 67 (reaches ronned before they stood); deducting on `reach_accepted`
missed 1 in 6004. Placement labels are the value head's entire target, so this
would have quietly poisoned it.

**Known gap:** only discard decisions are extracted. Call opportunities are
invisible in mjai logs when declined — the log shows nothing where a player chose
not to pon. Recovering those requires detecting legal call chances during replay
and synthesising a `pass` action. That is how the `call` and `push_fold` puzzle
kinds get populated, and it is worth doing: binary decisions make the cleanest
puzzles.

## 3. Training — `features.py` and `train.py` done

- [x] Feature encoder (`features.py`). 64 planes over the 34-tile axis. The layout
      is a versioned contract written into every checkpoint; drift silently
      invalidates a model, so `test_features.py` pins it.
- [x] Training script (`train.py`). Policy + value heads, ResNet-1D, MPS by
      default. Verified end to end on extracted decisions at ~6000 samples/sec on
      an M5 — matching the standalone benchmark.
- [x] **Run it on real data.** 6.7M decisions from 14,000 hanchan of the 2010
      houou set; holdout of 959k decisions from 2,000 disjoint games. Final:
      **72.9% top-1 / 96.0% top-3** agreement on held-out games, cross-entropy
      0.735, 20M samples in 1.38h at 4,023 samples/sec on MPS. Splits are carved
      by game, not by decision — decisions from one hand are far too correlated
      to straddle a split.
- [x] **Confirm the mining premise.** 23.6% disagreement between the model's top
      discard and the efficiency baseline over the shipped bank. Enough to mine;
      and a floor, since that bank was selected for having clear-cut efficiency
      answers.
- [ ] Scale up if wanted. Agreement was still climbing at 20M samples and
      cross-entropy had not flattened (0.97 -> 0.735), so more data or a bigger
      network would both help. Published imitation models reach ~78-80%.
- [ ] Consider CQL for the value head. Plain regression on realised placement
      learns the behaviour policy's value, which is biased where humans rarely
      act. Not blocking: akochan can carry EV meanwhile.

## 3b. `mine.py` — scoring works

- [x] `OfflineModel.rank_actions` — loads a checkpoint, verifies its
      `layout_version` and tensor shapes against `features.py`, scores legal
      discards. A layout mismatch does not crash, it silently scores garbage, so
      the guard refuses rather than warns.
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
- **Server-side Glicko-2 difficulty.** Needs a backend and a shared datastore;
  the site is a static deploy. Vercel functions would make this possible later —
  the schema is shaped so it can be added without a migration.
