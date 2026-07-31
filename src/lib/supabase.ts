/**
 * Supabase client: puzzles, auth, and attempt recording.
 *
 * The key shipped here is the *publishable* key. It is compiled into this bundle
 * and readable by anyone, which is safe only because row-level security is
 * enabled on every table. Verified rather than assumed: with this key, a delete
 * against a real row reports HTTP 204 and leaves the row untouched, because RLS
 * makes the row invisible rather than refusing the request. A check that read
 * only the status code would have concluded the opposite.
 *
 * PKCE is selected explicitly. The implicit OAuth flow returns tokens in the URL
 * *fragment* (`#access_token=...`), and this app routes on the fragment too
 * (`#/train`), so the two collide — the router would try to navigate to a route
 * named after an access token. PKCE returns `?code=...` in the query string
 * instead, leaving the fragment alone.
 */

import type { Session, SupabaseClient } from '@supabase/supabase-js';

const URL_BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** Rows per request. PostgREST caps responses server-side; paging is explicit. */
const PAGE_SIZE = 500;

export function isConfigured(): boolean {
  return Boolean(URL_BASE && PUBLISHABLE_KEY);
}

let client: Promise<SupabaseClient> | undefined;

/**
 * The client, imported on first use.
 *
 * Loaded through a dynamic import so the library lands in its own chunk rather
 * than the main bundle: it costs 57 kB gzipped, which is 78% on top of the
 * entire rest of the app. A deployment serving bundled JSON to a signed-out
 * visitor never needs it, and should not pay for it — the same reasoning that
 * kept the puzzle bank small. Signing in, or reading puzzles from the database,
 * fetches it then.
 *
 * The type-only import above is erased at build time, so it does not pull the
 * library into the main chunk.
 */
export async function supabase(): Promise<SupabaseClient> {
  if (!isConfigured()) throw new Error('Supabase is not configured');
  client ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(URL_BASE as string, PUBLISHABLE_KEY as string, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }),
  );
  return client;
}

/**
 * Whether this browser could possibly have a session, without loading the client.
 *
 * supabase-js persists its session in localStorage under `sb-<ref>-auth-token`.
 * If no such key exists the visitor is definitely signed out, and asking the
 * library to confirm that would mean downloading 57 kB to learn nothing. The
 * PKCE callback also leaves a code verifier there, and arrives with `?code=` in
 * the query string, so both cases still load the client.
 *
 * Wrong only in the safe direction: a stale or expired token loads the client and
 * resolves to signed out, which is the same outcome by a slower route.
 */
export function mayHaveSession(): boolean {
  if (!isConfigured()) return false;
  try {
    if (new URLSearchParams(window.location.search).has('code')) return true;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.includes('-auth-token')) return true;
    }
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). Assume no
    // session rather than failing; signing in still works on demand.
  }
  return false;
}

/** Which source the site should read puzzles from. */
export function puzzleSource(): 'static' | 'supabase' {
  const configured = (import.meta.env.VITE_PUZZLE_SOURCE as string | undefined) ?? 'static';
  // Asking for supabase without credentials is a misconfiguration, not a request
  // to fail: fall back rather than break the page.
  if (configured === 'supabase' && isConfigured()) return 'supabase';
  return 'static';
}

/** A puzzles row, as the table stores it. */
interface PuzzleRow {
  id: string;
  schema_version: number;
  kind: string;
  difficulty: number;
  tags: string[];
  best_shanten: number | null;
  position: unknown;
  actions: unknown;
  accepted_action_ids: string[];
  evaluation: unknown;
  source: unknown;
  explanation: string | null;
  history: unknown;
}

export interface BankMetaRow {
  schema_version: number;
  generated_at: string;
  provenance: string;
}

/** Table columns -> the site's schema. */
function fromRow(row: PuzzleRow): Record<string, unknown> {
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
  if (row.best_shanten !== null) puzzle.bestShanten = row.best_shanten;
  if (row.explanation) puzzle.explanation = row.explanation;
  if (row.history) puzzle.history = row.history;
  return puzzle;
}

/**
 * Every puzzle, paged.
 *
 * Deliberately not one request with a large limit: PostgREST applies its own
 * maximum, so a single request silently returns a truncated page once the table
 * outgrows it — which looks exactly like a smaller bank rather than an error.
 */
export async function fetchPuzzles(): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const db = await supabase();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await db
      .from('puzzles')
      .select('*')
      .order('id')
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`puzzles: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as PuzzleRow[]).map(fromRow));
    if (data.length < PAGE_SIZE) break;
  }
  return out;
}

export async function fetchBankMeta(): Promise<BankMetaRow> {
  const db = await supabase();
  const { data, error } = await db.from('bank_meta').select('*').limit(1).single();
  if (error) throw new Error(`bank_meta: ${error.message}`);
  return data as BankMetaRow;
}

// -- auth --------------------------------------------------------------------

export async function currentSession(): Promise<Session | null> {
  if (!isConfigured()) return null;
  const db = await supabase();
  const { data } = await db.auth.getSession();
  return data.session;
}

/**
 * Subscribe to sign-in and sign-out.
 *
 * Returns a synchronous unsubscribe even though the client loads asynchronously,
 * so a component that mounts and unmounts before the chunk arrives still tears
 * down cleanly instead of leaking a subscription.
 */
export function onAuthChange(handler: (session: Session | null) => void): () => void {
  if (!isConfigured()) return () => {};
  let cancelled = false;
  let unsubscribe: (() => void) | undefined;

  void supabase()
    .then((db) => {
      if (cancelled) return;
      const { data } = db.auth.onAuthStateChange((_event, session) => handler(session));
      unsubscribe = () => data.subscription.unsubscribe();
    })
    .catch(() => {
      // Never surfaced: no session simply means signed out.
    });

  return () => {
    cancelled = true;
    unsubscribe?.();
  };
}

/**
 * Whether the project actually has Google configured.
 *
 * signInWithOAuth does not check — it redirects the browser straight to the
 * authorize endpoint, so a project with the provider switched off dumps the user
 * on a raw JSON error page with no way back. Asking first turns that into a
 * message beside the button.
 */
export async function googleEnabled(): Promise<boolean> {
  if (!isConfigured()) return false;
  try {
    const response = await fetch(`${URL_BASE}/auth/v1/settings`, {
      headers: { apikey: PUBLISHABLE_KEY as string },
    });
    if (!response.ok) return false;
    const settings = (await response.json()) as { external?: Record<string, boolean> };
    return Boolean(settings.external?.google);
  } catch {
    return false;
  }
}

export async function signInWithGoogle(): Promise<void> {
  if (!(await googleEnabled())) {
    throw new Error('Google sign-in is not enabled for this project yet.');
  }
  // Return to the training view rather than wherever the flow started, so the
  // redirect never lands on a puzzle the solver has already answered.
  const redirectTo = `${window.location.origin}${window.location.pathname}#/train`;
  const db = await supabase();
  const { error } = await db.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo },
  });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  const db = await supabase();
  await db.auth.signOut();
}

// -- attempts ----------------------------------------------------------------

export interface RecordedAttempt {
  puzzleId: string;
  actionId: string;
  elapsedMs?: number;
}

/**
 * Record one answered puzzle.
 *
 * Note what is *not* sent: whether it was correct, the loss, or the grade. A
 * database trigger derives all three from the puzzle's own accept set and
 * discards anything the client claims, so a forged "I solved it" is stored as
 * the miss it actually was. Signing in does not make a client honest — a
 * signed-in user can lie exactly as easily as an anonymous one — so the check
 * lives server-side.
 */
export async function recordAttempt(attempt: RecordedAttempt): Promise<boolean> {
  const session = await currentSession();
  if (!session) return false;
  const db = await supabase();
  const { error } = await db.from('attempts').insert({
    user_id: session.user.id,
    puzzle_id: attempt.puzzleId,
    action_id: attempt.actionId,
    elapsed_ms: attempt.elapsedMs ?? null,
  });
  if (error) throw new Error(`attempts: ${error.message}`);
  return true;
}

export interface RemoteProgress {
  attempts: number;
  correct: number;
  puzzles_seen: number;
  mean_loss: number | null;
  last_attempt_at: string | null;
}

export async function fetchMyProgress(): Promise<RemoteProgress | null> {
  const session = await currentSession();
  if (!session) return null;
  const db = await supabase();
  const { data, error } = await db.from('my_progress').select('*').maybeSingle();
  if (error) throw new Error(`my_progress: ${error.message}`);
  return (data as RemoteProgress) ?? null;
}

// -- community difficulty ----------------------------------------------------

export interface PuzzleStats {
  puzzleId: string;
  rating: number;
  rd: number;
  games: number;
  solveRate: number | null;
}

/**
 * Learned difficulty per puzzle, from real solve attempts.
 *
 * Absent for a static deployment, and empty until people have played, so every
 * caller has to cope with having none — the offline estimate remains the
 * fallback rather than the exception.
 */
export async function fetchPuzzleStats(ids?: string[]): Promise<Map<string, PuzzleStats>> {
  const out = new Map<string, PuzzleStats>();
  if (!isConfigured()) return out;
  if (ids && ids.length === 0) return out;
  const db = await supabase();
  let query = db
    .from('puzzle_difficulty')
    .select('puzzle_id,rating,rd,games,solve_rate')
    .gt('games', 0);
  // Scoped to the session's puzzles: fetching every rating would reintroduce the
  // whole-bank request that sampling exists to avoid.
  if (ids) query = query.in('puzzle_id', ids.slice(0, 500));
  const { data, error } = await query;
  if (error) throw new Error(`puzzle_difficulty: ${error.message}`);
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    out.set(row.puzzle_id as string, {
      puzzleId: row.puzzle_id as string,
      rating: Number(row.rating),
      rd: Number(row.rd),
      games: Number(row.games),
      solveRate: row.solve_rate === null ? null : Number(row.solve_rate),
    });
  }
  return out;
}

export interface PlayerRating {
  rating: number;
  rd: number;
  games: number;
}

export async function fetchMyRating(): Promise<PlayerRating | null> {
  const session = await currentSession();
  if (!session) return null;
  const db = await supabase();
  const { data, error } = await db
    .from('player_ratings')
    .select('rating,rd,games')
    .maybeSingle();
  if (error) throw new Error(`player_ratings: ${error.message}`);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return { rating: Number(row.rating), rd: Number(row.rd), games: Number(row.games) };
}

/**
 * Send attempts answered while signed out.
 *
 * Correctness is still derived server-side, so nothing about the grade travels;
 * these are just "this person answered this puzzle this way". Returns the
 * timestamps that were accepted, so the caller can mark them and not send them
 * again.
 */
export async function backfillAttempts(
  attempts: Array<{ puzzleId: string; actionId: string; at: number }>,
): Promise<number[]> {
  if (!attempts.length) return [];
  const session = await currentSession();
  if (!session) return [];
  const db = await supabase();

  const accepted: number[] = [];
  // In chunks, because one malformed row fails a whole insert and a solver with
  // a long offline history should not lose all of it to one bad record.
  const CHUNK = 50;
  for (let start = 0; start < attempts.length; start += CHUNK) {
    const slice = attempts.slice(start, start + CHUNK);
    const { error } = await db.from('attempts').insert(
      slice.map((attempt) => ({
        user_id: session.user.id,
        puzzle_id: attempt.puzzleId,
        action_id: attempt.actionId,
      })),
    );
    if (!error) accepted.push(...slice.map((attempt) => attempt.at));
  }
  return accepted;
}
