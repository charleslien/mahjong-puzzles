/**
 * Upload the generated puzzle bank to Supabase.
 *
 *   node --env-file=.env.local scripts/upload-bank.mjs
 *   node --env-file=.env.local scripts/upload-bank.mjs --dry-run
 *
 * Reads public/puzzles/, the same JSON the static site serves, so the database
 * and the bundled fallback stay the same bank rather than drifting apart.
 *
 * Uses the secret key, which bypasses row-level security — that is the whole
 * reason this runs on your machine and never in a browser or on Vercel. It
 * refuses to start if that key was exposed through a VITE_ prefix, since anything
 * so prefixed is compiled into the shipped bundle.
 *
 * Upserts by id, so re-running after a regeneration updates in place.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BANK_DIR = join(process.cwd(), 'public', 'puzzles');
const BATCH = 100;

const url = process.env.VITE_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const dryRun = process.argv.includes('--dry-run');

if (!url || !secret) {
  console.error('missing VITE_SUPABASE_URL or SUPABASE_SECRET_KEY');
  console.error('run with: node --env-file=.env.local scripts/upload-bank.mjs');
  process.exit(2);
}
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith('VITE_') && value && value.startsWith('sb_secret_')) {
    console.error(`${name} holds a secret key. Anything VITE_-prefixed is compiled`);
    console.error('into the browser bundle, so this key is public. Rotate it.');
    process.exit(2);
  }
}

const headers = {
  apikey: secret,
  Authorization: `Bearer ${secret}`,
  'Content-Type': 'application/json',
};

/** Site schema (camelCase) -> table columns (snake_case). */
function toRow(puzzle) {
  return {
    id: puzzle.id,
    schema_version: puzzle.schemaVersion,
    kind: puzzle.kind,
    difficulty: puzzle.difficulty,
    tags: puzzle.tags ?? [],
    best_shanten: puzzle.bestShanten ?? null,
    position: puzzle.position,
    actions: puzzle.actions,
    accepted_action_ids: puzzle.acceptedActionIds,
    evaluation: puzzle.evaluation,
    source: puzzle.source,
    explanation: puzzle.explanation ?? null,
    history: puzzle.history ?? null,
  };
}

const index = JSON.parse(readFileSync(join(BANK_DIR, 'index.json'), 'utf8'));
const puzzles = [];
for (const shard of index.shards) {
  puzzles.push(...JSON.parse(readFileSync(join(BANK_DIR, shard.file), 'utf8')).puzzles);
}
console.log(`read ${puzzles.length} puzzles from ${index.shards.length} shards`);

if (puzzles.length !== index.count) {
  console.error(`index claims ${index.count} puzzles but the shards hold ${puzzles.length}`);
  process.exit(1);
}
const ids = new Set(puzzles.map((p) => p.id));
if (ids.size !== puzzles.length) {
  console.error('duplicate puzzle ids in the bank');
  process.exit(1);
}

if (dryRun) {
  const sample = toRow(puzzles[0]);
  console.log('dry run; first row would be:');
  for (const [k, v] of Object.entries(sample)) {
    const shown = v === null ? 'null' : typeof v === 'object' ? `${JSON.stringify(v).length} bytes` : String(v);
    console.log(`  ${k.padEnd(20)} ${String(shown).slice(0, 70)}`);
  }
  process.exit(0);
}

let done = 0;
for (let start = 0; start < puzzles.length; start += BATCH) {
  const rows = puzzles.slice(start, start + BATCH).map(toRow);
  const response = await fetch(`${url}/rest/v1/puzzles`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!response.ok) {
    console.error(`\nbatch at ${start} failed: ${response.status} ${await response.text()}`);
    process.exit(1);
  }
  done += rows.length;
  process.stdout.write(`\ruploaded ${done}/${puzzles.length}`);
}
process.stdout.write('\n');

const meta = await fetch(`${url}/rest/v1/bank_meta`, {
  method: 'POST',
  headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify([
    {
      id: true,
      schema_version: index.schemaVersion,
      generated_at: index.generatedAt,
      provenance: index.provenance,
      updated_at: new Date().toISOString(),
    },
  ]),
});
if (!meta.ok) {
  console.error(`bank_meta failed: ${meta.status} ${await meta.text()}`);
  process.exit(1);
}

// Remove rows the regenerated bank no longer contains. Upserting alone leaves
// them behind, and because the site reads the database rather than the JSON,
// stale puzzles would keep being served long after they stopped existing in the
// source — visible only as a puzzle that cannot be found on disk.
const existing = await fetch(`${url}/rest/v1/puzzles?select=id`, { headers });
if (!existing.ok) {
  console.error(`could not list existing rows: ${existing.status}`);
  process.exit(1);
}
const stale = (await existing.json()).map((row) => row.id).filter((id) => !ids.has(id));
if (stale.length) {
  const list = stale.map((id) => `"${id}"`).join(',');
  const removed = await fetch(`${url}/rest/v1/puzzles?id=in.(${list})`, {
    method: 'DELETE',
    headers,
  });
  if (!removed.ok) {
    console.error(`could not remove stale rows: ${removed.status} ${await removed.text()}`);
    process.exit(1);
  }
  console.log(`removed ${stale.length} puzzle(s) no longer in the bank`);
}

const check = await fetch(`${url}/rest/v1/puzzles?select=id`, {
  headers: { ...headers, Prefer: 'count=exact', Range: '0-0' },
});
const total = check.headers.get('content-range')?.split('/')[1] ?? '?';
console.log(`done. rows in table: ${total}`);
if (String(total) !== String(puzzles.length)) {
  console.error(`expected ${puzzles.length}; the table and the bank disagree`);
  process.exit(1);
}
