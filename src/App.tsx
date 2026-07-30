import { useCallback, useEffect, useMemo, useState } from 'react';

import { About } from './components/About';
import { ProgressPanel } from './components/ProgressPanel';
import { PuzzleView } from './components/PuzzleView';
import { ReplayView } from './components/ReplayView';
import { gradeAnswer, type GradedAnswer } from './lib/grade';
import { filterPuzzles, loadBank, shuffled, type LoadedBank } from './lib/puzzleBank';
import {
  clearProgress,
  loadProgress,
  recordAttempt,
  saveProgress,
  type Progress,
} from './lib/progress';
import type { Puzzle } from './types/puzzle';

type View = 'train' | 'replay' | 'progress' | 'about';

interface Route {
  view: View;
  puzzleId?: string;
}

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('p/')) return { view: 'train', puzzleId: hash.slice(2) };
  if (hash === 'replay') return { view: 'replay' };
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

  const [upright, setUpright] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mahjong-puzzles:upright') === '1';
    } catch {
      return false;
    }
  });
  const [band, setBand] = useState<(typeof DIFFICULTY_BANDS)[number]['id']>('all');
  const [seed, setSeed] = useState(() => 1);
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
    return shuffled(filtered, seed);
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

  const toggleUpright = useCallback(() => {
    setUpright((current) => {
      const next = !current;
      try {
        localStorage.setItem('mahjong-puzzles:upright', next ? '1' : '0');
      } catch {
        // A missing preference is harmless.
      }
      return next;
    });
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
            <p className="topbar__tagline">Riichi decision drills, graded by evaluation loss</p>
          </div>
        </div>

        <nav className="topbar__nav">
          <a href="#/train" className={route.view === 'train' ? 'active' : ''}>
            Train
          </a>
          <a href="#/replay" className={route.view === 'replay' ? 'active' : ''}>
            Replay
          </a>
          <a href="#/progress" className={route.view === 'progress' ? 'active' : ''}>
            Progress
          </a>
          <a href="#/about" className={route.view === 'about' ? 'active' : ''}>
            Method
          </a>
        </nav>
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

              <div className="sessionbar__group">
                <label className="field field--check">
                  <input type="checkbox" checked={upright} onChange={toggleUpright} />
                  <span>Upright tiles</span>
                </label>
                <span className="sessionbar__streak">
                  streak <strong>{progress.currentStreak}</strong>
                </span>
                <button type="button" className="button" onClick={startFreshSession}>
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
                upright={upright}
              />
            ) : (
              <section className="panel">
                <h2>No puzzles in this band</h2>
                <p className="muted">Try a different difficulty.</p>
              </section>
            )}
          </>
        )}

        {route.view === 'replay' && (
          <ReplayView
            basePath={import.meta.env.BASE_URL}
            upright={upright}
            onToggleUpright={toggleUpright}
          />
        )}

        {bank && route.view === 'progress' && (
          <ProgressPanel
            progress={progress}
            onClear={() => setProgress(clearProgress())}
          />
        )}

        {bank && route.view === 'about' && <About index={bank.index} />}
      </main>

      <footer className="footer">
        <span>
          Positions and evaluations are precomputed offline; no model runs in your browser.
        </span>
        <a href="https://github.com/charleslien/mahjong-puzzles">Source</a>
      </footer>
    </div>
  );
}
