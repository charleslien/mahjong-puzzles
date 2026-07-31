import { GRADE_LABELS, type Grade, type GradedAnswer } from '../lib/grade';

const ORDER: Grade[] = ['optimal', 'good', 'inaccuracy', 'mistake', 'blunder'];

/**
 * How a set went.
 *
 * The stream used to run on forever, so there was never a point that said how
 * you had done — you either kept going or closed the tab. This is that point.
 *
 * Deliberately not congratulatory. It reports what happened; the numbers are
 * more use than praise, and a set of twenty is too small to celebrate.
 */
export function SetSummary({
  results,
  onNext,
  onReviewMisses,
}: {
  results: GradedAnswer[];
  onNext: () => void;
  onReviewMisses?: () => void;
}) {
  const total = results.length;
  const best = results.filter((result) => result.correct).length;
  const counts = ORDER.map((grade) => ({
    grade,
    count: results.filter((result) => result.grade === grade).length,
  })).filter((entry) => entry.count > 0);

  // The largest single loss in the set — usually the one worth looking at again.
  const worst = results.reduce<GradedAnswer | undefined>(
    (found, result) => (!found || result.action.loss > found.action.loss ? result : found),
    undefined,
  );

  return (
    <section className="panel summary">
      <h2>Set finished</h2>

      <div className="stats">
        <div className="stat">
          <span className="stat__value">
            {best}
            <span className="muted">/{total}</span>
          </span>
          <span className="stat__label">best answer</span>
        </div>
        <div className="stat">
          <span className="stat__value">
            {total ? Math.round((best / total) * 100) : 0}%
          </span>
          <span className="stat__label">accuracy</span>
        </div>
        {worst && worst.action.loss > 0 && (
          <div className="stat">
            <span className="stat__value">−{worst.action.loss.toFixed(1)}</span>
            <span className="stat__label">worst miss</span>
            <span className="stat__hint">{worst.action.label}</span>
          </div>
        )}
      </div>

      <ul className="summary__grades">
        {counts.map(({ grade, count }) => (
          <li key={grade}>
            <span className={`chip chip--${grade}`}>{GRADE_LABELS[grade]}</span>
            <span className="summary__count">{count}</span>
          </li>
        ))}
      </ul>

      <div className="summary__actions">
        <button type="button" className="button button--primary" onClick={onNext}>
          Next set
        </button>
        {onReviewMisses && best < total && (
          <button type="button" className="button" onClick={onReviewMisses}>
            Review what you missed
          </button>
        )}
      </div>
    </section>
  );
}
