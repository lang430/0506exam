import type postgres from "postgres";
import { queueBacklogWarnRows, stuckBatchSeconds } from "@/lib/v4/http";

/**
 * 监控聚合查询：吞吐、队列积压、阶段耗时百分位、错误分布。
 * 数据来源均为任务/批次/错误/性能日志的真实聚合。
 */

export interface MonitorSummary {
  generatedAt: string;
  throughput: { minute: string; rows: number }[];
  queueDepth: {
    pendingBatches: number;
    readyBatches: number;
    processingBatches: number;
    stuckBatches: number;
    stuckThresholdSeconds: number;
    waitingRows: number;
    outboxPending: number;
    alertLevel: "ok" | "warn" | "critical";
  };
  stagePercentiles: Record<"parse" | "rule" | "validate" | "insert", { p50: number; p95: number; p99: number }>;
  errorDistribution: { errorCode: string; count: number }[];
  recentTasks: {
    id: string;
    fileName: string;
    status: string;
    totalRows: number;
    processedRows: number;
    successRows: number;
    failedRows: number;
    totalBatches: number;
    degraded: boolean;
    createdAt: string;
    completedAt: string | null;
  }[];
  slowBatches: {
    taskId: string;
    unitId: string;
    batchIndex: number;
    totalDurationMs: number;
    parseDurationMs: number;
    validateDurationMs: number;
    insertDurationMs: number;
    successRows: number;
    failedRows: number;
    createdAt: string;
  }[];
  failedTaskTrend: { day: string; count: number }[];
}

export const getMonitorSummary = async (sql: postgres.Sql): Promise<MonitorSummary> => {
  // 顺序执行：避免 Next 运行时内单连接并发流水线的兼容性风险（生产 RTT 极低，耗时可忽略）
  const throughputRows = await sql<{ minute: string; rows: number }[]>`
    select to_char(date_trunc('minute', created_at), 'HH24:MI') as minute, count(*)::int as rows
    from imported_orders
    where created_at > now() - interval '5 minutes'
    group by 1
    order by 1
  `;
  const stuckSecs = stuckBatchSeconds();
  const depthRows = await sql`
    select
      count(*) filter (where status = 'pending')::int as pending_batches,
      count(*) filter (where status = 'ready')::int as ready_batches,
      count(*) filter (where status = 'processing')::int as processing_batches,
      count(*) filter (where status = 'processing' and locked_at < now() - make_interval(secs => ${stuckSecs}))::int as stuck_batches,
      coalesce(sum(case when status in ('pending','ready','processing') then greatest(end_row - start_row, 0) end), 0)::bigint as waiting_rows
    from import_task_batches
  `;
  const outboxRows = await sql`select count(*)::int as c from event_outbox where status = 'pending'`;
  const percentileRows = await sql`
    select
      percentile_cont(0.5) within group (order by parse_duration_ms)::int as parse_p50,
      percentile_cont(0.95) within group (order by parse_duration_ms)::int as parse_p95,
      percentile_cont(0.99) within group (order by parse_duration_ms)::int as parse_p99,
      percentile_cont(0.5) within group (order by rule_duration_ms)::int as rule_p50,
      percentile_cont(0.95) within group (order by rule_duration_ms)::int as rule_p95,
      percentile_cont(0.99) within group (order by rule_duration_ms)::int as rule_p99,
      percentile_cont(0.5) within group (order by validate_duration_ms)::int as validate_p50,
      percentile_cont(0.95) within group (order by validate_duration_ms)::int as validate_p95,
      percentile_cont(0.99) within group (order by validate_duration_ms)::int as validate_p99,
      percentile_cont(0.5) within group (order by insert_duration_ms)::int as insert_p50,
      percentile_cont(0.95) within group (order by insert_duration_ms)::int as insert_p95,
      percentile_cont(0.99) within group (order by insert_duration_ms)::int as insert_p99
    from batch_performance_log
    where created_at > now() - interval '24 hours'
  `;
  const errorRows = await sql`
    select error_code, count(*)::int as c
    from import_task_errors
    where created_at > now() - interval '24 hours'
    group by error_code
    order by c desc
  `;
  const taskRows = await sql`
    select id, file_name, status, total_rows, processed_rows, success_rows, failed_rows,
           total_batches, degraded, created_at, completed_at
    from import_tasks
    order by created_at desc
    limit 10
  `;
  const slowBatchRows = await sql`
    select task_id, unit_id, batch_index, total_duration_ms, parse_duration_ms,
           validate_duration_ms, insert_duration_ms, success_rows, failed_rows, created_at
    from batch_performance_log
    where created_at > now() - interval '24 hours'
    order by total_duration_ms desc
    limit 10
  `;
  const failedTrendRows = await sql`
    select to_char(date_trunc('day', created_at), 'MM-DD') as day, count(*)::int as c
    from import_tasks
    where status = 'failed' and created_at > now() - interval '7 days'
    group by 1
    order by 1
  `;

  const depth = depthRows[0];
  const waitingRows = Number(depth?.waiting_rows ?? 0);
  const stuckBatches = Number(depth?.stuck_batches ?? 0);
  const warnRows = queueBacklogWarnRows();
  const alertLevel: MonitorSummary["queueDepth"]["alertLevel"] =
    stuckBatches > 0 || waitingRows >= warnRows * 2 ? "critical" :
    waitingRows >= warnRows || Number(outboxRows[0]?.c ?? 0) > 50 ? "warn" :
    "ok";
  const percentile = percentileRows[0];
  const stagePercentiles: MonitorSummary["stagePercentiles"] = {
    parse: { p50: Number(percentile?.parse_p50 ?? 0), p95: Number(percentile?.parse_p95 ?? 0), p99: Number(percentile?.parse_p99 ?? 0) },
    rule: { p50: Number(percentile?.rule_p50 ?? 0), p95: Number(percentile?.rule_p95 ?? 0), p99: Number(percentile?.rule_p99 ?? 0) },
    validate: { p50: Number(percentile?.validate_p50 ?? 0), p95: Number(percentile?.validate_p95 ?? 0), p99: Number(percentile?.validate_p99 ?? 0) },
    insert: { p50: Number(percentile?.insert_p50 ?? 0), p95: Number(percentile?.insert_p95 ?? 0), p99: Number(percentile?.insert_p99 ?? 0) }
  };

  return {
    generatedAt: new Date().toISOString(),
    throughput: throughputRows.map((row) => ({ minute: row.minute, rows: Number(row.rows) })),
    queueDepth: {
      pendingBatches: Number(depth?.pending_batches ?? 0),
      readyBatches: Number(depth?.ready_batches ?? 0),
      processingBatches: Number(depth?.processing_batches ?? 0),
      stuckBatches,
      stuckThresholdSeconds: stuckSecs,
      waitingRows,
      outboxPending: Number(outboxRows[0]?.c ?? 0),
      alertLevel: alertLevel
    },
    stagePercentiles,
    errorDistribution: errorRows.map((row) => ({ errorCode: row.error_code, count: Number(row.c) })),
    recentTasks: taskRows.map((row) => ({
      id: row.id,
      fileName: row.file_name,
      status: row.status,
      totalRows: Number(row.total_rows),
      processedRows: Number(row.processed_rows),
      successRows: Number(row.success_rows),
      failedRows: Number(row.failed_rows),
      totalBatches: Number(row.total_batches),
      degraded: Boolean(row.degraded),
      createdAt: new Date(row.created_at as unknown as string).toISOString(),
      completedAt: row.completed_at ? new Date(row.completed_at as unknown as string).toISOString() : null
    })),
    slowBatches: slowBatchRows.map((row) => ({
      taskId: row.task_id,
      unitId: row.unit_id,
      batchIndex: Number(row.batch_index),
      totalDurationMs: Number(row.total_duration_ms),
      parseDurationMs: Number(row.parse_duration_ms),
      validateDurationMs: Number(row.validate_duration_ms),
      insertDurationMs: Number(row.insert_duration_ms),
      successRows: Number(row.success_rows),
      failedRows: Number(row.failed_rows),
      createdAt: new Date(row.created_at as unknown as string).toISOString()
    })),
    failedTaskTrend: failedTrendRows.map((row) => ({ day: row.day, count: Number(row.c) }))
  };
};
