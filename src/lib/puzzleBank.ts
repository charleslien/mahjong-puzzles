/**
 * Puzzle bank loading. The bank is static JSON under the site's base path, so
 * it is fetched at runtime and cached in memory for the session.
 */

import { SCHEMA_VERSION, type Puzzle, type PuzzleIndex, type PuzzleShard } from '../types/puzzle';

function bankUrl(path: string): string {
  // BASE_URL already carries a trailing slash under Vite.
  return `${import.meta.env.BASE_URL}puzzles/${path}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(bankUrl(path));
  if (!response.ok) {
    throw new Error(`failed to load ${path}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export interface LoadedBank {
  index: PuzzleIndex;
  puzzles: Puzzle[];
}

let cached: Promise<LoadedBank> | undefined;

export function loadBank(): Promise<LoadedBank> {
  cached ??= (async () => {
    const index = await fetchJson<PuzzleIndex>('index.json');
    if (index.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `puzzle bank schema ${index.schemaVersion} does not match app schema ${SCHEMA_VERSION}`,
      );
    }

    const shards = await Promise.all(
      index.shards.map((shard) => fetchJson<PuzzleShard>(shard.file)),
    );
    const puzzles = shards.flatMap((shard) => shard.puzzles);
    return { index, puzzles };
  })();

  return cached;
}

/** Deterministic shuffle so a given seed always yields the same run order. */
export function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface SessionFilters {
  kinds?: string[];
  tags?: string[];
  maxDifficulty?: number;
  minDifficulty?: number;
}

export function filterPuzzles(puzzles: Puzzle[], filters: SessionFilters): Puzzle[] {
  return puzzles.filter((puzzle) => {
    if (filters.kinds?.length && !filters.kinds.includes(puzzle.kind)) return false;
    if (filters.tags?.length && !filters.tags.some((tag) => puzzle.tags.includes(tag))) return false;
    if (filters.minDifficulty !== undefined && puzzle.difficulty < filters.minDifficulty) return false;
    if (filters.maxDifficulty !== undefined && puzzle.difficulty > filters.maxDifficulty) return false;
    return true;
  });
}
