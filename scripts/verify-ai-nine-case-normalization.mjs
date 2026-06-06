const fixture = (name, rows) => [{ name, rows }];

process.env.AI_API_KEY = "verify-only-key";
process.env.AI_BASE_URL = "https://verify.invalid/v1/chat/completions";
process.env.AI_MODEL = "verify-model";
process.env.AI_RATE_LIMIT_PER_MINUTE = "100";
process.env.AI_DAILY_LIMIT = "500";

const { POST } = await import("../app/api/ai-rules/route.ts");

const weakRule = {
  name: "模型返回的弱规则",
  mode: "table",
  sheetStrategy: "first",
  headerRow: 1,
  dataStartRow: 2,
  mappings: {
    skuName: { source: "header", header: "物品名称" },
    quantity: { source: "header", header: "数量" }
  }
};

const cases = [
  {
    fileName: "多门店分Sheet出库单.xlsx",
    expectedRows: 2,
    expectedMode: "table",
    expectedSheetStrategy: "all",
    sheets: [
      { name: "银泰店", rows: [["标题"], [""], [""], ["序号", "物品编码", "物品名称", "规格型号", "单位", "出库数量", "仓库", "备注"], ["1", "SKU001", "牛肉卷", "1kg", "件", "3", "仓", ""]] },
      { name: "金桥店", rows: [["标题"], [""], [""], ["序号", "物品编码", "物品名称", "规格型号", "单位", "出库数量", "仓库", "备注"], ["1", "SKU002", "蘸料", "500g", "件", "5", "仓", ""]] }
    ]
  },
  {
    fileName: "欢乐牧场模板0430.xlsx",
    expectedRows: 2,
    expectedMode: "matrix",
    sheets: fixture("矩阵", [
      ["仓库名称", "货主名称", "SKU名称", "SKU条码", "外部商品编码", "库存状态", "库存单位", "规格", "在库数量的总和", "可用数量的总和", "待移入数的总和", "分配数量的总和", "冻结数量的总和", "银泰", "金桥", "下单后结余"],
      ["仓", "货主", "牛肉卷", "SKU001", "SKU001", "正常", "正品", "1kg", "10", "10", "0", "0", "0", "2", "1", "7"]
    ])
  },
  {
    fileName: "门店配送确认单.docx",
    expectedRows: 2,
    expectedMode: "text",
    sheets: fixture("文本", [["门店：银泰店 收货人：王店长 电话：13900001111 地址：武汉银泰\n1. SKU001 | 牛肉卷 | 1kg | 3\n━━━\n门店：金桥店 收货人：李店长 电话：13900002222 地址：武汉金桥\n1. SKU002 | 蘸料 | 500g | 5"]])
  },
  {
    fileName: "周配送计划.xlsx",
    expectedRows: 3,
    expectedMode: "matrix",
    sheets: fixture("周计划", [
      ["门店", "周一", "周二"],
      ["银泰店", "牛肉卷x3\n蘸料x5", "香肠x2"]
    ])
  },
  {
    fileName: "配送签收单.pdf",
    expectedRows: 2,
    expectedMode: "text",
    sheets: fixture("多单PDF", [["配送签收单 A 收货人：王店长 电话：13900001111 地址：武汉银泰 1 SKU001 牛肉卷 1kg 件 3 ---PAGE--- 配送签收单 B 收货人：李店长 电话：13900002222 地址：武汉金桥 1 SKU002 蘸料 500g 件 5"]])
  }
];

const originalFetch = globalThis.fetch;
const results = [];

try {
  for (const item of cases) {
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(weakRule) }, finish_reason: "stop" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const response = await POST(new Request("http://localhost/api/ai-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: item.fileName, sheets: item.sheets, auto: true })
    }));
    const body = await response.json();
    const pass = response.ok &&
      !body.degraded &&
      body.parsedRows === item.expectedRows &&
      body.rule?.mode === item.expectedMode &&
      (!item.expectedSheetStrategy || body.rule?.sheetStrategy === item.expectedSheetStrategy);
    results.push({
      fileName: item.fileName,
      status: response.status,
      mode: body.rule?.mode,
      sheetStrategy: body.rule?.sheetStrategy,
      parsedRows: body.parsedRows,
      expectedRows: item.expectedRows,
      pass,
      error: body.error
    });
    if (!pass) process.exitCode = 1;
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log(JSON.stringify({ results, failed: results.filter((item) => !item.pass) }, null, 2));
