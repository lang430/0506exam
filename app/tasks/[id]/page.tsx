"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertTriangle, Download, RefreshCw, Search } from "lucide-react";
import V4Shell from "@/app/v4-shell";
import { readTaskSeed } from "@/lib/task-seed";

interface TaskDetail {
  task_id: string;
  view: "basic" | "full";
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

/**
 * 首屏只保证 task_id 存在，其余字段随后台拉取逐步补齐。
 * 页面必须能在任意字段缺失的情况下正常渲染，不允许因为某个字段没到就整页空白。
 */
type TaskView = Partial<TaskDetail> & { task_id: string };

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
/** 任务进度轮询间隔 */
const TASK_POLL_MS = 1_500;
/** 错误明细 / 批次属于补充数据，用更低频率轮询，减少连接池占用 */
const DETAIL_POLL_MS = 3_000;
/** 详情数据让位于首屏基础数据，延迟一拍再发起 */
const DETAIL_KICKOFF_MS = 300;
/**
 * 单次请求超时上限。
 * 必须有：单飞（single-flight）锁只在 finally 释放，若请求永远挂起，
 * 锁将永久处于占用状态，后续所有轮询都会被静默丢弃，页面就此卡死。
 */
const REQUEST_TIMEOUT_MS = 8_000;

export const runSingleFlight = async <T,>(
  state: { current: boolean },
  operation: () => Promise<T>
): Promise<T | undefined> => {
  if (state.current) return undefined;
  state.current = true;
  try {
    return await operation();
  } finally {
    state.current = false;
  }
};

/** 基础视图不做批次聚合，用 null 表示“未统计”，合并时不能覆盖已拿到的完整数据 */
const UNCOUNTED_ON_BASIC = new Set(["completed_batches", "failed_batches"]);

export const mergeTask = (
  current: TaskView | null,
  incoming: Record<string, unknown>
): TaskView => {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null && UNCOUNTED_ON_BASIC.has(key)) continue;
    next[key] = value;
  }
  return next as TaskView;
};

const timedFetch = (url: string): Promise<Response> =>
  fetch(url, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

/** 字段未到位时用骨架条占位，保持布局稳定，避免数字跳动 */
function Pending({ width = 56 }: { width?: number }) {
  return <span className="skeleton" style={{ display: "inline-block", width, height: 16, verticalAlign: "middle" }} />;
}

function Metric({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className={accent ? "metric-card accent" : "metric-card"}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function TableSkeleton({ columns, rows = 3 }: { columns: number; rows?: number }) {
  return (
    <div style={{ padding: "6px 10px" }}>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="skeleton-row" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
          {Array.from({ length: columns }, (_, columnIndex) => <span key={columnIndex} className="skeleton" />)}
        </div>
      ))}
    </div>
  );
}

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<TaskView | null>(null);
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [errorTotal, setErrorTotal] = useState(0);
  const [errorPage, setErrorPage] = useState(1);
  const [batchFilter, setBatchFilter] = useState("");
  const [codeFilter, setCodeFilter] = useState("");
  const [batches, setBatches] = useState<BatchInfo[]>([]);
  const [errorsLoaded, setErrorsLoaded] = useState(false);
  const [batchesLoaded, setBatchesLoaded] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState("");
  const terminalRef = useRef(false);
  const taskRequestInFlightRef = useRef(false);
  const errorsRequestInFlightRef = useRef(false);
  const batchesRequestInFlightRef = useRef(false);

  /**
   * 首屏基础数据：来自上传接口的交接快照，零网络直接渲染。
   * 放在 effect 里读取而非 useState 初始值，避免服务端渲染与客户端不一致导致的 hydration 报错。
   */
  useEffect(() => {
    const seed = readTaskSeed(id);
    if (seed) setTask((current) => current ?? ({ ...seed } as TaskView));
  }, [id]);

  const loadTask = useCallback(async (view?: "basic"): Promise<void> => {
    await runSingleFlight(taskRequestInFlightRef, async () => {
      try {
        const query = view === "basic" ? "?view=basic" : "";
        const response = await timedFetch(`/api/import-tasks/${id}${query}`);
        if (response.status === 404) return setNotFound(true);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as Record<string, unknown>;
        if (!data.task_id) return;
        setTask((current) => mergeTask(current, data));
        setLoadError("");
        if (TERMINAL_STATUS.includes(String(data.status))) terminalRef.current = true;
      } catch {
        // 已有基础数据时只做角标提示，绝不清空页面内容
        setLoadError("任务状态刷新失败，正在自动重试…");
      }
    });
  }, [id]);

  const loadErrors = useCallback(async (): Promise<void> => {
    await runSingleFlight(errorsRequestInFlightRef, async () => {
      const params = new URLSearchParams({ page: String(errorPage), page_size: "20" });
      if (batchFilter) params.set("batch", batchFilter);
      if (codeFilter) params.set("error_code", codeFilter);
      try {
        const response = await timedFetch(`/api/import-tasks/${id}/errors?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setErrors(Array.isArray(data.errors) ? data.errors : []);
        setErrorTotal(Number(data.total ?? 0));
        setErrorsLoaded(true);
      } catch { /* 错误明细失败不影响任务主状态 */ }
    });
  }, [id, errorPage, batchFilter, codeFilter]);

  const loadBatches = useCallback(async (): Promise<void> => {
    await runSingleFlight(batchesRequestInFlightRef, async () => {
      try {
        const response = await timedFetch(`/api/import-tasks/${id}/batches`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setBatches(Array.isArray(data.batches) ? data.batches : []);
        setBatchesLoaded(true);
      } catch { /* 批次详情失败不影响任务主状态 */ }
    });
  }, [id]);

  // 任务信息：基础数据先行 → 完整信息后台补齐 → 之后按 1.5s 轮询
  useEffect(() => {
    let cancelled = false;
    const bootstrap = async (): Promise<void> => {
      await loadTask("basic");
      if (!cancelled) void loadTask();
    };
    void bootstrap();
    const timer = setInterval(() => {
      if (terminalRef.current) return; // 终态后停止轮询
      void loadTask();
    }, TASK_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loadTask]);

  // 详情数据：与首屏解耦，延迟发起 + 低频轮询，任一失败都不影响基础信息展示
  useEffect(() => {
    const kickoff = setTimeout(() => {
      void loadErrors();
      void loadBatches();
    }, DETAIL_KICKOFF_MS);
    const timer = setInterval(() => {
      if (terminalRef.current) return;
      void loadErrors();
      void loadBatches();
    }, DETAIL_POLL_MS);
    return () => {
      clearTimeout(kickoff);
      clearInterval(timer);
    };
  }, [loadErrors, loadBatches]);

  const finished = task?.status ? TERMINAL_STATUS.includes(task.status) : false;

  // 进入终态时补拉一次详情，确保最终的错误明细与批次结果完整
  useEffect(() => {
    if (!finished) return;
    void loadErrors();
    void loadBatches();
  }, [finished, loadErrors, loadBatches]);

  const refreshAll = (): void => {
    terminalRef.current = false;
    void loadTask();
    void loadErrors();
    void loadBatches();
  };

  if (notFound) {
    return (
      <V4Shell title="任务详情" subtitle="任务不存在或已清理">
        <section className="shell">
          <section className="panel"><div className="empty-state compact"><strong>任务不存在</strong><span>请检查 task_id 是否正确。</span></div></section>
        </section>
      </V4Shell>
    );
  }

  // 无任何基础数据（直接打开链接且首个请求尚未返回）时展示结构骨架，而不是空白转圈
  if (!task) {
    return (
      <V4Shell title="任务详情" subtitle="正在获取任务基础信息">
        <section className="shell">
          {loadError ? (
            <section className="panel">
              <div className="empty-state compact">
                <AlertTriangle size={28} />
                <strong>{loadError}</strong>
                <button onClick={() => void loadTask("basic")}><RefreshCw size={14} /> 重试</button>
              </div>
            </section>
          ) : (
            <section className="panel">
              <div className="panel-title">任务详情</div>
              <div className="progress"><span style={{ width: "0%" }} /></div>
              <div className="metric-grid">
                {Array.from({ length: 8 }, (_, index) => (
                  <Metric key={index} label="加载中" value={<Pending width={72} />} />
                ))}
              </div>
            </section>
          )}
        </section>
      </V4Shell>
    );
  }

  const totalRows = task.total_rows;
  const processedRows = task.processed_rows;
  const percent = typeof totalRows === "number" && totalRows > 0 && typeof processedRows === "number"
    ? Math.min(100, Math.round((processedRows / totalRows) * 100))
    : task.status_raw === "completed" ? 100 : 0;
  const recentErrors = task.recent_errors ?? [];

  return (
    <V4Shell title="任务详情" subtitle="基础信息即时呈现 · 明细异步加载 · 进度 1.5s 轮询">
      <section className="shell">
        <section className="panel">
          <div className="panel-title">
            任务详情 · <span className={`badge ${task.status_raw ?? "pending"}`}>{task.status ?? "PENDING"}</span>
            <span className="muted">（1.5 秒自动刷新，终态自动停止）</span>
            <button style={{ marginLeft: "auto", minHeight: 30 }} onClick={refreshAll}>
              <RefreshCw size={14} /> 刷新
            </button>
          </div>
          {loadError && (
            <div className="alert-box" role="status" style={{ marginBottom: 10 }}>
              {loadError}
            </div>
          )}
          {task.degraded && (
            <div className="degrade-banner" role="alert">
              <AlertTriangle size={18} />
              ⚠️ SKU 校验已降级：本次导入未经过商品主数据完整校验，数据可能需要后续复核。
            </div>
          )}
          <div className="progress"><span style={{ width: `${percent}%` }} /></div>
          <div className="progress-meta">
            <span>{percent}%</span>
            <span>{processedRows ?? 0}/{totalRows ?? 0} 行</span>
          </div>
          <div className="metric-grid">
            <Metric label="文件名" value={<span style={{ fontSize: 14 }}>{task.file_name || "-"}</span>} />
            <Metric label="task_id" value={<span style={{ fontSize: 13 }}>{task.task_id}</span>} />
            <Metric
              label="trace_id"
              value={task.trace_id
                ? <span style={{ fontSize: 13 }}><Link href={`/traces?trace_id=${task.trace_id}`}>{task.trace_id}</Link></span>
                : <Pending width={110} />}
            />
            <Metric accent label="成功行数" value={task.success_rows ?? <Pending />} />
            <Metric label="失败行数" value={task.failed_rows ?? <Pending />} />
            <Metric
              label="已完成批次 / 总批次"
              value={task.completed_batches === undefined
                ? <Pending width={70} />
                : `${task.completed_batches}/${task.total_batches ?? 0}${(task.failed_batches ?? 0) > 0 ? `（失败 ${task.failed_batches}）` : ""}`}
            />
            <Metric
              accent
              label="当前吞吐量"
              value={task.throughput_per_sec === undefined ? <Pending /> : `${task.throughput_per_sec} 行/秒`}
            />
            <Metric
              label="预计剩余时间"
              value={finished ? "已完成" : task.eta_seconds != null ? `${task.eta_seconds}s` : "计算中"}
            />
          </div>
          {task.error_message && <div className="alert-box critical">{task.error_message}</div>}
          {recentErrors.length > 0 && (
            <p className="muted">
              最近错误摘要：{recentErrors.map((item) => `${item.error_code}×${item.count}`).join("，")}
              <a href={`/api/import-tasks/${task.task_id}/errors-export`} style={{ marginLeft: 10, display: "inline-flex", alignItems: "center", gap: 4 }}><Download size={13} />导出失败明细 CSV</a>
            </p>
          )}
          {finished && !recentErrors.length && (
            <a href={`/api/import-tasks/${task.task_id}/errors-export`}><button><Download size={16} /> 导出失败明细 CSV</button></a>
          )}
        </section>

        <section className="panel wide">
          <div className="panel-title">行级错误明细（共 {errorsLoaded ? errorTotal : "…"} 条，按批次/错误码筛选）</div>
          <div className="v4-toolbar">
            <div className="field">
              <label>批次号</label>
              <input className="search" placeholder="批次号，如 0" value={batchFilter} onChange={(event) => { setBatchFilter(event.target.value); setErrorPage(1); }} />
            </div>
            <div className="field">
              <label>错误码</label>
              <select value={codeFilter} onChange={(event) => { setCodeFilter(event.target.value); setErrorPage(1); }}>
                <option value="">全部错误码</option>
                {["E001", "E002", "E003", "E004", "E005", "E006", "E007", "E008"].map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
            </div>
            <div className="v4-toolbar-actions">
              <button onClick={() => void loadErrors()}><Search size={16} /> 筛选</button>
            </div>
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
            {!errorsLoaded && !errors.length && <TableSkeleton columns={7} />}
            {errorsLoaded && !errors.length && <div className="empty-state compact"><strong>没有匹配的错误记录</strong><span>任务校验通过的行不会产生错误明细。</span></div>}
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
            {!batchesLoaded && !batches.length && <TableSkeleton columns={8} />}
            {batchesLoaded && !batches.length && <div className="empty-state compact"><strong>暂无批次记录</strong><span>批次创建后会在这里显示执行进度。</span></div>}
          </div>
        </section>
      </section>
    </V4Shell>
  );
}
