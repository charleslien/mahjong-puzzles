import type { PuzzleIndex } from '../types/puzzle';

/**
 * The methodology page. This exists because a puzzle site that grades your play
 * owes you an account of where its answers come from — especially while the bank
 * is still efficiency drills rather than AI-evaluated positions.
 */
export function About({ index }: { index: PuzzleIndex }) {
  return (
    <section className="panel prose">
      <h2>How this works</h2>

      <p>
        Chess puzzle generators lean on three things mahjong does not have: a single best move, a
        forced line to verify it, and an engine eval that is effectively ground truth. Lichess mines
        positions where a shallow search and a deep search disagree, then keeps only those where one
        move survives and every alternative collapses.
      </p>

      <p>
        Mahjong is imperfect-information and stochastic, so there is no forced line and often no
        unique best play. Each of those three ingredients needs a statistical replacement:
      </p>

      <ul>
        <li>
          <strong>Centipawn loss</strong> becomes loss in expected placement points — the same unit
          mahjong reviewers already use.
        </li>
        <li>
          <strong>Uniqueness</strong> becomes a margin test. A position is only published when the
          best action leads the next one by a real gap, and everything within epsilon of the best is
          accepted as correct.
        </li>
        <li>
          <strong>Depth verification</strong> becomes cross-evaluator agreement. Two independent
          evaluators must rank the same action first, or the position is discarded rather than
          published.
        </li>
      </ul>

      <h3>Current bank</h3>
      <p>
        <strong>{index.count} puzzles.</strong> {index.provenance}
      </p>
      <p className="callout">
        These are tile-efficiency drills, not AI evaluations. They score acceptance count and nothing
        else — no yaku, no score situation, no safety. Efficiency is also the naive baseline the AI
        pipeline exists to disagree with, so treat this bank as scaffolding that proves the site works
        end to end.
      </p>

      <h3>Where the real evaluations will come from</h3>
      <p>
        The strongest riichi AI, <em>Mortal</em>, does not publish its trained weights — its author
        withheld them deliberately to avoid arming cheaters. Neither does Kanachan. So the pipeline
        trains its own model rather than relying on anyone's withheld or leaked weights.
      </p>
      <p>
        Two evaluators, cross-checked. An offline-RL model trained on the CC BY 4.0 Tenhou houou
        dataset does cheap mass mining over millions of positions. <em>akochan</em>, which is fully
        open and needs no weights, verifies the survivors by expected-value search. On Mortal's own
        published benchmarks akochan trails it by roughly 0.09 average placement across 110,000
        games — a real gap, but far closer than its reputation suggests, and more than good enough to
        corroborate a second opinion.
      </p>
      <p>
        Positions where the two disagree are thrown away, not published. Kan decisions and extreme
        endgame spots are excluded outright, since those are akochan's documented weak points.
      </p>

      <h3>No model in your browser</h3>
      <p>
        Every evaluation is precomputed offline and shipped as static JSON. No network weights are
        sent to the browser, because weights delivered to a browser are trivially extractable — doing
        that would recreate exactly the risk that keeps Mortal's weights private in the first place.
      </p>

      <h3>Difficulty</h3>
      <p>
        Lichess learns difficulty from real solve attempts via Glicko-2. That needs a server to
        aggregate across users, and this site is static, so difficulty is currently a model-derived
        proxy from evaluation margin and hand complexity. The schema is shaped so real ratings can be
        added later without a migration.
      </p>

      <h3>Attribution</h3>
      <ul className="links">
        <li>
          Tenhou houou logs in mjai format, CC BY 4.0 —{' '}
          <a href="https://github.com/NikkeTryHard/tenhou-to-mjai">tenhou-to-mjai</a>
        </li>
        <li>
          <a href="https://github.com/critter-mj/akochan">akochan</a> — open expected-value engine
        </li>
        <li>
          <a href="https://mortal.ekyu.moe/perf/strength.html">Mortal strength benchmarks</a> — the
          source of the akochan comparison above
        </li>
        <li>
          <a href="https://database.lichess.org/">Lichess open database</a> — the puzzle-generation
          model this borrows from
        </li>
      </ul>
    </section>
  );
}
