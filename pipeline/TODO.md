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

## 7. Done since

- [x] **Riichi puzzles.** The declaration precedes its discard in mjai, which made
      the declaring discard look forced (dropped by extract) *and* left the
      declaration inside the prefix handed to akochan (which then offered nothing
      to evaluate). Together those produced a bank whose answer was "stay
      concealed" in all 13 cases — a finding about akochan that was entirely
      self-inflicted. Fixed, and akochan now agrees with the houou player's
      declaration in 16 of 18 cases.
- [x] **Call puzzles.** Recovered by checking the rules against each seat's hand
      at every discard, since declining leaves no trace. akochan already answers
      at an opponent's discard, so the evaluator needed no work.
- [x] **Glicko-2 difficulty**, validated against Glickman's published worked
      example. `supabase/tests/glicko2.sql`.
- [x] **Server-side sampling.** 5.7 MB of puzzle data per visit became 229 kB,
      and bank size is no longer bounded by what a browser will download.
- [x] **Answer balancing.** Calls came out 84% "pass"; capped at 60% so the bank
      cannot be beaten by reflex.

## 8. Call and riichi decisions are played out in full — done

A riichi puzzle used to ask a binary question — declare, or the single best
concealed line — and a call puzzle asked call-or-pass with one pre-chosen
follow-up discard. Both threw away most of the decision, and both felt awkward to
play because the interesting part (which tile, which set) had already been
decided for you.

**akochan was already returning the whole tree**; the pipeline was collapsing it.
Every line is now published as its own action:

    {"id": "riichi:3p",    "branch": "riichi", "tile": "3p"}
    {"id": "discard:9p",   "branch": "dama",   "tile": "9p"}
    {"id": "pass",         "branch": "pass"}
    {"id": "chi:2s+3s:5m", "branch": "chi", "consumed": ["2s","3s"], "tile": "5m"}

The consumed set is part of the identity: chi-ing 4s with 2s+3s and with 3s+5s
are different plays, and so is using the red five rather than the plain one.
`daiminkan` lines carry no tile — the discard after an open kan follows a draw
from the dead wall and belongs to a later decision.

The interface walks the branch, and the legal tiles narrow with it: a sampled
position offers 3 ways to declare against 12 ways to play on, and the illegal
ones are dimmed rather than hidden, since the narrowing is the lesson. A branch
with one line resolves without asking.

**Two things measured rather than assumed:**

- *Criteria needed no retuning.* The worry was that seventeen lines instead of
  two would push everything into `margin_too_small` or `too_many_answers`.
  Measured over a 1,200-candidate slice, yields are unchanged: 250 call and 30
  riichi puzzles against 241 and 28 scaled from the previous run, with the accept
  set still a median of 1 and a maximum of 3. Adding weaker lines does not move
  the gap between the best line and the best rejected one.
- *Agreement is judged per branch, not per line.* The second evaluator is the
  houou player who was there, and all they expressed is which branch they took.
  Comparing full lines would manufacture disagreement about a ranking one
  evaluator never gave.

**Two bugs this surfaced**, both of which had been shipping:

- The `declared` / `stayed-concealed` and `called` / `let-it-pass` tags were
  drawn as chips above the board *before* the puzzle was answered. Since a
  position is only published when akochan and the houou player agree on the
  branch, the chip was the answer — it predicted it in 169 of 169 riichi and 544
  of 544 call puzzles. `tags_for` no longer emits anything derived from the
  answer, and the bank audit checks for those four strings.
- `naive_disagreement` read a missing efficiency baseline as disagreement, so all
  713 call and riichi puzzles carried `efficiency-trap` — the headline category —
  plus the +12 difficulty it is worth, on a comparison that never ran.

`extract.py` also now records `calledTile` and `calledFrom` on a call position.
`observe()` runs before the discard is applied, so the tile on offer was in
nobody's river and the position did not record it anywhere: the board could not
mark which discard was being asked about, nor draw the meld a call would make.

## 9. Remaining

- [x] **Post-call discards cannot be verified — and the reason is in akochan,
      not in the bridge.** The open question was whether some other entry point
      would accept an arbitrary decision. There is not one. `mjai_log` calls
      `ai_review`, which does *not* gate on the event type — but it delegates to
      `Selector::set_selector`, which opens with

          assert(type == "tsumo" ||
                 (type == "dahai" && actor != my_pid) ||
                 (type == "kakan" && actor != my_pid))

      (`ai_src/selector.cpp:334`), the same condition `pipe_detailed` dispatches
      on (`main.cpp:212`). So a discard made immediately after the seat's own
      call is not a state the engine models, in either mode; `triggers_evaluation`
      mirrors it exactly and rejecting is correct. Recovering these ~6% means
      adding a post-call branch to akochan's selector, which would be inventing
      expected values from a code path the engine was not built for. Not planned.
- [ ] **push/fold is still its own unpopulated kind.** In practice the decision
      shows up inside discard puzzles — folding is simply a discard akochan
      prices highly — so a separate kind may not be worth having. Decide before
      building it.
- [x] **Call evaluation is slow**, and now it does not have to dominate a run.
      akochan's fuuro search runs at roughly 0.7 positions/s against 5/s for a
      discard. `curate.py` caps how many of each kind reach verification, so a
      run can skip calls entirely when the bank already has enough of them.
- [ ] **Redact opponents' hands from shipped `history`.** Real logs carry every
      seat's tiles. The board never renders them before an answer, but they are in
      the JSON. Redaction has to keep tile *counts* intact or the replay cannot
      draw the right number of backs, and it would remove the "Reveal all hands"
      review feature, so it is a genuine trade rather than an oversight.

      Worth noting what it would and would not buy: the answer is in the payload
      too — `accepted` is a field on every action — so this is not an anti-cheat
      measure. It would cut ~3.2 kB of the 6.2 kB average row, which matters for
      the session fetch and for the database's size, and that is the honest case
      for it.

## 10. Composition is chosen now, not sampled — done

`curate.py` sits between annotation and verification and caps how many of each
kind reach akochan, so mining density and bank composition stopped being the
same number. The rules and the measurements are in the README under
**What gets verified is chosen, not sampled**; the short version:

- riichi-capable positions are ~5% of discard candidates and publish at ~53%,
  so a riichi-aimed pass is cheap once the other kinds are quota'd out;
- `--max-shanten 0` makes the annotation ahead of it ~6x faster for the same
  result, because tenpai is one shanten call and acceptance is fourteen;
- growing one kind alone skews the bank, so a top-up pass for the others runs
  after, and `export.py --input a.jsonl b.jsonl c.jsonl` merges the runs on
  (gameId, decisionIndex).

## Deliberately not planned

- **Shipping model weights to the browser.** Weights delivered to a browser are
  trivially extractable, which would recreate exactly the cheating risk that
  keeps Mortal's weights private. Evaluations stay precomputed.
- **Using leaked or bot-fork Mortal weights.** Against the author's explicit
  wishes, and it would poison the project's standing with the community it is for.
- **Server-side Glicko-2 difficulty.** Needs a backend and a shared datastore;
  the site is a static deploy. Vercel functions would make this possible later —
  the schema is shaped so it can be added without a migration.
