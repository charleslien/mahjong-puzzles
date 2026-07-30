/**
 * Tile notation and conversion.
 *
 * Canonical string form follows the mjai protocol, since that is what the
 * offline pipeline emits: "1m".."9m", "1p".."9p", "1s".."9s", "E","S","W","N",
 * "P","F","C" for honors, and "5mr"/"5pr"/"5sr" for red fives.
 *
 * Internally tiles collapse to a 34-length count vector indexed:
 *   0..8   1m..9m
 *   9..17  1p..9p
 *   18..26 1s..9s
 *   27..30 E S W N
 *   31..33 P(haku) F(hatsu) C(chun)
 *
 * Red fives share an index with their normal counterpart; redness is carried
 * separately because it affects scoring but never shape.
 */

export type Tile = string;

export const NUM_TILE_TYPES = 34;

const HONOR_ORDER = ['E', 'S', 'W', 'N', 'P', 'F', 'C'] as const;
const SUIT_OFFSET: Record<string, number> = { m: 0, p: 9, s: 18 };

/** Every distinct tile type in canonical index order. */
export const ALL_TILES: Tile[] = (() => {
  const out: Tile[] = [];
  for (const suit of ['m', 'p', 's']) {
    for (let n = 1; n <= 9; n++) out.push(`${n}${suit}`);
  }
  out.push(...HONOR_ORDER);
  return out;
})();

/** Parse a single tile string to its 34-index. Throws on malformed input. */
export function tileToIndex(tile: Tile): number {
  const honorIdx = HONOR_ORDER.indexOf(tile as (typeof HONOR_ORDER)[number]);
  if (honorIdx >= 0) return 27 + honorIdx;

  // Tenhou-style honors ("1z".."7z") accepted as an alias.
  const zMatch = /^([1-7])z$/.exec(tile);
  if (zMatch) return 27 + (Number(zMatch[1]) - 1);

  const match = /^([0-9])([mps])r?$/.exec(tile);
  if (!match) throw new Error(`unparseable tile: ${tile}`);
  const [, digitStr, suit] = match;
  const digit = Number(digitStr);
  // "0m" is the Tenhou spelling of a red five.
  const rank = digit === 0 ? 5 : digit;
  return SUIT_OFFSET[suit] + (rank - 1);
}

export function indexToTile(index: number): Tile {
  const tile = ALL_TILES[index];
  if (tile === undefined) throw new Error(`tile index out of range: ${index}`);
  return tile;
}

export function isRedFive(tile: Tile): boolean {
  return tile.endsWith('r') || /^0[mps]$/.test(tile);
}

export function isHonor(index: number): boolean {
  return index >= 27;
}

/** Terminals and honors — the tiles that can never sit mid-run. */
export function isTerminalOrHonor(index: number): boolean {
  if (index >= 27) return true;
  const rank = (index % 9) + 1;
  return rank === 1 || rank === 9;
}

/** Normalise to the canonical mjai spelling (so "0p" becomes "5pr"). */
export function canonicalize(tile: Tile): Tile {
  const match = /^0([mps])$/.exec(tile);
  if (match) return `5${match[1]}r`;
  const zMatch = /^([1-7])z$/.exec(tile);
  if (zMatch) return HONOR_ORDER[Number(zMatch[1]) - 1];
  return tile;
}

/** Build a 34-length count vector from a tile list. */
export function toCounts(tiles: Tile[]): number[] {
  const counts = new Array<number>(NUM_TILE_TYPES).fill(0);
  for (const tile of tiles) counts[tileToIndex(tile)] += 1;
  return counts;
}

export function countsToTiles(counts: number[]): Tile[] {
  const out: Tile[] = [];
  for (let i = 0; i < NUM_TILE_TYPES; i++) {
    for (let n = 0; n < counts[i]; n++) out.push(indexToTile(i));
  }
  return out;
}

/**
 * Parse a compact hand string like "123m456p789s11z" or "19m19p19s1234567z"
 * into canonical tiles. Digits accumulate until a suit letter closes them.
 */
export function parseHand(input: string): Tile[] {
  const out: Tile[] = [];
  let pending: string[] = [];
  for (const ch of input.replace(/\s+/g, '')) {
    if (/[0-9]/.test(ch)) {
      pending.push(ch);
      continue;
    }
    if (/[mpsz]/.test(ch)) {
      for (const digit of pending) {
        out.push(canonicalize(ch === 'z' ? `${digit}z` : `${digit}${ch}`));
      }
      pending = [];
      continue;
    }
    throw new Error(`unexpected character in hand string: ${ch}`);
  }
  if (pending.length > 0) throw new Error(`trailing digits with no suit: ${pending.join('')}`);
  return out;
}

/** Sort tiles into conventional display order. */
export function sortTiles(tiles: Tile[]): Tile[] {
  return [...tiles].sort((a, b) => {
    const diff = tileToIndex(a) - tileToIndex(b);
    if (diff !== 0) return diff;
    // Show the red five before its plain twin so it is visible in the hand.
    return Number(isRedFive(b)) - Number(isRedFive(a));
  });
}

/** Human-readable label, used for accessibility text. */
export function tileLabel(tile: Tile): string {
  const canonical = canonicalize(tile);
  const honorNames: Record<string, string> = {
    E: 'East',
    S: 'South',
    W: 'West',
    N: 'North',
    P: 'White dragon',
    F: 'Green dragon',
    C: 'Red dragon',
  };
  if (canonical in honorNames) return honorNames[canonical];
  // Singular at rank 1, since the number is a count of what the tile depicts:
  // the 5 of circles really does show five circles, but "1 characters" is just
  // wrong, and it appeared in every label and explanation for a 1m, 1p or 1s.
  const suitNames: Record<string, [singular: string, plural: string]> = {
    m: ['character', 'characters'],
    p: ['circle', 'circles'],
    s: ['bamboo', 'bamboo'],
  };
  const match = /^([0-9])([mps])(r?)$/.exec(canonical);
  if (!match) return canonical;
  const [, rank, suit, red] = match;
  const [singular, plural] = suitNames[suit];
  return `${red ? 'red ' : ''}${rank} ${rank === '1' ? singular : plural}`;
}

/** The dora indicated by a given indicator tile. */
export function doraFromIndicator(indicator: Tile): Tile {
  const index = tileToIndex(indicator);
  if (index >= 27) {
    // Winds cycle E->S->W->N->E, dragons cycle P->F->C->P.
    if (index <= 30) return indexToTile(27 + ((index - 27 + 1) % 4));
    return indexToTile(31 + ((index - 31 + 1) % 3));
  }
  const suitBase = Math.floor(index / 9) * 9;
  const rank = index % 9;
  return indexToTile(suitBase + ((rank + 1) % 9));
}
