import { GRADE_LABELS, describeLoss, formatLoss, type GradedAnswer } from '../lib/grade';
import type { Puzzle } from '../types/puzzle';
import { TileView } from './TileView';

function EvalRow({
  puzzle,
  action,
  chosen,
  scale,
}: {
  puzzle: Puzzle;
  action: Puzzle['actions'][number];
  chosen: boolean;
  scale: number;
}) {
  const unit = puzzle.evaluation.unit;

  const regressed =
    puzzle.bestShanten !== undefined &&
    action.shantenAfter !== undefined &&
    action.shantenAfter > puzzle.bestShanten;

  // For efficiency puzzles the bar shows acceptance directly — a longer bar
  // means more tiles improve the hand. That is a real quantity, unlike the
  // composite grading scalar, which mixes in a shanten-regression penalty.
  //
  // Discards that give up shanten get no bar at all. Breaking a hand usually
  // *raises* raw acceptance, so drawing them on the same scale would make the
  // worst options look like the longest bars.
  const magnitude = action.ukeire ?? Math.max(0, scale - action.loss);
  const fill = regressed ? 0 : scale <= 0 ? 100 : Math.max(2, (magnitude / scale) * 100);

  return (
    <li
      className={[
        'evalrow',
        action.accepted ? 'evalrow--best' : '',
        chosen ? 'evalrow--chosen' : '',
        regressed ? 'evalrow--regressed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="evalrow__tile">
        {action.tile ? (
          <TileView tile={action.tile} size="sm" />
        ) : (
          <span className="evalrow__verb">{action.label}</span>
        )}
      </span>

      <span className="evalrow__bar" aria-hidden="true">
        <span className="evalrow__fill" style={{ width: `${fill}%` }} />
      </span>

      {typeof action.ukeire === 'number' && (
        <span className="evalrow__ukeire" title="Tiles of acceptance">
          {action.ukeire}
        </span>
      )}

      <span className="evalrow__loss">{describeLoss(action, unit, puzzle.bestShanten)}</span>

      {typeof action.policy === 'number' && (
        <span className="evalrow__policy" title="Imitation-policy probability">
          {Math.round(action.policy * 100)}%
        </span>
      )}

      {chosen && <span className="evalrow__marker">your pick</span>}
    </li>
  );
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
  // Bars are scaled to the widest acceptance among the actions that actually
  // hold the best shanten, since those are the only ones that get a bar.
  const barred = puzzle.actions.filter(
    (action) =>
      puzzle.bestShanten === undefined ||
      action.shantenAfter === undefined ||
      action.shantenAfter === puzzle.bestShanten,
  );
  const scale = Math.max(1, ...barred.map((action) => action.ukeire ?? Math.max(0, action.loss)));

  return (
    <section className="feedback" aria-live="polite">
      <header className={`feedback__head feedback__head--${answer.grade}`}>
        <span className="feedback__grade">{GRADE_LABELS[answer.grade]}</span>
        {!answer.correct && (
          <span className="feedback__loss">
            {describeLoss(answer.action, unit, puzzle.bestShanten)}
          </span>
        )}
      </header>

      <div className="feedback__body">
        {!answer.correct && (
          <p className="feedback__line">
            You chose <strong>{answer.action.label}</strong>; the best was{' '}
            <strong>{answer.best.label}</strong>.
          </p>
        )}
        {answer.correct && alsoAccepted && (
          <p className="feedback__line">
            Accepted — {puzzle.acceptedActionIds.length} answers tie here, and yours is one of them.
          </p>
        )}
        {answer.correct && !alsoAccepted && (
          <p className="feedback__line">Correct, and it was the only best answer.</p>
        )}

        {puzzle.explanation && <p className="feedback__explanation">{puzzle.explanation}</p>}

        <details className="feedback__details">
          <summary>All options ({ranked.length})</summary>
          <ul className="evallist">
            {ranked.map((action) => (
              <EvalRow
                key={action.id}
                puzzle={puzzle}
                action={action}
                chosen={action.id === answer.action.id}
                scale={scale}
              />
            ))}
          </ul>
        </details>

        <details className="feedback__details">
          <summary>How this was scored</summary>
          <dl className="provenance">
            <dt>Evaluators</dt>
            <dd>{puzzle.evaluation.evaluators.join(', ')}</dd>
            <dt>Unit</dt>
            <dd>{unit === 'ukeire_tiles' ? 'tiles of acceptance' : 'expected placement points'}</dd>
            <dt>Margin over next answer</dt>
            <dd>{formatLoss(puzzle.evaluation.margin, unit).replace('−', '')}</dd>
            <dt>Cross-evaluator agreement</dt>
            <dd>{puzzle.evaluation.agreement ? 'yes' : 'not corroborated'}</dd>
            <dt>Source</dt>
            <dd>{puzzle.source.dataset}</dd>
          </dl>
        </details>
      </div>

      <button type="button" className="button button--primary" onClick={onNext} autoFocus>
        Next puzzle
      </button>
    </section>
  );
}
