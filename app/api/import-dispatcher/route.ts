import { NextResponse, after } from "next/server";
import { dbUnavailable, dispatcherBudgetMs, dispatcherMaxBatches, dispatcherTriggerTimeoutMs, getV4Sql, verifyDispatcherToken } from "@/lib/v4/http";
import { runDispatchCycle } from "@/lib/v4/dispatch";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/import-dispatcher —— Outbox 投递 + 批次处理调度端点（Bearer DISPATCHER_TOKEN）
 * 触发方式：
 * 1. 上传接口 after() 进程内直调（主路径，零延迟）；
 * 2. Vercel Cron / 本地 scripts/worker-loop.mjs 定期调用（兜底与持续消费）；
 * 3. 每次执行结束若仍有积压，自链式再次触发，直到清空（Serverless 无常驻进程的补偿方案）。
 */
export async function POST(request: Request) {
  if (!verifyDispatcherToken(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  const sql = await getV4Sql();
  if (!sql) return dbUnavailable();

  // Hobby 函数实际约 10s 硬顶，单轮预算必须预留安全余量；
  // 默认 8s/3 批，靠 after() 自链 + 轮询内联 + cron 兜底清空积压。
  const result = await runDispatchCycle(sql, {
    maxBatches: dispatcherMaxBatches(),
    timeBudgetMs: dispatcherBudgetMs()
  });

  // 仍有积压 → 自链式触发下一轮。
  // 用 after() 保证续跑不被 Lambda 冻结打断（fire-and-forget 在 Vercel 可能被杀）。
  const hasBacklog = result.outbox.scanned > 0 || result.processed.length > 0;
  if (hasBacklog) {
    const origin = new URL(request.url).origin;
    const token = process.env.DISPATCHER_TOKEN;
    after(async () => {
      try {
        await fetch(`${origin}/api/import-dispatcher`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(dispatcherTriggerTimeoutMs())
        });
      } catch {
        /* 下一轮 cron 兜底 */
      }
    });
  }

  return NextResponse.json({
    outbox: result.outbox,
    recovered: result.recovered,
    deadLettered: result.deadLettered,
    processed: result.processed.map((outcome) => ({
      unit_id: outcome.unitId,
      batch_index: outcome.batchIndex,
      success_rows: outcome.successRows,
      failed_rows: outcome.failedRows,
      degraded: outcome.degraded,
      durations: outcome.durations,
      task_final_status: outcome.taskFinalStatus ?? null
    })),
    elapsed_ms: result.elapsedMs
  });
}

/**
 * GET /api/import-dispatcher —— 供 Vercel Cron 调用（Cron 只发 GET，不发 POST）。
 * 鉴权复用 verifyDispatcherToken：Vercel 在项目配置了 CRON_SECRET 时，
 * 会以 `Authorization: Bearer $CRON_SECRET` 调用本端点。
 * 语义与 POST 完全一致，直接委托，避免逻辑分叉。
 */
export const GET = POST;
