import { GRADE_LABELS, type Grade } from '../lib/grade';
import { summarize, type Progress } from '../lib/progress';

const GRADE_ORDER: Grade[] = ['optimal', 'good', 'inaccuracy', 'mistake', 'blunder'];

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
      {hint && <span className="stat__hint">{hint}</span>}
    </div>
  );
}

export function ProgressPanel({ progress, onClear }: { progress: Progress; onClear: () => void }) {
  const summary = summarize(progress);

  if (summary.attempted === 0) {
    return (
      <section className="panel">
        <h2>Progress</h2>
        <p className="muted">
          Nothing solved yet. Progress is stored in this browser only — there is no account and no
          server, so clearing site data resets it.
        </p>
      </section>
    );
  }

  const worst = summary.gradeCounts.mistake + summary.gradeCounts.blunder;

  return (
    <section className="panel">
      <h2>Progress</h2>

      <div className="stats">
        <Stat label="attempted" value={String(summary.attempted)} />
        <Stat
          label="optimal"
          value={`${Math.round(summary.accuracy * 100)}%`}
          hint={`${summary.solved} of ${summary.attempted}`}
        />
        <Stat label="avg score" value={summary.averageScore.toFixed(0)} hint="0–100 per puzzle" />
        <Stat
          label="streak"
          value={String(summary.currentStreak)}
          hint={`best ${summary.bestStreak}`}
        />
      </div>

      <h3>Grade breakdown</h3>
      <ul className="gradebars">
        {GRADE_ORDER.map((grade) => {
          const count = summary.gradeCounts[grade];
          const share = summary.attempted === 0 ? 0 : (count / summary.attempted) * 100;
          return (
            <li key={grade} className="gradebar">
              <span className="gradebar__label">{GRADE_LABELS[grade]}</span>
              <span className="gradebar__track">
                <span className={`gradebar__fill gradebar__fill--${grade}`} style={{ width: `${share}%` }} />
              </span>
              <span className="gradebar__count">{count}</span>
            </li>
          );
        })}
      </ul>

      {worst > 0 && (
        <p className="muted">
          {worst} answer{worst === 1 ? '' : 's'} landed in mistake or blunder territory. Those are the
          ones worth revisiting.
        </p>
      )}

      <button type="button" className="button button--danger" onClick={onClear}>
        Reset progress
      </button>
    </section>
  );
}
