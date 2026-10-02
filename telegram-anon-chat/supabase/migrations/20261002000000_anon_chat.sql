-- Anonymous random-chat Telegram bot: users, pairing and reports.
-- Only the Edge Function (service_role) touches these; RLS with no policies
-- blocks the anon/authenticated API keys entirely.

create table public.tg_users (
  chat_id       bigint primary key,
  status        text not null default 'idle'
                check (status in ('idle', 'waiting', 'chatting')),
  partner_id    bigint,
  waiting_since timestamptz,
  banned        boolean not null default false,
  created_at    timestamptz not null default now()
);

create index tg_users_waiting_idx
  on public.tg_users (waiting_since)
  where status = 'waiting';

create table public.tg_reports (
  id         bigserial primary key,
  reporter   bigint not null,
  reported   bigint not null,
  created_at timestamptz not null default now(),
  unique (reporter, reported)
);

create index tg_reports_reported_idx on public.tg_reports (reported);

alter table public.tg_users   enable row level security;
alter table public.tg_reports enable row level security;
revoke all on public.tg_users, public.tg_reports from anon, authenticated;

-- Put a user in the queue, or pair them with the longest-waiting user.
-- Returns the partner's chat_id, or null if now waiting.
create or replace function public.tg_find_partner(p_chat_id bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_partner bigint;
begin
  insert into public.tg_users (chat_id) values (p_chat_id)
  on conflict (chat_id) do nothing;

  perform 1 from public.tg_users where chat_id = p_chat_id for update;

  select chat_id into v_partner
  from public.tg_users
  where status = 'waiting'
    and chat_id <> p_chat_id
    and not banned
  order by waiting_since
  limit 1
  for update skip locked;

  if v_partner is null then
    update public.tg_users
       set status = 'waiting', partner_id = null, waiting_since = now()
     where chat_id = p_chat_id;
    return null;
  end if;

  update public.tg_users
     set status = 'chatting', partner_id = v_partner, waiting_since = null
   where chat_id = p_chat_id;
  update public.tg_users
     set status = 'chatting', partner_id = p_chat_id, waiting_since = null
   where chat_id = v_partner;
  return v_partner;
end;
$$;

-- Leave the queue or current chat. Returns the ex-partner's chat_id, if any.
create or replace function public.tg_end_chat(p_chat_id bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_partner bigint;
begin
  select partner_id into v_partner
  from public.tg_users where chat_id = p_chat_id for update;

  update public.tg_users
     set status = 'idle', partner_id = null, waiting_since = null
   where chat_id = p_chat_id;

  if v_partner is not null then
    update public.tg_users
       set status = 'idle', partner_id = null, waiting_since = null
     where chat_id = v_partner and partner_id = p_chat_id;
  end if;
  return v_partner;
end;
$$;

-- Record a report; ban the reported user after 3 distinct reporters.
create or replace function public.tg_report(p_reporter bigint, p_reported bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tg_reports (reporter, reported)
  values (p_reporter, p_reported)
  on conflict do nothing;

  if (select count(*) from public.tg_reports where reported = p_reported) >= 3 then
    update public.tg_users set banned = true where chat_id = p_reported;
  end if;
end;
$$;

revoke execute on function public.tg_find_partner(bigint)     from public, anon, authenticated;
revoke execute on function public.tg_end_chat(bigint)         from public, anon, authenticated;
revoke execute on function public.tg_report(bigint, bigint)   from public, anon, authenticated;
grant  execute on function public.tg_find_partner(bigint)     to service_role;
grant  execute on function public.tg_end_chat(bigint)         to service_role;
grant  execute on function public.tg_report(bigint, bigint)   to service_role;
