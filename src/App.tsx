import { useCallback, useEffect, useState } from 'react';

import { About } from './components/About';
import { AccountButton } from './components/AccountButton';
import { ProgressPanel } from './components/ProgressPanel';
import { PuzzleView } from './components/PuzzleView';
import { SetSummary } from './components/SetSummary';
import { DIFFICULTY_BANDS, type DifficultyBand } from './lib/difficulty';
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
  /**
   * A theme the session is drawn from.
   *
   * In the route rather than in component state so that a drill survives a
   * reload and can be bookmarked or shared. Held in state it vanished on
   * refresh, silently, which is a confusing thing for a mode to do.
   */
  theme?: string;
}

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('p/')) return { view: 'train', puzzleId: hash.slice(2) };
  if (hash.startsWith('t/')) return { view: 'train', theme: decodeURIComponent(hash.slice(2)) };
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

/**
 * How many puzzles a set holds.
 *
 * Small enough to finish in a sitting. The stream used to be endless, which
 * meant there was never a moment that said how you had done — you either kept
 * going or closed the tab. A set that ends gives the session a shape and a
 * result.
 */
const SESSION_SIZE = 20;

export default function App() {
  const [source, setSource] = useState<PuzzleSource>();
  const [meta, setMeta] = useState<BankMeta>();
  const [session, setSession] = useState<Puzzle[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Map<string, PuzzleStats>>(new Map());
  const [linked, setLinked] = useState<Puzzle>();
  /**
   * A permalink that names no puzzle.
   *
   * Without this the session's own puzzle showed instead, so a dead link looked
   * like a working one pointing somewhere else — which is exactly what a link
   * shared before a regeneration used to do.
   */
  const [linkMissing, setLinkMissing] = useState(false);
  const [error, setError] = useState<string>();
  const [route, setRoute] = useState<Route>(() => parseHash());
  const [progress, setProgress] = useState<Progress>(() => loadProgress());

  const [band, setBand] = useState<DifficultyBand['id']>('all');
  const [kindFilter, setKindFilter] = useState<(typeof KINDS)[number]['id']>('all');
  // When set, the session replays exactly these puzzles instead of sampling.
  const [drill, setDrill] = useState<string[]>();
  /**
   * A theme the session is narrowed to, chosen from the progress breakdown.
   *
   * Deliberately not a row of chips beside the kind filter: there are eleven
   * themes and no reason to browse them, but a strong reason to practise the one
   * your own history says is costing you points. It lives in the route, so
   * `#/t/endgame` is a bookmarkable drill.
   */
  const theme = route.theme;
  // A fresh order per visit. This was a constant, so every reload dealt the
  // identical shuffle and reopened the same puzzle — the site looked like it had
  // one position in it.
  const [seed, setSeed] = useState(() => (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
  const [cursor, setCursor] = useState(0);
  const [answer, setAnswer] = useState<GradedAnswer>();
  /** Grades from the current set, for the summary at the end of it. */
  const [setResults, setSetResults] = useState<GradedAnswer[]>([]);
  const [setDone, setSetDone] = useState(false);

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
    const tags = theme ? [theme] : undefined;

    void (async () => {
      try {
        const [puzzles, count] = await Promise.all([
          source.session({
            size: SESSION_SIZE,
            minDifficulty: selected.min,
            maxDifficulty: selected.max,
            kinds: kinds ? [...kinds] : undefined,
            tags,
            onlyIds: drill,
            // Answered puzzles go to the back rather than being dropped, so a
            // session never runs out.
            excludeIds: drill ? undefined : [...attemptedIds(progress)],
          }),
          drill
            ? Promise.resolve(drill.length)
            : source.count(selected.min, selected.max, kinds ? [...kinds] : undefined, tags),
        ]);
        if (!live) return;
        setSession(puzzles);
        setTotal(count);
        setCursor(0);
        setAnswer(undefined);
        setSetResults([]);
        setSetDone(false);
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
  }, [source, band, kindFilter, theme, seed, drill]);

  // A permalinked puzzle takes precedence over wherever the session sits, and
  // may not be in the sampled page at all, so it is fetched by id.
  useEffect(() => {
    // Whichever way this effect goes, the puzzle on screen is about to change,
    // and an answer belongs to the puzzle it was given for. Going from one
    // permalink straight to another is a hash change and not a reload, so the
    // previous grade stayed up: the new position opened already answered, with
    // the old hand's verdict over the new hand's options.
    setAnswer(undefined);
    if (!source || !route.puzzleId) {
      setLinked(undefined);
      setLinkMissing(false);
      return;
    }
    let live = true;
    source.byId(route.puzzleId).then(
      (found) => {
        if (!live) return;
        setLinked(found);
        setLinkMissing(found === undefined);
      },
      () => {
        if (!live) return;
        setLinked(undefined);
        setLinkMissing(true);
      },
    );
    return () => { live = false; };
  }, [source, route.puzzleId]);

  const current = linked ?? session[cursor];

  const onAnswer = useCallback(
    (actionId: string) => {
      if (!current || answer) return;
      const graded = gradeAnswer(current, actionId);
      setAnswer(graded);
      if (!linked) setSetResults((previous) => [...previous, graded]);

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
    [current, answer, linked],
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
        // End of the set: stop and say how it went rather than sliding straight
        // into the next twenty.
        setSetDone(true);
        return previous;
      }
      return next;
    });
  }, [linked, session.length]);

  const nextSet = useCallback(() => {
    setSetDone(false);
    setAnswer(undefined);
    setCursor(0);
    setSeed((value) => value + 1);
  }, []);

  const startFreshSession = useCallback(() => {
    setAnswer(undefined);
    setCursor(0);
    setSeed((previous) => previous + 1);
  }, []);

  const onBandChange = useCallback((next: DifficultyBand['id']) => {
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
   * Practise one theme, drawn from the whole bank rather than from your history.
   *
   * The kind filter is cleared with it: "endgame" and "Riichi" together can
   * genuinely match nothing, and an empty board is a worse answer to "drill
   * this" than a wider session is.
   */
  const drillTheme = useCallback((tag: string) => {
    setKindFilter('all');
    setDrill(undefined);
    setAnswer(undefined);
    setCursor(0);
    window.location.hash = `#/t/${encodeURIComponent(tag)}`;
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

            {linkMissing && (
              <p className="permalink-note">
                That link does not point at a puzzle in the current bank — it may have been
                retired. <a href="#/train">Return to the session</a>
              </p>
            )}

            {theme && !drill && !linked && (
              <p className="permalink-note">
                Drilling <strong>{theme.replace(/-/g, ' ')}</strong> positions, drawn from the whole
                bank. <a href="#/train">Back to a normal session</a>
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

            {setDone ? (
              <SetSummary
                results={setResults}
                onNext={nextSet}
                onReviewMisses={
                  setResults.some((result) => !result.correct) ? reviewMistakes : undefined
                }
              />
            ) : current ? (
              <PuzzleView
                key={current.id}
                puzzle={current}
                answer={answer}
                onAnswer={onAnswer}
                onNext={onNext}
                index={linked ? 0 : cursor}
                total={linked ? 1 : session.length}
                available={linked ? undefined : total}
                stats={stats.get(current.id)}
              />
            ) : (
              <section className="panel">
                {/* Named, because the filters combine: a theme and a kind can
                    each hold hundreds of puzzles and share none, and "try a
                    different difficulty" then points at the wrong control. */}
                <h2>Nothing matches these filters</h2>
                <p className="muted">
                  No {theme ? `${theme.replace(/-/g, ' ')} ` : ''}
                  {kindFilter === 'all' ? 'positions' : `${kindFilter} positions`}
                  {band === 'all' ? '' : ` in the ${band} band`}. Widen one of them.
                </p>
              </section>
            )}
          </>
        )}

        {source && route.view === 'progress' && (
          <ProgressPanel
            progress={progress}
            source={source}
            onReviewMistakes={reviewMistakes}
            onDrillTheme={drillTheme}
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
