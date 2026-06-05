import { NextResponse } from "next/server";
import { consumeAiQuota } from "@/lib/ai-quota";
import { parseByRule, validateRows } from "@/lib/rule-engine";
import { getAiConfig } from "@/lib/runtime-config";
import { orderFields } from "@/lib/types";
import type { ColumnMapping, ParseRule, SheetSnapshot } from "@/lib/types";

export const runtime = "nodejs";

interface Payload {
  fileName: string;
  sheets: SheetSnapshot[];
  auto?: boolean;
}

interface AiAttempt {
  model: string;
  attemptIndex?: number;
  ok: boolean;
  error?: string;
  category?: string;
  status?: number;
  contentPreview?: string;
  quota?: unknown;
}

const logAiRules = (event: string, details: Record<string, unknown>): void => {
  console.info(`[ai-rules] ${event}`, JSON.stringify(details));
};

const maxAiAttempts = 3;
const aiRequestTimeoutMs = 30000;

const previewText = (value: unknown, maxLength = 240): string =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

const classifyModelFailure = (content: string, status?: number): { category: string; message: string } => {
  const lower = content.toLowerCase();
  if (status === 401 || status === 403 || lower.includes("invalid api key") || lower.includes("unauthorized")) {
    return { category: "auth", message: "大模型鉴权失败，请检查 AI_API_KEY 配置" };
  }
  if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { category: "rate-limit", message: "大模型服务触发限流，请稍后重试或调整候选模型" };
  }
  if (lower.includes("prevent abuse of free resources") || lower.includes("topup") || lower.includes("recharg")) {
    return { category: "provider-quota", message: "大模型服务额度受限，请稍后重试或检查账号额度" };
  }
  if (lower.includes("model") && (lower.includes("not found") || lower.includes("not exist") || lower.includes("unsupported"))) {
    return { category: "model-unavailable", message: "模型不可用，请检查 AI_MODEL 配置" };
  }
  return { category: "invalid-response", message: "模型未返回可解析的规则 JSON" };
};

type RawMapping = Partial<ColumnMapping> & { column?: number; columnIndex?: number };

const fieldAliasEntries: Array<[string, keyof ParseRule["mappings"]]> = [
  ["externalCode", "externalCode"],
  ["外部编码", "externalCode"],
  ["单号", "externalCode"],
  ["订单号", "externalCode"],
  ["出库单号", "externalCode"],
  ["配送单号", "externalCode"],
  ["storeName", "storeName"],
  ["门店", "storeName"],
  ["收货门店", "storeName"],
  ["客户", "storeName"],
  ["订货方", "storeName"],
  ["receiverName", "receiverName"],
  ["收件人", "receiverName"],
  ["收件人姓名", "receiverName"],
  ["收货人姓名", "receiverName"],
  ["联系人", "receiverName"],
  ["receiverPhone", "receiverPhone"],
  ["电话", "receiverPhone"],
  ["收件人电话", "receiverPhone"],
  ["收货人电话", "receiverPhone"],
  ["手机号", "receiverPhone"],
  ["receiverAddress", "receiverAddress"],
  ["地址", "receiverAddress"],
  ["收件人地址", "receiverAddress"],
  ["收货人地址", "receiverAddress"],
  ["收货地址", "receiverAddress"],
  ["skuCode", "skuCode"],
  ["productCode", "skuCode"],
  ["SKU物品编码", "skuCode"],
  ["SKU编码", "skuCode"],
  ["物品编码", "skuCode"],
  ["商品编码", "skuCode"],
  ["产品编码", "skuCode"],
  ["skuName", "skuName"],
  ["productName", "skuName"],
  ["SKU物品名称", "skuName"],
  ["SKU名称", "skuName"],
  ["物品名称", "skuName"],
  ["商品名称", "skuName"],
  ["产品名称", "skuName"],
  ["quantity", "quantity"],
  ["数量", "quantity"],
  ["SKU发货数量", "quantity"],
  ["发货数量", "quantity"],
  ["订货数量", "quantity"],
  ["原订货数量", "quantity"],
  ["应发数量", "quantity"],
  ["出库数量", "quantity"],
  ["实发数量", "quantity"],
  ["配送数量", "quantity"],
  ["spec", "spec"],
  ["SKU规格型号", "spec"],
  ["规格", "spec"],
  ["规格型号", "spec"],
  ["remark", "remark"],
  ["备注", "remark"]
];

const normalizeFieldName = (field: string): keyof ParseRule["mappings"] | undefined => {
  const key = field.trim().toLowerCase().replace(/[\s_（()）-]/g, "");
  const found = fieldAliasEntries.find(([alias]) => alias.trim().toLowerCase().replace(/[\s_（()）-]/g, "") === key);
  return found?.[1];
};

const findHeaderMapping = (field: keyof ParseRule["mappings"], payload: Payload, headerRow: number): ColumnMapping | undefined => {
  const aliases = fieldAliasEntries.filter(([, target]) => target === field).map(([alias]) => alias);
  const normalizedAliases = aliases.map((alias) => alias.trim().toLowerCase().replace(/[\s_*＊（()）-]/g, ""));
  for (const sheet of payload.sheets) {
    const header = sheet.rows[Math.max(headerRow - 1, 0)] ?? [];
    for (const cell of header) {
      const normalizedCell = String(cell ?? "").trim().toLowerCase().replace(/[\s_*＊（()）-]/g, "");
      if (normalizedCell && normalizedAliases.some((alias) => normalizedCell.includes(alias) || alias.includes(normalizedCell))) {
        return { source: "header", header: String(cell) };
      }
    }
  }
  return undefined;
};

const scoreHeaderRow = (row: string[]): number => {
  const normalizedCells = row.map((cell) => String(cell ?? "").trim().toLowerCase().replace(/[\s_*＊（()）-]/g, ""));
  return orderFields.reduce((score, field) => {
    const aliases = fieldAliasEntries
      .filter(([, target]) => target === field)
      .map(([alias]) => alias.trim().toLowerCase().replace(/[\s_*＊（()）-]/g, ""));
    return score + (normalizedCells.some((cell) => cell && aliases.some((alias) => cell.includes(alias) || alias.includes(cell))) ? 1 : 0);
  }, 0);
};

const inferHeaderRow = (payload: Payload, fallback: number): number => {
  let best = { rowNumber: fallback, score: 0 };
  for (const sheet of payload.sheets) {
    sheet.rows.slice(0, 20).forEach((row, index) => {
      const score = scoreHeaderRow(row);
      if (score > best.score) best = { rowNumber: index + 1, score };
    });
  }
  return best.score >= 3 ? best.rowNumber : fallback;
};

const inferTailExtractions = (payload: Payload): ParseRule["tailExtractions"] => {
  const labels = [
    { field: "receiverName", label: "收货人" },
    { field: "receiverPhone", label: "电话" },
    { field: "receiverAddress", label: "地址" },
    { field: "storeName", label: "收货机构" },
    { field: "storeName", label: "收货门店" }
  ] as const;
  const found: ParseRule["tailExtractions"] = [];
  const textRows = payload.sheets.flatMap((sheet) => sheet.rows);
  for (const item of labels) {
    if (textRows.some((row) => row.some((cell) => String(cell ?? "").includes(item.label)))) {
      found.push(item);
    }
  }
  return found;
};

const inferStopWhenContains = (payload: Payload): string | undefined =>
  payload.sheets.some((sheet) => sheet.rows.some((row) => row.some((cell) => String(cell ?? "").trim() === "合计")))
    ? "合计"
    : undefined;

const normalizeMapping = (mapping: unknown): ColumnMapping | undefined => {
  if (!mapping || typeof mapping !== "object") return undefined;
  const raw = mapping as RawMapping;
  if (raw.source === "header" && raw.header) return { source: "header", header: String(raw.header) };
  if (raw.source === "index" && raw.index) return { source: "index", index: Number(raw.index) };
  if (raw.source === "static") return { source: "static", value: String(raw.value ?? "") };
  if (raw.source === "sheet") return { source: "sheet" };
  if (raw.source === "regex" && raw.pattern) return { source: "regex", pattern: String(raw.pattern) };
  const index = raw.index ?? raw.column ?? raw.columnIndex;
  if (index) return { source: "index", index: Number(index) };
  if (raw.header) return { source: "header", header: String(raw.header) };
  return undefined;
};

const normalizeModelRule = (rule: Partial<ParseRule>, payload: Payload): Partial<ParseRule> | null => {
  if (!rule || typeof rule !== "object") return null;
  const mappings: ParseRule["mappings"] = {};
  const rawMappings = rule.mappings && typeof rule.mappings === "object" ? rule.mappings as Record<string, unknown> : {};
  for (const [rawField, rawMapping] of Object.entries(rawMappings)) {
    const field = normalizeFieldName(rawField);
    if (!field) continue;
    const mapping = normalizeMapping(rawMapping);
    if (mapping) mappings[field] = mapping;
  }
  if (!Object.keys(mappings).length) return null;
  const rawSheetStrategy = rule.sheetStrategy as unknown;
  const sheetStrategy = rawSheetStrategy === "all" || (typeof rawSheetStrategy === "object" && rawSheetStrategy && (rawSheetStrategy as { type?: unknown }).type === "all") ? "all" : "first";
  const headerRow = inferHeaderRow(payload, Number(rule.headerRow || 1));
  const dataStartRow = Number(rule.dataStartRow || Math.max(headerRow + 1, 2));
  for (const field of orderFields) {
    if (!mappings[field]) {
      const mapping = findHeaderMapping(field, payload, headerRow);
      if (mapping) mappings[field] = mapping;
    }
  }
  return {
    ...rule,
    name: String(rule.name ?? `AI规则-${payload.fileName.replace(/\.[^.]+$/, "")}`).slice(0, 50),
    mode: rule.mode && ["table", "matrix", "cards", "text"].includes(rule.mode) ? rule.mode : "table",
    sheetStrategy,
    headerRow,
    dataStartRow,
    stopWhenContains: rule.stopWhenContains ?? inferStopWhenContains(payload),
    assumptions: Array.isArray(rule.assumptions) ? rule.assumptions.map((item) => typeof item === "string" ? item : JSON.stringify(item)) : ["大模型生成规则，已由服务端归一化字段映射"],
    mappings,
    tailExtractions: rule.tailExtractions?.length ? rule.tailExtractions : inferTailExtractions(payload)
  };
};

const parseModelRule = (content: string, payload: Payload): Partial<ParseRule> | null => {
  try {
    return normalizeModelRule(JSON.parse(content) as Partial<ParseRule>, payload);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return normalizeModelRule(JSON.parse(content.slice(start, end + 1)) as Partial<ParseRule>, payload);
    } catch {
      return null;
    }
  }
};

const redactHeaders = (headers: Headers): Record<string, string | null> => ({
  contentType: headers.get("content-type"),
  requestId: headers.get("x-request-id")
});

const getCandidateModels = (): string[] => {
  return Array.from(new Set(getAiConfig().models));
};

const aiConfigStatus = () => {
  const { provider, apiKey, apiKeySource, baseUrl, models, usingDefaultBaseUrl, usingDefaultModels } = getAiConfig();
  return {
    provider,
    hasApiKey: Boolean(apiKey),
    apiKeySource: apiKeySource ?? null,
    apiKeyLength: apiKey?.length ?? 0,
    hasBaseUrl: Boolean(baseUrl),
    modelCount: models.length,
    usingDefaultBaseUrl,
    usingDefaultModels,
    ready: Boolean(apiKey && baseUrl && models.length)
  };
};

export async function GET() {
  const status = aiConfigStatus();
  logAiRules("config-check", status);
  return NextResponse.json(status);
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const payload = await request.json() as Payload;
  const { provider, apiKey, apiKeySource, baseUrl, model, usingDefaultBaseUrl, usingDefaultModels } = getAiConfig();
  const candidateModels = getCandidateModels();
  const configStatus = aiConfigStatus();
  logAiRules("request-start", {
    requestId,
    fileName: payload.fileName,
    sheetCount: payload.sheets.length,
    sampledRows: payload.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0),
    provider,
    hasApiKey: configStatus.hasApiKey,
    apiKeySource,
    apiKeyLength: apiKey?.length ?? 0,
    hasBaseUrl: configStatus.hasBaseUrl,
    modelCount: configStatus.modelCount,
    ready: configStatus.ready,
    usingDefaultBaseUrl,
    usingDefaultModels,
    baseUrl,
    models: candidateModels
  });
  if (!apiKey || !baseUrl || !model) {
    const missing = [
      !apiKey ? "AI_API_KEY" : "",
      !baseUrl ? "AI_BASE_URL" : "",
      !model ? "AI_MODEL" : ""
    ].filter(Boolean).join("、");
    const error = `大模型环境变量未完整配置，缺少：${missing}，请检查 Vercel Environment Variables`;
    return NextResponse.json({ degraded: true, error, configStatus }, { status: 503 });
  }

  const systemPrompt = `你是出库单导入规则生成器。你的唯一任务是输出一个可被 JSON.parse 解析的 ParseRule JSON 对象。
禁止输出 Markdown、代码块、解释、前后缀、思考过程、自然语言说明或 <think>。
不要直接解析明细数据，只生成规则。`;
const userPrompt = `请根据文件快照生成 ParseRule。
输出格式必须满足：
{
  "name": "简短规则名",
  "mode": "table" | "matrix" | "cards" | "text",
  "sheetStrategy": "first" | "all",
  "headerRow": 数字,
  "dataStartRow": 数字,
  "mappings": {
    "externalCode": ColumnMapping,
    "storeName": ColumnMapping,
    "receiverName": ColumnMapping,
    "receiverPhone": ColumnMapping,
    "receiverAddress": ColumnMapping,
    "skuCode": ColumnMapping,
    "skuName": ColumnMapping,
    "quantity": ColumnMapping,
    "spec": ColumnMapping,
    "remark": ColumnMapping
  },
  "assumptions": ["判断依据"]
}
注意：sheetStrategy 必须是字符串 "first" 或 "all"，不能是对象。
mappings 只能包含以下字段名：externalCode、storeName、receiverName、receiverPhone、receiverAddress、skuCode、skuName、quantity、spec、remark。
禁止输出 lineNo、category、productCode、productName、brand、picker、orderUnit 等原表字段名。
字段含义对应：
- skuCode：商品/SKU/物品/产品编码
- skuName：商品/SKU/物品/产品名称
- quantity：数量、实发数量、订货数量、配送数量
- spec：规格、规格型号
- storeName：门店、收货门店、客户、订货方
- externalCode：单号、订单号、出库单号、配送单号
- receiverName：收件人、联系人
- receiverPhone：电话、手机号
- receiverAddress：地址、收货地址
- remark：备注
ColumnMapping 只能使用以下形式：
- 按列号取值：{"source":"index","index":1}
- 按表头取值：{"source":"header","header":"表头文本"}
- 固定值：{"source":"static","value":"固定值"}
- 工作表名：{"source":"sheet"}
- 正则提取：{"source":"regex","pattern":"带捕获组的正则"}
禁止使用 column、columnIndex、field、description。
列号 index 从 1 开始。普通明细表优先使用 mode="table"。如果无法确定某个可选字段，可以省略该字段映射，但 skuName 和 quantity 必须尽量给出。
文件快照 JSON：
${JSON.stringify(payload).slice(0, 12000)}`;
  const attempts: AiAttempt[] = [];
  let attemptedCount = 0;
  const maxAttempts = maxAiAttempts;
  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      const quota = await consumeAiQuota(`${provider}:${model}`);
      if (!quota.allowed) {
        logAiRules("quota-blocked", { requestId, model, attemptIndex, quota });
        attempts.push({ model, attemptIndex, ok: false, error: quota.reason, category: "local-quota", quota });
        break;
      }
      attemptedCount += 1;
      try {
      logAiRules("model-attempt", { requestId, model, attemptIndex, quota });
      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), aiRequestTimeoutMs);
      const response = await fetch(baseUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0,
          response_format: { type: "json_object" }
        })
      }).finally(() => clearTimeout(timeout));
      logAiRules("model-response", {
        requestId,
        model,
        attemptIndex,
        status: response.status,
        ok: response.ok,
        elapsedMs: Date.now() - startedAt,
        headers: redactHeaders(response.headers)
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok) {
        const errorText = previewText(await response.text());
        const failure = classifyModelFailure(errorText, response.status);
        logAiRules("model-http-error", { requestId, model, attemptIndex, status: response.status, category: failure.category, error: errorText });
        attempts.push({ model, attemptIndex, ok: false, error: `${failure.message}：HTTP ${response.status}`, category: failure.category, status: response.status, contentPreview: errorText, quota });
        continue;
      }
      const rawBody = await response.text();
      if (!contentType.includes("application/json")) {
        const rawPreview = previewText(rawBody);
        logAiRules("model-response-non-json-content-type", { requestId, model, attemptIndex, status: response.status, contentType, bodyPreview: rawPreview });
        attempts.push({ model, attemptIndex, ok: false, error: "大模型接口返回了非 JSON 内容，请检查 AI_BASE_URL 是否为 chat/completions 接口", category: "invalid-response", status: response.status, contentPreview: rawPreview, quota });
        continue;
      }
      let data: { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: unknown };
      try {
        data = JSON.parse(rawBody) as typeof data;
      } catch {
        const rawPreview = previewText(rawBody);
        const failure = classifyModelFailure(rawPreview, response.status);
        logAiRules("model-response-invalid-json", {
          requestId,
          model,
          attemptIndex,
          status: response.status,
          category: failure.category,
          bodyLength: rawBody.length,
          bodyPreview: rawPreview
        });
        attempts.push({ model, attemptIndex, ok: false, error: failure.message, category: failure.category, status: response.status, contentPreview: rawPreview, quota });
        continue;
      }
      const content = data.choices?.[0]?.message?.content ?? "{}";
      const contentPreview = previewText(content);
      logAiRules("model-body", {
        requestId,
        model,
        attemptIndex,
        choiceCount: Array.isArray(data.choices) ? data.choices.length : 0,
        finishReason: data.choices?.[0]?.finish_reason,
        contentLength: String(content).length,
        contentPreview,
        usage: data.usage
      });
      const parsedRule = parseModelRule(content, payload);
      if (!parsedRule) {
        const failure = classifyModelFailure(contentPreview);
        logAiRules("model-invalid-json", {
          requestId,
          model,
          attemptIndex,
          category: failure.category,
          message: failure.message,
          startsWith: String(content).slice(0, 40),
          hasJsonStart: String(content).includes("{"),
          hasJsonEnd: String(content).includes("}"),
          contentPreview
        });
        attempts.push({ model, attemptIndex, ok: false, error: failure.message, category: failure.category, status: response.status, contentPreview, quota });
        continue;
      }
      const rule = { ...parsedRule, id: crypto.randomUUID() } as ParseRule;
      const parsedRows = parseByRule(payload.sheets, rule);
      if (!parsedRows.length) {
        logAiRules("model-rule-empty", { requestId, model, attemptIndex, ruleName: rule.name, mode: rule.mode, mappings: Object.keys(rule.mappings ?? {}) });
        attempts.push({ model, attemptIndex, ok: false, error: "模型返回规则无法解析出 SKU 行", category: "invalid-rule", status: response.status, contentPreview, quota });
        continue;
      }
      const validationIssues = validateRows(parsedRows, new Set());
      if (validationIssues.length) {
        logAiRules("model-rule-invalid-for-order", {
          requestId,
          model,
          attemptIndex,
          parsedRows: parsedRows.length,
          issueCount: validationIssues.length,
          issuePreview: validationIssues.slice(0, 5).map((issue) => ({ rowNumber: issue.rowNumber, field: issue.field, message: issue.message }))
        });
        attempts.push({ model, attemptIndex, ok: false, error: `模型返回规则可解析但不满足下单字段要求：${validationIssues[0]?.message ?? "字段缺失"}`, category: "invalid-rule", status: response.status, contentPreview, quota });
        continue;
      }
      logAiRules("model-success", { requestId, model, attemptIndex, ruleName: rule.name, mode: rule.mode, parsedRows: parsedRows.length });
      return NextResponse.json({ rule, degraded: false, model, attemptIndex, parsedRows: parsedRows.length, quota, attempts });
    } catch (error) {
      logAiRules("model-exception", { requestId, model, attemptIndex, error: error instanceof Error ? error.message : "模型请求失败" });
      attempts.push({ model, attemptIndex, ok: false, error: error instanceof Error ? error.message : "模型请求失败", quota });
      }
  }
  const preferredFailure = attempts.find((attempt) => attempt.category === "provider-quota" || attempt.category === "auth" || attempt.category === "rate-limit") ?? attempts.at(-1);
  const fallbackReason = preferredFailure?.error
    ? `${preferredFailure.error}，未生成可保存规则`
    : "大模型未返回可用规则，未生成可保存规则";
  logAiRules("fallback", { requestId, reason: fallbackReason, attemptedCount, maxAiAttempts: maxAttempts, attempts });
  return NextResponse.json({ degraded: true, error: fallbackReason, configStatus, attempts }, { status: 503 });
}
