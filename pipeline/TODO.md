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
- [x] Attach the ukeire baseline per position for the naive-disagreement filter.
      Done by `scripts/annotate-ukeire.ts`, shelling out to the tested TS
      implementation rather than porting it. A Python port would mean a second
      copy of the subtlest code in the project, free to drift from the one that
      has a brute-force reference test.
- [x] `--stride`, so a bank is not drawn from a handful of games and the opening
      turns of each.

## 4. `verify.py` — done

- [x] Build akochan. `scripts/build-akochan.sh`. Two upstream assumptions have
      expired: `-lboost_system` names a library that no longer exists
      (Boost.System went header-only in 1.69, stub dropped by 1.90), and
      `io_service` / `address::from_string` / `buffer_cast` were removed in 1.87.
      The latter three are only used by akochan's TcpClient, a path this project
      never takes, so Boost is pinned to 1.85 rather than rewriting upstream's
      socket code to satisfy a compiler for code we do not run.
- [x] Subprocess bridge. `pipeline/akochan.py`. Not `mjai_client.cpp` — that is
      the TCP path. akochan's `mjai_log` and `pipe_detailed` modes both work over
      files and stdio, no networking involved.
- [x] Replay a real log to the decision, using an `eventIndex` recorded by
      extract.py. A *synthetic* stream would mean inventing three concealed hands
      and a wall, which changes the number of unseen tiles and therefore changes
      the EV, so nothing is invented.
- [x] **Throughput measured: ~5 positions/s**, so a 2,000-position batch is
      about 7 minutes. The unknown that mattered was not the per-game figure but
      which mode to use: `pipe_detailed` evaluates *every* decision in the stream
      it is fed, so a position deep in a hanchan costs 80s, while `mjai_log`
      evaluates one and costs 0.37s. A 218x difference for identical output.

**Two ways to get plausible wrong numbers**, both now guarded and both worth
knowing about before touching this code:

1. akochan reads `params/` relative to the working directory. Started elsewhere
   it reads none, does not complain, and returns confident nonsense. `probe()`
   checks a known position yields a spread of EVs rather than trusting an exit
   code — a check on the exit code alone would have passed.
2. akochan's EVs are denominated in whatever `jun_pt` its tactics declare, and
   `mjai_log` *ignores its command-line tactics argument* and loads the hardcoded
   `setup_mjai.json`. That is how the fast path came to run on upstream's
   [90, 30, -30, -90] while the reference path used the trained
   [90, 45, 0, -135]. Changing `jun_pt` is not a rescaling: the objective changes,
   so the ranking changes with it — in one test position the 2nd and 3rd best
   discards swapped. `test_akochan.py` pins the two paths to agree bit-for-bit.

## 5. `export.py` — done

Emits sharded JSON against the site schema, carries CC BY attribution into
`provenance`. Tested for loss/EV consistency, accept-set flags, sharding and
index integrity.

## 6. Wiring — done

- [x] Replace the ukeire bank in `public/puzzles/` with the mined, akochan-verified
      bank. `./scripts/run-pipeline.sh` runs the whole chain.
- [x] Recalibrate the grading thresholds. The `placement_pt` bounds were guessed
      before any real EVs existed, at 0.5/1.2/3.0, which put **62% of every wrong
      answer in "blunder"**. Measured over 2,889 non-accepted actions the losses
      run far larger (median 4.2, p75 8.1, p90 13.2), so the bounds are now
      2/5/12 and `grade.test.ts` pins them against that distribution.
- [ ] Consider keeping both banks and letting users pick, since efficiency drills
      are useful in their own right. Deliberately not done: two evaluators in one
      session means the same position type is graded to two different standards,
      and the ukeire bank's "best" is often not akochan's. Reversible — the site
      reads whatever `index.json` points at, and `evaluation.unit` is per puzzle,
      so both banks can coexist behind a picker whenever that is wanted.

## 7. Remaining

- [ ] **Post-call discards cannot be verified.** akochan evaluates when the seat
      draws, or when another seat discards or adds to a pon — a discard made
      immediately after the seat's *own* call matches none of those, so it returns
      nothing. ~6% of candidates are rejected as `no_akochan_decision_point`.
      Fixing it means finding an akochan entry point that accepts an arbitrary
      decision, or reconstructing the call as a `dahai` by the previous seat.
- [ ] **Call and push/fold puzzle kinds are still unpopulated.** Declined calls
      are invisible in mjai logs, so extract.py never sees them. akochan already
      returns EVs for call options (they arrive with `tile: null` and are
      currently discarded in `akochan._parse`), so the evaluator side is ready;
      the gap is entirely in extraction.
- [ ] **Redact opponents' hands from shipped `history`.** Real logs carry every
      seat's tiles. The board never renders them before an answer, but they are in
      the JSON. Redaction has to keep tile *counts* intact or the replay cannot
      draw the right number of backs, and it would remove the "Reveal all hands"
      review feature, so it is a genuine trade rather than an oversight.

## Deliberately not planned

- **Shipping model weights to the browser.** Weights delivered to a browser are
  trivially extractable, which would recreate exactly the cheating risk that
  keeps Mortal's weights private. Evaluations stay precomputed.
- **Using leaked or bot-fork Mortal weights.** Against the author's explicit
  wishes, and it would poison the project's standing with the community it is for.
- **Server-side Glicko-2 difficulty.** Needs a backend and a shared datastore;
  the site is a static deploy. Vercel functions would make this possible later —
  the schema is shaped so it can be added without a migration.
