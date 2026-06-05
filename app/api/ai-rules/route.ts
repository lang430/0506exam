import { NextResponse } from "next/server";
import { consumeAiQuota } from "@/lib/ai-quota";
import { getAiConfig } from "@/lib/runtime-config";
import type { ParseRule, SheetSnapshot } from "@/lib/types";

export const runtime = "nodejs";

interface Payload {
  fileName: string;
  sheets: SheetSnapshot[];
}

interface AiAttempt {
  model: string;
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
    return { category: "auth", message: "大模型鉴权失败，请检查 Vercel 中的 AIHUBMIX_API_KEY" };
  }
  if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { category: "rate-limit", message: "大模型服务触发限流，请稍后重试或调整候选模型" };
  }
  if (lower.includes("prevent abuse of free resources") || lower.includes("topup") || lower.includes("recharg")) {
    return { category: "provider-quota", message: "AIHUBMIX 免费额度受限，请检查账号额度或充值后重试" };
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

const parseModelRule = (content: string): Partial<ParseRule> | null => {
  try {
    return JSON.parse(content) as Partial<ParseRule>;
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(content.slice(start, end + 1)) as Partial<ParseRule>;
    } catch {
      return null;
    }
  }
};

const redactHeaders = (headers: Headers): Record<string, string | null> => ({
  contentType: headers.get("content-type"),
  requestId: headers.get("x-request-id") || headers.get("x-aihubmix-request-id")
});

const getCandidateModels = (): string[] => {
  return Array.from(new Set(getAiConfig().models));
};

const aiConfigStatus = () => {
  const { apiKey, apiKeySource, baseUrl, models, usingDefaultBaseUrl, usingDefaultModels } = getAiConfig();
  return {
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
  const { apiKey, apiKeySource, baseUrl, usingDefaultBaseUrl, usingDefaultModels } = getAiConfig();
  const candidateModels = getCandidateModels();
  const configStatus = aiConfigStatus();
  logAiRules("request-start", {
    requestId,
    fileName: payload.fileName,
    sheetCount: payload.sheets.length,
    sampledRows: payload.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0),
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
  if (!apiKey || !baseUrl || !candidateModels.length) {
    const missing = [
      !apiKey ? "AIHUBMIX_API_KEY" : "",
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

  const prompt = `你是物流导入规则设计助手。只输出一个 JSON 对象，不要输出 <think>、Markdown、解释文字或代码块。JSON 必须是 ParseRule，规则用于把文件快照解析为出库单 SKU 行，不要直接解析数据。字段包括 externalCode,storeName,receiverName,receiverPhone,receiverAddress,skuCode,skuName,quantity,spec,remark。行号和列号从 1 开始。必须给出 assumptions 标注推测项。文件快照：${JSON.stringify(payload).slice(0, 18000)}`;
  const attempts: AiAttempt[] = [];
  for (const model of candidateModels) {
    const quota = await consumeAiQuota(model);
    if (!quota.allowed) {
      logAiRules("quota-blocked", { requestId, model, quota });
      attempts.push({ model, ok: false, error: quota.reason, category: "local-quota", quota });
      break;
    }
    try {
      logAiRules("model-attempt", { requestId, model, quota });
      const startedAt = Date.now();
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1
        })
      });
      logAiRules("model-response", {
        requestId,
        model,
        status: response.status,
        ok: response.ok,
        elapsedMs: Date.now() - startedAt,
        headers: redactHeaders(response.headers)
      });
      if (!response.ok) {
        const errorText = previewText(await response.text());
        const failure = classifyModelFailure(errorText, response.status);
        logAiRules("model-http-error", { requestId, model, status: response.status, category: failure.category, error: errorText });
        attempts.push({ model, ok: false, error: `${failure.message}：HTTP ${response.status}`, category: failure.category, status: response.status, contentPreview: errorText, quota });
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
          status: response.status,
          category: failure.category,
          bodyLength: rawBody.length,
          bodyPreview: rawPreview
        });
        attempts.push({ model, ok: false, error: failure.message, category: failure.category, status: response.status, contentPreview: rawPreview, quota });
        continue;
      }
      const content = data.choices?.[0]?.message?.content ?? "{}";
      const contentPreview = previewText(content);
      logAiRules("model-body", {
        requestId,
        model,
        choiceCount: Array.isArray(data.choices) ? data.choices.length : 0,
        finishReason: data.choices?.[0]?.finish_reason,
        contentLength: String(content).length,
        contentPreview,
        usage: data.usage
      });
      const parsedRule = parseModelRule(content);
      if (!parsedRule) {
        const failure = classifyModelFailure(contentPreview);
        logAiRules("model-invalid-json", {
          requestId,
          model,
          category: failure.category,
          message: failure.message,
          startsWith: String(content).slice(0, 40),
          hasJsonStart: String(content).includes("{"),
          hasJsonEnd: String(content).includes("}"),
          contentPreview
        });
        attempts.push({ model, ok: false, error: failure.message, category: failure.category, status: response.status, contentPreview, quota });
        continue;
      }
      logAiRules("model-success", { requestId, model, ruleName: parsedRule.name, mode: parsedRule.mode });
      return NextResponse.json({ rule: { ...parsedRule, id: crypto.randomUUID() }, degraded: false, model, quota, attempts });
    } catch (error) {
      logAiRules("model-exception", { requestId, model, error: error instanceof Error ? error.message : "模型请求失败" });
      attempts.push({ model, ok: false, error: error instanceof Error ? error.message : "模型请求失败", quota });
    }
  }
  const preferredFailure = attempts.find((attempt) => attempt.category === "provider-quota" || attempt.category === "auth" || attempt.category === "rate-limit") ?? attempts.at(-1);
  const fallbackReason = preferredFailure?.error
    ? `${preferredFailure.error}，已降级为启发式规则`
    : "所有候选模型均未返回可用规则，已降级为启发式规则";
  logAiRules("fallback", { requestId, reason: fallbackReason, attempts });
  return NextResponse.json({ rule: fallbackRule(payload, fallbackReason), degraded: true, error: fallbackReason, configStatus, attempts }, { status: 200 });
}
