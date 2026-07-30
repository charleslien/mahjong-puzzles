import { GRADE_LABELS, describeLoss, formatLoss, type GradedAnswer } from '../lib/grade';
import type { Puzzle } from '../types/puzzle';
import { TileView } from './TileView';

/**
 * One option in the breakdown.
 *
 * This used to draw a long acceptance bar per row and grey out the tile. Both
 * went: the bars dominated the panel while encoding a quantity most solvers were
 * not asking about, and a greyed tile is harder to identify than a normal one
 * for no gain, since the row already says what happens if you pick it.
 *
 * What remains is what a solver actually reads: the tile, what it costs, and
 * whether it was theirs. Acceptance and the policy figure move to a title
 * attribute — available on hover, absent from the scan.
 */
function EvalRow({
  puzzle,
  action,
  chosen,
}: {
  puzzle: Puzzle;
  action: Puzzle['actions'][number];
  chosen: boolean;
}) {
  const unit = puzzle.evaluation.unit;
  const detail = [
    typeof action.ukeire === 'number' ? `${action.ukeire} tiles of acceptance` : undefined,
    typeof action.policy === 'number'
      ? `${Math.round(action.policy * 100)}% of houou players`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li
      className={[
        'option',
        action.accepted ? 'option--best' : '',
        chosen ? 'option--chosen' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={detail || undefined}
    >
      {action.tile ? (
        <TileView tile={action.tile} size="sm" />
      ) : (
        <span className="option__nontile" aria-hidden="true" />
      )}

      <span className="option__label">{action.label}</span>

      <span className="option__cost">
        {action.accepted ? 'best' : describeLoss(action, unit, puzzle.bestShanten)}
      </span>

      {chosen && <span className="option__yours">yours</span>}
    </li>
  );
}

/**
 * Evaluator ids are pipeline identifiers. Shown raw they read as jargon —
 * "offline-model" tells a solver nothing about who judged their answer.
 */
const JUDGE_NAMES: Record<string, string> = {
  akochan: 'the akochan engine',
  'offline-model': 'a network trained on 20M houou decisions',
  'houou-player': 'the houou player who was there',
  'ukeire-baseline': 'tile-efficiency counting',
};

function judgeName(id: string): string {
  return JUDGE_NAMES[id] ?? id;
}

export function Feedback({
  puzzle,
  answer,
  onNext,
}: {
  puzzle: Puzzle;
  answer: GradedAnswer;
  onNext: () => void;
}) {
  const unit = puzzle.evaluation.unit;
  const ranked = [...puzzle.actions].sort((a, b) => a.loss - b.loss);
  const alsoAccepted = puzzle.acceptedActionIds.length > 1;

  return (
    <section className={`feedback feedback--${answer.grade}`} aria-live="polite">
      <header className="feedback__head">
        <span className="feedback__grade">{GRADE_LABELS[answer.grade]}</span>
        {!answer.correct && (
          <span className="feedback__loss">
            {describeLoss(answer.action, unit, puzzle.bestShanten)}
          </span>
        )}
        <button type="button" className="button button--primary" onClick={onNext} autoFocus>
          Next
        </button>
      </header>

      <div className="feedback__body">
        <p className="feedback__line">
          {!answer.correct && (
            <>
              You played <strong>{answer.action.label}</strong>. The best was{' '}
              <strong>{answer.best.label}</strong>.
            </>
          )}
          {answer.correct && alsoAccepted && (
            <>
              <strong>Correct.</strong> {puzzle.acceptedActionIds.length} answers tie here and yours
              is one of them.
            </>
          )}
          {answer.correct && !alsoAccepted && (
            <>
              <strong>Correct</strong>, and it was the only best answer.
            </>
          )}
        </p>

        {puzzle.explanation && <p className="feedback__why">{puzzle.explanation}</p>}

        <ul className="optionlist">
          {ranked.map((action) => (
            <EvalRow
              key={action.id}
              puzzle={puzzle}
              action={action}
              chosen={action.id === answer.action.id}
            />
          ))}
        </ul>

        <details className="feedback__provenance">
          <summary>Where this answer comes from</summary>
          <dl className="provenance">
            <dt>Judged by</dt>
            <dd>{puzzle.evaluation.evaluators.map(judgeName).join(', agreed by ')}</dd>
            <dt>Measured in</dt>
            <dd>{unit === 'ukeire_tiles' ? 'tiles of acceptance' : 'expected placement points'}</dd>
            <dt>Lead over the next answer</dt>
            <dd>{formatLoss(puzzle.evaluation.margin, unit).replace('−', '')}</dd>
            <dt>Both judges agreed</dt>
            <dd>{puzzle.evaluation.agreement ? 'yes' : 'not corroborated'}</dd>
          </dl>
        </details>
      </div>
    </section>
  );
}
