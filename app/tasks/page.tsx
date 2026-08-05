"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FileUp,
  Loader2,
  Wand2,
  Search,
  Trash2,
  ChevronLeft,
  ChevronRight
} from "lucide-react";
import V4Shell from "@/app/v4-shell";
import { writeTaskSeed } from "@/lib/task-seed";
import type { ParseRule } from "@/lib/types";

interface TaskSummary {
  id: string;
  file_name: string;
  status: string;
  total_rows: string | number;
  processed_rows: string | number;
  success_rows: string | number;
  failed_rows: string | number;
  total_batches: string | number;
  trace_id: string;
  degraded: boolean;
  created_at: string;
  completed_at: string | null;
}

interface PaginationInfo {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "pending", label: "待处理" },
  { value: "processing", label: "处理中" },
  { value: "completed", label: "已完成" },
  { value: "partial_success", label: "部分成功" },
  { value: "failed", label: "失败" }
];

const DEFAULT_PAGE_SIZE = 10;

export default function TasksPage() {
  const router = useRouter();
  const [rules, setRules] = useState<ParseRule[]>([]);
  const [ruleId, setRuleId] = useState("");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  // 分页与筛选状态
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [statusFilter, setStatusFilter] = useState("");
  const [keyword, setKeyword] = useState("");
  const [pagination, setPagination] = useState<PaginationInfo>({
    page: 1,
    page_size: DEFAULT_PAGE_SIZE,
    total: 0,
    total_pages: 1
  });

  // 清空数据状态
  const [clearing, setClearing] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 用 ref 保存最新筛选值，避免 loadTasks 闭包捕获过期状态（修复关键词搜索失效的根本原因）
  const filtersRef = useRef({ page, pageSize, statusFilter, keyword });
  filtersRef.current = { page, pageSize, statusFilter, keyword };

  /** 加载任务列表（带分页和筛选）——始终读取 ref 中的最新值 */
  const loadTasks = useCallback(async (): Promise<void> => {
    const { page: p, pageSize: ps, statusFilter: st, keyword: kw } = filtersRef.current;
    setLoadingList(true);
    setError("");
    try {
      const params = new URLSearchParams({ page: String(p), page_size: String(ps) });
      if (st) params.set("status", st);
      if (kw) params.set("keyword", kw);

      const response = await fetch(`/api/import-tasks?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (Array.isArray(data.tasks)) setTasks(data.tasks);
      if (data.pagination) setPagination(data.pagination);
    } catch {
      setError("任务列表加载失败，请稍后重试");
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    // 加载解析规则（仅首次）
    fetch("/api/rules")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.rules)) {
          setRules(data.rules as ParseRule[]);
          setRuleId((data.rules as ParseRule[])[0]?.id ?? "");
        }
      })
      .catch(() => undefined);

    void loadTasks();
    // 注意：导入任务列表不再自动刷新，需点击「查询」按钮或翻页后手动拉取
  }, [loadTasks]);

  /** 筛选条件仅更新状态，点击「查询」按钮或回车才真正拉取（列表不再自动刷新） */
  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    setPage(1);
  };

  const handleKeywordChange = (value: string) => {
    setKeyword(value);
    setPage(1);
  };

  const handlePageSizeChange = (value: number) => {
    setPageSize(value);
    setPage(1);
  };

  /** 点击「查询」或回车：按当前筛选条件重新拉取列表（重置到第 1 页） */
  const applyQuery = (): void => {
    setPage(1);
    void loadTasks();
  };

  /** 重置全部筛选条件并重新拉取 */
  const resetFilters = (): void => {
    setKeyword("");
    setStatusFilter("");
    setPageSize(DEFAULT_PAGE_SIZE);
    setPage(1);
    void loadTasks();
  };

  /** 翻页 */
  const goToPage = (p: number) => {
    if (p < 1 || p > pagination.total_pages) return;
    setPage(p);
    setTimeout(() => void loadTasks(), 0);
  };

  /** 上传文件 */
  const upload = async (): Promise<void> => {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return setMessage("请先选择文件");
    if (!ruleId) return setMessage("请先选择解析规则");
    setBusy(true);
    setMessage("");
    const startedAt = Date.now();
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("ruleId", ruleId);
      const response = await fetch("/api/import-tasks", { method: "POST", body: form });
      const data = await response.json();
      const elapsed = Date.now() - startedAt;
      if (!response.ok) {
        setMessage(data.error ?? "上传失败");
        setBusy(false);
        return;
      }

      writeTaskSeed({
        task_id: data.task_id,
        trace_id: data.trace_id,
        file_name: file.name,
        status: data.status ?? "PENDING",
        status_raw: String(data.status ?? "PENDING").toLowerCase(),
        total_rows: Number(data.total_rows ?? 0),
        total_batches: Number(data.total_batches ?? 0),
        created_at: new Date().toISOString()
      });

      setMessage(`上传成功（${elapsed}ms），正在进入任务详情…${data.duplicate_of ? `（检测到 24 小时内重复文件 ${data.duplicate_of}，已按幂等策略处理）` : ""}`);
      setFileName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      router.push(`/tasks/${data.task_id}`);
    } catch {
      setMessage("上传失败，请检查网络");
      setBusy(false);
    }
  };

  /** 清空全部任务数据 */
  const clearAllTasks = async () => {
    setClearing(true);
    try {
      const response = await fetch("/api/import-tasks", { method: "DELETE" });
      const result = await response.json();
      if (result.ok) {
        setMessage("已清空全部导入任务及相关数据");
        setShowClearConfirm(false);
        setPage(1);
        void loadTasks();
      } else {
        setMessage(result.error ?? "清空失败");
      }
    } catch {
      setMessage("清空失败，请检查网络");
    } finally {
      setClearing(false);
    }
  };

  /** 拖拽上传处理 */
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const droppedFile = e.dataTransfer.files?.[0];
      if (droppedFile && fileInputRef.current) {
        const dt = new DataTransfer();
        dt.items.add(droppedFile);
        fileInputRef.current.files = dt.files;
        setFileName(droppedFile.name);
      }
    },
    []
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // 生成分页按钮
  const renderPagination = () => {
    const { total_pages: totalPages, total } = pagination;
    if (totalPages <= 1 && total <= pageSize) return null;

    const pages: (number | "...")[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (page > 3) pages.push("...");
      for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) {
        pages.push(i);
      }
      if (page < totalPages - 2) pages.push("...");
      pages.push(totalPages);
    }

    return (
      <div className="pager">
        <span className="muted">
          共 <strong>{total}</strong> 条记录，第 {page}/{totalPages} 页
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            onClick={() => goToPage(page - 1)}
            disabled={page <= 1}
            title="上一页"
            style={{ padding: "6px 10px", minHeight: 32 }}
          >
            <ChevronLeft size={14} />
          </button>
          {pages.map((p, idx) =>
            p === "..." ? (
              <span key={`dots-${idx}`} className="muted" style={{ padding: "0 4px" }}>…</span>
            ) : (
              <button
                key={p}
                onClick={() => goToPage(p)}
                disabled={p === page}
                style={{
                  padding: "5px 12px",
                  minHeight: 32,
                  background: p === page ? "#0b8f8c" : undefined,
                  borderColor: p === page ? "#0b8f8c" : undefined
                }}
              >
                {p}
              </button>
            )
          )}
          <button
            onClick={() => goToPage(page + 1)}
            disabled={page >= totalPages}
            title="下一页"
            style={{ padding: "6px 10px", minHeight: 32 }}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    );
  };

  // 当前页统计摘要
  const processingCount = tasks.filter(
    (t) => t.status === "processing" || t.status === "pending"
  ).length;
  const failedCount = tasks.filter(
    (t) => t.status === "failed" || t.status === "partial_success"
  ).length;

  return (
    <V4Shell title="导入任务" subtitle="异步导入：上传即返回 task_id，后台事件驱动批量处理">
      <section className="shell">
        {/* ===== 上传区域（支持拖拽） ===== */}
        <section className="panel">
          <div className="panel-title"><FileUp size={18} /> 新建异步导入任务（上传即返回 task_id）</div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr auto" }}>
            <label
              className="dropzone"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.docx,.pdf"
                disabled={busy}
                onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")}
              />
              <strong>{fileName || "选择或拖拽 Excel / Word / PDF 文件到此区域"}</strong>
              <span>上传后由后台 Worker 异步解析入库，进度实时可见</span>
            </label>
            <div>
              <p className="muted" style={{ marginBottom: 6 }}>手动选择解析规则（不做自动匹配）</p>
              <select value={ruleId} onChange={(event) => setRuleId(event.target.value)}>
                {!rules.length && <option value="">数据库暂无规则，请先到工作台创建</option>}
                {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}
              </select>
              <Link href="/" className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 8 }}>
                <Wand2 size={13} /> 需要 AI 生成新规则？前往导入工作台
              </Link>
            </div>
            <button onClick={() => void upload()} disabled={busy} style={{ alignSelf: "center" }}>
              {busy ? <Loader2 className="spinner" size={16} /> : <FileUp size={16} />} 上传并开始
            </button>
          </div>
          {message && <p className="muted" style={{ marginTop: 10 }}>{message}</p>}
        </section>

        {/* ===== 任务列表（分页表格 + 筛选 + 清空） ===== */}
        <section className="panel wide">
          <div className="panel-title" style={{ justifyContent: "space-between" }}>
            <span>导入任务列表</span>
            <button
              onClick={() => setShowClearConfirm(true)}
              disabled={clearing || pagination.total === 0}
              className="btn-ghost"
              title="清空全部任务数据"
            >
              {clearing ? <Loader2 className="spinner" size={14} /> : <Trash2 size={14} />} 清空数据
            </button>
          </div>

          {/* 筛选条件栏：统一工具栏，点击「查询」才拉取，不自动刷新 */}
          <div className="v4-toolbar">
            <div className="field has-icon">
              <label>文件名搜索</label>
              <Search size={14} className="search-icon" />
              <input
                type="text"
                className="search"
                placeholder="输入文件名关键词…"
                value={keyword}
                onChange={(e) => handleKeywordChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") applyQuery(); }}
              />
            </div>
            <div className="field">
              <label>任务状态</label>
              <select value={statusFilter} onChange={(e) => handleStatusChange(e.target.value)}>
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>每页条数</label>
              <select value={String(pageSize)} onChange={(e) => handlePageSizeChange(Number(e.target.value))}>
                {[10, 20, 50].map((s) => (
                  <option key={s} value={String(s)}>{s} 条/页</option>
                ))}
              </select>
            </div>
            <div className="v4-toolbar-actions">
              <button onClick={() => applyQuery()}><Search size={16} /> 查询</button>
              <button className="btn-ghost" onClick={() => resetFilters()} disabled={loadingList}>重置</button>
            </div>
          </div>

          {/* 列表摘要 */}
          <div className="list-summary">
            <span className="summary-chip">共 <strong>{pagination.total}</strong> 条</span>
            {processingCount > 0 && (
              <span className="summary-chip"><span className="pulse-dot" style={{ color: "#0b8f8c" }} /> 处理中 <strong>{processingCount}</strong></span>
            )}
            {failedCount > 0 && (
              <span className="summary-chip danger">失败/部分成功 <strong>{failedCount}</strong></span>
            )}
            {statusFilter && <span className="summary-chip warn">已筛选：{STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label}</span>}
            {keyword && <span className="summary-chip warn">关键词：{keyword}</span>}
          </div>

          {/* 表格 */}
          <div className="table-wrap">
            <table className="v4-table">
              <thead>
                <tr>
                  <th>task_id</th><th>文件名</th><th>状态</th><th className="num">总行数</th><th className="num">已处理</th>
                  <th className="num">成功</th><th className="num">失败</th><th className="num">批次</th><th>降级</th><th>创建时间</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => {
                  const isActive = task.status === "processing" || task.status === "pending";
                  return (
                    <tr
                      key={task.id}
                      className={`tr-clickable${isActive ? " row-processing" : ""}`}
                      onClick={() => router.push(`/tasks/${task.id}`)}
                    >
                      <td><Link href={`/tasks/${task.id}`} className="code-pill" onClick={(e) => e.stopPropagation()}>{task.id.slice(0, 14)}…</Link></td>
                      <td>{task.file_name}</td>
                      <td><span className={`badge ${task.status}`}>{task.status}</span></td>
                      <td className="num">{Number(task.total_rows)}</td>
                      <td className="num">{Number(task.processed_rows)}</td>
                      <td className="num">{Number(task.success_rows)}</td>
                      <td className="num">{Number(task.failed_rows)}</td>
                      <td className="num">{Number(task.total_batches)}</td>
                      <td>{task.degraded ? "⚠️ 是" : "否"}</td>
                      <td>{new Date(task.created_at).toLocaleString("zh-CN")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* 错误态 */}
            {error && !tasks.length && (
              <div className="empty-state compact">
                <div className="empty-illustration">⚠️</div>
                <strong>加载失败</strong>
                <span>{error}</span>
              </div>
            )}

            {/* 骨架屏加载态 */}
            {loadingList && !tasks.length && !error && (
              <div style={{ padding: "6px 10px" }}>
                <div className="skeleton-row"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>
                <div className="skeleton-row"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>
                <div className="skeleton-row"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>
              </div>
            )}

            {/* 空状态 */}
            {!tasks.length && !loadingList && !error && (
              <div className="empty-state compact">
                <div className="empty-illustration">📋</div>
                <strong>暂无导入任务</strong>
                <span>
                  {statusFilter || keyword
                    ? "当前筛选条件下没有匹配的任务，试试调整条件"
                    : "上传文件后会创建异步导入任务并显示在这里。"}
                </span>
              </div>
            )}
          </div>

          {/* 分页控件 */}
          {renderPagination()}
        </section>

        {/* ===== 清空确认弹窗 ===== */}
        {showClearConfirm && (
          <div className="loading-overlay" onClick={() => setShowClearConfirm(false)}>
            <div
              className="loading-card"
              onClick={(e) => e.stopPropagation()}
              style={{ minWidth: 360, maxWidth: 420 }}
            >
              <h3 style={{ margin: "0 0 8px", color: "#cf1322", fontSize: 16 }}>
                ⚠️ 确认清空数据
              </h3>
              <p style={{ margin: "0 0 18px", color: "#4e5969", fontSize: 13, lineHeight: 1.6 }}>
                此操作将<strong>永久删除</strong>全部导入任务及其关联数据（包括文件、批次、错误日志、性能记录等）。此操作不可撤销。
              </p>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button
                  onClick={() => setShowClearConfirm(false)}
                  disabled={clearing}
                  className="btn-ghost"
                >
                  取消
                </button>
                <button
                  onClick={() => void clearAllTasks()}
                  disabled={clearing}
                  style={{ background: "#cf1322", borderColor: "#ffccc7" }}
                >
                  {clearing ? (
                    <>
                      <Loader2 className="spinner" size={14} /> 清空中…
                    </>
                  ) : (
                    <>
                      <Trash2 size={14} /> 确认清空
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </V4Shell>
  );
}
