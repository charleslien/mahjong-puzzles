/**
 * Tests for the mjai replay engine.
 *
 * Uses the same synthetic log as pipeline/test_extract.py, which makes this a
 * cross-check that the TypeScript replayer and the Python extractor agree about
 * what a position is. They are separate implementations of the same rules, so
 * they can drift.
 */

import { describe, expect, it } from 'vitest';
import { replayKyoku, seatLayout, splitKyoku, type MjaiEvent } from './replay';
import type { Seat } from '../types/puzzle';

const TEHAIS = [
  ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p'],
  ['5p', '6p', '7p', '8p', '9p', '9p', '1s', '2s', '3s', '4s', '5s', '6s', '7s'],
  ['9p', '9p', '8s', '9s', 'E', 'E', 'S', 'S', 'W', 'W', 'N', 'N', 'P'],
  ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p'],
];

function log(): MjaiEvent[] {
  return [
    { type: 'start_game', names: ['a', 'b', 'c', 'd'] },
    {
      type: 'start_kyoku',
      bakaze: 'E',
      kyoku: 1,
      honba: 0,
      kyotaku: 0,
      oya: 0,
      dora_marker: '1s',
      tehais: TEHAIS,
    },
    { type: 'tsumo', actor: 0, pai: '5m' },
    { type: 'dahai', actor: 0, pai: '1m', tsumogiri: false },
    { type: 'tsumo', actor: 1, pai: 'E' },
    { type: 'dahai', actor: 1, pai: 'E', tsumogiri: true },
    { type: 'pon', actor: 2, target: 1, pai: 'E', consumed: ['E', 'E'] },
    { type: 'dahai', actor: 2, pai: 'P', tsumogiri: false },
    {
      type: 'hora',
      actor: 0,
      target: 2,
      deltas: [8000, 0, -8000, 0],
      scores: [33000, 25000, 17000, 25000],
    },
    { type: 'end_kyoku' },
    { type: 'end_game' },
  ];
}

describe('replayKyoku', () => {
  const frames = replayKyoku(log());

  it('produces one snapshot per meaningful event', () => {
    // deal, draw, discard, draw, discard, pon, discard, hora
    expect(frames.length).toBe(8);
  });

  it('deals thirteen tiles to every seat', () => {
    const deal = frames[0];
    for (const seat of deal.seats) expect(seat.hand.length).toBe(13);
    expect(deal.tilesLeft).toBe(70);
  });

  it('adds the drawn tile and marks it', () => {
    const afterDraw = frames[1];
    expect(afterDraw.seats[0].hand.length).toBe(14);
    expect(afterDraw.seats[0].drawn).toBe('5m');
    expect(afterDraw.tilesLeft).toBe(69);
  });

  it('clears the drawn marker once discarded', () => {
    const afterDiscard = frames[2];
    expect(afterDiscard.seats[0].hand.length).toBe(13);
    expect(afterDiscard.seats[0].drawn).toBeUndefined();
    expect(afterDiscard.seats[0].river.map((entry) => entry.tile)).toEqual(['1m']);
  });

  it('records tsumogiri', () => {
    const afterTsumogiri = frames[4];
    expect(afterTsumogiri.seats[1].river[0]).toMatchObject({ tile: 'E', tsumogiri: true });
  });

  it('marks a claimed tile as called rather than deleting it', () => {
    const afterPon = frames[5];
    const entry = afterPon.seats[1].river.find((candidate) => candidate.tile === 'E');
    // Kept in the river so it still reads chronologically, but flagged so the UI
    // can render it as gone.
    expect(entry).toMatchObject({ tile: 'E', called: true });
  });

  it('builds the meld on the calling seat', () => {
    const afterPon = frames[5];
    expect(afterPon.seats[2].melds).toHaveLength(1);
    expect(afterPon.seats[2].melds[0].kind).toBe('pon');
    expect(afterPon.seats[2].melds[0].tiles).toEqual(['E', 'E', 'E']);
    expect(afterPon.seats[2].melds[0].from).toBe(1);
    // Two copies left the hand.
    expect(afterPon.seats[2].hand.length).toBe(11);
  });

  it('leaves the caller holding fourteen tiles worth before discarding', () => {
    const afterPon = frames[5];
    const seat = afterPon.seats[2];
    expect(seat.hand.length + seat.melds.length * 3).toBe(14);
    expect(seat.drawn).toBeUndefined();
  });

  it('applies the result and final scores', () => {
    const final = frames[frames.length - 1];
    expect(final.result).toMatchObject({ kind: 'hora', winner: 0 });
    expect(final.seats.map((seat) => seat.score)).toEqual([33000, 25000, 17000, 25000]);
  });

  it('describes each step', () => {
    expect(frames.map((frame) => frame.description)).toEqual([
      'E1 — deal',
      'E draws',
      'E discards 1m',
      'S draws',
      'S discards E',
      'W calls pon on E',
      'W discards P',
      'E wins off W',
    ]);
  });

  it('keeps snapshots independent so stepping back does not mutate', () => {
    // The deal frame must still show 13 tiles even though later frames changed
    // the hand — a shared-reference bug would show the final state here.
    expect(frames[0].seats[0].hand.length).toBe(13);
    expect(frames[0].seats[0].river).toEqual([]);
    expect(frames[0].seats[2].melds).toEqual([]);
  });

  it('falls back to deltas when scores are absent', () => {
    const events = log().map((event) =>
      event.type === 'hora' ? { ...event, scores: undefined } : event,
    );
    const withDeltas = replayKyoku(events as MjaiEvent[]);
    const final = withDeltas[withDeltas.length - 1];
    expect(final.seats.map((seat) => seat.score)).toEqual([33000, 25000, 17000, 25000]);
  });

  it('tracks riichi and flags the declaring discard', () => {
    const events: MjaiEvent[] = [
      log()[1],
      { type: 'tsumo', actor: 0, pai: '5m' },
      { type: 'reach', actor: 0 },
      { type: 'dahai', actor: 0, pai: '1m', tsumogiri: false },
      { type: 'tsumo', actor: 0, pai: '6m' },
      { type: 'dahai', actor: 0, pai: '6m', tsumogiri: true },
    ];
    const frames = replayKyoku(events);
    const last = frames[frames.length - 1];
    expect(last.seats[0].riichi).toBe(true);
    // Only the declaring discard is flagged, not every later one.
    expect(last.seats[0].river.map((entry) => entry.riichi)).toEqual([true, false]);
  });

  it('appends revealed dora indicators', () => {
    const events: MjaiEvent[] = [log()[1], { type: 'dora', dora_marker: '3p' }];
    const frames = replayKyoku(events);
    expect(frames[frames.length - 1].doraIndicators).toEqual(['1s', '3p']);
  });

  it('ignores events before the deal', () => {
    const frames = replayKyoku([{ type: 'tsumo', actor: 0, pai: '1m' }] as MjaiEvent[]);
    expect(frames).toEqual([]);
  });
});

describe('splitKyoku', () => {
  it('slices a hanchan into hands', () => {
    const events = [...log(), ...log().slice(1)];
    const hands = splitKyoku(events as MjaiEvent[]);
    expect(hands.length).toBe(2);
    for (const hand of hands) {
      expect(hand[0].type).toBe('start_kyoku');
    }
  });

  it('returns nothing for a log with no hands', () => {
    expect(splitKyoku([{ type: 'start_game' }] as MjaiEvent[])).toEqual([]);
  });
});

describe('seatLayout', () => {
  it('places the viewer at the bottom', () => {
    for (const viewer of [0, 1, 2, 3] as Seat[]) {
      expect(seatLayout(viewer).bottom).toBe(viewer);
    }
  });

  it('orders the table so the next player to act sits to the right', () => {
    expect(seatLayout(0)).toEqual({ bottom: 0, right: 1, top: 2, left: 3 });
    expect(seatLayout(2)).toEqual({ bottom: 2, right: 3, top: 0, left: 1 });
  });

  it('assigns four distinct seats', () => {
    for (const viewer of [0, 1, 2, 3] as Seat[]) {
      const layout = seatLayout(viewer);
      expect(new Set(Object.values(layout)).size).toBe(4);
    }
  });
});
