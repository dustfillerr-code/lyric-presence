-- v2: profiles, sessions with stored messages, roleplay queues, ratings,
-- report reasons and admin statistics.

alter table public.tg_users
  add column alias          text,
  add column username       text,
  add column first_name     text,
  add column gender         text not null default 'x' check (gender in ('m', 'f', 'x')),
  add column age_group      text check (age_group in ('teen', '18', '25', '35')),
  add column seek_gender    text not null default 'any' check (seek_gender in ('any', 'm', 'f')),
  add column karma          int  not null default 0,
  add column chats_count    int  not null default 0,
  add column msgs_count     int  not null default 0,
  add column accepted_rules boolean not null default false,
  add column pending        text,
  add column queue          text,
  add column last_queue     text,
  add column session_id     bigint,
  add column last_seen      timestamptz not null default now();

create table public.tg_sessions (
  id         bigserial primary key,
  user_a     bigint not null,
  user_b     bigint not null,
  scenario   text,
  role_a     text,
  role_b     text,
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  ended_by   bigint,
  msg_count  int not null default 0
);
create index tg_sessions_started_idx on public.tg_sessions (started_at desc);
create index tg_sessions_active_idx  on public.tg_sessions (id) where ended_at is null;
create index tg_sessions_user_a_idx  on public.tg_sessions (user_a);
create index tg_sessions_user_b_idx  on public.tg_sessions (user_b);

create table public.tg_messages (
  id         bigserial primary key,
  session_id bigint not null references public.tg_sessions (id) on delete cascade,
  sender     bigint not null,
  kind       text not null,
  body       text,
  file_id    text,
  created_at timestamptz not null default now()
);
create index tg_messages_session_idx on public.tg_messages (session_id, id);

create table public.tg_ratings (
  session_id bigint not null references public.tg_sessions (id) on delete cascade,
  rater      bigint not null,
  rated      bigint not null,
  value      smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (session_id, rater)
);

alter table public.tg_reports
  add column reason     text,
  add column session_id bigint;

alter table public.tg_sessions enable row level security;
alter table public.tg_messages enable row level security;
alter table public.tg_ratings  enable row level security;
revoke all on public.tg_sessions, public.tg_messages, public.tg_ratings from anon, authenticated;

drop function public.tg_find_partner(bigint);
drop function public.tg_end_chat(bigint);
drop function public.tg_report(bigint, bigint);

-- Queue the user under p_queue ('random' or 'rp:<scenario>') or pair them with
-- a compatible waiting user. Returns {session_id, partner} or null if queued.
create function public.tg_find_partner(p_chat_id bigint, p_queue text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me        public.tg_users;
  v_partner public.tg_users;
  v_sid     bigint;
begin
  select * into me from public.tg_users where chat_id = p_chat_id for update;
  if not found or me.status = 'chatting' then
    return null;
  end if;

  select * into v_partner
  from public.tg_users u
  where u.status = 'waiting'
    and u.chat_id <> p_chat_id
    and not u.banned
    and u.queue = p_queue
    and (u.age_group = 'teen') = (me.age_group = 'teen')
    and (me.seek_gender = 'any' or u.gender = me.seek_gender)
    and (u.seek_gender = 'any' or me.gender = u.seek_gender)
  order by u.waiting_since
  limit 1
  for update skip locked;

  if not found then
    update public.tg_users
       set status = 'waiting', partner_id = null, session_id = null,
           queue = p_queue, last_queue = p_queue, waiting_since = now()
     where chat_id = p_chat_id;
    return null;
  end if;

  insert into public.tg_sessions (user_a, user_b, scenario)
  values (v_partner.chat_id, p_chat_id,
          case when p_queue like 'rp:%' then substr(p_queue, 4) end)
  returning id into v_sid;

  update public.tg_users
     set status = 'chatting', partner_id = v_partner.chat_id, session_id = v_sid,
         queue = null, last_queue = p_queue, waiting_since = null
   where chat_id = p_chat_id;
  update public.tg_users
     set status = 'chatting', partner_id = p_chat_id, session_id = v_sid,
         queue = null, waiting_since = null
   where chat_id = v_partner.chat_id;

  return jsonb_build_object('session_id', v_sid, 'partner', v_partner.chat_id);
end;
$$;

-- Leave the queue or current chat. Returns {partner, session_id}.
create function public.tg_end_chat(p_chat_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.tg_users;
begin
  select * into me from public.tg_users where chat_id = p_chat_id for update;
  if not found then
    return jsonb_build_object('partner', null, 'session_id', null);
  end if;

  update public.tg_users
     set status = 'idle', partner_id = null, session_id = null, queue = null,
         waiting_since = null,
         chats_count = chats_count + (case when me.status = 'chatting' then 1 else 0 end)
   where chat_id = p_chat_id;

  if me.partner_id is not null then
    update public.tg_users
       set status = 'idle', partner_id = null, session_id = null, queue = null,
           waiting_since = null, chats_count = chats_count + 1
     where chat_id = me.partner_id and partner_id = p_chat_id;
  end if;

  if me.session_id is not null then
    update public.tg_sessions
       set ended_at = now(), ended_by = p_chat_id
     where id = me.session_id and ended_at is null;
  end if;

  return jsonb_build_object('partner', me.partner_id, 'session_id', me.session_id);
end;
$$;

create function public.tg_log_message(
  p_session bigint, p_sender bigint, p_kind text, p_body text, p_file text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tg_messages (session_id, sender, kind, body, file_id)
  values (p_session, p_sender, p_kind, p_body, p_file);
  update public.tg_sessions set msg_count = msg_count + 1 where id = p_session;
  update public.tg_users set msgs_count = msgs_count + 1 where chat_id = p_sender;
end;
$$;

-- Rate the other participant of a session once. Returns true if recorded.
create function public.tg_rate(p_session bigint, p_rater bigint, p_value smallint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rated bigint;
begin
  select case when user_a = p_rater then user_b else user_a end into v_rated
  from public.tg_sessions
  where id = p_session and p_rater in (user_a, user_b);
  if v_rated is null then
    return false;
  end if;

  insert into public.tg_ratings (session_id, rater, rated, value)
  values (p_session, p_rater, v_rated, p_value)
  on conflict do nothing;
  if not found then
    return false;
  end if;

  update public.tg_users set karma = karma + p_value where chat_id = v_rated;
  return true;
end;
$$;

-- Report the other participant of a session; 3 distinct reporters = ban.
-- Returns the reported chat_id, or null if invalid / already reported.
create function public.tg_report(p_reporter bigint, p_session bigint, p_reason text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reported bigint;
begin
  select case when user_a = p_reporter then user_b else user_a end into v_reported
  from public.tg_sessions
  where id = p_session and p_reporter in (user_a, user_b);
  if v_reported is null then
    return null;
  end if;

  insert into public.tg_reports (reporter, reported, reason, session_id)
  values (p_reporter, v_reported, p_reason, p_session)
  on conflict do nothing;
  if not found then
    return null;
  end if;

  if (select count(*) from public.tg_reports where reported = v_reported) >= 3 then
    update public.tg_users set banned = true where chat_id = v_reported;
  end if;
  return v_reported;
end;
$$;

create function public.tg_admin_stats()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'users',           (select count(*) from public.tg_users),
    'new_today',       (select count(*) from public.tg_users where created_at > now() - interval '1 day'),
    'active_today',    (select count(*) from public.tg_users where last_seen > now() - interval '1 day'),
    'waiting',         (select count(*) from public.tg_users where status = 'waiting'),
    'chatting',        (select count(*) from public.tg_users where status = 'chatting'),
    'banned',          (select count(*) from public.tg_users where banned),
    'active_sessions', (select count(*) from public.tg_sessions where ended_at is null),
    'sessions_total',  (select count(*) from public.tg_sessions),
    'sessions_today',  (select count(*) from public.tg_sessions where started_at > now() - interval '1 day'),
    'rp_sessions',     (select count(*) from public.tg_sessions where scenario is not null),
    'messages_total',  (select count(*) from public.tg_messages),
    'messages_today',  (select count(*) from public.tg_messages where created_at > now() - interval '1 day'),
    'reports_total',   (select count(*) from public.tg_reports)
  );
$$;

revoke execute on function public.tg_find_partner(bigint, text)                     from public, anon, authenticated;
revoke execute on function public.tg_end_chat(bigint)                               from public, anon, authenticated;
revoke execute on function public.tg_log_message(bigint, bigint, text, text, text)  from public, anon, authenticated;
revoke execute on function public.tg_rate(bigint, bigint, smallint)                 from public, anon, authenticated;
revoke execute on function public.tg_report(bigint, bigint, text)                   from public, anon, authenticated;
revoke execute on function public.tg_admin_stats()                                  from public, anon, authenticated;
grant  execute on function public.tg_find_partner(bigint, text)                     to service_role;
grant  execute on function public.tg_end_chat(bigint)                               to service_role;
grant  execute on function public.tg_log_message(bigint, bigint, text, text, text)  to service_role;
grant  execute on function public.tg_rate(bigint, bigint, smallint)                 to service_role;
grant  execute on function public.tg_report(bigint, bigint, text)                   to service_role;
grant  execute on function public.tg_admin_stats()                                  to service_role;
