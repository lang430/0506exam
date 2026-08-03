"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertTriangle, Download, Loader2, Search } from "lucide-react";
import V4Shell from "@/app/v4-shell";

interface TaskDetail {
  task_id: string;
  file_name: string;
  status: string;
  status_raw: string;
  total_rows: number;
  processed_rows: number;
  success_rows: number;
  failed_rows: number;
  total_batches: number;
  completed_batches: number;
  failed_batches: number;
  degraded: boolean;
  trace_id: string;
  error_message: string | null;
  throughput_per_sec: number;
  eta_seconds: number | null;
  recent_errors: { error_code: string; count: number }[];
  created_at: string;
  completed_at: string | null;
}

interface ErrorItem {
  batch_index: number;
  row_number: number;
  field_name: string;
  raw_value: string;
  error_code: string;
  error_reason: string;
  suggestion: string;
  unit_id: string;
}

interface BatchInfo {
  unit_id: string;
  batch_index: number;
  start_row: number;
  end_row: number;
  status: string;
  retry_count: number;
  success_rows: string | number;
  failed_rows: string | number;
  sku_check_skipped: boolean;
}

const TERMINAL_STATUS = ["COMPLETED", "PARTIAL_SUCCESS", "FAILED"];

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [errorTotal, setErrorTotal] = useState(0);
  const [errorPage, setErrorPage] = useState(1);
  const [batchFilter, setBatchFilter] = useState("");
  const [codeFilter, setCodeFilter] = useState("");
  const [batches, setBatches] = useState<BatchInfo[]>([]);
  const [notFound, setNotFound] = useState(false);

  const loadTask = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/import-tasks/${id}`);
      if (response.status === 404) return setNotFound(true);
      const data = await response.json();
      if (data.task_id) setTask(data);
    } catch { /* 轮询容错 */ }
  }, [id]);

  const loadErrors = useCallback(async (): Promise<void> => {
    const params = new URLSearchParams({ page: String(errorPage), page_size: "20" });
    if (batchFilter) params.set("batch", batchFilter);
    if (codeFilter) params.set("error_code", codeFilter);
    try {
      const response = await fetch(`/api/import-tasks/${id}/errors?${params.toString()}`);
      const data = await response.json();
      setErrors(Array.isArray(data.errors) ? data.errors : []);
      setErrorTotal(Number(data.total ?? 0));
    } catch { /* 忽略 */ }
  }, [id, errorPage, batchFilter, codeFilter]);

  const loadBatches = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/import-tasks/${id}/batches`);
      const data = await response.json();
      setBatches(Array.isArray(data.batches) ? data.batches : []);
    } catch { /* 忽略 */ }
  }, [id]);

  useEffect(() => {
    void loadTask();
    void loadErrors();
    void loadBatches();
    const timer = setInterval(() => {
      void loadTask();
      void loadBatches();
      void loadErrors();
    }, 1500);
    return () => clearInterval(timer);
  }, [loadTask, loadErrors, loadBatches]);

  if (notFound) {
    return (
      <V4Shell title="任务详情" subtitle="任务不存在或已清理">
        <section className="shell">
          <section className="panel"><div className="empty-state compact"><strong>任务不存在</strong><span>请检查 task_id 是否正确。</span></div></section>
        </section>
      </V4Shell>
    );
  }

  const percent = task && task.total_rows > 0 ? Math.min(100, Math.round((task.processed_rows / task.total_rows) * 100)) : task && task.status_raw === "completed" ? 100 : 0;
  const finished = task ? TERMINAL_STATUS.includes(task.status) : false;

  return (
    <V4Shell title="任务详情" subtitle="进度轮询 1.5s · 错误明细筛选导出 · 批次执行情况">
      <section className="shell">
        {!task ? (
          <section className="panel"><div className="empty-state compact"><Loader2 className="spinner" size={28} /><strong>加载任务中</strong></div></section>
        ) : (
          <>
            <section className="panel">
              <div className="panel-title">
                任务详情 · <span className={`badge ${task.status_raw}`}>{task.status}</span>
                <span className="muted">（1.5 秒自动刷新）</span>
              </div>
              {task.degraded && (
                <div className="degrade-banner" role="alert">
                  <AlertTriangle size={18} />
                  ⚠️ SKU 校验已降级：本次导入未经过商品主数据完整校验，数据可能需要后续复核。
                </div>
              )}
              <div className="progress"><span style={{ width: `${percent}%` }} /></div>
              <div className="progress-meta">
                <span>{percent}%</span>
                <span>{task.processed_rows}/{task.total_rows} 行</span>
              </div>
              <div className="metric-grid">
                <div className="metric-card"><div className="label">文件名</div><div className="value" style={{ fontSize: 14 }}>{task.file_name || "-"}</div></div>
                <div className="metric-card"><div className="label">task_id</div><div className="value" style={{ fontSize: 13 }}>{task.task_id}</div></div>
                <div className="metric-card"><div className="label">trace_id</div><div className="value" style={{ fontSize: 13 }}><Link href={`/traces?trace_id=${task.trace_id}`}>{task.trace_id}</Link></div></div>
                <div className="metric-card accent"><div className="label">成功行数</div><div className="value">{task.success_rows}</div></div>
                <div className="metric-card"><div className="label">失败行数</div><div className="value">{task.failed_rows}</div></div>
                <div className="metric-card"><div className="label">已完成批次 / 总批次</div><div className="value">{task.completed_batches}/{task.total_batches}{task.failed_batches > 0 ? `（失败 ${task.failed_batches}）` : ""}</div></div>
                <div className="metric-card accent"><div className="label">当前吞吐量</div><div className="value">{task.throughput_per_sec} 行/秒</div></div>
                <div className="metric-card"><div className="label">预计剩余时间</div><div className="value">{finished ? "已完成" : task.eta_seconds != null ? `${task.eta_seconds}s` : "计算中"}</div></div>
              </div>
              {task.error_message && <div className="alert-box critical">{task.error_message}</div>}
              {task.recent_errors.length > 0 && (
                <p className="muted">
                  最近错误摘要：{task.recent_errors.map((item) => `${item.error_code}×${item.count}`).join("，")}
                  <a href={`/api/import-tasks/${task.task_id}/errors-export`} style={{ marginLeft: 10, display: "inline-flex", alignItems: "center", gap: 4 }}><Download size={13} />导出失败明细 CSV</a>
                </p>
              )}
              {finished && !task.recent_errors.length && (
                <a href={`/api/import-tasks/${task.task_id}/errors-export`}><button><Download size={16} /> 导出失败明细 CSV</button></a>
              )}
            </section>

            <section className="panel wide">
              <div className="panel-title">行级错误明细（共 {errorTotal} 条，按批次/错误码筛选）</div>
              <div className="history-filters" style={{ gridTemplateColumns: "140px 160px auto" }}>
                <input className="search" placeholder="批次号，如 0" value={batchFilter} onChange={(event) => { setBatchFilter(event.target.value); setErrorPage(1); }} />
                <select value={codeFilter} onChange={(event) => { setCodeFilter(event.target.value); setErrorPage(1); }}>
                  <option value="">全部错误码</option>
                  {["E001", "E002", "E003", "E004", "E005", "E006", "E007", "E008"].map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
                <button onClick={() => void loadErrors()}><Search size={16} /> 筛选</button>
              </div>
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table className="v4-table">
                  <thead><tr><th>批次</th><th>行号</th><th>字段</th><th>原始值（脱敏）</th><th>错误码</th><th>错误原因</th><th>修复建议</th></tr></thead>
                  <tbody>
                    {errors.map((error, index) => (
                      <tr key={`${error.row_number}-${error.error_code}-${index}`}>
                        <td>{error.batch_index}</td>
                        <td>{error.row_number}</td>
                        <td>{error.field_name}</td>
                        <td>{error.raw_value || "-"}</td>
                        <td><span className="code-pill">{error.error_code}</span></td>
                        <td>{error.error_reason}</td>
                        <td className="muted">{error.suggestion}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!errors.length && <div className="empty-state compact"><strong>没有匹配的错误记录</strong><span>任务校验通过的行不会产生错误明细。</span></div>}
              </div>
              <div className="pager">
                <button onClick={() => setErrorPage((page) => Math.max(1, page - 1))} disabled={errorPage <= 1}>上一页</button>
                <span>第 {errorPage} 页 / 共 {Math.max(1, Math.ceil(errorTotal / 20))} 页</span>
                <button onClick={() => setErrorPage((page) => page + 1)} disabled={errorPage >= Math.ceil(errorTotal / 20)}>下一页</button>
              </div>
            </section>

            <section className="panel wide">
              <div className="panel-title">批次执行情况</div>
              <div className="table-wrap">
                <table className="v4-table">
                  <thead><tr><th>unit_id</th><th>批次</th><th>行范围</th><th>状态</th><th>重试</th><th>成功</th><th>失败</th><th>SKU校验跳过</th></tr></thead>
                  <tbody>
                    {batches.map((batch) => (
                      <tr key={batch.unit_id}>
                        <td><span className="code-pill">{batch.unit_id}</span></td>
                        <td>{batch.batch_index}</td>
                        <td>{batch.start_row + 1} ~ {batch.end_row < 0 ? "末尾" : batch.end_row}</td>
                        <td><span className={`badge ${batch.status === "completed" ? "completed" : batch.status === "failed" ? "failed" : "processing"}`}>{batch.status}</span></td>
                        <td>{batch.retry_count}</td>
                        <td>{Number(batch.success_rows)}</td>
                        <td>{Number(batch.failed_rows)}</td>
                        <td>{batch.sku_check_skipped ? "⚠️ 是" : "否"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </section>
    </V4Shell>
  );
}
