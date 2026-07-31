/**
 * Puzzle bank loading.
 *
 * Two sources, chosen by VITE_PUZZLE_SOURCE:
 *
 *   static    JSON shards under the site's base path — no backend, always works
 *   supabase  the puzzles table, falling back to static on any failure
 *
 * The fallback is the point. A database outage should leave the site working
 * exactly as it does without one, not blank the page; and a clone with no
 * credentials behaves like the static site it has always been.
 */

import { SCHEMA_VERSION, type Puzzle, type PuzzleIndex, type PuzzleShard } from '../types/puzzle';
import { fetchBankMeta, fetchPuzzleStats, fetchPuzzles, puzzleSource, type PuzzleStats } from './supabase';

function bankUrl(path: string): string {
  // BASE_URL already carries a trailing slash under Vite.
  return `${import.meta.env.BASE_URL}puzzles/${path}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  // `cache: 'no-cache'` forces revalidation. The bank is regenerated wholesale
  // and its filenames are not content-hashed, so a cached manifest can point at
  // a shard that no longer exists — which is how a stale bank survived a deploy
  // and silently served positions without replay history.
  const response = await fetch(bankUrl(path), { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`failed to load ${path}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export interface LoadedBank {
  index: PuzzleIndex;
  puzzles: Puzzle[];
  /**
   * Difficulty learned from real attempts, keyed by puzzle id.
   *
   * Empty for a static deployment and until people have played, so callers must
   * treat its absence as normal rather than as an error.
   */
  stats: Map<string, PuzzleStats>;
}

let cached: Promise<LoadedBank> | undefined;

async function loadStaticBank(): Promise<LoadedBank> {
  const index = await fetchJson<PuzzleIndex>('index.json');
  if (index.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `puzzle bank schema ${index.schemaVersion} does not match app schema ${SCHEMA_VERSION}`,
    );
  }

  const shards = await Promise.all(index.shards.map((shard) => fetchJson<PuzzleShard>(shard.file)));
  const puzzles = shards.flatMap((shard) => shard.puzzles);
  return { index, puzzles, stats: new Map() };
}

async function loadSupabaseBank(): Promise<LoadedBank> {
  const [meta, rows] = await Promise.all([fetchBankMeta(), fetchPuzzles()]);
  if (meta.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `puzzle bank schema ${meta.schema_version} does not match app schema ${SCHEMA_VERSION}`,
    );
  }
  if (rows.length === 0) throw new Error('the puzzles table is empty');

  const puzzles = rows as unknown as Puzzle[];
  const index: PuzzleIndex = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: meta.generated_at,
    provenance: meta.provenance,
    count: puzzles.length,
    // The database is not sharded; the field exists for the static bank's sake.
    shards: [],
  };
  // Community difficulty is a bonus, never a reason to fail the load.
  const stats = await fetchPuzzleStats().catch(() => new Map<string, PuzzleStats>());
  return { index, puzzles, stats };
}

export function loadBank(): Promise<LoadedBank> {
  cached ??= (async () => {
    if (puzzleSource() === 'supabase') {
      try {
        return await loadSupabaseBank();
      } catch (error) {
        // Degrade to the bundled bank rather than showing nothing. Logged
        // because a silent fallback would hide a broken database behind a site
        // that looks entirely healthy.
        console.warn('[bank] Supabase load failed, falling back to bundled JSON:', error);
      }
    }
    return loadStaticBank();
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
