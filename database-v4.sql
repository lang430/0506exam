-- ============================================================
-- 万能导入 V4 数据库初始化脚本（异步事件驱动重构）
-- 适用：Supabase Postgres / Neon Postgres / 普通 PostgreSQL
-- 说明：在 V2 database.sql 基础上的增量脚本；应用层也会幂等自动建表（lib/v4/schema.ts）
-- ============================================================

begin;

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- V2 复用表改造：imported_orders（即题面 waybills 运单主表）
-- 新增 line_no（文件全局行号），不破坏已有字段语义
-- ------------------------------------------------------------
alter table public.imported_orders add column if not exists line_no integer;

-- 业务去重键索引：external_order_no(external_code) + sku_code + line_no
-- 仅对存在外部编码的行生效，避免空外部编码行互相冲突
create unique index if not exists imported_orders_business_key_idx
  on public.imported_orders (external_code, sku_code, line_no)
  where external_code is not null and external_code <> '';

-- ------------------------------------------------------------
-- SKU 主数据（压测与批量校验用）
-- ------------------------------------------------------------
create table if not exists public.sku_master (
  id uuid primary key default gen_random_uuid(),
  sku_code text not null,
  name text not null default '',
  spec text not null default '',
  unit text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists sku_master_sku_code_uq on public.sku_master (sku_code);

-- ------------------------------------------------------------
-- 导入任务主表
-- ------------------------------------------------------------
create table if not exists public.import_tasks (
  id text primary key,
  file_name text not null default '',
  rule_id text,
  status text not null default 'pending'
    check (status in ('pending','processing','completed','partial_success','failed')),
  total_rows bigint not null default 0,
  processed_rows bigint not null default 0,
  success_rows bigint not null default 0,
  failed_rows bigint not null default 0,
  total_batches integer not null default 0,
  file_sha256 text,
  trace_id text not null default '',
  degraded boolean not null default false,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists import_tasks_status_created_idx
  on public.import_tasks (status, created_at desc);
create index if not exists import_tasks_file_sha256_idx
  on public.import_tasks (file_sha256);

-- ------------------------------------------------------------
-- 原始文件存储（bytea，供 Worker 复读；10k 行 Excel 约 1~3MB）
-- ------------------------------------------------------------
create table if not exists public.import_task_files (
  task_id text primary key references public.import_tasks(id) on delete cascade,
  file_name text not null default '',
  content_type text not null default '',
  byte_size bigint not null default 0,
  sha256 text not null default '',
  data bytea not null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 处理单元（批次）状态表：PG 原生任务队列的工作项
-- ------------------------------------------------------------
create table if not exists public.import_task_batches (
  id uuid primary key default gen_random_uuid(),
  task_id text not null references public.import_tasks(id) on delete cascade,
  unit_id text not null,
  batch_index integer not null,
  start_row integer not null,
  end_row integer not null,
  status text not null default 'pending'
    check (status in ('pending','ready','processing','completed','failed')),
  retry_count integer not null default 0,
  locked_at timestamptz,
  completed_at timestamptz,
  success_rows bigint not null default 0,
  failed_rows bigint not null default 0,
  sku_check_skipped boolean not null default false
);
create unique index if not exists import_task_batches_task_unit_uq
  on public.import_task_batches (task_id, unit_id);
create index if not exists import_task_batches_status_idx
  on public.import_task_batches (status, task_id);

-- ------------------------------------------------------------
-- 行级错误明细
-- ------------------------------------------------------------
create table if not exists public.import_task_errors (
  id uuid primary key default gen_random_uuid(),
  task_id text not null references public.import_tasks(id) on delete cascade,
  unit_id text not null default '',
  batch_index integer not null default 0,
  row_number integer not null,
  field_name text not null default '',
  raw_value text not null default '',
  error_code text not null,
  error_reason text not null default '',
  suggestion text not null default '',
  trace_id text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists import_task_errors_task_unit_idx
  on public.import_task_errors (task_id, unit_id);
create index if not exists import_task_errors_error_code_idx
  on public.import_task_errors (error_code);
create index if not exists import_task_errors_task_batch_idx
  on public.import_task_errors (task_id, batch_index);

-- ------------------------------------------------------------
-- 本地可靠事件表（Transactional Outbox）
-- ------------------------------------------------------------
create table if not exists public.event_outbox (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  event_type text not null,
  schema_version integer not null default 1,
  aggregate_id text not null,
  trace_id text not null default '',
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending','sent','failed')),
  retry_count integer not null default 0,
  next_retry_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists event_outbox_status_retry_idx
  on public.event_outbox (status, next_retry_at);
create unique index if not exists event_outbox_event_id_uq on public.event_outbox (event_id);

-- ------------------------------------------------------------
-- 处理单元性能日志
-- ------------------------------------------------------------
create table if not exists public.batch_performance_log (
  id uuid primary key default gen_random_uuid(),
  task_id text not null,
  unit_id text not null,
  batch_index integer not null,
  parse_duration_ms integer not null default 0,
  rule_duration_ms integer not null default 0,
  validate_duration_ms integer not null default 0,
  insert_duration_ms integer not null default 0,
  total_duration_ms integer not null default 0,
  success_rows bigint not null default 0,
  failed_rows bigint not null default 0,
  degraded boolean not null default false,
  status text not null default 'completed',
  trace_id text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists batch_performance_log_task_unit_idx
  on public.batch_performance_log (task_id, unit_id);
create index if not exists batch_performance_log_created_idx
  on public.batch_performance_log (created_at desc);

-- ------------------------------------------------------------
-- 链路时间线事件
-- ------------------------------------------------------------
create table if not exists public.trace_events (
  id bigint generated always as identity primary key,
  trace_id text not null,
  task_id text not null default '',
  unit_id text not null default '',
  event_name text not null,
  event_status text not null default 'ok',
  message text not null default '',
  occurred_at timestamptz not null default now()
);
create index if not exists trace_events_trace_occurred_idx
  on public.trace_events (trace_id, occurred_at);
create index if not exists trace_events_task_idx on public.trace_events (task_id);

-- ------------------------------------------------------------
-- updated_at 触发器（复用 V2 函数，若不存在则创建）
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

alter table public.imported_orders add column if not exists updated_at timestamptz not null default now();
drop trigger if exists imported_orders_set_updated_at on public.imported_orders;
create trigger imported_orders_set_updated_at
  before update on public.imported_orders
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- RLS：与 V2 一致，启用并收回 anon/authenticated 直接访问
-- ------------------------------------------------------------
alter table public.sku_master enable row level security;
alter table public.import_tasks enable row level security;
alter table public.import_task_files enable row level security;
alter table public.import_task_batches enable row level security;
alter table public.import_task_errors enable row level security;
alter table public.event_outbox enable row level security;
alter table public.batch_performance_log enable row level security;
alter table public.trace_events enable row level security;

revoke all on table public.sku_master from anon, authenticated;
revoke all on table public.import_tasks from anon, authenticated;
revoke all on table public.import_task_files from anon, authenticated;
revoke all on table public.import_task_batches from anon, authenticated;
revoke all on table public.import_task_errors from anon, authenticated;
revoke all on table public.event_outbox from anon, authenticated;
revoke all on table public.batch_performance_log from anon, authenticated;
revoke all on table public.trace_events from anon, authenticated;

commit;
