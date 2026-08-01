import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  BRANCH_LABELS,
  branchesOf,
  consumedKey,
  consumedSets,
  isMultiStep,
  legalTiles,
  linesIn,
} from '../lib/decision';
import { difficultyWord } from '../lib/difficulty';
import type { GradedAnswer } from '../lib/grade';
import { replayKyoku, snapshotFromPosition, type Snapshot } from '../lib/replay';
import { positionTags } from '../lib/tags';
import type { Tile } from '../lib/tiles';
import type { PuzzleStats } from '../lib/supabase';
import type { ActionBranch, MeldKind, Puzzle } from '../types/puzzle';
import { DecisionSteps, type Step } from './DecisionSteps';
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

const MELD_KIND: Partial<Record<ActionBranch, MeldKind>> = {
  chi: 'chi',
  pon: 'pon',
  daiminkan: 'daiminkan',
};

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
  available,
  stats,
}: {
  puzzle: Puzzle;
  answer?: GradedAnswer;
  onAnswer: (actionId: string) => void;
  onNext: () => void;
  index: number;
  /** Puzzles in the current set. */
  total: number;
  /** Puzzles matching the filters overall, when that is a larger number. */
  available?: number;
  stats?: PuzzleStats;
}) {
  const frames = useFrames(puzzle);
  const decisionFrame = frames.length - 1;
  const [cursor, setCursor] = useState(decisionFrame);
  const [revealAll, setRevealAll] = useState(false);

  /**
   * How far into a multi-step decision the solver has got.
   *
   * A riichi or call puzzle is answered as a sequence — declare or not, then
   * which set if a call has several, then which tile — and this is the part of
   * that sequence already committed to. `undefined` means the first question is
   * still open. Discard puzzles never leave that state.
   */
  const [taken, setTaken] = useState<{ branch: ActionBranch; consumed?: Tile[] } | undefined>();

  // A new puzzle starts at its decision, with opponents concealed and no branch
  // carried over from the last one.
  useEffect(() => {
    setCursor(frames.length - 1);
    setRevealAll(false);
    setTaken(undefined);
  }, [frames]);

  const answered = answer !== undefined;
  const atDecision = cursor === decisionFrame;
  const hasHistory = frames.length > 1;

  const multiStep = isMultiStep(puzzle.actions);
  const branches = useMemo(() => branchesOf(puzzle.actions), [puzzle]);
  // Only asked when the call could eat more than one set — chi-ing with 2+3 or
  // with 3+5 are different hands afterwards, but there is nothing to ask when
  // there is one way to do it. Computed whether or not one is chosen, since the
  // row stays on screen with its answer marked.
  const sets = useMemo(
    () => (taken ? consumedSets(puzzle.actions, taken.branch) : []),
    [puzzle, taken],
  );

  /** The lines still reachable from where the solver has got to. */
  const openLines = useMemo(
    () => (taken ? linesIn(puzzle.actions, taken.branch, taken.consumed) : []),
    [puzzle, taken],
  );

  const needsSet = taken !== undefined && sets.length > 1 && taken.consumed === undefined;
  const pickingTile = multiStep && taken !== undefined && !needsSet;
  // Only while the question is open. Once answered the feedback table explains
  // the position, and leaving eleven of fourteen tiles dimmed underneath it —
  // some of them also carrying verdict stripes — says two things at once.
  const legal = useMemo(
    () =>
      !answered && taken && pickingTile
        ? legalTiles(puzzle.actions, taken.branch, taken.consumed)
        : undefined,
    [puzzle, taken, pickingTile, answered],
  );

  const accentFor = (tile: Tile): 'best' | 'good' | 'bad' | undefined => {
    if (!answered || !atDecision) return undefined;
    // A tile is coloured by the line the solver actually took it down, not by
    // whichever line happens to mention the tile first. With two ways to chi the
    // same tile, the same discard sits on two lines with different values, so
    // the consumed set has to match as well as the branch.
    const played = answer.action;
    const action = puzzle.actions.find(
      (candidate) =>
        candidate.tile === tile &&
        candidate.branch === played.branch &&
        consumedKey(candidate.consumed) === consumedKey(played.consumed),
    );
    if (!action) return undefined;
    if (action.id === answer.best.id) return 'best';
    if (action.accepted) return 'good';
    if (action.id === answer.action.id) return 'bad';
    return undefined;
  };

  const onTile = (tile: Tile): void => {
    if (answered || !atDecision) return;
    if (multiStep) {
      if (!pickingTile || !taken) return;
      const line = openLines.find((candidate) => candidate.tile === tile);
      if (line) onAnswer(line.id);
      return;
    }
    const action = puzzle.actions.find((candidate) => candidate.tile === tile);
    if (action) onAnswer(action.id);
  };

  /**
   * Commit to a fork, or change one already committed to.
   *
   * A branch whose single line throws nothing — letting a discard pass, or an
   * open kan, which is followed by a draw from the dead wall — is the whole
   * answer, so it settles the puzzle outright.
   *
   * A branch with one *legal discard* does not. It still shows the tile step
   * with that one tile live, because clicking a fork and having the puzzle
   * answer itself is a jump, and because seeing the hand narrow to a single
   * legal tile is the clearest statement the position makes.
   */
  const chooseBranch = useCallback(
    (branch: ActionBranch) => {
      // Re-picking the fork already taken would clear the set chosen under it
      // for no reason.
      if (taken?.branch === branch) return;
      const lines = linesIn(puzzle.actions, branch);
      if (lines.length === 1 && lines[0].tile === undefined) {
        onAnswer(lines[0].id);
        return;
      }
      const options = consumedSets(puzzle.actions, branch);
      setTaken({ branch, consumed: options.length === 1 ? options[0] : undefined });
    },
    [puzzle, taken, onAnswer],
  );

  const chooseSet = useCallback(
    (consumed: Tile[]) => {
      if (!taken) return;
      setTaken({ ...taken, consumed });
    },
    [taken],
  );

  const frame = frames[Math.min(cursor, frames.length - 1)];

  const stepBack = useCallback(() => setCursor((current) => Math.max(0, current - 1)), []);
  const stepForward = useCallback(
    () => setCursor((current) => Math.min(decisionFrame, current + 1)),
    [decisionFrame],
  );
  const toStart = useCallback(() => setCursor(0), []);
  const toDecision = useCallback(() => setCursor(decisionFrame), [decisionFrame]);

  /**
   * Take the numbered choice on the deepest step still open.
   *
   * Every step stays on screen, so the numbers address the one actually being
   * asked rather than all of them at once — numbering every visible option would
   * need a modifier to disambiguate, and the shortcut exists so a keyboard can
   * reach the buttons at all.
   */
  const chooseByNumber = useCallback(
    (index: number) => {
      if (answered || !atDecision || !multiStep) return;
      if (!taken) {
        const branch = branches[index];
        if (branch) chooseBranch(branch);
        return;
      }
      if (needsSet) {
        const set = sets[index];
        if (set) chooseSet(set);
      }
    },
    [answered, atDecision, multiStep, taken, needsSet, branches, sets, chooseBranch, chooseSet],
  );

  /**
   * Undo the last committed step. False when there was nothing to undo.
   *
   * Every step is re-selectable by clicking, so this is only the keyboard's way
   * of walking back out — a set first, then the call it belongs to.
   */
  const stepBackChoice = useCallback((): boolean => {
    if (!taken) return false;
    const several = consumedSets(puzzle.actions, taken.branch).length > 1;
    setTaken(taken.consumed && several ? { branch: taken.branch } : undefined);
    return true;
  }, [puzzle, taken]);

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
    stepBackChoice,
  });
  handlers.current = {
    stepBack,
    stepForward,
    toStart,
    toDecision,
    onNext,
    answered,
    chooseByNumber,
    stepBackChoice,
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
          event.preventDefault();
          current.toDecision();
          break;
        case 'Escape':
        case 'Backspace':
          // Undoes a committed step while a decision is part-answered, which is
          // the nearer thing to go back from; only once nothing is committed
          // does it mean "back to the decision".
          event.preventDefault();
          if (!current.stepBackChoice()) current.toDecision();
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

  // The steps belong on the table next to the hand they concern, not in a panel
  // underneath it.
  // Every step the solver has reached, each with its answer marked and each
  // still clickable — the chain stays on screen rather than being replaced by
  // the next question, so what has been committed to is readable and any part of
  // it can be revised in place.
  let choices: ReactNode;
  if (!answered && multiStep) {
    const steps: Step[] = [
      {
        key: 'branch',
        prompt: PROMPTS[puzzle.kind],
        options: branches.map((branch) => ({ id: branch, label: BRANCH_LABELS[branch] })),
        selected: taken?.branch,
        onPick: (id) => chooseBranch(id as ActionBranch),
      },
    ];
    if (taken && sets.length > 1) {
      steps.push({
        key: 'set',
        prompt: 'Which tiles do you call with?',
        options: sets.map((consumed) => ({ id: consumedKey(consumed), tiles: consumed })),
        selected: taken.consumed ? consumedKey(taken.consumed) : undefined,
        onPick: (id) => {
          const set = sets.find((consumed) => consumedKey(consumed) === id);
          if (set) chooseSet(set);
        },
      });
    }
    choices = (
      <DecisionSteps
        steps={steps}
        hint={
          pickingTile
            ? atDecision
              ? 'And which tile do you discard?'
              : 'Return to the decision to answer.'
            : undefined
        }
        disabled={!atDecision}
      />
    );
  }

  // The call in progress while the question is open, and the call that was
  // actually played once it is answered — so the feedback shows the meld the
  // solver made rather than leaving them to picture it.
  const calling = answered ? answer.action : taken;
  const pendingMeld =
    calling?.branch &&
    calling.consumed?.length &&
    MELD_KIND[calling.branch] &&
    puzzle.position.calledTile
      ? {
          kind: MELD_KIND[calling.branch] as MeldKind,
          called: puzzle.position.calledTile,
          consumed: calling.consumed,
          from: puzzle.position.calledFrom,
          settled: answered,
        }
      : undefined;

  return (
    <article className="puzzle">
      <header className="puzzle__head">
        <div className="puzzle__meta">
          {/* Position in this set, not in the bank. Sampling means a session
              holds forty puzzles drawn from hundreds, so counting against the
              bank total showed "1 of 740" over and over while the number you
              were actually moving through stayed hidden. */}
          <span
            className="puzzle__counter"
            title={
              available && available > total
                ? `${available.toLocaleString()} puzzles match your filters`
                : undefined
            }
          >
            {index + 1} <span className="muted">of {total}</span>
          </span>
          {/* Tags carry the theme; the raw record id does not mean anything to a
              solver, so it survives only as the permalink it is useful for.

              Only the ones describing the position. `efficiency-trap` says the
              obvious efficient discard is *not* the answer — and its absence
              says it is, which held in 815 of 815 discard puzzles that lack it.
              Those wait for the feedback panel. */}
          {positionTags(puzzle.tags)
            .slice(0, 3)
            .map((tag) => (
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
        interactive={!answered && atDecision && (!multiStep || pickingTile)}
        onSelect={onTile}
        accentFor={accentFor}
        selectable={legal ? (tile) => legal.has(tile) : undefined}
        pendingMeld={pendingMeld}
        offerFrom={atDecision ? puzzle.position.calledFrom : undefined}
        overlay={choices}
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
      {!answered && !multiStep && (
        <section className="ask">
          <h2 className="ask__prompt">{PROMPTS[puzzle.kind]}</h2>
          <p className="ask__hint">
            {atDecision ? 'Pick a tile from your hand.' : 'Return to the decision to answer.'}
          </p>
        </section>
      )}

      {answer && <Feedback puzzle={puzzle} answer={answer} stats={stats} onNext={onNext} />}
    </article>
  );
}
