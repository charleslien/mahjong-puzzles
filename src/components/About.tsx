import type { BankMeta } from '../lib/puzzleSource';

/**
 * The about page.
 *
 * Previously this was a methodology write-up: feature encodings, evaluator
 * agreement rates, why a scale was chosen. All true, all interesting to whoever
 * built it, none of it what someone deciding whether to trust a puzzle wants.
 *
 * What a player needs is short: where the positions come from, who says what the
 * right answer is, and where that judgement is weak. The engineering detail lives
 * in the repository, which is linked, and is not reproduced here.
 */
export function About({ meta }: { meta: BankMeta }) {
  return (
    <section className="panel prose">
      <h2>About</h2>

      <p className="lede">
        {meta.count.toLocaleString()} riichi decisions taken from real games, each scored by a
        mahjong engine, so you can find out whether the tile you would have played is the one that
        actually wins points.
      </p>

      <h3>Where the hands come from</h3>
      <p>
        Every position is a real one, played in Tenhou's houou lobby — the room the strongest
        players use. Nothing is invented or randomly dealt, so the scores, the discards and the
        pressure you are under all really happened. You can step back through any hand to see how it
        got there.
      </p>

      <h3>What you are asked</h3>
      <p>
        Most positions ask which tile to discard. Where a riichi or a call is available you play the
        whole decision out: declare or not, and then which tile — from the tiles that branch actually
        allows, which is usually a much shorter list once you have declared. A call asks whether to
        take the tile, which set to take it with, and what to throw afterwards. Every one of those
        lines is scored separately, so calling correctly and then throwing the wrong tile is not the
        same answer as calling correctly.
      </p>

      <h3>Who decides the answer</h3>
      <p>
        Answers come from <em>akochan</em>, an open mahjong engine that searches ahead and scores
        each option by how it changes your expected finishing position. A second judge has to agree
        before a puzzle is published: for tile choices that is a neural network trained on twenty
        million decisions by strong players, and for riichi and call decisions it is the player who
        was actually sitting there. Where the two disagree, the position is thrown out rather than
        guessed at. The human only ever chose a branch, so that is all they are asked to agree
        about — not which of five riichi discards was best.
      </p>
      <p>
        Answers are given in <strong>placement points</strong> — what a choice is worth in final
        standings, not just in this hand. That is why folding is sometimes correct even when it
        looks slow.
      </p>

      <h3>What it is not</h3>
      <p>
        The engine is strong but not perfect, and it is not the strongest program in existence. On
        close calls, treat a small difference as a matter of taste rather than a verdict — puzzles
        where the top two answers are nearly tied are filtered out for exactly that reason, but the
        line is a judgement call. Kan decisions and desperate endgames are left out altogether,
        because that is where the engine is least reliable.
      </p>
      <p>
        Difficulty is estimated from the position, not from how often people get it wrong. Nothing
        you do here is judged by a human.
      </p>

      <h3>Your progress</h3>
      <p>
        Everything you play is saved in this browser. Signing in with Google keeps it across devices
        and lets your results count toward how hard each puzzle is rated. You can use the whole site
        without an account.
      </p>

      <p className="muted">
        Hands are used under CC BY 4.0. <a href="https://github.com/charleslien/mahjong-puzzles">
          Source and full method
        </a>
        {' · '}
        <a href="https://github.com/critter-mj/akochan">akochan</a>
        {' · '}
        <a href="https://github.com/NikkeTryHard/tenhou-to-mjai">tenhou-to-mjai</a>
      </p>
    </section>
  );
}
