import { NextResponse } from "next/server";
import type { ParseRule, SheetSnapshot } from "@/lib/types";

export const runtime = "nodejs";

interface Payload {
  fileName: string;
  sheets: SheetSnapshot[];
}

const fallbackRule = ({ fileName, sheets }: Payload): ParseRule => {
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
      "当前环境未配置大模型 API Key，此规则由启发式分析生成",
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

export async function POST(request: Request) {
  const payload = await request.json() as Payload;
  const apiKey = process.env.AIHUBMIX_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = process.env.AIHUBMIX_API_KEY
    ? (process.env.AI_BASE_URL || "https://aihubmix.com/v1/chat/completions")
    : process.env.DEEPSEEK_API_KEY
      ? "https://api.deepseek.com/chat/completions"
      : "https://api.openai.com/v1/chat/completions";
  const model = process.env.AI_MODEL || (process.env.AIHUBMIX_API_KEY ? "coding-minimax-m3-free" : process.env.DEEPSEEK_API_KEY ? "deepseek-chat" : "gpt-4o-mini");
  if (!apiKey) return NextResponse.json({ rule: fallbackRule(payload), degraded: true });

  const prompt = `你是物流导入规则设计助手。只输出一个 JSON 对象，不要输出 <think>、Markdown、解释文字或代码块。JSON 必须是 ParseRule，规则用于把文件快照解析为出库单 SKU 行，不要直接解析数据。字段包括 externalCode,storeName,receiverName,receiverPhone,receiverAddress,skuCode,skuName,quantity,spec,remark。行号和列号从 1 开始。必须给出 assumptions 标注推测项。文件快照：${JSON.stringify(payload).slice(0, 18000)}`;
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      response_format: { type: "json_object" }
    })
  });
  if (!response.ok) return NextResponse.json({ rule: fallbackRule(payload), degraded: true, error: await response.text() }, { status: 200 });
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "{}";
  const parsedRule = parseModelRule(content);
  if (!parsedRule) return NextResponse.json({ rule: fallbackRule(payload), degraded: true, error: "模型未返回可解析的规则 JSON" }, { status: 200 });
  return NextResponse.json({ rule: { ...parsedRule, id: crypto.randomUUID() }, degraded: false });
}
