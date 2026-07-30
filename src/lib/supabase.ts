/**
 * Minimal Supabase (PostgREST) client.
 *
 * Hand-rolled rather than pulling in @supabase/supabase-js: this needs three
 * GETs against a public table, and the whole point of the recent bank work was
 * to keep what the browser downloads small. If sessions and token refresh arrive
 * with user accounts, that calculus changes and the official client earns its
 * weight — hand-rolling auth would not be a good trade.
 *
 * The key here is the *publishable* key. It is compiled into this bundle and is
 * readable by anyone, which is safe only because row-level security is enabled
 * on every table and grants nothing but select. Verified rather than assumed:
 * with this key a delete against a real row reports HTTP 204 and leaves the row
 * untouched, because RLS makes it invisible rather than refusing the request.
 */

const URL_BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** Rows per request. PostgREST caps responses server-side; paging is explicit. */
const PAGE_SIZE = 500;

export function isConfigured(): boolean {
  return Boolean(URL_BASE && PUBLISHABLE_KEY);
}

/** Which source the site should read puzzles from. */
export function puzzleSource(): 'static' | 'supabase' {
  const configured = (import.meta.env.VITE_PUZZLE_SOURCE as string | undefined) ?? 'static';
  // Asking for supabase without credentials is a misconfiguration, not a
  // request to fail: fall back rather than break the page.
  if (configured === 'supabase' && isConfigured()) return 'supabase';
  return 'static';
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: PUBLISHABLE_KEY as string,
    Authorization: `Bearer ${PUBLISHABLE_KEY as string}`,
    ...extra,
  };
}

export class SupabaseError extends Error {}

async function get<T>(path: string, range?: [number, number]): Promise<{ rows: T[]; total?: number }> {
  const response = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    headers: headers(
      range ? { Range: `${range[0]}-${range[1]}`, Prefer: 'count=exact' } : undefined,
    ),
  });
  if (!response.ok) {
    throw new SupabaseError(`${path}: ${response.status} ${response.statusText}`);
  }
  const rows = (await response.json()) as T[];
  // "0-499/897" — the figure after the slash is the unfiltered total, which is
  // how a truncated page is told apart from a complete one.
  const total = Number(response.headers.get('content-range')?.split('/')[1]);
  return { rows, total: Number.isFinite(total) ? total : undefined };
}

/**
 * Fetch every row of a table, paging until the server says we have them all.
 *
 * Deliberately not a single request with a large limit: PostgREST applies its
 * own maximum, so one request returns a silently truncated page once the table
 * outgrows it. That would look exactly like a smaller bank.
 */
async function getAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { rows, total } = await get<T>(path, [offset, offset + PAGE_SIZE - 1]);
    out.push(...rows);
    if (rows.length === 0) break;
    if (total !== undefined && out.length >= total) break;
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
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

interface BankMetaRow {
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

export async function fetchPuzzles(): Promise<Record<string, unknown>[]> {
  const rows = await getAll<PuzzleRow>('puzzles?select=*&order=id');
  return rows.map(fromRow);
}

export async function fetchBankMeta(): Promise<BankMetaRow> {
  const { rows } = await get<BankMetaRow>('bank_meta?select=*&limit=1');
  if (!rows.length) throw new SupabaseError('bank_meta is empty');
  return rows[0];
}
