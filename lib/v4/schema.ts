import type postgres from "postgres";

/**
 * V4 幂等自动迁移：在任何 V4 API 首次访问时确保表结构存在。
 * 与 database-v4.sql 保持一致；生产环境无需手动执行 SQL。
 */
export const ensureV4Schema = async (sql: postgres.Sql): Promise<void> => {
  await sql`create extension if not exists pgcrypto`;

  // V2 复用表改造：imported_orders 增加 line_no 与业务去重键
  await sql`alter table public.imported_orders add column if not exists line_no integer`;
  await sql`alter table public.imported_orders add column if not exists updated_at timestamptz not null default now()`;
  await sql`
    create unique index if not exists imported_orders_business_key_idx
    on public.imported_orders (external_code, sku_code, line_no)
    where external_code is not null and external_code <> ''
  `;

  await sql`
    create table if not exists public.sku_master (
      id uuid primary key default gen_random_uuid(),
      sku_code text not null,
      name text not null default '',
      spec text not null default '',
      unit text not null default '',
      created_at timestamptz not null default now()
    )
  `;
  await sql`create unique index if not exists sku_master_sku_code_uq on public.sku_master (sku_code)`;

  await sql`
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
    )
  `;
  await sql`create index if not exists import_tasks_status_created_idx on public.import_tasks (status, created_at desc)`;
  await sql`create index if not exists import_tasks_file_sha256_idx on public.import_tasks (file_sha256)`;

  await sql`
    create table if not exists public.import_task_files (
      task_id text primary key references public.import_tasks(id) on delete cascade,
      file_name text not null default '',
      content_type text not null default '',
      byte_size bigint not null default 0,
      sha256 text not null default '',
      data bytea not null,
      created_at timestamptz not null default now()
    )
  `;

  await sql`
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
    )
  `;
  await sql`create unique index if not exists import_task_batches_task_unit_uq on public.import_task_batches (task_id, unit_id)`;
  await sql`create index if not exists import_task_batches_status_idx on public.import_task_batches (status, task_id)`;

  await sql`
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
    )
  `;
  await sql`create index if not exists import_task_errors_task_unit_idx on public.import_task_errors (task_id, unit_id)`;
  await sql`create index if not exists import_task_errors_error_code_idx on public.import_task_errors (error_code)`;
  await sql`create index if not exists import_task_errors_task_batch_idx on public.import_task_errors (task_id, batch_index)`;

  await sql`
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
    )
  `;
  await sql`create index if not exists event_outbox_status_retry_idx on public.event_outbox (status, next_retry_at)`;
  await sql`create unique index if not exists event_outbox_event_id_uq on public.event_outbox (event_id)`;

  await sql`
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
    )
  `;
  await sql`create index if not exists batch_performance_log_task_unit_idx on public.batch_performance_log (task_id, unit_id)`;
  await sql`create index if not exists batch_performance_log_created_idx on public.batch_performance_log (created_at desc)`;

  await sql`
    create table if not exists public.trace_events (
      id bigint generated always as identity primary key,
      trace_id text not null,
      task_id text not null default '',
      unit_id text not null default '',
      event_name text not null,
      event_status text not null default 'ok',
      message text not null default '',
      occurred_at timestamptz not null default now()
    )
  `;
  await sql`create index if not exists trace_events_trace_occurred_idx on public.trace_events (trace_id, occurred_at)`;
  await sql`create index if not exists trace_events_task_idx on public.trace_events (task_id)`;

  // 调度租约表：Serverless 友好的全局单处理器锁（自动过期，可被接管）
  await sql`
    create table if not exists public.dispatch_lease (
      key integer primary key,
      owner text not null,
      acquired_at timestamptz not null default now(),
      expires_at timestamptz not null
    )
  `;

  // ----------------------------------------------------------
  // 查询性能索引补充（与 database-v4.sql 保持一致，按接口真实查询模式补齐）
  // ----------------------------------------------------------
  // 监控吞吐查询扫描 imported_orders（全库最大表）的 created_at range —— 此前无索引，全表扫描
  await sql`create index if not exists imported_orders_created_at_idx on public.imported_orders (created_at desc)`;
  // 监控错误分布按 created_at 24h 过滤（原 error_code 单列索引无法服务）
  await sql`create index if not exists import_task_errors_created_at_idx on public.import_task_errors (created_at desc)`;
  // 错误明细分页 where task_id order by row_number（原索引不提供 row_number 有序性）
  await sql`create index if not exists import_task_errors_task_row_idx on public.import_task_errors (task_id, row_number)`;
  // 任务列表/监控 recentTasks 全局按时间倒序（原 (status, created_at) 前导列为 status）
  await sql`create index if not exists import_tasks_created_at_idx on public.import_tasks (created_at desc)`;
  // 列表接口覆盖索引：select 的 12 个列全部进 INCLUDE，使 order by created_at desc limit 50
  // 走 index-only scan，免去堆回表（import_tasks 行被高频更新 status/processed_rows，
  // 普通 (created_at) 索引仍会触发堆取，覆盖索引直接消除该往返）。
  await sql`create index if not exists import_tasks_list_cover_idx on public.import_tasks (created_at desc)
    include (id, file_name, status, total_rows, processed_rows, success_rows, failed_rows,
             total_batches, trace_id, degraded, completed_at)`;
  // 慢批次 TOP10：created_at 过滤 + total_duration_ms 排序
  await sql`create index if not exists batch_performance_log_created_duration_idx on public.batch_performance_log (created_at desc, total_duration_ms desc)`;
  // 任务详情批次聚合 where task_id 按 status 分类计数（原 (status, task_id) 前导列为 status）
  await sql`create index if not exists import_task_batches_task_status_idx on public.import_task_batches (task_id, status)`;
};
