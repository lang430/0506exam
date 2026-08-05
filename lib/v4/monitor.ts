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

type RecoverableQueueDepth = Pick<
  MonitorSummary["queueDepth"],
  "pendingBatches" | "stuckBatches" | "processingBatches" | "readyBatches" | "outboxPending"
>;

/** 仅在消费已经停止时唤醒 Dispatcher；正常处理中的队列由现有自链继续推进。 */
export const shouldWakeDispatcher = (depth: RecoverableQueueDepth): boolean =>
  depth.stuckBatches > 0 || (
    depth.processingBatches === 0 &&
    (depth.pendingBatches > 0 || depth.readyBatches > 0 || depth.outboxPending > 0)
  );

export const getMonitorSummary = async (sql: postgres.Sql): Promise<MonitorSummary> => {
  const stuckSecs = stuckBatchSeconds();
  // 所有看板数据合并为一次 SQL 往返。生产数据库与函数跨区时，原先 8 次顺序查询
  // 会把网络 RTT 线性放大到数秒甚至触发网关超时；各子查询仍保持原统计口径。
  const rows = await sql<{
    throughput: { minute: string; rows: number }[];
    queue_depth: Record<string, number>;
    stage_percentiles: MonitorSummary["stagePercentiles"];
    error_distribution: { errorCode: string; count: number }[];
    recent_tasks: MonitorSummary["recentTasks"];
    slow_batches: MonitorSummary["slowBatches"];
    failed_task_trend: MonitorSummary["failedTaskTrend"];
  }[]>`
    select
      coalesce((
        select jsonb_agg(jsonb_build_object('minute', q.minute, 'rows', q.rows) order by q.minute)
        from (
          select to_char(date_trunc('minute', created_at), 'HH24:MI') as minute, count(*)::int as rows
          from imported_orders
          where created_at > now() - interval '5 minutes'
          group by 1
        ) q
      ), '[]'::jsonb) as throughput,
      (
        select jsonb_build_object(
          'pendingBatches', count(*) filter (where status = 'pending')::int,
          'readyBatches', count(*) filter (where status = 'ready')::int,
          'processingBatches', count(*) filter (where status = 'processing')::int,
          'stuckBatches', count(*) filter (where status = 'processing' and locked_at < now() - make_interval(secs => ${stuckSecs}))::int,
          'waitingRows', coalesce(sum(case when status in ('pending','ready','processing') then greatest(end_row - start_row, 0) end), 0)::bigint,
          'outboxPending', (select count(*)::int from event_outbox where status = 'pending')
        )
        from import_task_batches
      ) as queue_depth,
      (
        select jsonb_build_object(
          'parse', jsonb_build_object('p50', coalesce(percentile_cont(0.5) within group (order by parse_duration_ms)::int, 0), 'p95', coalesce(percentile_cont(0.95) within group (order by parse_duration_ms)::int, 0), 'p99', coalesce(percentile_cont(0.99) within group (order by parse_duration_ms)::int, 0)),
          'rule', jsonb_build_object('p50', coalesce(percentile_cont(0.5) within group (order by rule_duration_ms)::int, 0), 'p95', coalesce(percentile_cont(0.95) within group (order by rule_duration_ms)::int, 0), 'p99', coalesce(percentile_cont(0.99) within group (order by rule_duration_ms)::int, 0)),
          'validate', jsonb_build_object('p50', coalesce(percentile_cont(0.5) within group (order by validate_duration_ms)::int, 0), 'p95', coalesce(percentile_cont(0.95) within group (order by validate_duration_ms)::int, 0), 'p99', coalesce(percentile_cont(0.99) within group (order by validate_duration_ms)::int, 0)),
          'insert', jsonb_build_object('p50', coalesce(percentile_cont(0.5) within group (order by insert_duration_ms)::int, 0), 'p95', coalesce(percentile_cont(0.95) within group (order by insert_duration_ms)::int, 0), 'p99', coalesce(percentile_cont(0.99) within group (order by insert_duration_ms)::int, 0))
        )
        from batch_performance_log
        where created_at > now() - interval '24 hours'
      ) as stage_percentiles,
      coalesce((
        select jsonb_agg(jsonb_build_object('errorCode', e.error_code, 'count', e.c) order by e.c desc)
        from (
          select error_code, count(*)::int as c
          from import_task_errors
          where created_at > now() - interval '24 hours'
          group by error_code
        ) e
      ), '[]'::jsonb) as error_distribution,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', t.id, 'fileName', t.file_name, 'status', t.status, 'totalRows', t.total_rows,
          'processedRows', t.processed_rows, 'successRows', t.success_rows, 'failedRows', t.failed_rows,
          'totalBatches', t.total_batches, 'degraded', t.degraded, 'createdAt', t.created_at,
          'completedAt', t.completed_at
        ) order by t.created_at desc)
        from (
          select id, file_name, status, total_rows, processed_rows, success_rows, failed_rows,
                 total_batches, degraded, created_at, completed_at
          from import_tasks order by created_at desc limit 10
        ) t
      ), '[]'::jsonb) as recent_tasks,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'taskId', p.task_id, 'unitId', p.unit_id, 'batchIndex', p.batch_index,
          'totalDurationMs', p.total_duration_ms, 'parseDurationMs', p.parse_duration_ms,
          'validateDurationMs', p.validate_duration_ms, 'insertDurationMs', p.insert_duration_ms,
          'successRows', p.success_rows, 'failedRows', p.failed_rows, 'createdAt', p.created_at
        ) order by p.total_duration_ms desc)
        from (
          select task_id, unit_id, batch_index, total_duration_ms, parse_duration_ms,
                 validate_duration_ms, insert_duration_ms, success_rows, failed_rows, created_at
          from batch_performance_log
          where created_at > now() - interval '24 hours'
          order by total_duration_ms desc limit 10
        ) p
      ), '[]'::jsonb) as slow_batches,
      coalesce((
        select jsonb_agg(jsonb_build_object('day', f.day, 'count', f.c) order by f.day)
        from (
          select to_char(date_trunc('day', created_at), 'MM-DD') as day, count(*)::int as c
          from import_tasks
          where status = 'failed' and created_at > now() - interval '7 days'
          group by 1
        ) f
      ), '[]'::jsonb) as failed_task_trend
  `;

  const snapshot = rows[0];
  const depth = snapshot?.queue_depth ?? {};
  const waitingRows = Number(depth.waitingRows ?? 0);
  const stuckBatches = Number(depth.stuckBatches ?? 0);
  const warnRows = queueBacklogWarnRows();
  const alertLevel: MonitorSummary["queueDepth"]["alertLevel"] =
    stuckBatches > 0 || waitingRows >= warnRows * 2 ? "critical" :
    waitingRows >= warnRows || Number(depth.outboxPending ?? 0) > 50 ? "warn" :
    "ok";

  return {
    generatedAt: new Date().toISOString(),
    throughput: snapshot?.throughput ?? [],
    queueDepth: {
      pendingBatches: Number(depth.pendingBatches ?? 0),
      readyBatches: Number(depth.readyBatches ?? 0),
      processingBatches: Number(depth.processingBatches ?? 0),
      stuckBatches,
      stuckThresholdSeconds: stuckSecs,
      waitingRows,
      outboxPending: Number(depth.outboxPending ?? 0),
      alertLevel: alertLevel
    },
    stagePercentiles: snapshot?.stage_percentiles ?? {
      parse: { p50: 0, p95: 0, p99: 0 }, rule: { p50: 0, p95: 0, p99: 0 },
      validate: { p50: 0, p95: 0, p99: 0 }, insert: { p50: 0, p95: 0, p99: 0 }
    },
    errorDistribution: snapshot?.error_distribution ?? [],
    recentTasks: snapshot?.recent_tasks ?? [],
    slowBatches: snapshot?.slow_batches ?? [],
    failedTaskTrend: snapshot?.failed_task_trend ?? []
  };
};
