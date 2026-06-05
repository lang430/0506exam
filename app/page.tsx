"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Copy, Database, Download, FileUp, Play, Plus, Save, Trash2, Wand2 } from "lucide-react";
import { defaultRules } from "@/lib/default-rules";
import { parseByRule, validateRows } from "@/lib/rule-engine";
import type { OrderField, OrderRow, ParseRule, SheetSnapshot, ValidationIssue } from "@/lib/types";

const fields: { key: OrderField; label: string }[] = [
  { key: "externalCode", label: "外部编码" },
  { key: "storeName", label: "收货门店" },
  { key: "receiverName", label: "收件人" },
  { key: "receiverPhone", label: "电话" },
  { key: "receiverAddress", label: "地址" },
  { key: "skuCode", label: "SKU编码" },
  { key: "skuName", label: "SKU名称" },
  { key: "quantity", label: "数量" },
  { key: "spec", label: "规格" },
  { key: "remark", label: "备注" }
];

const sheetRowsFromText = (name: string, content: string): SheetSnapshot[] => [{
  name,
  rows: content.split(/\r?\n/).map((line) => [line])
}];

const excelCellText = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "object") {
    const record = value as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (record.text) return record.text;
    if (record.result != null) return String(record.result);
    if (record.richText) return record.richText.map((item) => item.text).join("");
  }
  return String(value);
};

export default function Page() {
  const [rules, setRules] = useState<ParseRule[]>(defaultRules);
  const [selectedRuleId, setSelectedRuleId] = useState(defaultRules[0].id);
  const [ruleText, setRuleText] = useState(JSON.stringify(defaultRules[0], null, 2));
  const [sheets, setSheets] = useState<SheetSnapshot[]>([]);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [history, setHistory] = useState<OrderRow[]>([]);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [toast, setToast] = useState("等待上传文件");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("0/0");
  const [filter, setFilter] = useState("");
  const [previewLimit, setPreviewLimit] = useState(300);
  const [historyPage, setHistoryPage] = useState(1);
  const selectedRule = rules.find((rule) => rule.id === selectedRuleId) ?? rules[0];
  const existingCodes = useMemo(() => new Set(history.map((row) => row.externalCode).filter(Boolean)), [history]);
  const visibleRows = rows.slice(0, previewLimit);
  const filteredHistory = history.filter((row) => [row.externalCode, row.receiverName, row.storeName, row.submittedAt].join(" ").includes(filter));
  const historyPageSize = 24;
  const totalHistoryPages = Math.max(1, Math.ceil(filteredHistory.length / historyPageSize));
  const pagedHistory = filteredHistory.slice((historyPage - 1) * historyPageSize, historyPage * historyPageSize);

  useEffect(() => {
    fetch("/api/rules").then((res) => res.json()).then((data) => {
      if (Array.isArray(data.rules) && data.rules.length) {
        setRules(data.rules);
        setSelectedRuleId(data.rules[0].id);
      }
    }).catch(() => setTimedToast("规则加载失败，已使用默认规则"));
    fetch("/api/orders").then((res) => res.json()).then((data) => {
      if (Array.isArray(data.rows) && data.rows.length) setHistory(data.rows);
      if (data.error) setTimedToast(data.error);
    }).catch(() => setTimedToast("数据库历史记录读取失败"));
  }, []);

  useEffect(() => {
    if (selectedRule) setRuleText(JSON.stringify(selectedRule, null, 2));
  }, [selectedRuleId]);

  const setTimedToast = (message: string): void => setToast(message);

  const readFile = async (file: File): Promise<void> => {
    setBusy(true);
    setProgress(12);
    setProgressText("0/1");
    setFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
        const XLSX = await import("@e965/xlsx");
        const workbook = XLSX.read(buffer, { type: "array" });
        const nextSheets = workbook.SheetNames.map((name) => {
          const sheet = workbook.Sheets[name];
          const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false })
            .map((row) => row.map(excelCellText));
          return { name, rows };
        });
        setSheets(nextSheets);
        setProgressText(`${nextSheets.reduce((sum, sheet) => sum + sheet.rows.length, 0)}/${nextSheets.reduce((sum, sheet) => sum + sheet.rows.length, 0)}`);
      } else if (lower.endsWith(".docx")) {
        const mammoth = await import("mammoth/mammoth.browser");
        const result = await mammoth.extractRawText({ arrayBuffer: buffer });
        setSheets(sheetRowsFromText(file.name, result.value));
        setProgressText("1/1");
      } else if (lower.endsWith(".pdf")) {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;
        const lines: string[] = [];
        for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
          const page = await doc.getPage(pageNo);
          const content = await page.getTextContent();
          lines.push(content.items.map((item: { str?: string }) => item.str ?? "").join(" "));
          setProgress(Math.round((pageNo / doc.numPages) * 90));
          setProgressText(`${pageNo}/${doc.numPages}`);
        }
        setSheets(sheetRowsFromText(file.name, lines.join("\n")));
      } else {
        throw new Error("仅支持 .xlsx/.xls/.docx/.pdf 文件");
      }
      setProgress(100);
      setTimedToast("文件已读取，可选择规则或生成 AI 草案");
    } catch (error) {
      setTimedToast(error instanceof Error ? error.message : "文件读取失败");
    } finally {
      setBusy(false);
    }
  };

  const generateRule = async (): Promise<void> => {
    if (!sheets.length) return setTimedToast("请先上传文件");
    setBusy(true);
    setProgress(35);
    const response = await fetch("/api/ai-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName, sheets: sheets.map((sheet) => ({ ...sheet, rows: sheet.rows.slice(0, 30) })) })
    });
    const aiData = await response.json();
    const rule = aiData.rule as ParseRule;
    const savedData = await saveRuleRemote(rule);
    const nextRules = savedData.rules as ParseRule[];
    setRules(nextRules);
    setSelectedRuleId(rule.id);
    setProgress(100);
    setBusy(false);
    setTimedToast(aiData.degraded ? "已生成启发式规则草案，请人工确认" : `AI 已生成规则草案，已保存到${savedData.mode === "database" ? "数据库" : "服务端文件"}`);
  };

  const saveRule = (): void => {
    try {
      const rule = JSON.parse(ruleText) as ParseRule;
      void saveRuleRemote(rule).then((data) => {
        const nextRules = data.rules as ParseRule[];
        setRules(nextRules);
        setSelectedRuleId(rule.id);
        setTimedToast(`规则已保存，存储模式：${data.mode}`);
      });
    } catch {
      setTimedToast("规则 JSON 格式不正确");
    }
  };

  const saveRuleRemote = async (rule: ParseRule): Promise<{ rules: ParseRule[]; mode: string }> => {
    const response = await fetch("/api/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rule)
    });
    return response.json();
  };

  const copyRule = (): void => {
    const nextRule = { ...selectedRule, id: crypto.randomUUID(), name: `${selectedRule.name} 副本` };
    setRuleText(JSON.stringify(nextRule, null, 2));
    setTimedToast("已复制为新规则草案，请确认后保存");
  };

  const deleteRule = async (): Promise<void> => {
    if (rules.length <= 1) return setTimedToast("至少保留一条解析规则");
    const response = await fetch("/api/rules", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: selectedRule.id })
    });
    const data = await response.json();
    const nextRules = data.rules as ParseRule[];
    setRules(nextRules);
    setSelectedRuleId(nextRules[0]?.id ?? defaultRules[0].id);
    setTimedToast(`规则已删除，存储模式：${data.mode}`);
  };

  const runParse = (): void => {
    if (!sheets.length) return setTimedToast("请先上传文件");
    const parsed = parseByRule(sheets, selectedRule);
    const nextIssues = validateRows(parsed, existingCodes);
    setPreviewLimit(300);
    setProgress(100);
    setProgressText(`${parsed.length}/${parsed.length}`);
    setRows(parsed.map((row) => ({ ...row, errors: nextIssues.filter((issue) => issue.rowId === row.id).map((issue) => issue.message) })));
    setIssues(nextIssues);
    setTimedToast(`试解析完成：${parsed.length} 行，${nextIssues.length} 个问题`);
  };

  const revalidateAndSetRows = (nextRows: OrderRow[]): void => {
    const nextIssues = validateRows(nextRows, existingCodes);
    setRows(nextRows.map((row) => ({ ...row, errors: nextIssues.filter((issue) => issue.rowId === row.id).map((issue) => issue.message) })));
    setIssues(nextIssues);
  };

  const updateCell = (id: string, field: OrderField, value: string): void => {
    const nextRows = rows.map((row) => row.id === id ? { ...row, [field]: field === "quantity" ? value : value } : row);
    revalidateAndSetRows(nextRows);
  };

  const moveCellFocus = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter" && event.key !== "Tab") return;
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("[data-grid-cell='true']"));
    const index = inputs.indexOf(event.currentTarget);
    if (index < 0) return;
    event.preventDefault();
    inputs[Math.min(index + 1, inputs.length - 1)]?.focus();
  };

  const addEmptyRow = (): void => {
    const source = rows[0]?.source ?? "手工新增";
    const nextRows: OrderRow[] = [{
      id: crypto.randomUUID(),
      externalCode: "",
      storeName: "",
      receiverName: "",
      receiverPhone: "",
      receiverAddress: "",
      skuCode: "",
      skuName: "",
      quantity: "",
      spec: "",
      remark: "",
      source,
      errors: []
    }, ...rows];
    revalidateAndSetRows(nextRows);
  };

  const deletePreviewRow = (id: string): void => {
    revalidateAndSetRows(rows.filter((row) => row.id !== id));
  };

  const exportExcel = async (): Promise<void> => {
    const ExcelJS = await import("exceljs");
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("预览数据");
    sheet.columns = [
      { header: "来源", key: "source" },
      ...fields.map((field) => ({ header: field.label, key: field.key })),
      { header: "错误", key: "errors" }
    ];
    rows.forEach(({ errors, source, ...row }) => sheet.addRow({ source, ...row, errors: errors.join(";") }));
    const buffer = await book.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "万能导入预览结果.xlsx";
    link.click();
    URL.revokeObjectURL(url);
  };

  const submitOrders = async (): Promise<void> => {
    if (issues.length) return setTimedToast("存在校验错误，请修正后再提交");
    setBusy(true);
    setProgress(10);
    setProgressText(`0/${rows.length}`);
    const total = Math.max(rows.length, 1);
    const step = Math.max(1, Math.ceil(total / 10));
    for (let done = 0; done < total; done += step) {
      setProgress(Math.min(90, Math.round((done / total) * 90)));
      setProgressText(`${Math.min(done, total)}/${total}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName, ruleId: selectedRule.id, rows })
    });
    const data = await response.json();
    if (!response.ok) {
      setBusy(false);
      setTimedToast(data.error ?? "提交失败，数据库未写入");
      return;
    }
    const successCount = Number(data.saved ?? rows.length);
    const failureCount = Math.max(rows.length - successCount, 0);
    const savedRows = Array.isArray(data.rows) ? data.rows as OrderRow[] : rows;
    const nextHistory = [...savedRows, ...history];
    setHistory(nextHistory);
    setBusy(false);
    setProgress(100);
    setProgressText(`${rows.length}/${rows.length}`);
    setTimedToast(`提交结果：成功 ${successCount} 条，失败 ${failureCount} 条，模式：${data.mode}`);
  };

  return (
    <main>
      <section className="shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">万能导入 V2</p>
            <h1>智能多格式批量下单系统</h1>
          </div>
          <div className="status"><CheckCircle2 size={18} />{toast}</div>
        </header>

        <div className="grid">
          <section className="panel">
            <div className="panel-title"><FileUp size={18} /> 文件导入</div>
            <label className="dropzone">
              <input type="file" accept=".xlsx,.xls,.docx,.pdf" onChange={(event) => event.target.files?.[0] && readFile(event.target.files[0])} />
              <strong>{fileName || "拖拽或点击上传文件"}</strong>
              <span>支持 Excel、Word、PDF；上传后手动选择规则或新建 AI 草案</span>
            </label>
            <div className="progress"><span style={{ width: `${progress}%` }} /></div>
            <div className="progress-meta"><span>{progress}%</span><span>{progressText}</span></div>
            <div className="sheet-list">{sheets.map((sheet) => <span key={sheet.name}>{sheet.name} · {sheet.rows.length} 行</span>)}</div>
          </section>

          <section className="panel">
            <div className="panel-title"><Wand2 size={18} /> 解析规则</div>
            <select value={selectedRuleId} onChange={(event) => setSelectedRuleId(event.target.value)}>
              {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}
            </select>
            <div className="actions">
              <button onClick={generateRule} disabled={busy}><Wand2 size={16} /> AI 生成规则</button>
              <button onClick={() => setRuleText(JSON.stringify({ ...defaultRules[0], id: crypto.randomUUID(), name: "新建规则" }, null, 2))}><Plus size={16} /> 新建规则</button>
              <button onClick={copyRule}><Copy size={16} /> 复制</button>
              <button onClick={saveRule}><Save size={16} /> 保存</button>
              <button onClick={deleteRule}><Trash2 size={16} /> 删除</button>
              <button onClick={runParse}><Play size={16} /> 试解析</button>
            </div>
            <textarea value={ruleText} onChange={(event) => setRuleText(event.target.value)} spellCheck={false} />
          </section>
        </div>

        <section className="panel wide">
          <div className="panel-title"><AlertCircle size={18} /> 数据预览与校验</div>
          {issues.length > 0 && <div className="error-box" aria-live="polite">
            <strong>共 {issues.length} 个错误，已全部列出</strong>
            {issues.map((issue) => <span key={`${issue.rowId}-${issue.field}-${issue.message}`}>第 {issue.rowNumber} 行 · {issue.field}：{issue.message}</span>)}
          </div>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>操作</th>{fields.map((field) => <th key={field.key}>{field.label}</th>)}</tr></thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.id} className={row.errors.length ? "bad" : ""}>
                    <td><button className="icon" onClick={() => deletePreviewRow(row.id)}><Trash2 size={15} /></button></td>
                    {fields.map((field) => <td key={field.key}><input data-grid-cell="true" value={String(row[field.key] ?? "")} onKeyDown={moveCellFocus} onChange={(event) => updateCell(row.id, field.key, event.target.value)} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions sticky-actions">
            <button onClick={addEmptyRow}><Plus size={16} /> 新增行</button>
            <button onClick={() => setPreviewLimit((value) => Math.min(value + 300, rows.length))} disabled={previewLimit >= rows.length}><Plus size={16} /> 加载更多</button>
            <button onClick={exportExcel} disabled={!rows.length}><Download size={16} /> 导出 Excel</button>
            <button onClick={submitOrders} disabled={!rows.length || busy}><Database size={16} /> 提交下单</button>
            <span>当前渲染 {visibleRows.length}/{rows.length} 行，按 300 行分批展示以保证流畅</span>
          </div>
        </section>

        <section className="panel wide">
          <div className="panel-title"><Database size={18} /> 已导入运单</div>
          <input className="search" value={filter} onChange={(event) => { setFilter(event.target.value); setHistoryPage(1); }} placeholder="按外部编码、收件人、门店、提交时间筛选" />
          <div className="history">
            {pagedHistory.map((row) => <div key={row.id}><strong>{row.externalCode || row.storeName || "未命名运单"}</strong><span>{row.receiverName} {row.skuName} × {row.quantity}</span><span>{row.submittedAt ? new Date(row.submittedAt).toLocaleString("zh-CN") : "数据库记录"}</span></div>)}
            {!filteredHistory.length && <p className="empty">暂无历史记录</p>}
          </div>
          <div className="pager">
            <button onClick={() => setHistoryPage((page) => Math.max(1, page - 1))} disabled={historyPage <= 1}>上一页</button>
            <span>第 {historyPage} / {totalHistoryPages} 页，共 {filteredHistory.length} 条</span>
            <button onClick={() => setHistoryPage((page) => Math.min(totalHistoryPages, page + 1))} disabled={historyPage >= totalHistoryPages}>下一页</button>
          </div>
        </section>
      </section>
    </main>
  );
}
