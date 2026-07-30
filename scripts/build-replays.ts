/**
 * Generate simulated games as mjai logs, so the replay UI has something
 * coherent to show before the real houou logs are wired in.
 *
 * These are *simulated*, not real games, and the simulation is deliberately
 * partial. What it does model: a legal wall, legal draws and discards, riichi
 * declaration, pon calls, ron with a furiten check, tsumo, and exhaustive draw.
 * Discard choice runs through the real shanten/ukeire library, so the play is
 * efficiency-sensible rather than random.
 *
 * What it does NOT model, and why that is stated rather than faked:
 *   - yaku. A hand is treated as won once it is mechanically complete, so some
 *     wins here would be illegal at a real table.
 *   - hand scoring. No point deltas are emitted at all, because inventing hand
 *     values would put fabricated numbers on screen.
 *   - chi and kan calls.
 *
 * Every generated log carries that caveat in its provenance, which the replay UI
 * displays.
 *
 * Run with: npm run build:replays
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shanten } from '../src/lib/shanten';
import { analyzeDiscards } from '../src/lib/ukeire';
import { NUM_TILE_TYPES, indexToTile, tileToIndex, type Tile } from '../src/lib/tiles';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'replays');

const DEAD_WALL = 14;
const HAND_SIZE = 13;

type Seat = 0 | 1 | 2 | 3;
type Event = Record<string, unknown>;

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** A full 136-tile wall with one red five per suit. */
function buildWall(random: () => number): Tile[] {
  const wall: Tile[] = [];
  for (let index = 0; index < NUM_TILE_TYPES; index++) {
    for (let copy = 0; copy < 4; copy++) {
      const tile = indexToTile(index);
      // The first copy of each five is the red one.
      const isFive = /^5[mps]$/.test(tile);
      wall.push(isFive && copy === 0 ? `${tile}r` : tile);
    }
  }
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [wall[i], wall[j]] = [wall[j], wall[i]];
  }
  return wall;
}

class Player {
  hand: Tile[] = [];
  melds: Array<{ kind: string; tiles: Tile[]; from?: Seat }> = [];
  river: Tile[] = [];
  riichi = false;

  counts(): number[] {
    const counts = new Array<number>(NUM_TILE_TYPES).fill(0);
    for (const tile of this.hand) counts[tileToIndex(tile)] += 1;
    return counts;
  }

  meldCount(): 0 | 1 | 2 | 3 | 4 {
    return Math.min(4, this.melds.length) as 0 | 1 | 2 | 3 | 4;
  }

  isClosed(): boolean {
    return this.melds.length === 0;
  }

  remove(tile: Tile): void {
    const index = this.hand.indexOf(tile);
    if (index >= 0) this.hand.splice(index, 1);
  }

  /** Tile types that would complete this hand. */
  winningTiles(): Set<number> {
    const counts = this.counts();
    const winning = new Set<number>();
    for (let index = 0; index < NUM_TILE_TYPES; index++) {
      if (counts[index] >= 4) continue;
      counts[index] += 1;
      if (shanten(counts, this.meldCount()) === -1) winning.add(index);
      counts[index] -= 1;
    }
    return winning;
  }

  /** A player cannot ron on a tile type they have already discarded. */
  isFuriten(): boolean {
    const winning = this.winningTiles();
    return this.river.some((tile) => winning.has(tileToIndex(tile)));
  }
}

function chooseDiscard(player: Player, random: () => number): Tile {
  const options = analyzeDiscards(player.counts(), player.meldCount());
  if (options.length === 0) return player.hand[0];
  // Mostly best, occasionally second best, so four players do not play in
  // lockstep and the logs vary.
  const pick = options.length > 1 && random() < 0.15 ? 1 : 0;
  return options[pick].tile;
}

interface SimResult {
  events: Event[];
  outcome: string;
}

function simulateKyoku(
  random: () => number,
  bakaze: string,
  kyoku: number,
  oya: Seat,
): SimResult {
  const wall = buildWall(random);
  const players = [new Player(), new Player(), new Player(), new Player()];

  let cursor = 0;
  for (let seat = 0; seat < 4; seat++) {
    players[seat].hand = wall.slice(cursor, cursor + HAND_SIZE);
    cursor += HAND_SIZE;
  }
  const doraMarker = wall[wall.length - DEAD_WALL];
  const liveWall = wall.slice(cursor, wall.length - DEAD_WALL);

  const events: Event[] = [
    {
      type: 'start_kyoku',
      bakaze,
      kyoku,
      honba: 0,
      kyotaku: 0,
      oya,
      dora_marker: doraMarker,
      tehais: players.map((player) => [...player.hand]),
    },
  ];

  let turn: Seat = oya;
  let drawIndex = 0;
  // Set when a call means the caller discards instead of drawing.
  let skipDraw = false;

  for (;;) {
    if (!skipDraw) {
      if (drawIndex >= liveWall.length) {
        events.push({ type: 'ryukyoku' });
        events.push({ type: 'end_kyoku' });
        return { events, outcome: 'exhaustive draw' };
      }
      const drawn = liveWall[drawIndex++];
      players[turn].hand.push(drawn);
      events.push({ type: 'tsumo', actor: turn, pai: drawn });

      if (shanten(players[turn].counts(), players[turn].meldCount()) === -1) {
        // No deltas: hand value is not simulated.
        events.push({ type: 'hora', actor: turn, target: turn });
        events.push({ type: 'end_kyoku' });
        return { events, outcome: `seat ${turn + 1} wins by tsumo` };
      }
    }
    skipDraw = false;

    const player = players[turn];
    const drawnTile = player.hand[player.hand.length - 1];

    // A riichi hand is locked: it must discard whatever it drew.
    let discard: Tile;
    if (player.riichi) {
      discard = drawnTile;
    } else {
      let declaring = false;
      if (player.isClosed() && !player.riichi && drawIndex < liveWall.length - 4) {
        const candidate = chooseDiscard(player, random);
        const counts = player.counts();
        counts[tileToIndex(candidate)] -= 1;
        if (shanten(counts, 0) === 0 && random() < 0.8) declaring = true;
      }
      discard = chooseDiscard(player, random);
      if (declaring) {
        events.push({ type: 'reach', actor: turn });
        player.riichi = true;
      }
    }

    player.remove(discard);
    player.river.push(discard);
    events.push({
      type: 'dahai',
      actor: turn,
      pai: discard,
      tsumogiri: discard === drawnTile,
    });
    if (player.riichi) events.push({ type: 'reach_accepted', actor: turn });

    // Ron, checked in turn order from the discarder.
    let claimed = false;
    for (let offset = 1; offset <= 3 && !claimed; offset++) {
      const seat = (((turn + offset) % 4) as Seat);
      const other = players[seat];
      const counts = other.counts();
      counts[tileToIndex(discard)] += 1;
      if (shanten(counts, other.meldCount()) === -1 && !other.isFuriten()) {
        events.push({ type: 'hora', actor: seat, target: turn });
        events.push({ type: 'end_kyoku' });
        return { events, outcome: `seat ${seat + 1} wins off seat ${turn + 1}` };
      }
    }

    // Pon, only when it actually improves the hand and only for closed-ish
    // hands, to keep the logs from filling up with calls.
    for (let offset = 1; offset <= 3; offset++) {
      const seat = (((turn + offset) % 4) as Seat);
      const other = players[seat];
      if (other.riichi || other.melds.length >= 3) continue;

      const index = tileToIndex(discard);
      const held = other.hand.filter((tile) => tileToIndex(tile) === index);
      if (held.length < 2) continue;

      const before = shanten(other.counts(), other.meldCount());
      const counts = other.counts();
      counts[index] -= 2;
      const after = shanten(counts, Math.min(4, other.melds.length + 1) as 0 | 1 | 2 | 3 | 4);
      if (after >= before || random() < 0.5) continue;

      const consumed = held.slice(0, 2);
      for (const tile of consumed) other.remove(tile);
      other.melds.push({ kind: 'pon', tiles: [...consumed, discard], from: turn });
      // The claimed tile leaves the discarder's river.
      players[turn].river.pop();

      events.push({
        type: 'pon',
        actor: seat,
        target: turn,
        pai: discard,
        consumed,
      });
      turn = seat;
      skipDraw = true;
      claimed = true;
      break;
    }

    if (!claimed) turn = (((turn + 1) % 4) as Seat);
  }
}

function simulateGame(seed: number, hands: number): { events: Event[]; outcomes: string[] } {
  const random = makeRandom(seed);
  const events: Event[] = [{ type: 'start_game', names: ['Sim 1', 'Sim 2', 'Sim 3', 'Sim 4'] }];
  const outcomes: string[] = [];

  for (let hand = 0; hand < hands; hand++) {
    const kyoku = (hand % 4) + 1;
    const result = simulateKyoku(random, hand < 4 ? 'E' : 'S', kyoku, (hand % 4) as Seat);
    events.push(...result.events);
    outcomes.push(`${hand < 4 ? 'E' : 'S'}${kyoku}: ${result.outcome}`);
  }

  events.push({ type: 'end_game' });
  return { events, outcomes };
}

const PROVENANCE =
  'Simulated game, not a real one. The wall, draws, discards, riichi, pon, ron ' +
  '(with furiten check), tsumo and exhaustive draw are all modelled, and discard ' +
  'choice runs through the same shanten/ukeire library the drills use. Yaku are ' +
  'NOT checked, so some wins shown here would be illegal at a real table, and ' +
  'hand scoring is not simulated at all — no point deltas are emitted rather ' +
  'than invented. Real Tenhou houou logs will replace these once the pipeline runs.';

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const replays = [];
  const seeds = [
    { seed: 20260729, hands: 4, title: 'Simulated game 1 (East round)' },
    { seed: 555001, hands: 4, title: 'Simulated game 2 (East round)' },
    { seed: 909112, hands: 8, title: 'Simulated game 3 (full hanchan)' },
  ];

  for (const [i, config] of seeds.entries()) {
    const { events, outcomes } = simulateGame(config.seed, config.hands);
    const file = `sim-${String(i + 1).padStart(2, '0')}.json`;
    writeFileSync(join(OUT_DIR, file), `${JSON.stringify(events, null, 1)}\n`);
    replays.push({
      id: `sim-${i + 1}`,
      title: config.title,
      provenance: `${PROVENANCE} Outcomes: ${outcomes.join('; ')}.`,
      file,
    });
    process.stdout.write(`${file}: ${events.length} events — ${outcomes.join('; ')}\n`);
  }

  writeFileSync(join(OUT_DIR, 'index.json'), `${JSON.stringify({ replays }, null, 2)}\n`);
  process.stdout.write(`wrote ${replays.length} replays to ${OUT_DIR}\n`);
}

main();
