import { useCallback, useEffect, useMemo, useState } from 'react';

import { About } from './components/About';
import { AccountButton } from './components/AccountButton';
import { ProgressPanel } from './components/ProgressPanel';
import { PuzzleView } from './components/PuzzleView';
import { gradeAnswer, type GradedAnswer } from './lib/grade';
import { filterPuzzles, loadBank, shuffled, type LoadedBank } from './lib/puzzleBank';
import {
  clearProgress,
  loadProgress,
  attemptedIds,
  recordAttempt,
  saveProgress,
  type Progress,
} from './lib/progress';
// Aliased: `recordAttempt` above writes to localStorage, this one to the
// database. They are not alternatives — both run for a signed-in solver.
import { recordAttempt as recordRemoteAttempt } from './lib/supabase';
import type { Puzzle } from './types/puzzle';

type View = 'train' | 'progress' | 'about';

interface Route {
  view: View;
  puzzleId?: string;
}

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('p/')) return { view: 'train', puzzleId: hash.slice(2) };
  if (hash === 'progress') return { view: 'progress' };
  if (hash === 'about') return { view: 'about' };
  return { view: 'train' };
}

const DIFFICULTY_BANDS = [
  { id: 'all', label: 'All', min: 0, max: 100 },
  { id: 'easy', label: 'Easy', min: 0, max: 40 },
  { id: 'medium', label: 'Medium', min: 41, max: 65 },
  { id: 'hard', label: 'Hard', min: 66, max: 100 },
] as const;

export default function App() {
  const [bank, setBank] = useState<LoadedBank>();
  const [error, setError] = useState<string>();
  const [route, setRoute] = useState<Route>(() => parseHash());
  const [progress, setProgress] = useState<Progress>(() => loadProgress());

  const [band, setBand] = useState<(typeof DIFFICULTY_BANDS)[number]['id']>('all');
  // A fresh order per visit. This was a constant, so every reload dealt the
  // identical shuffle and reopened the same puzzle — the site looked like it had
  // one position in it.
  const [seed, setSeed] = useState(() => (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
  const [cursor, setCursor] = useState(0);
  const [answer, setAnswer] = useState<GradedAnswer>();

  useEffect(() => {
    loadBank().then(setBank, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, []);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const session = useMemo<Puzzle[]>(() => {
    if (!bank) return [];
    const selected = DIFFICULTY_BANDS.find((candidate) => candidate.id === band)!;
    const filtered = filterPuzzles(bank.puzzles, {
      minDifficulty: selected.min,
      maxDifficulty: selected.max,
    });

    // Unseen puzzles first, then everything else. Without this a random order
    // still keeps serving positions already answered, which with 897 puzzles and
    // a growing history is most of what you would see. Answered ones stay in the
    // queue rather than being dropped, so the session never runs dry.
    const seen = attemptedIds(progress);
    const order = shuffled(filtered, seed);
    const fresh = order.filter((puzzle) => !seen.has(puzzle.id));
    const repeats = order.filter((puzzle) => seen.has(puzzle.id));
    return [...fresh, ...repeats];
    // `progress` is deliberately not a dependency: re-sorting the moment an
    // answer lands would move the puzzle you are still looking at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank, band, seed]);

  // A permalinked puzzle takes precedence over wherever the session sits.
  const linked = useMemo(() => {
    if (!bank || !route.puzzleId) return undefined;
    return bank.puzzles.find((puzzle) => puzzle.id === route.puzzleId);
  }, [bank, route.puzzleId]);

  const current = linked ?? session[cursor];

  const onAnswer = useCallback(
    (actionId: string) => {
      if (!current || answer) return;
      const graded = gradeAnswer(current, actionId);
      setAnswer(graded);

      // Mirror the attempt to the database when signed in. Deliberately not
      // awaited and never surfaced: local progress is the source of truth for
      // the session, so a network failure here must not delay the feedback panel
      // or lose the local record. The server recomputes correctness itself, so
      // nothing about the grade is trusted from here.
      void recordRemoteAttempt({ puzzleId: current.id, actionId }).catch((cause) => {
        console.warn('[attempts] not recorded remotely:', cause);
      });

      setProgress((previous) => {
        const next = recordAttempt(
          previous,
          {
            puzzleId: current.id,
            actionId,
            grade: graded.grade,
            score: graded.score,
            loss: graded.action.loss,
            policy: graded.action.policy,
            at: Date.now(),
          },
          graded.correct,
        );
        saveProgress(next);
        return next;
      });
    },
    [current, answer],
  );

  const onNext = useCallback(() => {
    setAnswer(undefined);
    if (linked) {
      // Leaving a permalink drops back into the normal session.
      window.location.hash = '#/train';
      return;
    }
    setCursor((previous) => (previous + 1) % Math.max(1, session.length));
  }, [linked, session.length]);

  const startFreshSession = useCallback(() => {
    setAnswer(undefined);
    setCursor(0);
    setSeed((previous) => previous + 1);
  }, []);

  const onBandChange = useCallback((next: (typeof DIFFICULTY_BANDS)[number]['id']) => {
    setBand(next);
    setAnswer(undefined);
    setCursor(0);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__logo" aria-hidden="true">
            🀄
          </span>
          <div>
            <h1>Mahjong Puzzles</h1>
            <p className="topbar__tagline">Practise the decisions that actually cost you points</p>
          </div>
        </div>

        <nav className="topbar__nav">
          <a href="#/train" className={route.view === 'train' ? 'active' : ''}>
            Train
          </a>
          <a href="#/progress" className={route.view === 'progress' ? 'active' : ''}>
            Progress
          </a>
          <a href="#/about" className={route.view === 'about' ? 'active' : ''}>
            About
          </a>
        </nav>
        <AccountButton />
      </header>

      <main className="main">
        {error && (
          <section className="panel panel--error">
            <h2>Could not load the puzzle bank</h2>
            <p>{error}</p>
            <p className="muted">
              If you are running this locally, generate the bank first with{' '}
              <code>npm run build:seed</code>.
            </p>
          </section>
        )}

        {!error && !bank && <section className="panel">Loading puzzles…</section>}

        {bank && route.view === 'train' && (
          <>
            <div className="sessionbar">
              <div className="sessionbar__group" role="group" aria-label="Difficulty">
                {DIFFICULTY_BANDS.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={`chip ${band === candidate.id ? 'chip--on' : ''}`}
                    onClick={() => onBandChange(candidate.id)}
                    aria-pressed={band === candidate.id}
                  >
                    {candidate.label}
                  </button>
                ))}
              </div>

              {/* The score was a small grey word in the corner. It is the thing a
                  solver checks most often, so it reads as a figure now. */}
              <div className="sessionbar__group">
                <span className="score" title="Correct answers in a row">
                  <strong className="score__value">{progress.currentStreak}</strong>
                  <span className="score__label">streak</span>
                </span>
                <span className="score" title="Puzzles you have answered">
                  <strong className="score__value">{progress.attempts.length}</strong>
                  <span className="score__label">played</span>
                </span>
                <button
                  type="button"
                  className="button"
                  onClick={startFreshSession}
                  title="Deal a different set"
                >
                  Shuffle
                </button>
              </div>
            </div>

            {linked && (
              <p className="permalink-note">
                Viewing a single linked puzzle. <a href="#/train">Return to the session</a>
              </p>
            )}

            {current ? (
              <PuzzleView
                key={current.id}
                puzzle={current}
                answer={answer}
                onAnswer={onAnswer}
                onNext={onNext}
                index={linked ? 0 : cursor}
                total={linked ? 1 : session.length}
              />
            ) : (
              <section className="panel">
                <h2>No puzzles in this band</h2>
                <p className="muted">Try a different difficulty.</p>
              </section>
            )}
          </>
        )}

        {bank && route.view === 'progress' && (
          <ProgressPanel
            progress={progress}
            puzzles={bank.puzzles}
            onClear={() => setProgress(clearProgress())}
          />
        )}

        {bank && route.view === 'about' && <About index={bank.index} />}
      </main>

      <footer className="footer">
        <span>Real hands from Tenhou's houou lobby, scored by the akochan engine.</span>
        <a href="https://github.com/charleslien/mahjong-puzzles">Source</a>
      </footer>
    </div>
  );
}
