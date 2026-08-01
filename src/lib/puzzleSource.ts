/**
 * Where puzzles come from.
 *
 * Two implementations behind one interface:
 *
 *   static    every shard downloaded once and served from memory — no backend,
 *             always works, and the fallback whenever the other one fails
 *   supabase  a session's worth sampled server-side
 *
 * The distinction that matters is not where the bytes live but how many arrive.
 * The static source has to send the whole bank to answer "give me twenty
 * puzzles", which caps the bank at what is reasonable to download and makes
 * every visit pay for 900 puzzles to play twenty of them. Sampling server-side
 * removes both limits at once.
 *
 * Falling back is deliberate and total: if the database is unreachable, or the
 * deployment has no credentials, the site behaves exactly as it did before any
 * of this existed.
 */

import { SCHEMA_VERSION, type Puzzle, type PuzzleIndex, type PuzzleShard } from '../types/puzzle';
import {
  fetchPuzzleStats,
  isConfigured,
  puzzleSource as configuredSource,
  supabase,
  type PuzzleStats,
} from './supabase';

export interface SessionRequest {
  size: number;
  minDifficulty: number;
  maxDifficulty: number;
  /** Decision kinds to draw from; undefined means all of them. */
  kinds?: string[];
  /**
   * Themes to draw from, matched as "carries any of these".
   *
   * The sampling function has taken this since it was written and the site
   * always passed null, so a solver could see which theme was costing them
   * points and had no way to practise it.
   */
  tags?: string[];
  /** Only these puzzles, in this order. Used to replay a set of mistakes. */
  onlyIds?: string[];
  /** Puzzles already answered, so a session leads with unseen ones. */
  excludeIds?: string[];
}

export interface BankMeta {
  count: number;
  generatedAt: string;
  provenance: string;
}

export interface PuzzleSource {
  kind: 'static' | 'supabase';
  meta(): Promise<BankMeta>;
  /** One session's puzzles, already in the order they should be played. */
  session(request: SessionRequest): Promise<Puzzle[]>;
  /** How many puzzles exist in a difficulty band. */
  count(
    minDifficulty: number,
    maxDifficulty: number,
    kinds?: string[],
    tags?: string[],
  ): Promise<number>;
  byId(id: string): Promise<Puzzle | undefined>;
  byIds(ids: string[]): Promise<Puzzle[]>;
  stats(ids: string[]): Promise<Map<string, PuzzleStats>>;
}

/** Deterministic shuffle, used only by the static source. */
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

// -- static ------------------------------------------------------------------

function bankUrl(path: string): string {
  return `${import.meta.env.BASE_URL}puzzles/${path}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  // `cache: 'no-cache'` forces revalidation. The bank is regenerated wholesale
  // and its filenames are not content-hashed, so a cached manifest can point at
  // a shard that no longer exists — which is how a stale bank once survived a
  // deploy and silently served positions without replay history.
  const response = await fetch(bankUrl(path), { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`failed to load ${path}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

interface StaticBank {
  index: PuzzleIndex;
  puzzles: Puzzle[];
}

let staticBank: Promise<StaticBank> | undefined;

function loadStaticBank(): Promise<StaticBank> {
  staticBank ??= (async () => {
    const index = await fetchJson<PuzzleIndex>('index.json');
    if (index.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `puzzle bank schema ${index.schemaVersion} does not match app schema ${SCHEMA_VERSION}`,
      );
    }
    const shards = await Promise.all(
      index.shards.map((shard) => fetchJson<PuzzleShard>(shard.file)),
    );
    return { index, puzzles: shards.flatMap((shard) => shard.puzzles) };
  })();
  return staticBank;
}

function inBand(puzzle: Puzzle, min: number, max: number): boolean {
  return puzzle.difficulty >= min && puzzle.difficulty <= max;
}

/** Mirrors the sampler's `kinds`/`any_tags`: all of the filters, any of the tags. */
function matches(puzzle: Puzzle, kinds?: string[], tags?: string[]): boolean {
  if (kinds?.length && !kinds.includes(puzzle.kind)) return false;
  if (tags?.length && !tags.some((tag) => puzzle.tags.includes(tag))) return false;
  return true;
}

export const staticSource: PuzzleSource = {
  kind: 'static',

  async meta() {
    const { index } = await loadStaticBank();
    return { count: index.count, generatedAt: index.generatedAt, provenance: index.provenance };
  },

  async session({ size, minDifficulty, maxDifficulty, kinds, tags, onlyIds, excludeIds }) {
    const { puzzles } = await loadStaticBank();

    if (onlyIds?.length) {
      const wanted = new Set(onlyIds);
      const found = new Map(puzzles.filter((p) => wanted.has(p.id)).map((p) => [p.id, p]));
      // Keep the caller's order — a mistakes drill is deliberately ordered.
      return onlyIds.map((id) => found.get(id)).filter((p): p is Puzzle => Boolean(p));
    }

    const seen = new Set(excludeIds ?? []);
    const matching = puzzles.filter(
      (puzzle) =>
        inBand(puzzle, minDifficulty, maxDifficulty) && matches(puzzle, kinds, tags),
    );
    const order = shuffled(matching, (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    // Unseen first, but answered ones stay in the queue rather than being
    // dropped, so a session never runs dry.
    const fresh = order.filter((puzzle) => !seen.has(puzzle.id));
    const repeats = order.filter((puzzle) => seen.has(puzzle.id));
    return [...fresh, ...repeats].slice(0, size);
  },

  async count(minDifficulty, maxDifficulty, kinds, tags) {
    const { puzzles } = await loadStaticBank();
    return puzzles.filter(
      (puzzle) => inBand(puzzle, minDifficulty, maxDifficulty) && matches(puzzle, kinds, tags),
    ).length;
  },

  async byId(id) {
    const { puzzles } = await loadStaticBank();
    return puzzles.find((puzzle) => puzzle.id === id);
  },

  async byIds(ids) {
    const { puzzles } = await loadStaticBank();
    const wanted = new Set(ids);
    return puzzles.filter((puzzle) => wanted.has(puzzle.id));
  },

  async stats() {
    // No database, so no community difficulty. Not an error.
    return new Map();
  },
};

// -- supabase ----------------------------------------------------------------

/** A puzzles row as the table stores it, mapped back to the site's schema. */
function fromRow(row: Record<string, unknown>): Puzzle {
  const puzzle: Record<string, unknown> = {
    id: row.id,
    schemaVersion: row.schema_version,
    kind: row.kind,
    difficulty: row.difficulty,
    tags: row.tags ?? [],
    position: row.position,
    actions: row.actions,
    acceptedActionIds: row.accepted_action_ids,
    evaluation: row.evaluation,
    source: row.source,
  };
  if (row.best_shanten !== null && row.best_shanten !== undefined) {
    puzzle.bestShanten = row.best_shanten;
  }
  if (row.explanation) puzzle.explanation = row.explanation;
  if (row.history) puzzle.history = row.history;
  return puzzle as unknown as Puzzle;
}

/**
 * Cap on how many answered ids are sent to the sampler.
 *
 * The exclusion list travels in the request, so an unbounded one would grow with
 * a solver's history until the request itself became the problem. Past this many
 * the oldest are dropped: repeating a puzzle answered months ago is a far
 * smaller cost than a request that fails.
 */
const MAX_EXCLUSIONS = 400;

export const supabaseSource: PuzzleSource = {
  kind: 'supabase',

  async meta() {
    const db = await supabase();
    const { data, error } = await db.from('bank_meta').select('*').limit(1).single();
    if (error) throw new Error(`bank_meta: ${error.message}`);
    const row = data as Record<string, unknown>;
    if (row.schema_version !== SCHEMA_VERSION) {
      throw new Error(
        `puzzle bank schema ${row.schema_version} does not match app schema ${SCHEMA_VERSION}`,
      );
    }
    const { data: total, error: countError } = await db.rpc('count_puzzles', {});
    if (countError) throw new Error(`count_puzzles: ${countError.message}`);
    return {
      count: Number(total ?? 0),
      generatedAt: String(row.generated_at),
      provenance: String(row.provenance),
    };
  },

  async session({ size, minDifficulty, maxDifficulty, kinds, tags, onlyIds, excludeIds }) {
    const db = await supabase();

    if (onlyIds?.length) {
      const found = new Map((await this.byIds(onlyIds)).map((puzzle) => [puzzle.id, puzzle]));
      return onlyIds.map((id) => found.get(id)).filter((p): p is Puzzle => Boolean(p));
    }

    const exclude = (excludeIds ?? []).slice(-MAX_EXCLUSIONS);
    const { data, error } = await db.rpc('sample_puzzles', {
      sample_size: size,
      min_difficulty: minDifficulty,
      max_difficulty: maxDifficulty,
      kinds: kinds?.length ? kinds : null,
      any_tags: tags?.length ? tags : null,
      exclude_ids: exclude.length ? exclude : null,
    });
    if (error) throw new Error(`sample_puzzles: ${error.message}`);
    const rows = (data ?? []) as Record<string, unknown>[];
    // Everything unseen is exhausted; fall back to replaying answered ones so the
    // session does not simply end.
    if (rows.length === 0 && exclude.length) {
      return this.session({ size, minDifficulty, maxDifficulty, kinds, tags });
    }
    return rows.map(fromRow);
  },

  async count(minDifficulty, maxDifficulty, kinds, tags) {
    const db = await supabase();
    const { data, error } = await db.rpc('count_puzzles', {
      min_difficulty: minDifficulty,
      max_difficulty: maxDifficulty,
      kinds: kinds?.length ? kinds : null,
      any_tags: tags?.length ? tags : null,
    });
    if (error) throw new Error(`count_puzzles: ${error.message}`);
    return Number(data ?? 0);
  },

  async byId(id) {
    const db = await supabase();
    const { data, error } = await db.from('puzzles').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`puzzles: ${error.message}`);
    return data ? fromRow(data as Record<string, unknown>) : undefined;
  },

  async byIds(ids) {
    if (!ids.length) return [];
    const db = await supabase();
    const { data, error } = await db.from('puzzles').select('*').in('id', ids.slice(0, 500));
    if (error) throw new Error(`puzzles: ${error.message}`);
    return ((data ?? []) as Record<string, unknown>[]).map(fromRow);
  },

  async stats(ids) {
    return fetchPuzzleStats(ids);
  },
};

/**
 * Pick a source, proving the chosen one works before committing to it.
 *
 * The check is a real request rather than a configuration test: credentials can
 * be present and correct while the database is unreachable, and the point of the
 * fallback is to survive exactly that.
 */
export async function openSource(): Promise<PuzzleSource> {
  if (configuredSource() === 'supabase' && isConfigured()) {
    try {
      await supabaseSource.meta();
      return supabaseSource;
    } catch (error) {
      console.warn('[bank] Supabase unavailable, serving the bundled bank:', error);
    }
  }
  return staticSource;
}
