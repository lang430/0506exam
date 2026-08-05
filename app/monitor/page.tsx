"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Activity, AlertTriangle, BarChart3, Layers, Pause, Play, RefreshCw } from "lucide-react";
import V4Shell from "@/app/v4-shell";

interface MonitorSummary {
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
    successRows: number;
    failedRows: number;
    degraded: boolean;
    createdAt: string;
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
  alertLevel?: string;
  error?: string;
}

const ERROR_CODE_LABELS: Record<string, string> = {
  E001: "SKU 不存在",
  E002: "必填缺失",
  E003: "电话格式",
  E004: "数量非正",
  E005: "外部编码重复",
  E006: "规则映射失败",
  E007: "数据库写入失败",
  E008: "文件格式不支持"
};

const STAGE_LABELS: Record<string, string> = {
  parse: "文件解析",
  rule: "规则引擎",
  validate: "数据校验",
  insert: "批量写入"
};

export default function MonitorPage() {
  const [summary, setSummary] = useState<MonitorSummary | null>(null);
  const [critical, setCritical] = useState(false);
  const [paused, setPaused] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/import-monitor/summary");
      const data = await response.json();
      if (!response.ok) {
        setCritical(true);
        setSummary(null); // 503 JSON 不是数据，绝不能进入渲染
        return;
      }
      setCritical(false);
      setSummary(data);
      setLastUpdatedAt(Date.now());
    } catch {
      setCritical(true);
      setSummary(null);
    }
  }, []);

  useEffect(() => {
    if (paused) return;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load, paused]);

  // 相对时间每秒刷新（仅用于展示"X秒前"）
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const secondsAgo = lastUpdatedAt ? Math.max(0, Math.round((now - lastUpdatedAt) / 1000)) : null;
  const lastUpdatedText =
    secondsAgo === null ? "—"
      : secondsAgo < 1 ? "刚刚"
        : secondsAgo < 60 ? `${secondsAgo} 秒前`
          : `${Math.floor(secondsAgo / 60)} 分 ${secondsAgo % 60} 秒前`;

  // 总体健康度横幅（基于队列告警级别）
  const healthBanner = (() => {
    if (!summary) return null;
    const level = summary.queueDepth.alertLevel;
    const wait = summary.queueDepth.waitingRows ?? 0;
    if (level === "critical") return { cls: "critical", icon: <AlertTriangle size={18} />, title: "严重告警", metric: `队列积压 ${wait} 行，存在卡死批次需介入` };
    if (level === "warn") return { cls: "warn", icon: <AlertTriangle size={18} />, title: "队列积压预警", metric: `等待处理 ${wait} 行，请关注推进速度` };
    return { cls: "ok", icon: <Activity size={18} />, title: "系统健康 · 运行正常", metric: `等待处理 ${wait} 行` };
  })();

  const maxThroughput = Math.max(1, ...((summary?.throughput ?? []).map((item) => item.rows).length ? (summary?.throughput ?? []).map((item) => item.rows) : [1]));
  const maxErrorCount = Math.max(1, ...((summary?.errorDistribution ?? []).length ? (summary?.errorDistribution ?? []).map((item) => item.count) : [1]));
  const maxStageMs = summary?.stagePercentiles
    ? Math.max(1, ...Object.values(summary.stagePercentiles).flatMap((stage) => [stage.p50, stage.p95, stage.p99]))
    : 1;

  return (
    <V4Shell title="监控看板" subtitle="吞吐 / 队列积压 / 阶段耗时 / 错误分布 / 慢批次 / 失败趋势">
      <section className="shell">
        {critical && (
          <div className="alert-box critical" role="alert">
            <AlertTriangle size={16} /> 队列/数据库不可用：监控聚合失败，请检查数据库连接与部署环境变量。
          </div>
        )}
        {!summary && !critical && (
          <section className="panel">
            <div className="skeleton-row"><span className="skeleton" style={{ height: 24 }} /><span className="skeleton" style={{ height: 24 }} /><span className="skeleton" style={{ height: 24 }} /></div>
            <div className="skeleton-row"><span className="skeleton" style={{ height: 90 }} /><span className="skeleton" style={{ height: 90 }} /><span className="skeleton" style={{ height: 90 }} /></div>
          </section>
        )}
        {summary && !critical && healthBanner && (
          <>
            <div className={`health-banner ${healthBanner.cls}`}>
              <span className="hb-icon">{healthBanner.icon}</span>
              <span>{healthBanner.title}</span>
              <span className="hb-metric">{healthBanner.metric}</span>
            </div>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <section className="panel" style={{ gridColumn: "1 / -1", padding: "10px 18px" }}>
              <div className="refresh-meta" style={{ justifyContent: "space-between", width: "100%" }}>
                <span>
                  <span className="pulse-dot" style={{ color: paused ? "#c9cdd4" : "#0b8f8c", marginRight: 6 }} />
                  5 秒自动刷新 · 最后更新 {lastUpdatedText}
                </span>
                <span style={{ display: "inline-flex", gap: 8 }}>
                  <button className="btn-ghost" style={{ minHeight: 30 }} onClick={() => setPaused((p) => !p)}>
                    {paused ? <><Play size={14} /> 继续</> : <><Pause size={14} /> 暂停</>}
                  </button>
                  <button style={{ minHeight: 30 }} onClick={() => void load()} disabled={paused}><RefreshCw size={14} /> 立即刷新</button>
                </span>
              </div>
            </section>
            <section className="panel">
              <div className="panel-title"><Activity size={18} /> 实时吞吐量（过去 5 分钟每分钟入库行数）</div>
              {summary.throughput.length ? (
                <div className="bar-chart" style={{ marginBottom: 26 }}>
                  {summary.throughput.map((item) => (
                    <div key={item.minute} className="bar" style={{ height: `${Math.max(4, (item.rows / maxThroughput) * 100)}%` }} title={`${item.minute} → ${item.rows} 行`}>
                      <span>{item.minute}·{item.rows}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="muted">最近 5 分钟暂无入库记录。</p>}
            </section>

            <section className="panel">
              <div className="panel-title"><Layers size={18} /> 队列积压深度</div>
              <div className={`alert-box ${summary.queueDepth.alertLevel}`}>
                {summary.queueDepth.alertLevel === "critical" ? (
                  <><AlertTriangle size={16} /> 🚨 红色告警：{summary.queueDepth.stuckBatches > 0
                    ? `发现 ${summary.queueDepth.stuckBatches} 个卡死批次（Hobby 函数被 kill），等待 ${summary.queueDepth.waitingRows} 行`
                    : `等待处理行数 ${summary.queueDepth.waitingRows} 已严重积压`}</>
                ) : summary.queueDepth.alertLevel === "warn" ? (
                  <>⚠️ 橙色预警：等待处理行数 {summary.queueDepth.waitingRows}，{(summary.queueDepth.stuckBatches ?? 0) > 0 ? `含 ${summary.queueDepth.stuckBatches} 个卡死批次` : "请关注队列推进"}</>
                ) : (
                  <>队列运行正常，等待处理 {summary.queueDepth.waitingRows} 行</>
                )}
              </div>
              <div className="metric-grid">
                <div className="metric-card"><div className="label">待投递 Outbox</div><div className="value">{summary.queueDepth.outboxPending}</div></div>
                <div className="metric-card"><div className="label">待入队批次</div><div className="value">{summary.queueDepth.pendingBatches}</div></div>
                <div className="metric-card accent"><div className="label">就绪待消费</div><div className="value">{summary.queueDepth.readyBatches}</div></div>
                <div className="metric-card"><div className="label">处理中</div><div className="value">{summary.queueDepth.processingBatches}</div></div>
                <div className="metric-card" style={{ gridColumn: "1 / -1" }}><div className="label">卡死批次（locked &gt; {summary.queueDepth.stuckThresholdSeconds}s）</div><div className="value" style={{ color: summary.queueDepth.stuckBatches > 0 ? "#d97706" : "inherit" }}>{summary.queueDepth.stuckBatches ?? 0}</div></div>
              </div>
            </section>

            <section className="panel">
              <div className="panel-title"><BarChart3 size={18} /> 阶段耗时分布（近 24 小时，毫秒）</div>
              {Object.entries(summary.stagePercentiles).map(([stage, values]) => (
                <div key={stage} style={{ marginBottom: 12 }}>
                  <p className="muted" style={{ marginBottom: 4 }}>{STAGE_LABELS[stage]}</p>
                  {(["p50", "p95", "p99"] as const).map((percentile) => (
                    <div className="hbar-row" key={percentile}>
                      <span>{percentile.toUpperCase()}</span>
                      <div className="hbar"><span style={{ width: `${Math.max(2, (values[percentile] / maxStageMs) * 100)}%` }} /></div>
                      <span>{values[percentile]}ms</span>
                    </div>
                  ))}
                </div>
              ))}
            </section>

            <section className="panel">
              <div className="panel-title"><AlertTriangle size={18} /> 错误类型分布（近 24 小时）</div>
              {summary.errorDistribution.length ? summary.errorDistribution.map((item) => (
                <div className="hbar-row" key={item.errorCode}>
                  <Link href={`/traces?error_code=${item.errorCode}`}>
                    <span className="code-pill">{item.errorCode}</span> {ERROR_CODE_LABELS[item.errorCode] ?? ""}
                  </Link>
                  <div className={`hbar ${item.errorCode === "E007" ? "danger" : item.errorCode === "E001" ? "warn" : ""}`}>
                    <span style={{ width: `${Math.max(3, (item.count / maxErrorCount) * 100)}%` }} />
                  </div>
                  <span>{item.count}</span>
                </div>
              )) : <p className="muted">最近 24 小时没有错误记录。</p>}

              <div className="section-title">最近任务</div>
              <div className="table-wrap" style={{ maxHeight: 260 }}>
                <table className="v4-table">
                  <thead><tr><th>文件</th><th>状态</th><th>成功/失败</th><th>降级</th><th>时间</th></tr></thead>
                  <tbody>
                    {summary.recentTasks.map((task) => (
                      <tr key={task.id}>
                        <td><Link href={`/tasks/${task.id}`}>{task.fileName || task.id.slice(0, 10)}</Link></td>
                        <td><span className={`badge ${task.status}`}>{task.status}</span></td>
                        <td>{Number(task.successRows)}/{Number(task.failedRows)}</td>
                        <td>{task.degraded ? "⚠️" : "-"}</td>
                        <td>{new Date(task.createdAt).toLocaleTimeString("zh-CN")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel">
              <div className="panel-title"><BarChart3 size={18} /> 慢批次 TOP 10（近 24 小时）</div>
              {summary.slowBatches?.length ? (
                <div className="table-wrap" style={{ maxHeight: 300 }}>
                  <table className="v4-table">
                    <thead><tr><th>#</th><th>任务</th><th>批次</th><th>解析</th><th>校验</th><th>写入</th><th>总耗时</th></tr></thead>
                    <tbody>
                      {summary.slowBatches.map((batch, index) => (
                        <tr key={`${batch.taskId}-${batch.unitId}`}>
                          <td>{index + 1}</td>
                          <td><Link href={`/tasks/${batch.taskId}`}>{batch.taskId.slice(0, 10)}…</Link></td>
                          <td>{batch.batchIndex}</td>
                          <td>{batch.parseDurationMs}ms</td>
                          <td>{batch.validateDurationMs}ms</td>
                          <td>{batch.insertDurationMs}ms</td>
                          <td><strong>{batch.totalDurationMs}ms</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="muted">最近 24 小时没有批次性能记录。</p>}
            </section>

            <section className="panel">
              <div className="panel-title"><AlertTriangle size={18} /> 失败任务趋势（近 7 天）</div>
              {summary.failedTaskTrend?.length ? (
                <div className="bar-chart" style={{ marginBottom: 26 }}>
                  {summary.failedTaskTrend.map((item) => (
                    <div key={item.day} className="bar" style={{ height: `${Math.max(6, (item.count / Math.max(1, ...summary.failedTaskTrend.map((trend) => trend.count))) * 100)}%`, background: "#f53f3f" }} title={`${item.day} → ${item.count} 个失败任务`}>
                      <span>{item.day}·{item.count}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="muted">最近 7 天没有失败任务。</p>}
            </section>
          </div>
          </>
        )}
      </section>
    </V4Shell>
  );
}
