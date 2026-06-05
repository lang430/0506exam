"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Copy, Database, Download, FileUp, Play, Plus, Save, Trash2, Wand2 } from "lucide-react";
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

const orderGroupKey = (row: OrderRow): string =>
  row.externalCode?.trim() ||
  [row.storeName, row.receiverName, row.receiverPhone, row.receiverAddress].map((value) => String(value ?? "").trim()).join("|") ||
  row.id;

const groupRowsByOrder = (sourceRows: OrderRow[]) => {
  const map = new Map<string, OrderRow[]>();
  for (const row of sourceRows) {
    const key = orderGroupKey(row);
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  return Array.from(map.entries()).map(([key, groupRows], index) => ({ key, index: index + 1, rows: groupRows, head: groupRows[0] }));
};

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

const createBlankRule = (): ParseRule => ({
  id: crypto.randomUUID(),
  name: "新建规则",
  mode: "table",
  sheetStrategy: "first",
  headerRow: 1,
  dataStartRow: 2,
  mappings: {
    externalCode: { source: "header", header: "外部编码" },
    storeName: { source: "header", header: "收货门店" },
    receiverName: { source: "header", header: "收件人" },
    receiverPhone: { source: "header", header: "电话" },
    receiverAddress: { source: "header", header: "地址" },
    skuCode: { source: "header", header: "SKU编码" },
    skuName: { source: "header", header: "SKU名称" },
    quantity: { source: "header", header: "数量" },
    spec: { source: "header", header: "规格" },
    remark: { source: "header", header: "备注" }
  }
});

const isDegradedAiRule = (rule: ParseRule): boolean =>
  rule.name.startsWith("AI草案-") ||
  (rule.assumptions ?? []).some((item) => item.includes("大模型环境变量未完整配置") || item.includes("AI_API_KEY") || item.includes("启发式规则") || item.includes("所有字段映射均需用户预览确认后再保存"));

export default function Page() {
  const [rules, setRules] = useState<ParseRule[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [ruleText, setRuleText] = useState("");
  const [sheets, setSheets] = useState<SheetSnapshot[]>([]);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [history, setHistory] = useState<OrderRow[]>([]);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [toast, setToast] = useState("等待上传文件");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("0/0");
  const [historyFilters, setHistoryFilters] = useState({ keyword: "", externalCode: "", receiverName: "", dateFrom: "", dateTo: "" });
  const [previewPage, setPreviewPage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);
  const selectedRule = rules.find((rule) => rule.id === selectedRuleId);
  const existingCodes = useMemo(() => new Set(history.map((row) => row.externalCode).filter(Boolean)), [history]);
  const previewPageSize = 100;
  const totalPreviewPages = Math.max(1, Math.ceil(rows.length / previewPageSize));
  const visibleRows = rows.slice((previewPage - 1) * previewPageSize, previewPage * previewPageSize);
  const previewOrderGroups = useMemo(() => groupRowsByOrder(visibleRows), [visibleRows]);
  const filteredHistory = history.filter((row) => {
    const keyword = historyFilters.keyword.trim().toLowerCase();
    const values = [
      row.externalCode,
      row.storeName,
      row.receiverName,
      row.receiverPhone,
      row.receiverAddress,
      row.skuCode,
      row.skuName,
      row.spec,
      row.remark
    ].map((value) => String(value ?? "").toLowerCase());
    const submittedTime = row.submittedAt ? new Date(row.submittedAt).getTime() : 0;
    const fromTime = historyFilters.dateFrom ? new Date(`${historyFilters.dateFrom}T00:00:00`).getTime() : 0;
    const toTime = historyFilters.dateTo ? new Date(`${historyFilters.dateTo}T23:59:59.999`).getTime() : 0;
    return (!keyword || values.some((value) => value.includes(keyword))) &&
      (!historyFilters.externalCode || String(row.externalCode ?? "").toLowerCase().includes(historyFilters.externalCode.toLowerCase())) &&
      (!historyFilters.receiverName || String(row.receiverName ?? "").toLowerCase().includes(historyFilters.receiverName.toLowerCase())) &&
      (!fromTime || submittedTime >= fromTime) &&
      (!toTime || submittedTime <= toTime);
  });
  const historyPageSize = 24;
  const totalHistoryPages = Math.max(1, Math.ceil(filteredHistory.length / historyPageSize));
  const pagedHistory = filteredHistory.slice((historyPage - 1) * historyPageSize, historyPage * historyPageSize);
  const historyOrderGroups = useMemo(() => groupRowsByOrder(pagedHistory), [pagedHistory]);

  async function loadHistory(): Promise<void> {
    try {
      const params = new URLSearchParams();
      if (historyFilters.keyword.trim()) params.set("q", historyFilters.keyword.trim());
      if (historyFilters.externalCode.trim()) params.set("externalCode", historyFilters.externalCode.trim());
      if (historyFilters.receiverName.trim()) params.set("receiverName", historyFilters.receiverName.trim());
      if (historyFilters.dateFrom) params.set("dateFrom", historyFilters.dateFrom);
      if (historyFilters.dateTo) params.set("dateTo", historyFilters.dateTo);
      const response = await fetch(`/api/orders${params.size ? `?${params.toString()}` : ""}`);
      const data = await response.json();
      if (!response.ok) return setTimedToast(data.error ?? "数据库历史记录读取失败");
      setHistory(Array.isArray(data.rows) ? data.rows : []);
      setHistoryPage(1);
      if (data.error) setTimedToast(data.error);
    } catch {
      setTimedToast("数据库历史记录读取失败");
    }
  }

  useEffect(() => {
    fetch("/api/rules").then((res) => res.json()).then((data) => {
      if (Array.isArray(data.rules) && data.rules.length) {
        const usableRules = (data.rules as ParseRule[]).filter((rule) => !isDegradedAiRule(rule));
        setRules(usableRules);
        setSelectedRuleId(usableRules[0]?.id ?? "");
        if (usableRules.length !== data.rules.length) {
          void fetch("/api/rules", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ degraded: true }) });
          setTimedToast("已忽略并清理历史降级规则，请重新调用大模型生成规则");
        }
      }
      if (data.error) setTimedToast(data.error);
      if (Array.isArray(data.rules) && !data.rules.length) setTimedToast("数据库暂无解析规则，请新建或使用 AI 生成规则");
    }).catch(() => setTimedToast("数据库解析规则读取失败"));
    void loadHistory();
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
      let nextSheets: SheetSnapshot[];
      if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
        const XLSX = await import("@e965/xlsx");
        const workbook = XLSX.read(buffer, { type: "array" });
        nextSheets = workbook.SheetNames.map((name) => {
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
        nextSheets = sheetRowsFromText(file.name, result.value);
        setSheets(nextSheets);
        setProgressText("1/1");
      } else if (lower.endsWith(".pdf")) {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString();
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
        const lines: string[] = [];
        for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
          const page = await doc.getPage(pageNo);
          const content = await page.getTextContent();
          lines.push(content.items.map((item: { str?: string }) => item.str ?? "").join(" "));
          setProgress(Math.round((pageNo / doc.numPages) * 90));
          setProgressText(`${pageNo}/${doc.numPages}`);
        }
        nextSheets = sheetRowsFromText(file.name, lines.join("\n"));
        setSheets(nextSheets);
      } else {
        throw new Error("仅支持 .xlsx/.xls/.docx/.pdf 文件");
      }
      setRows([]);
      setIssues([]);
      setPreviewPage(1);
      setProgress(100);
      setTimedToast("文件已读取，正在实时调用 AI 生成规则");
      void generateRule(nextSheets, file.name, true);
    } catch (error) {
      setTimedToast(error instanceof Error ? error.message : "文件读取失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLLabelElement>): void => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void readFile(file);
  };

  const generateRule = async (sourceSheets = sheets, sourceFileName = fileName, auto = false): Promise<void> => {
    if (!sourceSheets.length) return setTimedToast("请先上传文件");
    setBusy(true);
    setProgress(35);
    setProgressText("AI生成中");
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch("/api/ai-rules", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: sourceFileName, auto, sheets: sourceSheets.map((sheet) => ({ ...sheet, rows: sheet.rows.slice(0, 30) })) })
      }).finally(() => clearTimeout(timeout));
      setProgress(70);
      const rawText = await response.text();
      const aiData = rawText ? JSON.parse(rawText) : {};
      if (!response.ok || aiData.degraded || !aiData.rule) {
        if (auto && parseWithExistingRule(sourceSheets, aiData.error ?? "AI 规则生成失败")) return;
        setProgress(100);
        setProgressText("AI失败");
        return setTimedToast(aiData.error ?? "AI 规则生成失败");
      }
      const rule = aiData.rule as ParseRule;
      const savedData = await saveRuleRemote(rule);
      const nextRules = Array.isArray(savedData.rules) ? savedData.rules as ParseRule[] : [rule, ...rules.filter((item) => item.id !== rule.id)];
      setRules(nextRules);
      setSelectedRuleId(rule.id);
      const parsed = parseByRule(sourceSheets, rule);
      const nextIssues = validateRows(parsed, existingCodes);
      setRows(parsed.map((row) => ({ ...row, errors: nextIssues.filter((issue) => issue.rowId === row.id).map((issue) => issue.message) })));
      setIssues(nextIssues);
      setPreviewPage(1);
      setProgressText(`${parsed.length}/${parsed.length}`);
      setProgress(100);
      const savedText = savedData.rules ? `已保存到${savedData.mode === "database" ? "数据库" : "服务端文件"}` : "数据库暂不可用，已先在当前页面使用";
      setTimedToast(aiData.degraded ? `已生成启发式规则草案：${aiData.error ?? "请人工确认"}，已解析 ${parsed.length} 行` : `${auto ? "已实时" : "AI 已"}生成规则草案，${savedText}，已解析 ${parsed.length} 行，${nextIssues.length} 个问题`);
    } catch (error) {
      setProgress(100);
      setProgressText("AI失败");
      setTimedToast(error instanceof Error && error.name === "AbortError" ? "AI 规则生成超时，请稍后重试或检查大模型配置" : "AI 规则生成失败，请查看服务端调用日志");
    } finally {
      setBusy(false);
    }
  };

  const parseWithExistingRule = (sourceSheets: SheetSnapshot[], reason: string): boolean => {
    const rule = selectedRule ?? rules[0];
    if (!rule) return false;
    const parsed = parseByRule(sourceSheets, rule);
    const nextIssues = validateRows(parsed, existingCodes);
    setRows(parsed.map((row) => ({ ...row, errors: nextIssues.filter((issue) => issue.rowId === row.id).map((issue) => issue.message) })));
    setIssues(nextIssues);
    setPreviewPage(1);
    setProgressText(`${parsed.length}/${parsed.length}`);
    setProgress(100);
    setTimedToast(`AI 规则生成失败，已使用「${rule.name}」解析 ${parsed.length} 行：${reason}`);
    return true;
  };

  const saveRule = (): void => {
    try {
      const rule = JSON.parse(ruleText) as ParseRule;
      void saveRuleRemote(rule).then((data) => {
        const nextRules = data.rules as ParseRule[];
        if (!nextRules) return setTimedToast("规则保存失败，请检查数据库配置");
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
    if (!selectedRule) return setTimedToast("请先从数据库选择一条规则");
    const nextRule = { ...selectedRule, id: crypto.randomUUID(), name: `${selectedRule.name} 副本` };
    setRuleText(JSON.stringify(nextRule, null, 2));
    setTimedToast("已复制为新规则草案，请确认后保存");
  };

  const deleteRule = async (): Promise<void> => {
    if (!selectedRule) return setTimedToast("请先从数据库选择一条规则");
    const response = await fetch("/api/rules", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: selectedRule.id })
    });
    const data = await response.json();
    if (!data.rules) return setTimedToast(data.error ?? "规则删除失败");
    const nextRules = data.rules as ParseRule[];
    setRules(nextRules);
    setSelectedRuleId(nextRules[0]?.id ?? "");
    setTimedToast(`规则已删除，存储模式：${data.mode}`);
  };

  const runParse = (): void => {
    if (!sheets.length) return setTimedToast("请先上传文件");
    if (!selectedRule) return setTimedToast("请先从数据库选择解析规则");
    const parsed = parseByRule(sheets, selectedRule);
    const nextIssues = validateRows(parsed, existingCodes);
    setPreviewPage(1);
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
    setPreviewPage(1);
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
      body: JSON.stringify({ fileName, ruleId: selectedRule?.id, rows })
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

  const clearImportedOrders = async (): Promise<void> => {
    if (!history.length) return setTimedToast("当前没有可清除的已导入运单");
    if (!window.confirm("确认清空数据库中的已导入运单数据？此操作不可撤销。")) return;
    setBusy(true);
    const response = await fetch("/api/orders", { method: "DELETE" });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) return setTimedToast(data.error ?? "清空数据库数据失败");
    setHistory([]);
    setHistoryPage(1);
    setTimedToast(`已清空数据库导入数据：运单 ${data.deletedOrders ?? 0} 条，批次 ${data.deletedBatches ?? 0} 条`);
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
            <label
              className="dropzone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
            >
              <input type="file" accept=".xlsx,.xls,.docx,.pdf" onChange={(event) => event.target.files?.[0] && readFile(event.target.files[0])} />
              <strong>{fileName || "拖拽或点击上传文件"}</strong>
              <span>支持 Excel、Word、PDF；上传后实时调用 AI 生成规则草案</span>
            </label>
            <div className="progress"><span style={{ width: `${progress}%` }} /></div>
            <div className="progress-meta"><span>{progress}%</span><span>{progressText}</span></div>
            <div className="sheet-list">{sheets.map((sheet) => <span key={sheet.name}>{sheet.name} · {sheet.rows.length} 行</span>)}</div>
          </section>

          <section className="panel">
            <div className="panel-title"><Wand2 size={18} /> 解析规则</div>
            <select value={selectedRuleId} onChange={(event) => setSelectedRuleId(event.target.value)}>
              {!rules.length && <option value="">数据库暂无规则</option>}
              {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}
            </select>
            <div className="actions">
              <button onClick={() => void generateRule()} disabled={busy}><Wand2 size={16} /> AI 生成规则</button>
              <button onClick={() => setRuleText(JSON.stringify(createBlankRule(), null, 2))}><Plus size={16} /> 新建规则</button>
              <button onClick={copyRule}><Copy size={16} /> 复制</button>
              <button onClick={saveRule}><Save size={16} /> 保存</button>
              <button onClick={deleteRule}><Trash2 size={16} /> 删除</button>
              <button onClick={runParse} disabled={!selectedRule}><Play size={16} /> 试解析</button>
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
                {previewOrderGroups.map((group) => (
                  <Fragment key={group.key}>
                    <tr key={`${group.key}-group`} className="order-group-row">
                      <td colSpan={fields.length + 1}>
                        出库单 {group.index} · 外部编码：{group.head.externalCode || "未填写"} ·
                        收货：{group.head.storeName || [group.head.receiverName, group.head.receiverPhone, group.head.receiverAddress].filter(Boolean).join(" / ") || "未填写"} ·
                        SKU {group.rows.length} 行
                      </td>
                    </tr>
                    {group.rows.map((row) => (
                      <tr key={row.id} className={row.errors.length ? "bad" : ""}>
                        <td><button className="icon" onClick={() => deletePreviewRow(row.id)}><Trash2 size={15} /></button></td>
                        {fields.map((field) => <td key={field.key}><input data-grid-cell="true" value={String(row[field.key] ?? "")} onKeyDown={moveCellFocus} onChange={(event) => updateCell(row.id, field.key, event.target.value)} /></td>)}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions sticky-actions">
            <button onClick={addEmptyRow}><Plus size={16} /> 新增行</button>
            <button onClick={() => setPreviewPage((page) => Math.max(1, page - 1))} disabled={previewPage <= 1}>上一页</button>
            <label className="page-jump"><span>第</span><input className="search" type="number" min={1} max={totalPreviewPages} value={previewPage} onChange={(event) => setPreviewPage(Math.min(totalPreviewPages, Math.max(1, Number(event.target.value) || 1)))} /><span>/ {totalPreviewPages} 页</span></label>
            <button onClick={() => setPreviewPage((page) => Math.min(totalPreviewPages, page + 1))} disabled={previewPage >= totalPreviewPages}>下一页</button>
            <button onClick={exportExcel} disabled={!rows.length}><Download size={16} /> 导出 Excel</button>
            <button onClick={submitOrders} disabled={!rows.length || busy}><Database size={16} /> 提交下单</button>
            <span>当前第 {previewPage} 页，每页 {previewPageSize} 个 SKU 行，显示 {previewOrderGroups.length} 个出库单 / {visibleRows.length} 个 SKU 行，共 {rows.length} 行</span>
          </div>
        </section>

        <section className="panel wide">
          <div className="panel-title"><Database size={18} /> 已导入运单</div>
          <div className="history-filters">
            <input className="search span-2" value={historyFilters.keyword} onChange={(event) => { setHistoryFilters((value) => ({ ...value, keyword: event.target.value })); setHistoryPage(1); }} placeholder="模糊查询：外部编码、门店、收件人、电话、地址、SKU、备注" />
            <input className="search" value={historyFilters.externalCode} onChange={(event) => { setHistoryFilters((value) => ({ ...value, externalCode: event.target.value })); setHistoryPage(1); }} placeholder="外部编码" />
            <input className="search" value={historyFilters.receiverName} onChange={(event) => { setHistoryFilters((value) => ({ ...value, receiverName: event.target.value })); setHistoryPage(1); }} placeholder="收件人" />
            <label className="date-filter"><span>开始日期</span><input className="search" type="date" value={historyFilters.dateFrom} onChange={(event) => { setHistoryFilters((value) => ({ ...value, dateFrom: event.target.value })); setHistoryPage(1); }} /></label>
            <label className="date-filter"><span>结束日期</span><input className="search" type="date" value={historyFilters.dateTo} onChange={(event) => { setHistoryFilters((value) => ({ ...value, dateTo: event.target.value })); setHistoryPage(1); }} /></label>
            <button onClick={loadHistory} disabled={busy}>查询</button>
            <button onClick={() => { setHistoryFilters({ keyword: "", externalCode: "", receiverName: "", dateFrom: "", dateTo: "" }); setHistoryPage(1); }}>重置查询</button>
            <button onClick={clearImportedOrders} disabled={!history.length || busy}><Trash2 size={16} /> 清空导入数据</button>
          </div>
          <div className="table-wrap history-table">
            <table>
              <thead><tr><th>外部编码</th><th>收货门店</th><th>收件人</th><th>电话</th><th>地址</th><th>SKU编码</th><th>SKU名称</th><th>规格</th><th>数量</th><th>备注</th><th>提交时间</th></tr></thead>
              <tbody>
                {historyOrderGroups.map((group) => (
                  <Fragment key={group.key}>
                    <tr key={`${group.key}-history-group`} className="order-group-row">
                      <td colSpan={11}>
                        出库单 {group.index} · 外部编码：{group.head.externalCode || "未填写"} ·
                        收货：{group.head.storeName || [group.head.receiverName, group.head.receiverPhone, group.head.receiverAddress].filter(Boolean).join(" / ") || "未填写"} ·
                        SKU {group.rows.length} 行
                      </td>
                    </tr>
                    {group.rows.map((row) => <tr key={row.id}><td>{row.externalCode}</td><td>{row.storeName}</td><td>{row.receiverName}</td><td>{row.receiverPhone}</td><td className="wide-cell">{row.receiverAddress}</td><td>{row.skuCode}</td><td className="wide-cell">{row.skuName}</td><td>{row.spec}</td><td>{row.quantity}</td><td className="wide-cell">{row.remark}</td><td>{row.submittedAt ? new Date(row.submittedAt).toLocaleString("zh-CN") : "数据库记录"}</td></tr>)}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {!filteredHistory.length && <p className="empty">暂无匹配的已导入运单</p>}
          </div>
          <div className="pager">
            <button onClick={() => setHistoryPage((page) => Math.max(1, page - 1))} disabled={historyPage <= 1}>上一页</button>
            <span>第 {historyPage} / {totalHistoryPages} 页，共 {groupRowsByOrder(filteredHistory).length} 个出库单 / {filteredHistory.length} 个 SKU 行</span>
            <button onClick={() => setHistoryPage((page) => Math.min(totalHistoryPages, page + 1))} disabled={historyPage >= totalHistoryPages}>下一页</button>
          </div>
        </section>
      </section>
    </main>
  );
}
