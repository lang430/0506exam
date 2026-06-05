import { NextResponse } from "next/server";
import { consumeAiQuota } from "@/lib/ai-quota";
import { parseByRule } from "@/lib/rule-engine";
import { getAiConfig } from "@/lib/runtime-config";
import { orderFields } from "@/lib/types";
import type { ColumnMapping, ParseRule, SheetSnapshot } from "@/lib/types";

export const runtime = "nodejs";

interface Payload {
  fileName: string;
  sheets: SheetSnapshot[];
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
const aiRequestTimeoutMs = 20000;

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
  for (const field of orderFields) {
    const mapping = normalizeMapping(rawMappings[field]);
    if (mapping) mappings[field] = mapping;
  }
  if (!Object.keys(mappings).length) return null;
  return {
    ...rule,
    name: String(rule.name ?? `AI规则-${payload.fileName.replace(/\.[^.]+$/, "")}`).slice(0, 50),
    mode: rule.mode && ["table", "matrix", "cards", "text"].includes(rule.mode) ? rule.mode : "table",
    sheetStrategy: rule.sheetStrategy === "all" ? "all" : "first",
    headerRow: Number(rule.headerRow || 1),
    dataStartRow: Number(rule.dataStartRow || Math.max(Number(rule.headerRow || 1) + 1, 2)),
    assumptions: Array.isArray(rule.assumptions) ? rule.assumptions.map((item) => typeof item === "string" ? item : JSON.stringify(item)) : ["大模型生成规则，已由服务端归一化字段映射"],
    mappings
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

  const prompt = `你是物流导入规则设计助手。只输出一个 JSON 对象，不要输出 <think>、Markdown、解释文字或代码块。JSON 必须严格符合 ParseRule，用于把文件快照解析为出库单 SKU 行，不要直接解析数据。
必填字段：
- name: 字符串
- mode: "table" | "matrix" | "cards" | "text"，普通表格优先用 "table"
- sheetStrategy: "first" | "all"
- headerRow: 数字，行号从 1 开始
- dataStartRow: 数字，行号从 1 开始
- mappings: 对象，字段包括 externalCode,storeName,receiverName,receiverPhone,receiverAddress,skuCode,skuName,quantity,spec,remark
- assumptions: 字符串数组
每个 mappings 字段值必须是 ColumnMapping，禁止输出 column/columnIndex。按列号取值时必须写 {"source":"index","index":列号}；按表头取值时必须写 {"source":"header","header":"表头文本"}；固定值写 {"source":"static","value":"固定值"}；工作表名写 {"source":"sheet"}；正则写 {"source":"regex","pattern":"带捕获组的正则"}。
示例：
{"name":"AI规则","mode":"table","sheetStrategy":"first","headerRow":1,"dataStartRow":2,"mappings":{"skuCode":{"source":"index","index":6},"quantity":{"source":"index","index":9}},"assumptions":["第1行是表头"]}
文件快照：${JSON.stringify(payload).slice(0, 18000)}`;
  const attempts: AiAttempt[] = [];
  let attemptedCount = 0;
  for (let attemptIndex = 0; attemptIndex < maxAiAttempts; attemptIndex += 1) {
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
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1
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
      if (!response.ok) {
        const errorText = previewText(await response.text());
        const failure = classifyModelFailure(errorText, response.status);
        logAiRules("model-http-error", { requestId, model, attemptIndex, status: response.status, category: failure.category, error: errorText });
        attempts.push({ model, attemptIndex, ok: false, error: `${failure.message}：HTTP ${response.status}`, category: failure.category, status: response.status, contentPreview: errorText, quota });
        continue;
      }
      const rawBody = await response.text();
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
    : "所有候选模型均未返回可用规则，未生成可保存规则";
  logAiRules("fallback", { requestId, reason: fallbackReason, attemptedCount, maxAiAttempts, attempts });
  return NextResponse.json({ degraded: true, error: fallbackReason, configStatus, attempts }, { status: 503 });
}
