import type { PuzzleIndex } from '../types/puzzle';

/**
 * The methodology page. This exists because a puzzle site that grades your play
 * owes you an account of where its answers come from, including the parts that
 * are weaker than a reader might assume.
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
      <h3>Where the evaluations come from</h3>
      <p>
        The strongest riichi AI, <em>Mortal</em>, does not publish its trained weights — its author
        withheld them deliberately to avoid arming cheaters. Neither does Kanachan. So this pipeline
        trains its own model rather than relying on anyone's withheld or leaked weights.
      </p>
      <p>
        Two evaluators, cross-checked. A 2.2M-parameter network trained on 20 million houou decisions
        does the cheap mass mining: it reaches 72.9% agreement with what houou players actually
        discarded on games it never saw, which is what a candidate <em>finder</em> needs.{' '}
        <em>akochan</em>, which is fully open and needs no weights, then re-scores the survivors by
        expected-value search and supplies every number shown here. On Mortal's own published
        benchmarks akochan trails it by roughly 0.09 average placement across 110,000 games — a real
        gap, but far closer than its reputation suggests.
      </p>
      <p>
        Positions where the two disagree are thrown away, not published — that discarded 14% of
        otherwise-publishable candidates. Kan decisions and extreme endgame spots are excluded
        outright, since those are akochan's documented weak points.
      </p>
      <p>
        <strong>Riichi puzzles use a different second opinion.</strong> The network ranks discards,
        so it has no view on whether to declare and cannot corroborate that decision. In its place
        stands the choice the houou player actually made at the table — a single strong human rather
        than a panel, but genuinely independent of a search. A riichi position is published only when
        akochan and that player agree.
      </p>
      <p className="callout">
        What this does <em>not</em> mean: that the answers are ground truth. akochan is a strong
        engine, not an oracle, and it is measurably weaker than the best AI available. Positions are
        discard and riichi decisions only — calls and push-or-fold are not yet mined, because
        declining a call leaves no trace in a game log to learn from. Difficulty is derived from the
        evaluation rather than from whether anyone actually gets it wrong.
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
