-- Glicko-2 difficulty, learned from solve attempts.
--
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/0003_ratings.sql
--
-- Difficulty is currently a proxy computed from the evaluation: margin, policy
-- entropy, how many answers tie. It measures how decisive the *engine* was,
-- which is not the same thing as how often a person gets it wrong — the two come
-- apart badly on positions that are obvious to a search and counterintuitive to
-- a human. This replaces it with the real thing, the way Lichess does: treat
-- each attempt as a game between the solver and the puzzle, and rate both.
--
-- Attempts are trustworthy enough to rate on because correctness is derived by a
-- trigger from the puzzle's own accept set rather than taken from the client
-- (see 0002_attempts.sql). Without that, a rating would measure who was willing
-- to POST "I solved it" in a loop.

-- Glicko-2 system constant. Smaller means volatility moves more slowly.
-- Glickman suggests 0.3-1.2; 0.5 is the usual default.
create or replace function public.glicko2_tau() returns double precision
  language sql immutable as $$ select 0.5::double precision $$;

/**
 * One Glicko-2 rating period.
 *
 * Takes a rating and the opponents faced, returns the updated rating. Written to
 * accept a whole period at once rather than a single game, because that is what
 * the algorithm is defined over — and because it lets the tests run Glickman's
 * own worked example, which uses three opponents, and check the published
 * numbers.
 *
 * scores: 1 for a win, 0 for a loss. A solver "beats" a puzzle by answering it
 * correctly.
 */
create or replace function public.glicko2_update(
  rating      double precision,
  rd          double precision,
  volatility  double precision,
  opp_ratings double precision[],
  opp_rds     double precision[],
  scores      double precision[]
)
returns table (new_rating double precision, new_rd double precision, new_volatility double precision)
language plpgsql
immutable
as $$
declare
  scale    constant double precision := 173.7178;
  tau      constant double precision := public.glicko2_tau();
  epsilon  constant double precision := 0.000001;
  mu       double precision;
  phi      double precision;
  sigma    double precision;
  n        integer;
  i        integer;
  g_j      double precision;
  e_j      double precision;
  mu_j     double precision;
  phi_j    double precision;
  v_inv    double precision := 0;
  v        double precision;
  delta_sum double precision := 0;
  delta    double precision;
  a        double precision;
  alpha    double precision;
  bb       double precision;
  fa       double precision;
  fb       double precision;
  cc       double precision;
  fc       double precision;
  k        integer;
  phi_star double precision;
  phi_new  double precision;
  mu_new   double precision;
begin
  n := coalesce(array_length(opp_ratings, 1), 0);

  -- No games: the rating stands, but confidence in it decays. Skipping this
  -- would leave an untouched puzzle looking permanently well-measured.
  if n = 0 then
    phi := rd / scale;
    phi_star := sqrt(phi * phi + volatility * volatility);
    return query select rating, least(350.0, phi_star * scale), volatility;
    return;
  end if;

  mu    := (rating - 1500.0) / scale;
  phi   := rd / scale;
  sigma := volatility;

  for i in 1..n loop
    mu_j  := (opp_ratings[i] - 1500.0) / scale;
    phi_j := opp_rds[i] / scale;
    g_j   := 1.0 / sqrt(1.0 + 3.0 * phi_j * phi_j / (pi() * pi()));
    e_j   := 1.0 / (1.0 + exp(-g_j * (mu - mu_j)));
    v_inv := v_inv + g_j * g_j * e_j * (1.0 - e_j);
    delta_sum := delta_sum + g_j * (scores[i] - e_j);
  end loop;

  -- Every opponent certain to win or lose gives no information at all.
  if v_inv <= 0 then
    return query select rating, rd, volatility;
    return;
  end if;

  v     := 1.0 / v_inv;
  delta := v * delta_sum;

  -- Volatility, by the Illinois variant of regula falsi. This is the step that
  -- distinguishes Glicko-2 from Glicko: it lets a rating move faster when recent
  -- results are surprising.
  a := ln(sigma * sigma);
  alpha := a;

  if delta * delta > phi * phi + v then
    bb := ln(delta * delta - phi * phi - v);
  else
    k := 1;
    while true loop
      bb := a - k * tau;
      -- f(bb)
      fb := exp(bb) * (delta * delta - phi * phi - v - exp(bb))
            / (2.0 * power(phi * phi + v + exp(bb), 2))
            - (bb - a) / (tau * tau);
      exit when fb >= 0 or k > 100;
      k := k + 1;
    end loop;
  end if;

  fa := exp(alpha) * (delta * delta - phi * phi - v - exp(alpha))
        / (2.0 * power(phi * phi + v + exp(alpha), 2))
        - (alpha - a) / (tau * tau);
  fb := exp(bb) * (delta * delta - phi * phi - v - exp(bb))
        / (2.0 * power(phi * phi + v + exp(bb), 2))
        - (bb - a) / (tau * tau);

  k := 0;
  while abs(bb - alpha) > epsilon and k < 100 loop
    cc := alpha + (alpha - bb) * fa / (fb - fa);
    fc := exp(cc) * (delta * delta - phi * phi - v - exp(cc))
          / (2.0 * power(phi * phi + v + exp(cc), 2))
          - (cc - a) / (tau * tau);
    if fc * fb <= 0 then
      alpha := bb;
      fa := fb;
    else
      fa := fa / 2.0;
    end if;
    bb := cc;
    fb := fc;
    k := k + 1;
  end loop;

  sigma := exp(alpha / 2.0);

  phi_star := sqrt(phi * phi + sigma * sigma);
  phi_new  := 1.0 / sqrt(1.0 / (phi_star * phi_star) + 1.0 / v);
  mu_new   := mu + phi_new * phi_new * delta_sum;

  return query select
    mu_new * scale + 1500.0,
    least(350.0, phi_new * scale),
    sigma;
end;
$$;

-- Ratings for puzzles and for solvers.
create table if not exists public.puzzle_ratings (
  puzzle_id   text primary key references public.puzzles (id) on delete cascade,
  rating      double precision not null,
  rd          double precision not null default 350,
  volatility  double precision not null default 0.06,
  games       integer not null default 0,
  updated_at  timestamptz not null default now()
);

create table if not exists public.player_ratings (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  rating      double precision not null default 1500,
  rd          double precision not null default 350,
  volatility  double precision not null default 0.06,
  games       integer not null default 0,
  updated_at  timestamptz not null default now()
);

-- Which attempts have already been counted. Rating twice would let anyone move a
-- puzzle simply by having the batch run again.
alter table public.attempts add column if not exists rated_at timestamptz;
create index if not exists attempts_unrated_idx on public.attempts (rated_at) where rated_at is null;

alter table public.puzzle_ratings enable row level security;
alter table public.player_ratings enable row level security;

drop policy if exists "puzzle ratings are public" on public.puzzle_ratings;
create policy "puzzle ratings are public"
  on public.puzzle_ratings for select to anon, authenticated using (true);

drop policy if exists "read own rating" on public.player_ratings;
create policy "read own rating"
  on public.player_ratings for select to authenticated
  using (user_id = (select auth.uid()));

-- No write policies: only the rating routine, which runs as definer, may write.

/**
 * Seed a puzzle's rating from the offline difficulty estimate.
 *
 * A new puzzle starting at 1500 with no information would be indistinguishable
 * from an average one, and the first solver's result would swing it wildly. The
 * pipeline's estimate is weak evidence but it is evidence, so it sets the
 * starting point while the deviation stays wide enough for real results to
 * overrule it quickly.
 */
create or replace function public.seed_puzzle_ratings()
returns integer
language sql
security definer
set search_path = public
as $$
  with inserted as (
    insert into public.puzzle_ratings (puzzle_id, rating, rd, volatility)
    select p.id, 1000.0 + p.difficulty * 10.0, 350.0, 0.06
    from public.puzzles p
    where not exists (select 1 from public.puzzle_ratings r where r.puzzle_id = p.id)
    returning 1
  )
  select count(*)::integer from inserted;
$$;

/**
 * Rate every attempt not yet counted.
 *
 * One rating period per call. Both sides are updated against the ratings as they
 * stood at the start, so a solver and a puzzle cannot chase each other within a
 * single batch.
 *
 * Only a solver's *first* attempt at a puzzle counts. Retries are practice, and
 * counting them would let anyone lift their rating by replaying puzzles they
 * have already been shown the answer to.
 */
create or replace function public.rate_attempts()
returns table (players_updated integer, puzzles_updated integer, attempts_rated integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  rated integer := 0;
  players integer := 0;
  puzzles integer := 0;
begin
  perform public.seed_puzzle_ratings();

  -- The attempts in this period: first attempt per (user, puzzle) only, and only
  -- those never rated before.
  create temporary table _period on commit drop as
    select distinct on (a.user_id, a.puzzle_id)
      a.id, a.user_id, a.puzzle_id, a.correct
    from public.attempts a
    where a.rated_at is null
    order by a.user_id, a.puzzle_id, a.created_at;

  -- Anything excluded still gets marked, or it would be reconsidered forever.
  update public.attempts set rated_at = now()
  where rated_at is null;
  get diagnostics rated = row_count;

  if not exists (select 1 from _period) then
    return query select 0, 0, rated;
    return;
  end if;

  insert into public.player_ratings (user_id)
  select distinct user_id from _period
  on conflict (user_id) do nothing;

  -- Snapshot, so both updates see the same starting point. Every input to the
  -- rating function is read from here rather than from the table being updated:
  -- an UPDATE ... FROM cannot reference its own target inside a LATERAL.
  create temporary table _before on commit drop as
    select pr.puzzle_id, pr.rating, pr.rd, pr.volatility from public.puzzle_ratings pr
    where pr.puzzle_id in (select puzzle_id from _period);
  create temporary table _pbefore on commit drop as
    select plr.user_id, plr.rating, plr.rd, plr.volatility from public.player_ratings plr
    where plr.user_id in (select user_id from _period);

  with per_player as (
    select
      p.user_id,
      array_agg(b.rating) as opp_ratings,
      array_agg(b.rd)     as opp_rds,
      array_agg(case when p.correct then 1.0 else 0.0 end) as scores,
      count(*)::integer   as n
    from _period p
    join _before b on b.puzzle_id = p.puzzle_id
    group by p.user_id
  ),
  updated as (
    update public.player_ratings plr
    set rating = g.new_rating,
        rd = g.new_rd,
        volatility = g.new_volatility,
        games = plr.games + pp.n,
        updated_at = now()
    from per_player pp
    join _pbefore pb on pb.user_id = pp.user_id
    cross join lateral public.glicko2_update(
      pb.rating, pb.rd, pb.volatility, pp.opp_ratings, pp.opp_rds, pp.scores
    ) g
    where plr.user_id = pp.user_id
    returning 1
  )
  select count(*)::integer into players from updated;

  with per_puzzle as (
    select
      p.puzzle_id,
      array_agg(pb.rating) as opp_ratings,
      array_agg(pb.rd)     as opp_rds,
      -- Inverted: the puzzle wins when the solver gets it wrong.
      array_agg(case when p.correct then 0.0 else 1.0 end) as scores,
      count(*)::integer    as n
    from _period p
    join _pbefore pb on pb.user_id = p.user_id
    group by p.puzzle_id
  ),
  updated as (
    update public.puzzle_ratings pr
    set rating = g.new_rating,
        rd = g.new_rd,
        volatility = g.new_volatility,
        games = pr.games + pz.n,
        updated_at = now()
    from per_puzzle pz
    join _before b on b.puzzle_id = pz.puzzle_id
    cross join lateral public.glicko2_update(
      b.rating, b.rd, b.volatility, pz.opp_ratings, pz.opp_rds, pz.scores
    ) g
    where pr.puzzle_id = pz.puzzle_id
    returning 1
  )
  select count(*)::integer into puzzles from updated;

  return query select players, puzzles, rated;
end;
$$;

revoke all on function public.rate_attempts() from anon, authenticated;

/**
 * Public difficulty view: the learned rating where there is evidence, and how
 * much evidence there is, so the site can decline to show a figure built on two
 * attempts.
 */
create or replace view public.puzzle_difficulty
with (security_invoker = off) as
  select
    r.puzzle_id,
    round(r.rating)::integer as rating,
    round(r.rd)::integer     as rd,
    r.games,
    s.solve_rate
  from public.puzzle_ratings r
  left join public.puzzle_stats s on s.puzzle_id = r.puzzle_id;

grant select on public.puzzle_difficulty to anon, authenticated;
