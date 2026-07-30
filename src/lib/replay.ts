/**
 * mjai replay engine.
 *
 * Turns a stream of mjai events into a list of snapshots, one per event, so the
 * UI can step forward and backward through a hand. Snapshots are materialised
 * eagerly and stored whole rather than reconstructed by replaying from the start
 * on every seek — a kyoku is at most a couple of hundred events, so the memory
 * cost is trivial and stepping stays instant.
 *
 * This mirrors the state tracking in pipeline/extract.py. The two are kept
 * deliberately parallel: that one produces training positions, this one produces
 * viewable frames, and both have to agree about what a position *is*.
 */

import { canonicalize, type Tile } from './tiles';
import type { Meld, MeldKind, RoundWind, Seat } from '../types/puzzle';

export type MjaiEvent =
  | { type: 'start_game'; names?: string[] }
  | {
      type: 'start_kyoku';
      bakaze: RoundWind;
      kyoku: number;
      honba: number;
      kyotaku: number;
      oya: Seat;
      dora_marker: Tile;
      tehais: Tile[][];
      scores?: number[];
    }
  | { type: 'tsumo'; actor: Seat; pai: Tile }
  | { type: 'dahai'; actor: Seat; pai: Tile; tsumogiri?: boolean }
  | { type: 'chi' | 'pon' | 'daiminkan'; actor: Seat; target: Seat; pai: Tile; consumed: Tile[] }
  | { type: 'kakan'; actor: Seat; pai: Tile; consumed: Tile[] }
  | { type: 'ankan'; actor: Seat; consumed: Tile[] }
  | { type: 'reach' | 'reach_accepted'; actor: Seat }
  | { type: 'dora'; dora_marker: Tile }
  | { type: 'hora'; actor: Seat; target: Seat; deltas?: number[]; scores?: number[] }
  | { type: 'ryukyoku'; deltas?: number[]; scores?: number[] }
  | { type: 'end_kyoku' }
  | { type: 'end_game' };

/** A discard as it sits in the river, carrying how it got there. */
export interface RiverTile {
  tile: Tile;
  /** Discarded immediately after drawing it. */
  tsumogiri: boolean;
  /** Discarded on the turn riichi was declared. */
  riichi: boolean;
  /** Claimed by another player, so no longer physically in the river. */
  called: boolean;
}

export interface SeatState {
  hand: Tile[];
  melds: Meld[];
  river: RiverTile[];
  riichi: boolean;
  score: number;
  /** Tile just drawn and not yet discarded. */
  drawn?: Tile;
  /**
   * Set when the hand contents are genuinely unknown rather than merely hidden
   * from the viewer — puzzle positions record only the acting player's tiles.
   * The board draws this many face-down tiles and never reveals them, so a
   * "reveal all" toggle cannot expose data that does not exist.
   */
  unknownCount?: number;
}

export interface Snapshot {
  /** Index of the event that produced this snapshot. */
  eventIndex: number;
  /** One-line description of what just happened, for the move list. */
  description: string;
  /** Seat that acted, when the event had an actor. */
  actor?: Seat;
  round: { wind: RoundWind; kyoku: number; honba: number; riichiSticks: number };
  oya: Seat;
  doraIndicators: Tile[];
  seats: [SeatState, SeatState, SeatState, SeatState];
  tilesLeft: number;
  /** Set once the hand has ended. */
  result?: { kind: 'hora' | 'ryukyoku'; winner?: Seat; deltas?: number[] };
}

const LIVE_WALL_AT_START = 70;
const HAND_SIZE = 13;
const SEAT_WINDS = ['E', 'S', 'W', 'N'] as const;

function emptySeat(score: number): SeatState {
  return { hand: [], melds: [], river: [], riichi: false, score };
}

function cloneSeat(seat: SeatState): SeatState {
  return {
    hand: [...seat.hand],
    melds: seat.melds.map((meld) => ({ ...meld, tiles: [...meld.tiles] })),
    river: seat.river.map((entry) => ({ ...entry })),
    riichi: seat.riichi,
    score: seat.score,
    drawn: seat.drawn,
    unknownCount: seat.unknownCount,
  };
}

function seatLabel(seat: Seat, oya: Seat): string {
  return SEAT_WINDS[(seat - oya + 4) % 4];
}

/**
 * Replay a kyoku. Events before the first `start_kyoku` are ignored, and the
 * replay stops at `end_kyoku`, so a whole-hanchan log can be sliced per hand.
 */
export function replayKyoku(events: MjaiEvent[]): Snapshot[] {
  let scores = [25000, 25000, 25000, 25000];
  let seats: [SeatState, SeatState, SeatState, SeatState] = [
    emptySeat(25000),
    emptySeat(25000),
    emptySeat(25000),
    emptySeat(25000),
  ];
  let round = { wind: 'E' as RoundWind, kyoku: 1, honba: 0, riichiSticks: 0 };
  let oya: Seat = 0;
  let doraIndicators: Tile[] = [];
  let tilesLeft = LIVE_WALL_AT_START;
  let result: Snapshot['result'];
  // Riichi is declared before the discard it applies to, so the flag has to
  // survive until that discard lands in the river.
  let pendingRiichi: Seat | undefined;
  let started = false;

  const snapshots: Snapshot[] = [];

  const push = (eventIndex: number, description: string, actor?: Seat): void => {
    snapshots.push({
      eventIndex,
      description,
      actor,
      round: { ...round },
      oya,
      doraIndicators: [...doraIndicators],
      seats: [cloneSeat(seats[0]), cloneSeat(seats[1]), cloneSeat(seats[2]), cloneSeat(seats[3])],
      tilesLeft,
      result: result ? { ...result } : undefined,
    });
  };

  const removeFromHand = (seat: Seat, tile: Tile): void => {
    const hand = seats[seat].hand;
    const index = hand.indexOf(tile);
    if (index >= 0) hand.splice(index, 1);
  };

  events.forEach((event, eventIndex) => {
    switch (event.type) {
      case 'start_kyoku': {
        started = true;
        round = {
          wind: event.bakaze,
          kyoku: event.kyoku,
          honba: event.honba,
          riichiSticks: event.kyotaku,
        };
        oya = event.oya;
        doraIndicators = [canonicalize(event.dora_marker)];
        tilesLeft = LIVE_WALL_AT_START;
        result = undefined;
        pendingRiichi = undefined;
        if (event.scores && event.scores.length === 4) scores = [...event.scores];
        seats = [
          emptySeat(scores[0]),
          emptySeat(scores[1]),
          emptySeat(scores[2]),
          emptySeat(scores[3]),
        ];
        event.tehais.forEach((hand, seat) => {
          seats[seat].hand = hand.map(canonicalize);
        });
        push(eventIndex, `${round.wind}${round.kyoku} — deal`);
        break;
      }

      case 'tsumo': {
        if (!started) break;
        tilesLeft = Math.max(0, tilesLeft - 1);
        seats[event.actor].hand.push(canonicalize(event.pai));
        seats[event.actor].drawn = canonicalize(event.pai);
        push(eventIndex, `${seatLabel(event.actor, oya)} draws`, event.actor);
        break;
      }

      case 'dahai': {
        if (!started) break;
        const tile = canonicalize(event.pai);
        removeFromHand(event.actor, tile);
        seats[event.actor].river.push({
          tile,
          tsumogiri: Boolean(event.tsumogiri),
          riichi: pendingRiichi === event.actor,
          called: false,
        });
        if (pendingRiichi === event.actor) pendingRiichi = undefined;
        seats[event.actor].drawn = undefined;
        push(
          eventIndex,
          `${seatLabel(event.actor, oya)} discards ${tile}`,
          event.actor,
        );
        break;
      }

      case 'chi':
      case 'pon':
      case 'daiminkan': {
        if (!started) break;
        const called = canonicalize(event.pai);
        const consumed = event.consumed.map(canonicalize);
        for (const tile of consumed) removeFromHand(event.actor, tile);

        // The claimed tile leaves the discarder's river; it is kept in the list
        // marked `called` so the river still reads chronologically.
        const targetRiver = seats[event.target].river;
        for (let i = targetRiver.length - 1; i >= 0; i--) {
          if (targetRiver[i].tile === called && !targetRiver[i].called) {
            targetRiver[i].called = true;
            break;
          }
        }

        const kind: MeldKind = event.type === 'daiminkan' ? 'daiminkan' : event.type;
        seats[event.actor].melds.push({
          kind,
          tiles: [...consumed, called],
          from: event.target,
        });
        seats[event.actor].drawn = undefined;
        push(
          eventIndex,
          `${seatLabel(event.actor, oya)} calls ${event.type} on ${called}`,
          event.actor,
        );
        break;
      }

      case 'kakan': {
        if (!started) break;
        const added = canonicalize(event.pai);
        removeFromHand(event.actor, added);
        const meld = seats[event.actor].melds.find(
          (candidate) => candidate.kind === 'pon' && candidate.tiles.includes(added),
        );
        if (meld) {
          meld.kind = 'shouminkan';
          meld.tiles = [...meld.tiles, added];
        }
        push(eventIndex, `${seatLabel(event.actor, oya)} adds to kan`, event.actor);
        break;
      }

      case 'ankan': {
        if (!started) break;
        const consumed = event.consumed.map(canonicalize);
        for (const tile of consumed) removeFromHand(event.actor, tile);
        seats[event.actor].melds.push({ kind: 'ankan', tiles: consumed });
        seats[event.actor].drawn = undefined;
        push(eventIndex, `${seatLabel(event.actor, oya)} calls closed kan`, event.actor);
        break;
      }

      case 'reach': {
        if (!started) break;
        seats[event.actor].riichi = true;
        pendingRiichi = event.actor;
        push(eventIndex, `${seatLabel(event.actor, oya)} declares riichi`, event.actor);
        break;
      }

      case 'dora': {
        if (!started) break;
        doraIndicators.push(canonicalize(event.dora_marker));
        push(eventIndex, 'new dora indicator');
        break;
      }

      case 'hora': {
        if (!started) break;
        if (event.scores && event.scores.length === 4) {
          scores = [...event.scores];
        } else if (event.deltas && event.deltas.length === 4) {
          scores = scores.map((score, i) => score + event.deltas![i]);
        }
        scores.forEach((score, i) => {
          seats[i].score = score;
        });
        result = { kind: 'hora', winner: event.actor, deltas: event.deltas };
        push(
          eventIndex,
          event.actor === event.target
            ? `${seatLabel(event.actor, oya)} wins by tsumo`
            : `${seatLabel(event.actor, oya)} wins off ${seatLabel(event.target, oya)}`,
          event.actor,
        );
        break;
      }

      case 'ryukyoku': {
        if (!started) break;
        if (event.scores && event.scores.length === 4) {
          scores = [...event.scores];
        } else if (event.deltas && event.deltas.length === 4) {
          scores = scores.map((score, i) => score + event.deltas![i]);
        }
        scores.forEach((score, i) => {
          seats[i].score = score;
        });
        result = { kind: 'ryukyoku', deltas: event.deltas };
        push(eventIndex, 'exhaustive draw');
        break;
      }

      default:
        break;
    }
  });

  return snapshots;
}

/** Split a whole-hanchan log into per-kyoku event slices. */
export function splitKyoku(events: MjaiEvent[]): MjaiEvent[][] {
  const hands: MjaiEvent[][] = [];
  let current: MjaiEvent[] | undefined;

  for (const event of events) {
    if (event.type === 'start_kyoku') {
      current = [event];
      hands.push(current);
      continue;
    }
    if (!current) continue;
    current.push(event);
    if (event.type === 'end_kyoku') current = undefined;
  }

  return hands;
}

/**
 * Render a stored puzzle position on the same board the replay uses.
 *
 * A puzzle records only the acting player's tiles, so the other three seats are
 * marked `unknownCount` rather than filled with placeholder tiles — the board
 * must not be able to "reveal" a hand that was never captured.
 */
export function snapshotFromPosition(position: {
  seat: Seat;
  round: { wind: RoundWind; kyoku: number; honba: number; riichiSticks: number };
  scores: [number, number, number, number];
  doraIndicators: Tile[];
  hand: Tile[];
  drawnTile?: Tile;
  melds: Meld[];
  rivers: Tile[][];
  opponentMelds: [Meld[], Meld[], Meld[], Meld[]];
  riichi: [boolean, boolean, boolean, boolean];
  tilesLeft: number;
}): Snapshot {
  const seats = ([0, 1, 2, 3] as Seat[]).map((seat): SeatState => {
    const isActor = seat === position.seat;
    const melds = isActor ? position.melds : position.opponentMelds[seat];
    return {
      hand: isActor ? [...position.hand] : [],
      melds: melds.map((meld) => ({ ...meld, tiles: [...meld.tiles] })),
      river: (position.rivers[seat] ?? []).map((tile) => ({
        tile,
        tsumogiri: false,
        riichi: false,
        called: false,
      })),
      riichi: position.riichi[seat],
      score: position.scores[seat],
      drawn: isActor ? position.drawnTile : undefined,
      unknownCount: isActor ? undefined : HAND_SIZE - melds.length * 3,
    };
  }) as [SeatState, SeatState, SeatState, SeatState];

  return {
    eventIndex: 0,
    description: 'puzzle position',
    actor: position.seat,
    round: { ...position.round },
    // Puzzle positions do not record the dealer, and the round wind plus hand
    // number is what the seat labels need; East seat is the safe assumption.
    oya: 0,
    doraIndicators: [...position.doraIndicators],
    seats,
    tilesLeft: position.tilesLeft,
  };
}

/**
 * Rotate absolute seats so `viewer` sits at the bottom of the table. Returns the
 * seat index for each screen position.
 */
export function seatLayout(viewer: Seat): {
  bottom: Seat;
  right: Seat;
  top: Seat;
  left: Seat;
} {
  return {
    bottom: viewer,
    // Turn order runs counter-clockwise on screen: the player to the viewer's
    // right acts next.
    right: (((viewer + 1) % 4) as Seat),
    top: (((viewer + 2) % 4) as Seat),
    left: (((viewer + 3) % 4) as Seat),
  };
}
