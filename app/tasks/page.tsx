"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileUp, Loader2, Wand2 } from "lucide-react";
import V4Shell from "@/app/v4-shell";
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

export default function TasksPage() {
  const [rules, setRules] = useState<ParseRule[]>([]);
  const [ruleId, setRuleId] = useState("");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadTasks = async (): Promise<void> => {
    try {
      const response = await fetch("/api/import-tasks");
      const data = await response.json();
      if (Array.isArray(data.tasks)) setTasks(data.tasks);
    } catch {
      /* 静默重试 */
    }
  };

  useEffect(() => {
    fetch("/api/rules").then((res) => res.json()).then((data) => {
      if (Array.isArray(data.rules)) {
        setRules(data.rules as ParseRule[]);
        setRuleId((data.rules as ParseRule[])[0]?.id ?? "");
      }
    }).catch(() => undefined);
    void loadTasks();
    const timer = setInterval(() => void loadTasks(), 3000);
    return () => clearInterval(timer);
  }, []);

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
        return;
      }
      setMessage(`上传成功（${elapsed}ms）：task_id=${data.task_id}，预估 ${data.total_rows} 行，${data.total_batches} 个批次${data.duplicate_of ? `；检测到 24 小时内重复文件（${data.duplicate_of}），已按幂等策略处理` : ""}`);
      setFileName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadTasks();
      window.location.href = `/tasks/${data.task_id}`;
    } catch {
      setMessage("上传失败，请检查网络");
    } finally {
      setBusy(false);
    }
  };

  return (
    <V4Shell title="导入任务" subtitle="异步导入：上传即返回 task_id，后台事件驱动批量处理">
      <section className="shell">
        <section className="panel">
          <div className="panel-title"><FileUp size={18} /> 新建异步导入任务（上传即返回 task_id）</div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr auto" }}>
            <label className="dropzone" style={{ minHeight: 90 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.docx,.pdf"
                disabled={busy}
                onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")}
              />
              <strong>{fileName || "选择 Excel / Word / PDF 文件"}</strong>
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

        <section className="panel wide">
          <div className="panel-title">导入任务列表（3 秒自动刷新）</div>
          <div className="table-wrap">
            <table className="v4-table">
              <thead>
                <tr>
                  <th>task_id</th><th>文件名</th><th>状态</th><th>总行数</th><th>已处理</th>
                  <th>成功</th><th>失败</th><th>批次</th><th>降级</th><th>创建时间</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id}>
                    <td><Link href={`/tasks/${task.id}`} className="code-pill">{task.id.slice(0, 14)}…</Link></td>
                    <td>{task.file_name}</td>
                    <td><span className={`badge ${task.status}`}>{task.status}</span></td>
                    <td>{Number(task.total_rows)}</td>
                    <td>{Number(task.processed_rows)}</td>
                    <td>{Number(task.success_rows)}</td>
                    <td>{Number(task.failed_rows)}</td>
                    <td>{Number(task.total_batches)}</td>
                    <td>{task.degraded ? "⚠️ 是" : "否"}</td>
                    <td>{new Date(task.created_at).toLocaleString("zh-CN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!tasks.length && <div className="empty-state compact"><strong>暂无导入任务</strong><span>上传文件后会创建异步导入任务并显示在这里。</span></div>}
          </div>
        </section>
      </section>
    </V4Shell>
  );
}
