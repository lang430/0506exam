import type postgres from "postgres";

/**
 * 链路追踪：trace_events 写入 + 结构化控制台日志。
 * traceId 贯穿 上传 API → Outbox → Dispatcher → Worker → DB 写入。
 */

export interface TraceEventInput {
  traceId: string;
  taskId?: string;
  unitId?: string;
  eventName: string;
  eventStatus?: "ok" | "error" | "warn";
  message?: string;
}

export const recordTraceEvent = async (
  sql: postgres.Sql,
  input: TraceEventInput
): Promise<void> => {
  try {
    await sql`
      insert into trace_events (trace_id, task_id, unit_id, event_name, event_status, message)
      values (
        ${input.traceId},
        ${input.taskId ?? ""},
        ${input.unitId ?? ""},
        ${input.eventName},
        ${input.eventStatus ?? "ok"},
        ${input.message ?? ""}
      )
    `;
  } catch (error) {
    console.error("[trace] record failed", error instanceof Error ? error.message : error);
  }
  console.info(
    `[v4] trace=${input.traceId} task=${input.taskId ?? "-"} unit=${input.unitId ?? "-"} ${input.eventName} ${input.eventStatus ?? "ok"} ${input.message ?? ""}`
  );
};

/** 批量写入 trace 事件（减少往返） */
export const recordTraceEvents = async (
  sql: postgres.Sql,
  events: TraceEventInput[]
): Promise<void> => {
  if (!events.length) return;
  try {
    const rows = events.map((event) => ({
      trace_id: event.traceId,
      task_id: event.taskId ?? "",
      unit_id: event.unitId ?? "",
      event_name: event.eventName,
      event_status: event.eventStatus ?? "ok",
      message: event.message ?? ""
    }));
    await sql`insert into trace_events ${sql(rows, "trace_id", "task_id", "unit_id", "event_name", "event_status", "message")}`;
  } catch (error) {
    console.error("[trace] batch record failed", error instanceof Error ? error.message : error);
  }
};

export const newTraceId = (): string =>
  `trace_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

export const newTaskId = (): string =>
  `task_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
