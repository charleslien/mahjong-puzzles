import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { GradedAnswer } from '../lib/grade';
import { replayKyoku, snapshotFromPosition, type Snapshot } from '../lib/replay';
import type { Tile } from '../lib/tiles';
import type { PuzzleStats } from '../lib/supabase';
import type { Puzzle } from '../types/puzzle';
import { Feedback } from './Feedback';
import { GameBoard } from './GameBoard';

const PROMPTS: Record<Puzzle['kind'], string> = {
  discard: 'Which tile do you discard?',
  // Not "or stay concealed?": the alternative is sometimes backing off the hand
  // entirely, and each option says for itself what it does.
  riichi: 'Do you declare riichi?',
  call: 'Do you call, or let it pass?',
  push_fold: 'Push, or fold?',
  kan: 'Do you call kan?',
  placement: 'What does the placement situation demand?',
};

/** The difficulty bands the session filter offers, so the two agree. */
function difficultyWord(difficulty: number): string {
  if (difficulty <= 40) return 'Easy';
  if (difficulty <= 65) return 'Medium';
  return 'Hard';
}

/**
 * Frames for the hand this puzzle came from, ending at the decision.
 *
 * Puzzles without history fall back to a single frame built from the stored
 * position — which also has to assume the dealer, since a bare position does not
 * record it. Replayed history knows the real dealer, so seat winds are right.
 */
function useFrames(puzzle: Puzzle): Snapshot[] {
  return useMemo(() => {
    if (puzzle.history?.length) {
      const frames = replayKyoku(puzzle.history);
      if (frames.length > 0) return frames;
    }
    return [snapshotFromPosition(puzzle.position)];
  }, [puzzle]);
}

export function PuzzleView({
  puzzle,
  answer,
  onAnswer,
  onNext,
  index,
  total,
  stats,
}: {
  puzzle: Puzzle;
  answer?: GradedAnswer;
  onAnswer: (actionId: string) => void;
  onNext: () => void;
  index: number;
  total: number;
  stats?: PuzzleStats;
}) {
  const frames = useFrames(puzzle);
  const decisionFrame = frames.length - 1;
  const [cursor, setCursor] = useState(decisionFrame);
  const [revealAll, setRevealAll] = useState(false);

  // A new puzzle starts at its decision, with opponents concealed again.
  useEffect(() => {
    setCursor(frames.length - 1);
    setRevealAll(false);
  }, [frames]);

  const answered = answer !== undefined;
  const atDecision = cursor === decisionFrame;
  const hasHistory = frames.length > 1;

  const accentFor = (tile: Tile): 'best' | 'good' | 'bad' | undefined => {
    if (!answered || !atDecision) return undefined;
    const action = puzzle.actions.find((candidate) => candidate.tile === tile);
    if (!action) return undefined;
    if (action.id === answer.best.id) return 'best';
    if (action.accepted) return 'good';
    if (action.id === answer.action.id) return 'bad';
    return undefined;
  };

  const onTile = (tile: Tile): void => {
    if (answered || !atDecision || puzzle.kind !== 'discard') return;
    const action = puzzle.actions.find((candidate) => candidate.tile === tile);
    if (action) onAnswer(action.id);
  };

  const frame = frames[Math.min(cursor, frames.length - 1)];

  const stepBack = useCallback(() => setCursor((current) => Math.max(0, current - 1)), []);
  const stepForward = useCallback(
    () => setCursor((current) => Math.min(decisionFrame, current + 1)),
    [decisionFrame],
  );
  const toStart = useCallback(() => setCursor(0), []);
  const toDecision = useCallback(() => setCursor(decisionFrame), [decisionFrame]);

  /**
   * Answer a non-discard puzzle by number.
   *
   * Discards are answered by clicking a tile, but riichi and call puzzles are
   * buttons and were mouse-only — the one part of the interface a keyboard could
   * not reach.
   */
  const chooseByNumber = useCallback(
    (index: number) => {
      if (answered || !atDecision || puzzle.kind === 'discard') return;
      const action = puzzle.actions[index];
      if (action) onAnswer(action.id);
    },
    [answered, atDecision, puzzle, onAnswer],
  );

  // Held in a ref so the listener can stay mounted once rather than rebinding on
  // every cursor change.
  const handlers = useRef({
    stepBack,
    stepForward,
    toStart,
    toDecision,
    onNext,
    answered,
    chooseByNumber,
  });
  handlers.current = {
    stepBack,
    stepForward,
    toStart,
    toDecision,
    onNext,
    answered,
    chooseByNumber,
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      // Text and range inputs own their keys entirely — the scrubber uses arrows.
      if (tag && ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
      // A focused button only owns the keys that would activate it. Bailing on
      // every key while a button had focus meant that clicking any control —
      // a filter chip, Shuffle — silently disabled every shortcut until you
      // clicked elsewhere.
      if (tag === 'BUTTON' && (event.key === 'Enter' || event.key === ' ')) return;

      const current = handlers.current;
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          current.stepBack();
          break;
        case 'ArrowRight':
          event.preventDefault();
          current.stepForward();
          break;
        case 'Home':
          event.preventDefault();
          current.toStart();
          break;
        case 'End':
        case 'Escape':
          event.preventDefault();
          current.toDecision();
          break;
        case 'Enter':
        case ' ':
          // Only advances once the puzzle is answered, so a stray press cannot
          // skip a puzzle unsolved.
          if (current.answered) {
            event.preventDefault();
            current.onNext();
          }
          break;
        default:
          // 1-9 pick an option on puzzles that are answered by button.
          if (/^[1-9]$/.test(event.key)) {
            event.preventDefault();
            current.chooseByNumber(Number(event.key) - 1);
          }
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <article className="puzzle">
      <header className="puzzle__head">
        <div className="puzzle__meta">
          <span className="puzzle__counter">
            {index + 1} <span className="muted">of {total}</span>
          </span>
          {/* Tags carry the theme; the raw record id does not mean anything to a
              solver, so it survives only as the permalink it is useful for. */}
          {puzzle.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="tag">
              {tag.replace(/-/g, ' ')}
            </span>
          ))}
        </div>
        <div className="puzzle__meta">
          <span className="puzzle__difficulty" title={`Difficulty ${puzzle.difficulty} of 100`}>
            {difficultyWord(puzzle.difficulty)}
          </span>
          <a className="puzzle__link" href={`#/p/${puzzle.id}`} title="Link to this puzzle">
            link
          </a>
        </div>
      </header>

      <GameBoard
        snapshot={frame}
        viewer={puzzle.position.seat}
        // Opponents stay concealed until the puzzle is answered; revealing them
        // beforehand would hand over the information the puzzle is about.
        revealAll={answered && revealAll}
        interactive={!answered && atDecision && puzzle.kind === 'discard'}
        onSelect={onTile}
        accentFor={accentFor}
      />

      {hasHistory && (
        <div className="scrub">
          {/* One strip rather than a titled card with prose, a slider, a keyboard
              legend and a checkbox. Stepping back through a hand is a side
              errand; it should not outweigh the question being asked. */}
          <div className="scrub__controls">
            <button
              type="button"
              className="iconbutton"
              onClick={toStart}
              disabled={cursor === 0}
              title="Jump to the start of the hand (Home)"
              aria-label="Start of hand"
            >
              ⏮
            </button>
            <button
              type="button"
              className="iconbutton"
              onClick={stepBack}
              disabled={cursor === 0}
              title="Step back (left arrow)"
              aria-label="Step back"
            >
              ◀
            </button>
            <button
              type="button"
              className="iconbutton"
              onClick={stepForward}
              disabled={atDecision}
              title="Step forward (right arrow)"
              aria-label="Step forward"
            >
              ▶
            </button>
          </div>

          <input
            className="scrub__range"
            type="range"
            min={0}
            max={decisionFrame}
            value={cursor}
            onChange={(event) => setCursor(Number(event.target.value))}
            aria-label="Position in the hand"
          />

          {/* Reserved width, so counting up from "1 of 41" to "41 of 41" cannot
              nudge the controls sideways. */}
          <span className="scrub__count">
            {cursor + 1}/{frames.length}
          </span>

          {/* One fixed label. Swapping the text between "At the decision" and
              "Back to the decision" changed the button's width mid-hand, and in a
              centred flex row a width change can tip the row into wrapping and
              move every control down with it. */}
          <button
            type="button"
            className={`button button--small ${atDecision ? '' : 'button--primary'}`}
            onClick={toDecision}
            disabled={atDecision}
            title="Escape"
          >
            Back to the decision
          </button>

          {answered && (
            <label className="scrub__reveal">
              <input
                type="checkbox"
                checked={revealAll}
                onChange={(event) => setRevealAll(event.target.checked)}
              />
              <span>All hands</span>
            </label>
          )}
        </div>
      )}

      {/* Only while the question is still open. Once answered, the feedback panel
          says everything this did, and leaving it up just pushed the answer
          further down the page. */}
      {!answered && (
        <section className="ask">
          <h2 className="ask__prompt">{PROMPTS[puzzle.kind]}</h2>

          {puzzle.kind === 'discard' ? (
            <p className="ask__hint">
              {atDecision ? 'Pick a tile from your hand.' : 'Return to the decision to answer.'}
            </p>
          ) : (
            <div className="ask__actions">
              {puzzle.actions.map((action, index) => (
                <button
                  key={action.id}
                  type="button"
                  className="button button--choice"
                  onClick={() => onAnswer(action.id)}
                  disabled={!atDecision}
                >
                  <kbd className="choice__key">{index + 1}</kbd>
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {answer && <Feedback puzzle={puzzle} answer={answer} stats={stats} onNext={onNext} />}
    </article>
  );
}
