import { useEffect, useState } from 'react';

import { GRADE_LABELS, type Grade } from '../lib/grade';
import { fetchMyRating, type PlayerRating } from '../lib/supabase';
import { summarize, type Progress } from '../lib/progress';
import type { Puzzle } from '../types/puzzle';

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

function when(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ProgressPanel({
  progress,
  puzzles,
  onClear,
}: {
  progress: Progress;
  puzzles: Puzzle[];
  onClear: () => void;
}) {
  const summary = summarize(progress);
  const byId = new Map(puzzles.map((puzzle) => [puzzle.id, puzzle]));

  // Only exists for a signed-in solver on a deployment with a database, and only
  // after the rating batch has run, so its absence is the normal case.
  const [rating, setRating] = useState<PlayerRating | null>(null);
  useEffect(() => {
    let live = true;
    fetchMyRating()
      .then((found) => { if (live) setRating(found); })
      .catch(() => { /* a missing rating is not an error worth showing */ });
    return () => { live = false; };
  }, []);

  if (summary.attempted === 0) {
    return (
      <section className="panel panel--empty">
        <h2>Nothing solved yet</h2>
        <p className="muted">
          Answer a few puzzles and this is where they will be — every hand you have played, what you
          chose, and how it scored.
        </p>
        <a className="button button--primary" href="#/train">
          Start training
        </a>
      </section>
    );
  }

  // Newest first, so the most recent hand is the easiest one to go back to.
  const history = [...progress.attempts].sort((a, b) => b.at - a.at);

  return (
    <>
      <section className="panel">
        <div className="stats">
          <Stat label="played" value={String(summary.attempted)} />
          <Stat
            label="best answer"
            value={`${Math.round(summary.accuracy * 100)}%`}
            hint={`${summary.solved} of ${summary.attempted}`}
          />
          <Stat
            label="streak"
            value={String(summary.currentStreak)}
            hint={`best ${summary.bestStreak}`}
          />
          {rating && rating.games > 0 && (
            <Stat
              label="rating"
              value={String(Math.round(rating.rating))}
              hint={`± ${Math.round(rating.rd)} over ${rating.games}`}
            />
          )}
        </div>

        <ul className="gradebars">
          {GRADE_ORDER.map((grade) => {
            const count = summary.gradeCounts[grade];
            const share = summary.attempted === 0 ? 0 : (count / summary.attempted) * 100;
            return (
              <li key={grade} className="gradebar">
                <span className="gradebar__label">{GRADE_LABELS[grade]}</span>
                <span className="gradebar__track">
                  <span
                    className={`gradebar__fill gradebar__fill--${grade}`}
                    style={{ width: `${share}%` }}
                  />
                </span>
                <span className="gradebar__count">{count}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="panel">
        <h2>Hands you have played</h2>
        <ul className="history">
          {history.map((attempt) => {
            const puzzle = byId.get(attempt.puzzleId);
            return (
              <li key={`${attempt.puzzleId}-${attempt.at}`} className="history__row">
                <a className="history__link" href={`#/p/${attempt.puzzleId}`}>
                  <span className={`chip chip--${attempt.grade}`}>
                    {GRADE_LABELS[attempt.grade]}
                  </span>
                  <span className="history__what">
                    {puzzle
                      ? puzzle.actions.find((action) => action.id === attempt.actionId)?.label ??
                        attempt.actionId
                      : attempt.actionId}
                  </span>
                  {puzzle && <span className="history__kind">{puzzle.kind}</span>}
                  <span className="history__when">{when(attempt.at)}</span>
                </a>
              </li>
            );
          })}
        </ul>

        <button type="button" className="button button--danger" onClick={onClear}>
          Reset progress
        </button>
      </section>
    </>
  );
}
