import { NextResponse } from "next/server";
import { dbUnavailable, getV4Sql } from "@/lib/v4/http";
import { getMonitorSummary, QUEUE_BACKLOG_WARN_ROWS } from "@/lib/v4/monitor";

export const runtime = "nodejs";

/** GET /api/import-monitor/summary —— 监控聚合：吞吐 / 队列积压 / 阶段耗时百分位 / 错误分布 */
export async function GET() {
  const t0 = Date.now();
  try {
    console.log("[monitor] route start");
    const sql = await getV4Sql();
    console.log("[monitor] sql ready", Date.now() - t0, "ms");
    if (!sql) return dbUnavailable();
    const summary = await getMonitorSummary(sql);
    console.log("[monitor] summary done", Date.now() - t0, "ms");
    return NextResponse.json(summary);
  } catch (error) {
    console.error("[monitor] failed", Date.now() - t0, "ms", error);
    // 队列/数据库不可用 → 红色告警（考点 5 告警能力）
    return NextResponse.json({
      alertLevel: "critical",
      error: error instanceof Error ? error.message : "监控聚合失败",
      hint: "数据库或队列不可用，请检查连接配置",
      backlogWarnThreshold: QUEUE_BACKLOG_WARN_ROWS
    }, { status: 503 });
  }
}
