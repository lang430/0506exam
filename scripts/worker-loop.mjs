/**
 * V4 本地常驻 Worker 循环（开发/本地压测用）
 * 定期调用本地 /api/import-dispatcher 消费积压批次；
 * 生产环境由 Vercel 上传 after() 直调 + Cron/自链式调度承担同样职责。
 *
 * 执行：npm run worker-loop
 */
const BASE_URL = (process.env.V4_LOADTEST_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.DISPATCHER_TOKEN || (() => {
  const fs = require("fs");
  const path = require("path");
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return "";
  const line = fs.readFileSync(envPath, "utf8").split(/\r?\n/).find((item) => item.startsWith("DISPATCHER_TOKEN="));
  return line ? line.split("=")[1].trim().replace(/^["']|["']$/g, "") : "";
})();

const INTERVAL_MS = Number(process.env.V4_LOOP_INTERVAL_MS || 2000);

const tick = async () => {
  try {
    const response = await fetch(`${BASE_URL}/api/import-dispatcher`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (!response.ok) {
      console.log(`[worker-loop] HTTP ${response.status}（服务未启动或令牌无效？）`);
      return;
    }
    const data = await response.json();
    if (data.processed?.length || data.outbox?.sent || data.recovered || data.deadLettered) {
      console.log(`[worker-loop] outbox发送 ${data.outbox?.sent ?? 0}，处理批次 ${data.processed?.length ?? 0}，恢复 ${data.recovered ?? 0}，死信 ${data.deadLettered ?? 0}，耗时 ${data.elapsed_ms}ms`);
      for (const outcome of data.processed ?? []) {
        console.log(`  · 批次 ${outcome.batch_index}：成功 ${outcome.success_rows} / 失败 ${outcome.failed_rows} / 总耗时 ${outcome.durations?.total}ms${outcome.degraded ? "（降级）" : ""}`);
      }
    }
  } catch (error) {
    console.log(`[worker-loop] 调度失败：${error.message}（等待重试）`);
  }
};

console.log(`[worker-loop] 启动：目标 ${BASE_URL}，间隔 ${INTERVAL_MS}ms（Ctrl+C 退出）`);
void tick();
setInterval(() => void tick(), INTERVAL_MS);
