"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, AlertTriangle, BarChart3, Layers } from "lucide-react";
import V4Nav from "@/app/v4-nav";

interface MonitorSummary {
  generatedAt: string;
  throughput: { minute: string; rows: number }[];
  queueDepth: {
    pendingBatches: number;
    readyBatches: number;
    processingBatches: number;
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

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const response = await fetch("/api/import-monitor/summary");
        const data = await response.json();
        if (!response.ok) {
          setCritical(true);
          setSummary(data);
          return;
        }
        setCritical(false);
        setSummary(data);
      } catch {
        setCritical(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  const maxThroughput = Math.max(1, ...(summary?.throughput.map((item) => item.rows) ?? [1]));
  const maxErrorCount = Math.max(1, ...(summary?.errorDistribution.map((item) => item.count) ?? [1]));
  const backlogWarn = summary ? summary.queueDepth.waitingRows >= 5000 : false;
  const maxStageMs = summary
    ? Math.max(1, ...Object.values(summary.stagePercentiles).flatMap((stage) => [stage.p50, stage.p95, stage.p99]))
    : 1;

  return (
    <main>
      <section className="shell">
        <V4Nav />
        {critical && (
          <div className="alert-box critical" role="alert">
            <AlertTriangle size={16} /> 队列/数据库不可用：监控聚合失败，请检查数据库连接与部署环境变量。
          </div>
        )}
        {!summary && !critical && <section className="panel"><div className="empty-state compact"><strong>加载监控数据中…</strong></div></section>}
        {summary && !critical && (
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
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
              <div className={`alert-box ${summary.queueDepth.alertLevel === "warn" ? "warn" : "ok"}`}>
                {backlogWarn
                  ? <>⚠️ 橙色预警：等待处理行数 {summary.queueDepth.waitingRows} 已超过阈值 5000</>
                  : <>队列运行正常，等待处理 {summary.queueDepth.waitingRows} 行</>}
              </div>
              <div className="metric-grid">
                <div className="metric-card"><div className="label">待投递 Outbox</div><div className="value">{summary.queueDepth.outboxPending}</div></div>
                <div className="metric-card"><div className="label">待入队批次</div><div className="value">{summary.queueDepth.pendingBatches}</div></div>
                <div className="metric-card accent"><div className="label">就绪待消费</div><div className="value">{summary.queueDepth.readyBatches}</div></div>
                <div className="metric-card"><div className="label">处理中</div><div className="value">{summary.queueDepth.processingBatches}</div></div>
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
          </div>
        )}
      </section>
    </main>
  );
}
