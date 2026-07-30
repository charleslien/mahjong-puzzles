/**
 * The puzzle bank schema — the contract between the offline generation pipeline
 * and this site.
 *
 * Design notes that matter for anyone extending this:
 *
 * - Evaluations are baked in. The site ships precomputed per-action numbers and
 *   never runs a model, so no network weights are distributed to the browser.
 *   That is deliberate: shipped weights are trivially extractable and would
 *   recreate exactly the cheating risk that keeps Mortal's weights private.
 *
 * - There is no single correct answer. Mahjong is imperfect-information, so the
 *   schema carries an *accept set* of actions within epsilon of the best rather
 *   than one winning move.
 *
 * - EV is in placement points, the same unit mjai-reviewer reports, so a loss
 *   figure is directly interpretable as "this cost me N placement points".
 */

import type { Tile } from '../lib/tiles';
import type { MjaiEvent } from '../lib/replay';

export const SCHEMA_VERSION = 1;

/** Seat index in dealer-relative order: 0 = East, 1 = South, 2 = West, 3 = North. */
export type Seat = 0 | 1 | 2 | 3;

export type RoundWind = 'E' | 'S' | 'W' | 'N';

export type MeldKind = 'chi' | 'pon' | 'daiminkan' | 'shouminkan' | 'ankan';

export interface Meld {
  kind: MeldKind;
  tiles: Tile[];
  /** Seat the called tile came from; absent for a concealed kan. */
  from?: Seat;
}

/** What kind of decision the solver is being asked to make. */
export type DecisionKind =
  | 'discard'
  | 'riichi'
  | 'call'
  | 'push_fold'
  | 'kan'
  | 'placement';

export interface Position {
  /** Seat of the player to act. */
  seat: Seat;
  round: {
    wind: RoundWind;
    /** 1-indexed hand number within the round wind. */
    kyoku: number;
    honba: number;
    riichiSticks: number;
  };
  /** Point totals in seat order. */
  scores: [number, number, number, number];
  doraIndicators: Tile[];
  /** Concealed tiles, including the just-drawn tile when there is one. */
  hand: Tile[];
  /** The tile just drawn, if this is a post-draw decision. */
  drawnTile?: Tile;
  /** The tile just discarded by an opponent, for call decisions. */
  calledTile?: Tile;
  /** Seat that discarded `calledTile`. */
  calledFrom?: Seat;
  /** The acting player's own called melds. */
  melds: Meld[];
  /** Discard piles for all four seats, in seat order, oldest first. */
  rivers: Tile[][];
  /** Melds called by each seat, in seat order. */
  opponentMelds: [Meld[], Meld[], Meld[], Meld[]];
  /** Whether each seat has declared riichi. */
  riichi: [boolean, boolean, boolean, boolean];
  /** Live wall count remaining. */
  tilesLeft: number;
}

export interface PuzzleAction {
  /**
   * Stable action identifier. Discards are `discard:<tile>`; other decisions use
   * bare verbs (`riichi`, `damaten`, `pass`, `pon`, `chi:<tiles>`, `kan`).
   */
  id: string;
  label: string;
  /** Present for discard actions, so the UI can bind it to a tile in the hand. */
  tile?: Tile;
  /** Expected final placement points for this action. */
  ev: number;
  /**
   * Shortfall against the best action; always >= 0. This is the scalar used for
   * grading and ranking.
   *
   * Careful: for `ukeire_tiles` puzzles this is a *composite* — an action that
   * worsens shanten carries a large fixed penalty on top of any acceptance gap,
   * so the raw number is not a tile count. Never render it as one. Use
   * `describeLoss` in lib/grade, which reads `shantenAfter` and reports the
   * shanten consequence instead.
   */
  loss: number;
  /** Resulting shanten, when the evaluator computed it. */
  shantenAfter?: number;
  /** Resulting tiles of acceptance, when the evaluator computed it. */
  ukeire?: number;
  /** Imitation-policy probability that houou-level play picks this, 0..1. */
  policy?: number;
  /** Within epsilon of the best action, and therefore graded as correct. */
  accepted: boolean;
}

/**
 * The unit that `ev` and `loss` are denominated in.
 *
 * - `placement_pt`: expected final placement points, produced by the AI
 *   evaluators. This is the unit mjai-reviewer reports and the one the real
 *   pipeline emits.
 * - `ukeire_tiles`: tiles of acceptance given up, computed directly from the
 *   shanten/ukeire library. Pure tile-efficiency drills, with no notion of
 *   score, safety or table position.
 *
 * Keeping these distinct matters: an efficiency drill must not masquerade as an
 * AI evaluation, because the two disagree precisely where the game is
 * interesting.
 */
export type EvalUnit = 'placement_pt' | 'ukeire_tiles';

/** Provenance and verification metadata, kept per puzzle for auditability. */
export interface PuzzleEvaluation {
  /** Identifiers of every evaluator that scored this position. */
  evaluators: string[];
  /** EV gap between the best action and the best non-accepted action. */
  margin: number;
  /** Whether all evaluators ranked the same action first. */
  agreement: boolean;
  /** Actions within this many units of the best are accepted. */
  epsilon: number;
  unit: EvalUnit;
}

export interface PuzzleSource {
  /** Dataset the position was mined from. */
  dataset: string;
  /** Opaque game identifier within the dataset. */
  gameId?: string;
  /** Decision index within the game, for reproducibility. */
  decisionIndex?: number;
  /** Set when the position was authored by hand rather than mined. */
  authored?: boolean;
}

export interface Puzzle {
  id: string;
  schemaVersion: typeof SCHEMA_VERSION;
  kind: DecisionKind;
  position: Position;
  actions: PuzzleAction[];
  /** Action ids that count as correct. Never empty. */
  acceptedActionIds: string[];
  /** Shanten reached by the best action, when the evaluator computed it. */
  bestShanten?: number;
  /** Themes for filtering, e.g. "push-fold", "efficiency-trap", "all-last". */
  tags: string[];
  /**
   * Difficulty proxy from 0 (easy) to 100 (hard), derived offline from policy
   * entropy, EV margin, and whether a naive efficiency baseline fails. This is a
   * model-derived stand-in for the Glicko-2 rating a server-backed build would
   * learn from real solve attempts.
   */
  difficulty: number;
  evaluation: PuzzleEvaluation;
  source: PuzzleSource;
  /**
   * The mjai events for this hand up to (and excluding) the decision, so the
   * trainer can step back through how the position arose.
   *
   * Known limitation: real logs reveal every seat's tiles, so the events here
   * contain opponents' hands. The board never renders them before the answer is
   * given, but a determined reader could pull them out of the JSON. Redacting
   * them properly means rewriting draws and deals to placeholders, which the
   * replay engine would then have to track — worth doing, not done yet.
   */
  history?: MjaiEvent[];
  /** Prose shown after answering. */
  explanation?: string;
}

/** One shard of the bank, as served from /puzzles/<file>. */
export interface PuzzleShard {
  schemaVersion: typeof SCHEMA_VERSION;
  puzzles: Puzzle[];
}

/** The bank manifest, served from /puzzles/index.json. */
export interface PuzzleIndex {
  schemaVersion: typeof SCHEMA_VERSION;
  generatedAt: string;
  /** Human-readable description of how this bank was produced. */
  provenance: string;
  count: number;
  shards: Array<{
    file: string;
    count: number;
    kinds: DecisionKind[];
  }>;
}
