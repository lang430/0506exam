-- 万能导入 V2 数据库初始化脚本
-- 适用：Supabase Postgres / Neon Postgres / 普通 PostgreSQL
-- 执行位置：Supabase Dashboard -> SQL Editor

begin;

create extension if not exists pgcrypto;

create table if not exists public.parse_rules (
  id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  file_name text,
  rule_id text references public.parse_rules(id) on delete set null,
  total_rows bigint not null default 0 check (total_rows >= 0),
  success_rows bigint not null default 0 check (success_rows >= 0),
  failed_rows bigint not null default 0 check (failed_rows >= 0),
  status text not null default 'submitted' check (status in ('draft', 'submitted', 'failed')),
  created_at timestamptz not null default now()
);

create table if not exists public.imported_orders (
  id text primary key,
  batch_id uuid references public.import_batches(id) on delete set null,
  payload jsonb not null,
  external_code text,
  store_name text,
  receiver_name text,
  receiver_phone text,
  receiver_address text,
  sku_code text,
  sku_name text,
  quantity numeric check (quantity is null or quantity > 0),
  spec text,
  remark text,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_usage_events (
  id bigint generated always as identity primary key,
  model text not null,
  created_at timestamptz not null default now()
);

create index if not exists parse_rules_updated_at_idx
  on public.parse_rules (updated_at desc);

create index if not exists imported_orders_external_code_idx
  on public.imported_orders (external_code);

create index if not exists imported_orders_receiver_name_idx
  on public.imported_orders (receiver_name);

create index if not exists imported_orders_created_at_idx
  on public.imported_orders (created_at desc);

create index if not exists imported_orders_payload_gin_idx
  on public.imported_orders using gin (payload);

create index if not exists import_batches_created_at_idx
  on public.import_batches (created_at desc);

create index if not exists ai_usage_events_created_at_idx
  on public.ai_usage_events (created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists parse_rules_set_updated_at on public.parse_rules;
create trigger parse_rules_set_updated_at
before update on public.parse_rules
for each row execute function public.set_updated_at();

drop trigger if exists imported_orders_set_updated_at on public.imported_orders;
create trigger imported_orders_set_updated_at
before update on public.imported_orders
for each row execute function public.set_updated_at();

alter table public.parse_rules enable row level security;
alter table public.import_batches enable row level security;
alter table public.imported_orders enable row level security;
alter table public.ai_usage_events enable row level security;

revoke all on table public.parse_rules from anon, authenticated;
revoke all on table public.import_batches from anon, authenticated;
revoke all on table public.imported_orders from anon, authenticated;
revoke all on table public.ai_usage_events from anon, authenticated;

commit;
