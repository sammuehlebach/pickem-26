-- Pick'em '26 — database schema. Run once in the Supabase SQL editor (safe to re-run).
--
-- Model: the page talks to the database only through the anon key. Tables are readable only
-- where the pool rules allow (a pick becomes visible when its game kicks off; a tiebreaker
-- guess when the Monday night game kicks off). Writes go exclusively through save_sheet(),
-- which refuses any change to a game that has already started. Identity is honor-system:
-- the page's "Playing as" dropdown, same as the office-pool original.

create table if not exists players (
  slug text primary key,
  name text not null
);

create table if not exists games (
  id      text primary key,          -- ESPN event id
  week    int  not null,
  kickoff timestamptz not null,
  is_mnf  boolean not null default false
);
create index if not exists games_week on games(week);

create table if not exists picks (
  player     text not null references players(slug) on delete cascade,
  game_id    text not null references games(id) on delete cascade,
  side       text not null check (side in ('AWAY','HOME')),
  updated_at timestamptz not null default now(),
  primary key (player, game_id)
);

create table if not exists guesses (
  player     text not null references players(slug) on delete cascade,
  week       int  not null,
  mnf_guess  int  not null check (mnf_guess between 0 and 150),
  updated_at timestamptz not null default now(),
  primary key (player, week)
);

alter table players enable row level security;
alter table games   enable row level security;
alter table picks   enable row level security;
alter table guesses enable row level security;

drop policy if exists players_read on players;
create policy players_read on players for select using (true);

drop policy if exists games_read on games;
create policy games_read on games for select using (true);

drop policy if exists picks_read_after_kickoff on picks;
create policy picks_read_after_kickoff on picks for select using (
  exists (select 1 from games g where g.id = picks.game_id and g.kickoff <= now())
);

drop policy if exists guesses_read_after_mnf on guesses;
create policy guesses_read_after_mnf on guesses for select using (
  exists (select 1 from games g where g.week = guesses.week and g.is_mnf and g.kickoff <= now())
);
-- No insert/update/delete policies: direct table writes are denied. save_sheet() is the door.

-- A player's own sheet for a week, including picks still hidden from everyone else.
create or replace function my_sheet(p_player text, p_week int)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'picks', coalesce((
      select json_object_agg(p.game_id, p.side)
      from picks p join games g on g.id = p.game_id
      where p.player = p_player and g.week = p_week), '{}'::json),
    'mnf_guess', (select mnf_guess from guesses where player = p_player and week = p_week)
  );
$$;

-- Who has submitted this week (counts only — never the picks themselves).
create or replace function week_status(p_week int)
returns table(player text, n int, has_guess boolean)
language sql stable security definer set search_path = public as $$
  select pl.slug,
         (select count(*)::int from picks p join games g on g.id = p.game_id
           where p.player = pl.slug and g.week = p_week),
         exists (select 1 from guesses q where q.player = pl.slug and q.week = p_week)
  from players pl;
$$;

-- Save a player's sheet for a week. p_picks = {"<game id>": "AWAY"|"HOME"|null, ...}; a game
-- missing from p_picks is left as it is. Games that have kicked off are never changed; the
-- tiebreaker guess locks at the Monday night kickoff. Returns what was applied and refused.
create or replace function save_sheet(p_player text, p_week int, p_picks jsonb, p_guess int default null, p_set_guess boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare
  g record;
  v text;
  n_saved int := 0;
  locked text[] := '{}';
  mnf_started boolean;
begin
  if not exists (select 1 from players where slug = p_player) then
    raise exception 'unknown player %', p_player using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_picks, '{}'::jsonb)) <> 'object' then
    raise exception 'picks must be an object' using errcode = '22023';
  end if;

  for g in select * from games where week = p_week and p_picks ? id loop
    v := p_picks ->> g.id;
    if v is not null and v not in ('AWAY','HOME') then
      raise exception 'bad side % for game %', v, g.id using errcode = '22023';
    end if;
    if g.kickoff <= now() then
      -- Locked: only report it if the request actually tries to change it.
      if v is distinct from (select side from picks where player = p_player and game_id = g.id) then
        locked := locked || g.id;
      end if;
      continue;
    end if;
    if v is null then
      delete from picks where player = p_player and game_id = g.id;
    else
      insert into picks(player, game_id, side) values (p_player, g.id, v)
      on conflict (player, game_id) do update set side = excluded.side, updated_at = now()
      where picks.side is distinct from excluded.side;
      n_saved := n_saved + 1;
    end if;
  end loop;

  if p_set_guess then
    select coalesce(bool_or(kickoff <= now()), false) into mnf_started from games where week = p_week and is_mnf;
    if mnf_started then
      if p_guess is distinct from (select mnf_guess from guesses where player = p_player and week = p_week) then
        locked := locked || 'mnf'::text;
      end if;
    elsif p_guess is null then
      delete from guesses where player = p_player and week = p_week;
    else
      if p_guess < 0 or p_guess > 150 then
        raise exception 'tiebreaker must be 0-150' using errcode = '22023';
      end if;
      insert into guesses(player, week, mnf_guess) values (p_player, p_week, p_guess)
      on conflict (player, week) do update set mnf_guess = excluded.mnf_guess, updated_at = now();
    end if;
  end if;

  return json_build_object('saved', n_saved, 'locked', to_json(locked));
end;
$$;

revoke all on function my_sheet(text, int) from public;
revoke all on function week_status(int) from public;
revoke all on function save_sheet(text, int, jsonb, int, boolean) from public;
grant execute on function my_sheet(text, int) to anon, authenticated;
grant execute on function week_status(int) to anon, authenticated;
grant execute on function save_sheet(text, int, jsonb, int, boolean) to anon, authenticated;
grant select on players, games, picks, guesses to anon, authenticated;
