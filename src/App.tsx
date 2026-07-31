import { useCallback, useEffect, useState } from 'react';

import { About } from './components/About';
import { AccountButton } from './components/AccountButton';
import { ProgressPanel } from './components/ProgressPanel';
import { PuzzleView } from './components/PuzzleView';
import { gradeAnswer, type GradedAnswer } from './lib/grade';
import { openSource, type BankMeta, type PuzzleSource } from './lib/puzzleSource';
import {
  clearProgress,
  loadProgress,
  attemptedIds,
  markSynced,
  recordAttempt,
  saveProgress,
  unsyncedAttempts,
  type Progress,
} from './lib/progress';
import { useSession } from './lib/useSession';
// Aliased: `recordAttempt` above writes to localStorage, this one to the
// database. They are not alternatives — both run for a signed-in solver.
import {
  backfillAttempts,
  recordAttempt as recordRemoteAttempt,
  type PuzzleStats,
} from './lib/supabase';
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

/**
 * Decision kinds a session can be narrowed to.
 *
 * Worth having as its own control rather than a tag filter: the three ask
 * genuinely different questions, and someone who wants to drill calls does not
 * want them one in five.
 */
const KINDS = [
  { id: 'all', label: 'All', kinds: undefined as string[] | undefined },
  { id: 'discard', label: 'Discards', kinds: ['discard'] },
  { id: 'riichi', label: 'Riichi', kinds: ['riichi'] },
  { id: 'call', label: 'Calls', kinds: ['call'] },
] as const;

const DIFFICULTY_BANDS = [
  { id: 'all', label: 'All', min: 0, max: 100 },
  { id: 'easy', label: 'Easy', min: 0, max: 40 },
  { id: 'medium', label: 'Medium', min: 41, max: 65 },
  { id: 'hard', label: 'Hard', min: 66, max: 100 },
] as const;

/**
 * How many puzzles a session holds.
 *
 * Enough that nobody reaches the end of one in a sitting, small enough that the
 * page is not paying to download a bank it will not play. Running out simply
 * fetches more.
 */
const SESSION_SIZE = 40;

export default function App() {
  const [source, setSource] = useState<PuzzleSource>();
  const [meta, setMeta] = useState<BankMeta>();
  const [session, setSession] = useState<Puzzle[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Map<string, PuzzleStats>>(new Map());
  const [linked, setLinked] = useState<Puzzle>();
  const [error, setError] = useState<string>();
  const [route, setRoute] = useState<Route>(() => parseHash());
  const [progress, setProgress] = useState<Progress>(() => loadProgress());

  const [band, setBand] = useState<(typeof DIFFICULTY_BANDS)[number]['id']>('all');
  const [kindFilter, setKindFilter] = useState<(typeof KINDS)[number]['id']>('all');
  // When set, the session replays exactly these puzzles instead of sampling.
  const [drill, setDrill] = useState<string[]>();
  // A fresh order per visit. This was a constant, so every reload dealt the
  // identical shuffle and reopened the same puzzle — the site looked like it had
  // one position in it.
  const [seed, setSeed] = useState(() => (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
  const [cursor, setCursor] = useState(0);
  const [answer, setAnswer] = useState<GradedAnswer>();

  useEffect(() => {
    openSource().then(
      (opened) => {
        setSource(opened);
        opened.meta().then(setMeta, () => undefined);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, []);

  // Anything answered before signing in follows the solver to the server, once,
  // when a session appears. Without this, a history built up while signed out is
  // stranded in one browser and counts toward nothing.
  const { session: authSession } = useSession();
  useEffect(() => {
    if (!authSession) return;
    const pending = unsyncedAttempts(progress);
    if (!pending.length) return;
    let live = true;
    backfillAttempts(pending.map((a) => ({ puzzleId: a.puzzleId, actionId: a.actionId, at: a.at })))
      .then((accepted) => {
        if (!live || !accepted.length) return;
        setProgress((previous) => {
          const next = markSynced(previous, new Set(accepted));
          saveProgress(next);
          return next;
        });
      })
      .catch((cause) => console.warn('[attempts] back-fill failed:', cause));
    return () => { live = false; };
    // Runs on sign-in, not on every answer: `progress` is read but not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authSession]);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Fetch a session whenever the band changes or a fresh shuffle is asked for.
  // `seed` is not used to order anything any more — the sampler does that — but
  // changing it is still how "Shuffle" asks for a new draw.
  useEffect(() => {
    if (!source) return;
    let live = true;
    const selected = DIFFICULTY_BANDS.find((candidate) => candidate.id === band)!;
    const kinds = KINDS.find((candidate) => candidate.id === kindFilter)!.kinds;

    void (async () => {
      try {
        const [puzzles, count] = await Promise.all([
          source.session({
            size: SESSION_SIZE,
            minDifficulty: selected.min,
            maxDifficulty: selected.max,
            kinds: kinds ? [...kinds] : undefined,
            onlyIds: drill,
            // Answered puzzles go to the back rather than being dropped, so a
            // session never runs out.
            excludeIds: drill ? undefined : [...attemptedIds(progress)],
          }),
          drill
            ? Promise.resolve(drill.length)
            : source.count(selected.min, selected.max, kinds ? [...kinds] : undefined),
        ]);
        if (!live) return;
        setSession(puzzles);
        setTotal(count);
        setCursor(0);
        setAnswer(undefined);
        // Community difficulty is a bonus; never let it fail the session.
        source
          .stats(puzzles.map((puzzle) => puzzle.id))
          .then((found) => { if (live) setStats(found); })
          .catch(() => undefined);
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => { live = false; };
    // `progress` is read but deliberately not a dependency: refetching the moment
    // an answer lands would replace the puzzle still on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, band, kindFilter, seed, drill]);

  // A permalinked puzzle takes precedence over wherever the session sits, and
  // may not be in the sampled page at all, so it is fetched by id.
  useEffect(() => {
    if (!source || !route.puzzleId) {
      setLinked(undefined);
      return;
    }
    let live = true;
    source.byId(route.puzzleId).then(
      (found) => { if (live) setLinked(found); },
      () => { if (live) setLinked(undefined); },
    );
    return () => { live = false; };
  }, [source, route.puzzleId]);

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
      const at = Date.now();
      void recordRemoteAttempt({ puzzleId: current.id, actionId })
        .then((recorded) => {
          if (!recorded) return;
          setProgress((previous) => {
            const next = markSynced(previous, new Set([at]));
            saveProgress(next);
            return next;
          });
        })
        .catch((cause) => console.warn('[attempts] not recorded remotely:', cause));

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
            at,
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
    setCursor((previous) => {
      const next = previous + 1;
      if (next >= session.length) {
        // The page is spent. Ask for another rather than wrapping back to the
        // top, which would replay the same forty puzzles forever.
        setSeed((value) => value + 1);
        return 0;
      }
      return next;
    });
  }, [linked, session.length]);

  const startFreshSession = useCallback(() => {
    setAnswer(undefined);
    setCursor(0);
    setSeed((previous) => previous + 1);
  }, []);

  const onBandChange = useCallback((next: (typeof DIFFICULTY_BANDS)[number]['id']) => {
    setBand(next);
    setDrill(undefined);
    setAnswer(undefined);
    setCursor(0);
  }, []);

  const onKindChange = useCallback((next: (typeof KINDS)[number]['id']) => {
    setKindFilter(next);
    setDrill(undefined);
    setAnswer(undefined);
    setCursor(0);
  }, []);

  /**
   * Replay the puzzles answered wrong, hardest miss first.
   *
   * The most useful thing a solver can do with a history is work through what
   * they got wrong, and that data has been sitting in progress unused.
   */
  const reviewMistakes = useCallback(() => {
    const worst = new Map<string, number>();
    for (const attempt of progress.attempts) {
      if (attempt.grade === 'optimal') continue;
      // Keep each puzzle once, at its largest loss.
      worst.set(attempt.puzzleId, Math.max(worst.get(attempt.puzzleId) ?? 0, attempt.loss));
    }
    const ids = [...worst.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    if (!ids.length) return;
    setDrill(ids.slice(0, SESSION_SIZE));
    setAnswer(undefined);
    setCursor(0);
    window.location.hash = '#/train';
  }, [progress.attempts]);

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

        {!error && !source && <section className="panel">Loading puzzles…</section>}

        {source && route.view === 'train' && (
          <>
            <div className="sessionbar">
              <div className="sessionbar__group" role="group" aria-label="Decision kind">
                {KINDS.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className={`chip ${kindFilter === candidate.id && !drill ? 'chip--on' : ''}`}
                    onClick={() => onKindChange(candidate.id)}
                    aria-pressed={kindFilter === candidate.id && !drill}
                  >
                    {candidate.label}
                  </button>
                ))}
              </div>

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

            {drill && !linked && (
              <p className="permalink-note">
                Reviewing {drill.length} puzzle{drill.length === 1 ? '' : 's'} you missed, hardest
                first.{' '}
                <button type="button" className="linkbutton" onClick={() => setDrill(undefined)}>
                  Back to a normal session
                </button>
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
                total={linked ? 1 : total}
                stats={stats.get(current.id)}
              />
            ) : (
              <section className="panel">
                <h2>No puzzles in this band</h2>
                <p className="muted">Try a different difficulty.</p>
              </section>
            )}
          </>
        )}

        {source && route.view === 'progress' && (
          <ProgressPanel
            progress={progress}
            source={source}
            onReviewMistakes={reviewMistakes}
            onClear={() => setProgress(clearProgress())}
          />
        )}

        {meta && route.view === 'about' && <About meta={meta} />}
      </main>

      <footer className="footer">
        <span>Real hands from Tenhou's houou lobby, scored by the akochan engine.</span>
        <a href="https://github.com/charleslien/mahjong-puzzles">Source</a>
      </footer>
    </div>
  );
}
