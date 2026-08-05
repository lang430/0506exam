import { NextResponse, after } from "next/server";
import postgres from "postgres";
import { getDatabaseUrl } from "@/lib/db";
import { dbUnavailable, dispatcherTriggerTimeoutMs, getV4Sql, queueBacklogWarnRows } from "@/lib/v4/http";
import { getMonitorSummary, shouldWakeDispatcher, type MonitorSummary } from "@/lib/v4/monitor";

export const runtime = "nodejs";

/** GET /api/import-monitor/summary —— 监控聚合：吞吐 / 队列积压 / 阶段耗时百分位 / 错误分布 */
const wakeDispatcherIfNeeded = (request: Request, summary: MonitorSummary): void => {
  if (!shouldWakeDispatcher(summary.queueDepth)) return;
  const token = process.env.DISPATCHER_TOKEN;
  if (!token) {
    console.error("[monitor] dispatcher recovery skipped: DISPATCHER_TOKEN missing");
    return;
  }
  const origin = new URL(request.url).origin;
  after(async () => {
    try {
      await fetch(`${origin}/api/import-dispatcher`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(dispatcherTriggerTimeoutMs())
      });
    } catch (error) {
      console.error("[monitor] dispatcher recovery trigger failed", error instanceof Error ? error.message : error);
    }
  });
};

export async function GET(request: Request) {
  const t0 = Date.now();
  try {
    console.log("[monitor] route start");
    const sql = await getV4Sql();
    console.log("[monitor] sql ready", Date.now() - t0, "ms");
    if (!sql) return dbUnavailable();
    const summary = await getMonitorSummary(sql);
    wakeDispatcherIfNeeded(request, summary);
    console.log("[monitor] summary done", Date.now() - t0, "ms");
    return NextResponse.json(summary);
  } catch (error) {
    console.error("[monitor] first attempt failed", Date.now() - t0, "ms", error);
    // 重试一次：独立新建连接，规避单例客户端连接中断/重连竞态
    const url = getDatabaseUrl();
    if (url) {
      const fresh = postgres(url, { ssl: "require", max: 1, connect_timeout: 5 });
      try {
        const summary = await getMonitorSummary(fresh);
        wakeDispatcherIfNeeded(request, summary);
        console.log("[monitor] retry done", Date.now() - t0, "ms");
        return NextResponse.json(summary);
      } catch (retryError) {
        console.error("[monitor] retry failed", Date.now() - t0, "ms", retryError);
      } finally {
        await fresh.end().catch(() => undefined);
      }
    }
    // 队列/数据库不可用 → 红色告警（考点 5 告警能力）
    return NextResponse.json({
      alertLevel: "critical",
      error: error instanceof Error ? error.message : "监控聚合失败",
      hint: "数据库或队列不可用，请检查连接配置",
      backlogWarnThreshold: queueBacklogWarnRows()
    }, { status: 503 });
  }
}
