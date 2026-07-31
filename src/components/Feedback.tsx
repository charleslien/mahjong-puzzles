import { useMemo } from 'react';

import { analyzePosition, visibleCounts } from '../lib/analyzePosition';
import { GRADE_LABELS, formatLoss, gradeForLoss, type GradedAnswer } from '../lib/grade';
import type { PuzzleStats } from '../lib/supabase';
import { tileToIndex, type Tile } from '../lib/tiles';
import type { Puzzle } from '../types/puzzle';
import { ActionLabel, stripTileName } from './ActionLabel';
import { TileView } from './TileView';

/**
 * Below this many first attempts a solve rate is noise dressed as a statistic.
 * Two people getting it right does not make a puzzle easy.
 */
const MIN_GAMES_TO_SHOW = 8;

interface Acceptance {
  tiles: Tile[];
  /** How many of each acceptance tile are still unseen. */
  remaining: Map<Tile, number>;
}

/**
 * Which tiles each discard would accept, and how many of each are left.
 *
 * Computed here rather than shipped with the puzzle. The bank stores the
 * acceptance *count* per discard but not the tiles behind it, and recomputing in
 * the browser costs nothing, needs no regeneration, and uses the same
 * implementation the bank was built with.
 */
function useAcceptance(puzzle: Puzzle): Map<string, Acceptance> {
  return useMemo(() => {
    const out = new Map<string, Acceptance>();
    // A riichi puzzle is the same fourteen-tile decision as a discard — each
    // option names the tile that line throws — so acceptance is computable and
    // was simply not being computed, leaving those rows with a "draws" figure
    // and nothing behind it.
    //
    // A call puzzle genuinely cannot: it is judged at an opponent's discard with
    // thirteen tiles in hand and no discard made yet, and its options name the
    // tile you would throw *after* calling, from a hand that does not exist yet.
    // Those rows carry no acceptance figure either, so there is nothing to hover.
    if (puzzle.kind !== 'discard' && puzzle.kind !== 'riichi') return out;

    const analysis = analyzePosition(puzzle.position);
    if (!analysis) return out;
    const visible = visibleCounts(puzzle.position);

    for (const option of analysis.options) {
      const remaining = new Map<Tile, number>();
      for (const tile of option.acceptedTiles) {
        remaining.set(tile, Math.max(0, 4 - visible[tileToIndex(tile)]));
      }
      // Keyed by tile index so a red five finds its plain twin's entry.
      out.set(String(tileToIndex(option.tile)), { tiles: option.acceptedTiles, remaining });
    }
    return out;
  }, [puzzle]);
}

function shantenLabel(shanten: number | undefined): string {
  if (shanten === undefined) return '';
  if (shanten < 0) return 'won';
  return shanten === 0 ? 'tenpai' : `${shanten}-shanten`;
}

function OptionRow({
  puzzle,
  action,
  chosen,
  acceptance,
  showLabels,
}: {
  puzzle: Puzzle;
  action: Puzzle['actions'][number];
  chosen: boolean;
  acceptance?: Acceptance;
  showLabels: boolean;
}) {
  const unit = puzzle.evaluation.unit;
  const grade = gradeForLoss(action.loss, action.accepted, unit);

  return (
    <li
      className={[
        'opt',
        `opt--${grade}`,
        action.accepted ? 'opt--best' : '',
        chosen ? 'opt--chosen' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="opt__tile">
        {action.tile ? <TileView tile={action.tile} size="sm" /> : null}
      </span>

      <span className="opt__label">
        {showLabels && <ActionLabel action={action} showTile={false} />}
        {chosen && <span className="opt__you">yours</span>}
      </span>

      <span className={`opt__grade opt__grade--${grade}`}>{GRADE_LABELS[grade]}</span>

      {/* The expected value itself, on every row including the best one — the
          number is the point of the exercise, and hiding it behind the word
          "best" made the top line the only one you could not read. */}
      <span className="opt__ev">{action.ev >= 0 ? `+${action.ev.toFixed(2)}` : action.ev.toFixed(2)}</span>

      {/* A gap smaller than the displayed precision is reported as such rather
          than rounded to "−0.00", which reads as a signed zero and tells you
          neither that there is a gap nor that it does not matter. */}
      <span className="opt__delta">
        {action.loss <= 0 ? '—' : action.loss < 0.005 ? '−<0.01' : `−${action.loss.toFixed(2)}`}
      </span>

      <span className="opt__shanten">{shantenLabel(action.shantenAfter)}</span>

      {typeof action.ukeire === 'number' ? (
        <span className="opt__ukeire" tabIndex={0}>
          {action.ukeire}
          {acceptance && acceptance.tiles.length > 0 && (
            <span className="accept" role="tooltip">
              <span className="accept__title">Draws that improve the hand</span>
              <span className="accept__tiles">
                {acceptance.tiles.map((tile) => (
                  <span className="accept__tile" key={tile}>
                    <TileView tile={tile} size="xs" />
                    <span className="accept__count">{acceptance.remaining.get(tile) ?? 0}</span>
                  </span>
                ))}
              </span>
            </span>
          )}
        </span>
      ) : (
        <span className="opt__ukeire" />
      )}
    </li>
  );
}

export function Feedback({
  puzzle,
  answer,
  stats,
  onNext,
}: {
  puzzle: Puzzle;
  answer: GradedAnswer;
  stats?: PuzzleStats;
  onNext: () => void;
}) {
  const unit = puzzle.evaluation.unit;
  // Best first. `loss` is the gap to the best action, so ascending loss is
  // descending value.
  const ranked = [...puzzle.actions].sort((a, b) => a.loss - b.loss);
  const acceptance = useAcceptance(puzzle);
  // On a discard puzzle every row reduces to the same word, and the tile beside
  // it already says which play it is. Nothing is gained by printing "Discard"
  // twelve times, so the column collapses when it carries no information.
  const labels = new Set(ranked.map((action) => stripTileName(action.label)));
  const showLabels = labels.size > 1;
  const showShanten = ranked.some((action) => action.shantenAfter !== undefined);
  const showUkeire = ranked.some((action) => typeof action.ukeire === 'number');

  return (
    <section className={`feedback feedback--${answer.grade}`} aria-live="polite">
      <header className="feedback__head">
        <span className="feedback__grade">{GRADE_LABELS[answer.grade]}</span>
        {!answer.correct && (
          <span className="feedback__loss">{formatLoss(answer.action.loss, unit)}</span>
        )}
        <button type="button" className="button button--primary" onClick={onNext} autoFocus>
          Next
        </button>
      </header>

      <div className="feedback__body">
        {/* No prose restating the table. "You played X, the best was Y" and the
            sentence spelling out the same expected values were both saying what
            the rows below already show — the grade, the points, the gap, and
            which row was yours. The bank still carries the explanation; nothing
            renders it. */}
        {stats && stats.games >= MIN_GAMES_TO_SHOW && stats.solveRate !== null && (
          <p className="feedback__crowd">
            {Math.round(stats.solveRate * 100)}% of solvers find this one, over {stats.games}{' '}
            attempts.
          </p>
        )}

        <ul
          className={[
            'optionlist',
            showLabels ? '' : 'optionlist--terse',
            showShanten ? '' : 'optionlist--no-shanten',
            showUkeire ? '' : 'optionlist--no-ukeire',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <li className="opt opt--header" aria-hidden="true">
            <span className="opt__tile" />
            <span className="opt__label">{showLabels ? 'Option' : 'Tile'}</span>
            <span className="opt__grade" />
            <span className="opt__ev">points</span>
            <span className="opt__delta">vs best</span>
            <span className="opt__shanten">{showShanten ? 'after' : ''}</span>
            <span className="opt__ukeire">{showUkeire ? 'draws' : ''}</span>
          </li>
          {ranked.map((action) => (
            <OptionRow
              key={action.id}
              puzzle={puzzle}
              action={action}
              chosen={action.id === answer.action.id}
              showLabels={showLabels}
              acceptance={
                action.tile ? acceptance.get(String(tileToIndex(action.tile))) : undefined
              }
            />
          ))}
        </ul>
      </div>
    </section>
  );
}
