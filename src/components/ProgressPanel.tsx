import { useEffect, useState } from 'react';

import { GRADE_LABELS, type Grade } from '../lib/grade';
import { fetchMyRating, type PlayerRating } from '../lib/supabase';
import { summarize, type Progress } from '../lib/progress';
import type { PuzzleSource } from '../lib/puzzleSource';
import { themeBreakdown, themeLabel } from '../lib/weakness';
import type { Puzzle } from '../types/puzzle';
import { ActionLabel } from './ActionLabel';

const GRADE_ORDER: Grade[] = ['optimal', 'good', 'inaccuracy', 'mistake', 'blunder'];

/** How many themes to list. Past this it stops being a shortlist to work from. */
const THEMES_SHOWN = 6;

/**
 * How far back the panel resolves puzzles for.
 *
 * Local history holds up to 2,000 attempts and the ids travel in a request, so
 * something has to bound it. Five hundred is several months of ordinary play and
 * the panel says so rather than quietly describing a slice.
 */
const RESOLVED_WINDOW = 500;

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
  source,
  onReviewMistakes,
  onDrillTheme,
  onClear,
}: {
  progress: Progress;
  source: PuzzleSource;
  onReviewMistakes: () => void;
  /** Start a session drawn from one theme. */
  onDrillTheme: (tag: string) => void;
  onClear: () => void;
}) {
  const summary = summarize(progress);

  // The puzzles behind your history are not necessarily the ones in the current
  // session, so they are fetched by id. Until they arrive the list still renders
  // — with action ids instead of labels — rather than showing nothing.
  //
  // Bounded because the ids travel in a request, and the breakdown below is only
  // as complete as this map: a theme is invisible to it if the puzzles carrying
  // it fell off the end. `RESOLVED_WINDOW` is what the panel then says it covers.
  const [byId, setById] = useState<Map<string, Puzzle>>(new Map());
  useEffect(() => {
    let live = true;
    const ids = [...new Set(progress.attempts.map((attempt) => attempt.puzzleId))].slice(
      -RESOLVED_WINDOW,
    );
    if (!ids.length) return;
    source
      .byIds(ids)
      .then((found) => {
        if (live) setById(new Map(found.map((puzzle) => [puzzle.id, puzzle])));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [source, progress.attempts]);

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
  // Distinct puzzles answered less than optimally — what a review drill would
  // contain, so the button can say how much work it is.
  const missed = new Set(
    progress.attempts.filter((attempt) => attempt.grade !== 'optimal').map((a) => a.puzzleId),
  ).size;

  // Ranked by points given up per position. `byId` arrives asynchronously and
  // covers the most recent `RESOLVED_WINDOW` puzzles, so this fills in a moment
  // after the panel and describes recent play rather than all of it.
  const themes = themeBreakdown(progress.attempts, byId).slice(0, THEMES_SHOWN);
  const worst = themes[0]?.meanLoss ?? 0;
  // The bars are scaled against the worst theme, so a lone row fills its track
  // by construction and reads as an alarm about nothing. A comparison needs two
  // things to compare.
  const comparable = themes.length >= 2;

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

      {comparable && (
        <section className="panel">
          <div className="panel__head">
            <h2>Where you lose points</h2>
            <p className="muted">
              Placement points given up per position, on your first attempt at each
              {summary.attempted > RESOLVED_WINDOW
                ? ` of your last ${RESOLVED_WINDOW}`
                : ''}
              .
            </p>
          </div>
          <ul className="themes">
            {themes.map((theme) => (
              <li key={theme.tag} className="theme">
                <span className="theme__name">{themeLabel(theme.tag)}</span>
                <span className="theme__track">
                  {/* Relative to the worst theme, not to an absolute scale: what
                      the row is for is comparing themes with each other, and no
                      fixed ceiling would be honest across solvers. */}
                  <span
                    className="theme__fill"
                    style={{ width: `${worst > 0 ? (theme.meanLoss / worst) * 100 : 0}%` }}
                  />
                </span>
                <span className="theme__cost">{theme.meanLoss.toFixed(1)}</span>
                <span className="theme__count">
                  {theme.optimal}/{theme.attempts} best
                </span>
                <button
                  type="button"
                  className="button button--small"
                  onClick={() => onDrillTheme(theme.tag)}
                >
                  Drill
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <div className="panel__head">
          <h2>Hands you have played</h2>
          {missed > 0 && (
            <button type="button" className="button button--primary" onClick={onReviewMistakes}>
              Review {missed} miss{missed === 1 ? '' : 'es'}
            </button>
          )}
        </div>
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
                    {(() => {
                      const played = puzzle?.actions.find((a) => a.id === attempt.actionId);
                      return played ? (
                        <ActionLabel action={played} size="xs" />
                      ) : (
                        attempt.actionId
                      );
                    })()}
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
