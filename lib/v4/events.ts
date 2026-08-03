/**
 * V4 事件契约：统一事件信封 + 事件类型定义（schema_version=1）
 * 版本策略：新增字段向后兼容；消费者必须忽略未知字段；
 * 重大字段语义变化需升级 schema_version（见 README）。
 */

export const V4_EVENT_SCHEMA_VERSION = 1;

export const ImportEvents = {
  ImportTaskCreated: "ImportTaskCreated",
  ImportBatchCreated: "ImportBatchCreated",
  ImportBatchStarted: "ImportBatchStarted",
  ImportBatchSucceeded: "ImportBatchSucceeded",
  ImportBatchFailed: "ImportBatchFailed",
  ImportTaskCompleted: "ImportTaskCompleted",
  ImportTaskPartialSuccess: "ImportTaskPartialSuccess",
  ImportTaskDegraded: "ImportTaskDegraded"
} as const;

export type ImportEventType = (typeof ImportEvents)[keyof typeof ImportEvents];

export interface EventEnvelope<P = Record<string, unknown>> {
  event_id: string;
  event_type: ImportEventType;
  schema_version: number;
  aggregate_id: string;
  trace_id: string;
  occurred_at: string;
  payload: P;
}

export interface TaskCreatedPayload {
  task_id: string;
  file_name: string;
  rule_id: string | null;
  total_rows: number;
  total_batches: number;
  batch_size: number;
  file_sha256: string;
}

export interface BatchCreatedPayload {
  task_id: string;
  unit_id: string;
  batch_index: number;
  start_row: number;
  end_row: number;
}

export interface BatchResultPayload {
  task_id: string;
  unit_id: string;
  batch_index: number;
  success_rows: number;
  failed_rows: number;
  duration_ms: number;
  degraded: boolean;
  error?: string;
}

export interface TaskFinishedPayload {
  task_id: string;
  status: "completed" | "partial_success" | "failed";
  success_rows: number;
  failed_rows: number;
  degraded: boolean;
}

export const buildEnvelope = <P>(
  eventType: ImportEventType,
  aggregateId: string,
  traceId: string,
  payload: P
): EventEnvelope<P> => ({
  event_id: `evt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
  event_type: eventType,
  schema_version: V4_EVENT_SCHEMA_VERSION,
  aggregate_id: aggregateId,
  trace_id: traceId,
  occurred_at: new Date().toISOString(),
  payload
});

/** 消费者侧：宽松读取 payload，忽略未知字段（向后兼容） */
export const readPayloadField = <T>(payload: unknown, key: string, fallback: T): T => {
  if (!payload || typeof payload !== "object") return fallback;
  const value = (payload as Record<string, unknown>)[key];
  return (value === undefined || value === null ? fallback : value) as T;
};
