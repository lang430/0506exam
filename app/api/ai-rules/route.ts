import { NextResponse } from "next/server";
import { consumeAiQuota } from "@/lib/ai-quota";
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
  keyIndex?: number;
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

const previewText = (value: unknown, maxLength = 240): string =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

const classifyModelFailure = (content: string, status?: number): { category: string; message: string } => {
  const lower = content.toLowerCase();
  if (status === 401 || status === 403 || lower.includes("invalid api key") || lower.includes("unauthorized")) {
    return { category: "auth", message: "大模型鉴权失败，请检查 OpenRouter API Key 配置" };
  }
  if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { category: "rate-limit", message: "大模型服务触发限流，请稍后重试或调整候选模型" };
  }
  if (lower.includes("prevent abuse of free resources") || lower.includes("topup") || lower.includes("recharg")) {
    return { category: "provider-quota", message: "OpenRouter 免费额度受限，请切换 Key、稍后重试或检查账号额度" };
  }
  if (lower.includes("model") && (lower.includes("not found") || lower.includes("not exist") || lower.includes("unsupported"))) {
    return { category: "model-unavailable", message: "候选模型不可用，请检查 AI_MODELS 配置" };
  }
  return { category: "invalid-response", message: "模型未返回可解析的规则 JSON" };
};

const fallbackRule = ({ fileName, sheets }: Payload, reason = "大模型不可用，已使用启发式分析生成"): ParseRule => {
  const first = sheets[0];
  const rows = first?.rows ?? [];
  const headerIndex = rows.findIndex((row) => row.some((cell) => /物品编码|SKU|商品编码/.test(cell)));
  const cardLike = rows.some((row) => row.join(" ").includes("调拨记录"));
  const header = rows[Math.max(headerIndex, 0)] ?? [];
  const indexOf = (pattern: RegExp): number | undefined => {
    const index = header.findIndex((cell) => pattern.test(cell));
    return index >= 0 ? index + 1 : undefined;
  };
  return {
    id: crypto.randomUUID(),
    name: `AI草案-${fileName.replace(/\.[^.]+$/, "")}`.slice(0, 50),
    mode: cardLike ? "cards" : "table",
    confidence: headerIndex >= 0 ? 0.72 : 0.45,
    assumptions: [
      reason,
      "所有字段映射均需用户预览确认后再保存"
    ],
    sheetStrategy: sheets.length > 1 ? "all" : "first",
    headerRow: Math.max(headerIndex + 1, 1),
    dataStartRow: Math.max(headerIndex + 2, 2),
    stopWhenContains: "合计",
    boundaryPattern: "调拨记录",
    itemHeaderPattern: "物品编码",
    mappings: {
      externalCode: { source: "header", header: "配送单号" },
      storeName: { source: "header", header: "收货机构" },
      receiverName: { source: "header", header: "收货人" },
      receiverPhone: { source: "header", header: "电话" },
      receiverAddress: { source: "header", header: "收货地址" },
      skuCode: indexOf(/物品编码|SKU编码|商品编码/) ? { source: "index", index: indexOf(/物品编码|SKU编码|商品编码/) } : { source: "header", header: "物品编码" },
      skuName: indexOf(/物品名称|SKU名称|商品名称/) ? { source: "index", index: indexOf(/物品名称|SKU名称|商品名称/) } : { source: "header", header: "物品名称" },
      quantity: indexOf(/数量|应发|出库/) ? { source: "index", index: indexOf(/数量|应发|出库/) } : { source: "header", header: "数量" },
      spec: indexOf(/规格/) ? { source: "index", index: indexOf(/规格/) } : { source: "header", header: "规格型号" },
      remark: { source: "header", header: "备注" }
    },
    tailExtractions: [
      { field: "receiverName", label: "收货人" },
      { field: "receiverPhone", label: "电话" },
      { field: "receiverAddress", label: "地址" }
    ]
  };
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
    assumptions: Array.isArray(rule.assumptions) ? rule.assumptions.map((item) => typeof item === "string" ? item : JSON.stringify(item)) : ["OpenRouter 生成规则，已由服务端归一化字段映射"],
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
  requestId: headers.get("x-request-id") || headers.get("x-openrouter-request-id")
});

const getCandidateModels = (): string[] => {
  return Array.from(new Set(getAiConfig().models));
};

const aiConfigStatus = () => {
  const { provider, apiKey, apiKeys, apiKeySource, baseUrl, models, usingDefaultBaseUrl, usingDefaultModels } = getAiConfig();
  return {
    provider,
    hasApiKey: Boolean(apiKey),
    apiKeyCount: apiKeys.length,
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
  const { provider, apiKeys, apiKeySource, baseUrl, usingDefaultBaseUrl, usingDefaultModels } = getAiConfig();
  const candidateModels = getCandidateModels();
  const configStatus = aiConfigStatus();
  logAiRules("request-start", {
    requestId,
    fileName: payload.fileName,
    sheetCount: payload.sheets.length,
    sampledRows: payload.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0),
    provider,
    hasApiKey: configStatus.hasApiKey,
    apiKeyCount: configStatus.apiKeyCount,
    apiKeySource,
    apiKeyLengths: apiKeys.map((key) => key.length),
    hasBaseUrl: configStatus.hasBaseUrl,
    modelCount: configStatus.modelCount,
    ready: configStatus.ready,
    usingDefaultBaseUrl,
    usingDefaultModels,
    baseUrl,
    models: candidateModels
  });
  if (!apiKeys.length || !baseUrl || !candidateModels.length) {
    const missing = [
      !apiKeys.length ? "OPENROUTER_API_KEYS" : "",
      !baseUrl ? "AI_BASE_URL" : "",
      !candidateModels.length ? "AI_MODELS" : ""
    ].filter(Boolean).join("、");
    const error = `大模型环境变量未完整配置，缺少：${missing}`;
    return NextResponse.json({
      rule: fallbackRule(payload, error),
      degraded: true,
      error,
      configStatus
    });
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
  for (const [keyIndex, apiKey] of apiKeys.entries()) {
    for (const model of candidateModels) {
      const quota = await consumeAiQuota(`${provider}:${keyIndex}:${model}`);
      if (!quota.allowed) {
        logAiRules("quota-blocked", { requestId, model, keyIndex, quota });
        attempts.push({ model, keyIndex, ok: false, error: quota.reason, category: "local-quota", quota });
        break;
      }
      try {
      logAiRules("model-attempt", { requestId, model, keyIndex, quota });
      const startedAt = Date.now();
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "http://localhost:3000",
          "X-OpenRouter-Title": "Universal Order Import"
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1
        })
      });
      logAiRules("model-response", {
        requestId,
        model,
        keyIndex,
        status: response.status,
        ok: response.ok,
        elapsedMs: Date.now() - startedAt,
        headers: redactHeaders(response.headers)
      });
      if (!response.ok) {
        const errorText = previewText(await response.text());
        const failure = classifyModelFailure(errorText, response.status);
        logAiRules("model-http-error", { requestId, model, keyIndex, status: response.status, category: failure.category, error: errorText });
        attempts.push({ model, keyIndex, ok: false, error: `${failure.message}：HTTP ${response.status}`, category: failure.category, status: response.status, contentPreview: errorText, quota });
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
          keyIndex,
          status: response.status,
          category: failure.category,
          bodyLength: rawBody.length,
          bodyPreview: rawPreview
        });
        attempts.push({ model, keyIndex, ok: false, error: failure.message, category: failure.category, status: response.status, contentPreview: rawPreview, quota });
        continue;
      }
      const content = data.choices?.[0]?.message?.content ?? "{}";
      const contentPreview = previewText(content);
      logAiRules("model-body", {
        requestId,
        model,
        keyIndex,
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
          keyIndex,
          category: failure.category,
          message: failure.message,
          startsWith: String(content).slice(0, 40),
          hasJsonStart: String(content).includes("{"),
          hasJsonEnd: String(content).includes("}"),
          contentPreview
        });
        attempts.push({ model, keyIndex, ok: false, error: failure.message, category: failure.category, status: response.status, contentPreview, quota });
        continue;
      }
      logAiRules("model-success", { requestId, model, keyIndex, ruleName: parsedRule.name, mode: parsedRule.mode });
      return NextResponse.json({ rule: { ...parsedRule, id: crypto.randomUUID() }, degraded: false, model, keyIndex, quota, attempts });
    } catch (error) {
      logAiRules("model-exception", { requestId, model, keyIndex, error: error instanceof Error ? error.message : "模型请求失败" });
      attempts.push({ model, keyIndex, ok: false, error: error instanceof Error ? error.message : "模型请求失败", quota });
      }
    }
  }
  const preferredFailure = attempts.find((attempt) => attempt.category === "provider-quota" || attempt.category === "auth" || attempt.category === "rate-limit") ?? attempts.at(-1);
  const fallbackReason = preferredFailure?.error
    ? `${preferredFailure.error}，已降级为启发式规则`
    : "所有候选模型均未返回可用规则，已降级为启发式规则";
  logAiRules("fallback", { requestId, reason: fallbackReason, attempts });
  return NextResponse.json({ rule: fallbackRule(payload, fallbackReason), degraded: true, error: fallbackReason, configStatus, attempts }, { status: 200 });
}
