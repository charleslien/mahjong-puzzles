#!/usr/bin/env bash
#
# Run one Glicko-2 rating period over every attempt not yet counted.
#
#   ./scripts/rate.sh
#
# Safe to run repeatedly: attempts are stamped `rated_at` as they are counted, so
# a second run in the same minute rates nothing rather than moving every rating
# twice.
#
# There is no scheduler here on purpose. Rating is a batch over a period, and how
# long that period should be is a judgement about how much traffic the site gets
# — running it every few minutes against two attempts produces noise with a
# confidence interval. Wire it to pg_cron or a scheduled function when there is
# enough play to justify a cadence.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env.local ]; then
  echo "no .env.local; see .env.example" >&2
  exit 1
fi
set -a; . ./.env.local; set +a

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SUPABASE_DB_URL is not set" >&2
  exit 1
fi

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -tA -F' ' <<'SQL'
select 'players updated: ' || players_updated,
       'puzzles updated: ' || puzzles_updated,
       'attempts rated: '  || attempts_rated
from public.rate_attempts();
SQL

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -tA -F' | ' <<'SQL'
select 'rated puzzles: ' || count(*) filter (where games > 0),
       'median rating: ' || coalesce(round(percentile_cont(0.5) within group (order by rating) filter (where games > 0))::text, '-'),
       'mean deviation: ' || coalesce(round(avg(rd) filter (where games > 0))::text, '-')
from public.puzzle_ratings;
SQL
