"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import V4Nav from "@/app/v4-nav";

interface TraceHit {
  task_id: string;
  file_name: string;
  trace_id: string;
  status: string;
  total_rows: string | number;
  success_rows: string | number;
  failed_rows: string | number;
  created_at: string;
}

interface TimelineEvent {
  event_name: string;
  event_status: string;
  message: string;
  occurred_at: string;
  unit_id: string;
}

interface TraceError {
  batch_index: number;
  row_number: number;
  field_name: string;
  raw_value: string;
  error_code: string;
  error_reason: string;
  suggestion: string;
}

interface TraceBatch {
  unit_id: string;
  batch_index: number;
  status: string;
  retry_count: number;
  success_rows: string | number;
  failed_rows: string | number;
  parse_duration_ms: number | null;
  rule_duration_ms: number | null;
  validate_duration_ms: number | null;
  insert_duration_ms: number | null;
  total_duration_ms: number | null;
}

function TracesContent() {
  const searchParams = useSearchParams();
  const [taskId, setTaskId] = useState(searchParams.get("task_id") ?? "");
  const [fileName, setFileName] = useState("");
  const [errorCode, setErrorCode] = useState(searchParams.get("error_code") ?? "");
  const [batchFilter, setBatchFilter] = useState(searchParams.get("batch") ?? "");
  const [rowFrom, setRowFrom] = useState("");
  const [rowTo, setRowTo] = useState("");
  const [hits, setHits] = useState<TraceHit[]>([]);
  const [activeTraceId, setActiveTraceId] = useState(searchParams.get("trace_id") ?? "");
  const [taskInfo, setTaskInfo] = useState<{ id: string; file_name: string; status: string; rule_id: string | null; rule_name: string | null; degraded: boolean } | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [traceErrors, setTraceErrors] = useState<TraceError[]>([]);
  const [traceBatches, setTraceBatches] = useState<TraceBatch[]>([]);
  const [searched, setSearched] = useState(false);

  const loadTrace = useCallback(async (traceId: string): Promise<void> => {
    if (!traceId) return;
    try {
      const params = new URLSearchParams();
      if (batchFilter.trim()) params.set("batch", batchFilter.trim());
      const response = await fetch(`/api/traces/${traceId}${params.size ? `?${params.toString()}` : ""}`);
      const data = await response.json();
      setTaskInfo(data.task ?? null);
      setTimeline(Array.isArray(data.timeline) ? data.timeline : []);
      setTraceErrors(Array.isArray(data.errors) ? data.errors : []);
      setTraceBatches(Array.isArray(data.batches) ? data.batches : []);
    } catch { /* 忽略 */ }
  }, [batchFilter]);

  useEffect(() => {
    if (activeTraceId) void loadTrace(activeTraceId);
  }, [activeTraceId, loadTrace]);

  const search = async (): Promise<void> => {
    const params = new URLSearchParams();
    if (taskId.trim()) params.set("task_id", taskId.trim());
    if (fileName.trim()) params.set("file_name", fileName.trim());
    if (batchFilter.trim()) params.set("batch", batchFilter.trim());
    if (errorCode.trim()) params.set("error_code", errorCode.trim());
    if (rowFrom.trim()) params.set("row_from", rowFrom.trim());
    if (rowTo.trim()) params.set("row_to", rowTo.trim());
    try {
      const response = await fetch(`/api/traces?${params.toString()}`);
      const data = await response.json();
      const traces = Array.isArray(data.traces) ? data.traces as TraceHit[] : [];
      setHits(traces);
      setSearched(true);
      if (traces[0]?.trace_id && !activeTraceId) setActiveTraceId(traces[0].trace_id);
    } catch { /* 忽略 */ }
  };

  return (
    <main>
      <section className="shell">
        <V4Nav />
        <section className="panel">
          <div className="panel-title"><Search size={18} /> 全链路 Trace 检索（task_id / 文件名 / 错误码 / 行号范围）</div>
          <div className="history-filters" style={{ gridTemplateColumns: "minmax(200px,2fr) minmax(150px,1fr) 90px 110px 90px 90px auto" }}>
            <input className="search" placeholder="task_id（精确）" value={taskId} onChange={(event) => setTaskId(event.target.value)} />
            <input className="search" placeholder="文件名（模糊）" value={fileName} onChange={(event) => setFileName(event.target.value)} />
            <input className="search" placeholder="批次号" value={batchFilter} onChange={(event) => setBatchFilter(event.target.value)} />
            <select value={errorCode} onChange={(event) => setErrorCode(event.target.value)}>
              <option value="">全部错误码</option>
              {["E001", "E002", "E003", "E004", "E005", "E006", "E007", "E008"].map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
            <input className="search" placeholder="行号起" value={rowFrom} onChange={(event) => setRowFrom(event.target.value)} />
            <input className="search" placeholder="行号止" value={rowTo} onChange={(event) => setRowTo(event.target.value)} />
            <button onClick={() => void search()}><Search size={16} /> 搜索</button>
          </div>
          {searched && !hits.length && <p className="muted" style={{ marginTop: 10 }}>没有匹配的任务。试试清空条件或直接输入 task_id。</p>}
          {hits.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 10, maxHeight: 240 }}>
              <table className="v4-table">
                <thead><tr><th>task_id</th><th>文件名</th><th>状态</th><th>总行数</th><th>成功/失败</th><th>trace</th></tr></thead>
                <tbody>
                  {hits.map((hit) => (
                    <tr key={hit.task_id} style={{ cursor: "pointer" }} onClick={() => setActiveTraceId(hit.trace_id)}>
                      <td><Link href={`/tasks/${hit.task_id}`} className="code-pill" onClick={(event) => event.stopPropagation()}>{hit.task_id.slice(0, 14)}…</Link></td>
                      <td>{hit.file_name}</td>
                      <td><span className={`badge ${hit.status}`}>{hit.status}</span></td>
                      <td>{Number(hit.total_rows)}</td>
                      <td>{Number(hit.success_rows)}/{Number(hit.failed_rows)}</td>
                      <td><span className="code-pill">{hit.trace_id.slice(0, 18)}…</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {activeTraceId && (
          <section className="panel wide">
            <div className="panel-title">时间线 · <span className="code-pill">{activeTraceId}</span></div>
            {taskInfo && (
              <div className="metric-grid" style={{ marginBottom: 8 }}>
                <div className="metric-card"><div className="label">任务 / 文件</div><div className="value" style={{ fontSize: 13 }}>{taskInfo.file_name || taskInfo.id}</div></div>
                <div className="metric-card"><div className="label">任务状态</div><div className="value" style={{ fontSize: 14 }}><span className={`badge ${taskInfo.status}`}>{taskInfo.status}</span></div></div>
                <div className="metric-card accent"><div className="label">所属规则</div><div className="value" style={{ fontSize: 13 }}>{taskInfo.rule_name ?? "未知规则"}{taskInfo.rule_id ? <span className="muted">（{taskInfo.rule_id}）</span> : ""}</div></div>
                <div className="metric-card"><div className="label">SKU 校验</div><div className="value" style={{ fontSize: 14 }}>{taskInfo.degraded ? "⚠️ 已降级" : "正常"}</div></div>
              </div>
            )}
            <div className="timeline">
              {timeline.map((event, index) => (
                <div key={index} className={`timeline-item ${event.event_status === "error" ? "error" : event.event_status === "warn" ? "warn" : ""}`}>
                  <span className="time">{new Date(event.occurred_at).toLocaleTimeString("zh-CN")}</span>
                  <span className="dot" />
                  <span>
                    <strong>{event.event_name}</strong>
                    {event.unit_id ? <span className="code-pill" style={{ marginLeft: 6 }}>{event.unit_id}</span> : null}
                    {event.message ? <span className="muted"> —— {event.message}</span> : null}
                  </span>
                </div>
              ))}
              {!timeline.length && <p className="muted">该 trace 暂无事件记录。</p>}
            </div>

            {traceBatches.length > 0 && (
              <>
                <div className="section-title">批次耗时与重试</div>
                <div className="table-wrap">
                  <table className="v4-table">
                    <thead><tr><th>批次</th><th>状态</th><th>重试</th><th>解析</th><th>规则</th><th>校验</th><th>写入</th><th>总耗时</th><th>成功/失败</th></tr></thead>
                    <tbody>
                      {traceBatches.map((batch) => (
                        <tr key={batch.unit_id}>
                          <td>{batch.batch_index}</td>
                          <td><span className={`badge ${batch.status === "completed" ? "completed" : batch.status === "failed" ? "failed" : "processing"}`}>{batch.status}</span></td>
                          <td>{batch.retry_count}</td>
                          <td>{batch.parse_duration_ms ?? "-"}ms</td>
                          <td>{batch.rule_duration_ms ?? "-"}ms</td>
                          <td>{batch.validate_duration_ms ?? "-"}ms</td>
                          <td>{batch.insert_duration_ms ?? "-"}ms</td>
                          <td>{batch.total_duration_ms ?? "-"}ms</td>
                          <td>{Number(batch.success_rows)}/{Number(batch.failed_rows)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {traceErrors.length > 0 && (
              <>
                <div className="section-title">失败节点明细（点击可见原始值与修复建议）</div>
                <div className="table-wrap" style={{ maxHeight: 320 }}>
                  <table className="v4-table">
                    <thead><tr><th>批次</th><th>行号</th><th>字段</th><th>原始值（脱敏）</th><th>错误码</th><th>原因</th><th>建议</th></tr></thead>
                    <tbody>
                      {traceErrors.map((error, index) => (
                        <tr key={index}>
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
                </div>
              </>
            )}
          </section>
        )}
      </section>
    </main>
  );
}

export default function TracesPage() {
  return (
    <Suspense fallback={<main><section className="shell"><V4Nav /><section className="panel"><div className="empty-state compact"><strong>加载中…</strong></div></section></section></main>}>
      <TracesContent />
    </Suspense>
  );
}
