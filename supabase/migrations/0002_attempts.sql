-- Solve attempts, as the basis for difficulty ratings.
--
-- Apply with:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/0002_attempts.sql
--
-- The design problem this solves is that the client cannot be trusted to report
-- whether it was right. Anyone can POST "I solved it" in a loop, and a Glicko-2
-- rating computed from self-reported results is a rating of who bothered to
-- forge it. So `correct` is never taken from the request: a trigger derives it
-- from the puzzle's own accept set, server-side, and overwrites whatever was
-- sent. Authentication alone would not have fixed this — a signed-in user can
-- lie exactly as easily as an anonymous one.
--
-- Attempts are also append-only. No update or delete policy exists, so a user
-- cannot go back and rewrite a wrong answer into a right one.

create table if not exists public.attempts (
  id          bigint generated always as identity primary key,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  puzzle_id   text        not null references public.puzzles (id) on delete cascade,

  -- What they chose. Validated against the puzzle's action list.
  action_id   text        not null,

  -- Derived server-side by the trigger below; any client-supplied value is
  -- discarded.
  correct     boolean     not null default false,
  loss        double precision,
  grade       text,

  -- Milliseconds from the puzzle appearing to the answer, when the client
  -- reports it. Advisory: it is client-supplied and unverifiable, so it informs
  -- display but must never feed a rating.
  elapsed_ms  integer check (elapsed_ms is null or elapsed_ms >= 0),

  created_at  timestamptz not null default now()
);

create index if not exists attempts_user_idx   on public.attempts (user_id, created_at desc);
create index if not exists attempts_puzzle_idx on public.attempts (puzzle_id);

-- One first-attempt per user per puzzle is what a rating should consider; later
-- retries are practice. This index makes that query cheap.
create index if not exists attempts_first_idx  on public.attempts (puzzle_id, user_id, created_at);

/**
 * Derive correctness from the puzzle rather than trusting the client.
 *
 * Also rejects an action the puzzle does not offer, which catches a stale client
 * pointed at a regenerated bank as well as an outright forgery.
 */
create or replace function public.grade_attempt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  accepted  text[];
  action    jsonb;
  best_ev   double precision;
  this_ev   double precision;
begin
  select p.accepted_action_ids into accepted
  from public.puzzles p where p.id = new.puzzle_id;

  if accepted is null then
    raise exception 'unknown puzzle %', new.puzzle_id;
  end if;

  select a into action
  from public.puzzles p, jsonb_array_elements(p.actions) a
  where p.id = new.puzzle_id and a->>'id' = new.action_id;

  if action is null then
    raise exception 'action % is not offered by puzzle %', new.action_id, new.puzzle_id;
  end if;

  new.correct := new.action_id = any(accepted);

  select max((a->>'ev')::double precision) into best_ev
  from public.puzzles p, jsonb_array_elements(p.actions) a
  where p.id = new.puzzle_id;
  this_ev := (action->>'ev')::double precision;
  new.loss := greatest(0, best_ev - this_ev);

  -- Mirrors THRESHOLDS in src/lib/grade.ts for the placement-point unit. Kept
  -- here so a stored grade cannot disagree with the stored loss.
  new.grade := case
    when new.correct     then 'optimal'
    when new.loss <= 2   then 'good'
    when new.loss <= 5   then 'inaccuracy'
    when new.loss <= 12  then 'mistake'
    else 'blunder'
  end;

  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists grade_attempt_before_insert on public.attempts;
create trigger grade_attempt_before_insert
  before insert on public.attempts
  for each row execute function public.grade_attempt();

alter table public.attempts enable row level security;

drop policy if exists "insert own attempts" on public.attempts;
create policy "insert own attempts"
  on public.attempts for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "read own attempts" on public.attempts;
create policy "read own attempts"
  on public.attempts for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Deliberately no update or delete policy: the log is append-only.

/**
 * Per-puzzle solve statistics, from first attempts only.
 *
 * Exposed as a view so the aggregate is public while individual attempts stay
 * private — a solver may see that 38% of people miss a puzzle without seeing who.
 * security_invoker is off so the view reads past the row policy above; it emits
 * no user identifiers.
 */
create or replace view public.puzzle_stats
with (security_invoker = off) as
  select
    first_attempts.puzzle_id,
    count(*)                                             as attempts,
    count(*) filter (where first_attempts.correct)       as solved,
    round(avg(case when first_attempts.correct then 1 else 0 end)::numeric, 4) as solve_rate
  from (
    select distinct on (a.puzzle_id, a.user_id) a.puzzle_id, a.user_id, a.correct
    from public.attempts a
    order by a.puzzle_id, a.user_id, a.created_at
  ) first_attempts
  group by first_attempts.puzzle_id;

grant select on public.puzzle_stats to anon, authenticated;

/**
 * A signed-in user's own progress summary, for the Progress panel.
 */
create or replace view public.my_progress
with (security_invoker = on) as
  select
    a.user_id,
    count(*)                                   as attempts,
    count(*) filter (where a.correct)          as correct,
    count(distinct a.puzzle_id)                as puzzles_seen,
    avg(a.loss)                                as mean_loss,
    max(a.created_at)                          as last_attempt_at
  from public.attempts a
  group by a.user_id;

grant select on public.my_progress to authenticated;
