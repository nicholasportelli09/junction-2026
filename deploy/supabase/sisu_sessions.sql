-- Sisu's hosted state: one row per visitor session (lib/store/supabase.ts).
-- Run this once in a Supabase project (SQL editor, or `supabase db query -f deploy/supabase/sisu_sessions.sql`).
-- It can be run again safely.
--
-- A frontend never talks to this database. It talks to the Sisu server, and only the server comes here.
-- The table is closed: row level security is on and there is no policy, so the public key cannot read or write
-- it. The server reaches it through two functions, which ask for the server's own store token.

create table if not exists public.sisu_sessions (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{6,64}$'),
  state jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sisu_sessions enable row level security;
revoke all on public.sisu_sessions from anon, authenticated;

-- The server's password for the two functions below. The publishable key is public by design (it may end up in
-- a web page), so the key alone must not be enough to call them. Only a hash of the password is kept here.
-- While this table is empty the functions are open; set the password once and they are closed to everyone else:
--
--   insert into public.sisu_store_guard (token_hash)
--   values (encode(sha256(convert_to('<the value of SISU_STORE_TOKEN>', 'UTF8')), 'hex'))
--   on conflict (id) do update set token_hash = excluded.token_hash;
create table if not exists public.sisu_store_guard (
  id boolean primary key default true check (id),
  token_hash text not null
);
alter table public.sisu_store_guard enable row level security;
revoke all on public.sisu_store_guard from anon, authenticated;

-- The token arrives in the X-Sisu-Store-Token request header (lib/store/supabase.ts sends it).
create or replace function public.sisu_store_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.sisu_store_guard)
      or exists (select 1 from public.sisu_store_guard g
                 where g.token_hash = encode(sha256(convert_to(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-sisu-store-token', ''), 'UTF8')), 'hex'));
$$;
revoke all on function public.sisu_store_allowed() from public, anon, authenticated;

-- The state and version of one session, or null for a visitor who has none yet.
create or replace function public.sisu_load(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.sisu_store_allowed() then
    raise exception 'sisu: this call needs the server''s store token' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object('state', s.state, 'version', s.version)
    from public.sisu_sessions s
    where s.id = p_session
  );
end;
$$;

-- Stores a session's state if it is still at the version the caller read (0 for a new session).
-- Answers {ok: true, version} when stored. When another server saved first it stores nothing and answers
-- {ok: false, state, version} with what is there now, so the caller can put its change on top and try again.
create or replace function public.sisu_save(p_session text, p_state jsonb, p_expected integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version integer;
  v_state jsonb;
begin
  if not public.sisu_store_allowed() then
    raise exception 'sisu: this call needs the server''s store token' using errcode = '42501';
  end if;
  if p_session is null or p_session !~ '^[A-Za-z0-9_-]{6,64}$' then
    raise exception 'sisu_save: not a session id';
  end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' or octet_length(p_state::text) > 524288 then
    raise exception 'sisu_save: state must be a JSON object of at most 512 kB';
  end if;

  update public.sisu_sessions
    set state = p_state, version = version + 1, updated_at = now()
    where id = p_session and version = p_expected
    returning version into v_version;

  if v_version is null then
    select s.state, s.version into v_state, v_version from public.sisu_sessions s where s.id = p_session;
    if v_version is not null then
      return jsonb_build_object('ok', false, 'state', v_state, 'version', v_version);
    end if;
    -- No row at all: a new session, or one that was cleared. Two servers creating it at once is settled by
    -- the primary key: the second one gets the first one's row back.
    insert into public.sisu_sessions (id, state) values (p_session, p_state)
      on conflict (id) do nothing
      returning version into v_version;
    if v_version is null then
      select s.state, s.version into v_state, v_version from public.sisu_sessions s where s.id = p_session;
      return jsonb_build_object('ok', false, 'state', v_state, 'version', v_version);
    end if;
  end if;

  return jsonb_build_object('ok', true, 'version', v_version);
end;
$$;

-- The functions can be called with the publishable key, but only together with the store token (above).
revoke all on function public.sisu_load(text) from public, authenticated;
revoke all on function public.sisu_save(text, jsonb, integer) from public, authenticated;
grant execute on function public.sisu_load(text) to anon, service_role;
grant execute on function public.sisu_save(text, jsonb, integer) to anon, service_role;

-- Housekeeping, when wanted: delete from public.sisu_sessions where updated_at < now() - interval '7 days';
