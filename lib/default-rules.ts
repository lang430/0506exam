import type { ParseRule } from "@/lib/types";

export const defaultRules: ParseRule[] = [
  {
    id: "table-hunan",
    name: "标准明细表：表头映射 + 单号聚合",
    mode: "table",
    sheetStrategy: "first",
    headerRow: 2,
    dataStartRow: 3,
    mappings: {
      externalCode: { source: "header", header: "配送单号" },
      storeName: { source: "header", header: "收货机构" },
      receiverName: { source: "header", header: "收货人" },
      receiverPhone: { source: "header", header: "联系电话" },
      receiverAddress: { source: "header", header: "收货地址" },
      skuCode: { source: "header", header: "物品编码*" },
      skuName: { source: "header", header: "物品名称" },
      quantity: { source: "header", header: "应发数量" },
      spec: { source: "header", header: "规格型号" },
      remark: { source: "header", header: "备注" }
    }
  },
  {
    id: "tail-info",
    name: "尾部收货信息：跳过头部 + 底部提取",
    mode: "table",
    sheetStrategy: "first",
    headerRow: 4,
    dataStartRow: 5,
    stopWhenContains: "合计",
    mappings: {
      skuCode: { source: "index", index: 3 },
      skuName: { source: "index", index: 4 },
      quantity: { source: "index", index: 12 },
      spec: { source: "index", index: 6 }
    },
    tailExtractions: [
      { field: "receiverName", label: "收货人" },
      { field: "receiverPhone", label: "电话" },
      { field: "receiverAddress", label: "地址" },
      { field: "storeName", label: "收货机构" }
    ]
  },
  {
    id: "multi-sheet",
    name: "多 Sheet 同构出库单",
    mode: "table",
    sheetStrategy: "all",
    headerRow: 4,
    dataStartRow: 5,
    stopWhenContains: "合计",
    mappings: {
      storeName: { source: "sheet" },
      skuCode: { source: "header", header: "物品编码" },
      skuName: { source: "header", header: "物品名称" },
      spec: { source: "header", header: "规格型号" },
      quantity: { source: "header", header: "出库数量" },
      remark: { source: "header", header: "备注" }
    },
    tailExtractions: [
      { field: "receiverName", label: "收货人" },
      { field: "receiverPhone", label: "电话" },
      { field: "receiverAddress", label: "地址" }
    ]
  },
  {
    id: "cards",
    name: "卡片式调拨单：边界 + 内部小表",
    mode: "cards",
    sheetStrategy: "first",
    boundaryPattern: "调拨记录",
    itemHeaderPattern: "物品编码",
    stopWhenContains: "合计",
    mappings: {
      skuCode: { source: "header", header: "物品编码" },
      skuName: { source: "header", header: "物品名称" },
      spec: { source: "header", header: "规格型号" },
      quantity: { source: "header", header: "数量" },
      remark: { source: "header", header: "备注" }
    },
    tailExtractions: [
      { field: "storeName", label: "调入门店" },
      { field: "receiverName", label: "收货人" },
      { field: "receiverPhone", label: "电话" },
      { field: "receiverAddress", label: "收货地址" }
    ]
  },
  {
    id: "matrix-store",
    name: "门店矩阵：SKU × 门店转置",
    mode: "matrix",
    sheetStrategy: "first",
    headerRow: 1,
    dataStartRow: 2,
    matrixValueStartColumn: 14,
    matrixStopHeaderPattern: "下单后结余|结余|库存|合计",
    mappings: {
      skuName: { source: "index", index: 3 },
      skuCode: { source: "index", index: 5 },
      spec: { source: "index", index: 8 },
      remark: { source: "index", index: 2 }
    }
  },
  {
    id: "pdf-text-items",
    name: "PDF 文本表格：明细正则 + 底部收货信息",
    mode: "text",
    sheetStrategy: "first",
    itemPattern: "\\b\\d+\\s+(?<remark>[^\\s]+)\\s+(?<skuCode>[A-Z0-9-]{4,})\\s+(?<skuName>.+?)\\s+(?<spec>(?:\\d[^\\s]*(?:\\s*/\\s*[^\\s]+)?|[A-Z0-9]+码|均码))\\s+(?<unit>件|瓶|包|桶)\\s+(?<quantity>\\d+)\\b",
    mappings: {
      externalCode: { source: "regex", pattern: "单据编号：\\s*([A-Z0-9]+)" },
      storeName: { source: "regex", pattern: "收货机构：\\s*([^\\s]+)" },
      receiverName: { source: "regex", pattern: "收货人：\\s*([^\\s]+)" },
      receiverPhone: { source: "regex", pattern: "收货电话：\\s*([0-9-]+)" },
      receiverAddress: { source: "regex", pattern: "收货地址：\\s*(.+?)\\s+打印次数" }
    },
    assumptions: [
      "PDF 文本抽取后，明细行需包含序号、物品类别、编码、名称、规格、单位、数量。",
      "名称和规格之间的边界由规格以数字开头这一特征推断，保存前建议预览确认。"
    ]
  },
  {
    id: "word-text-blocks",
    name: "Word 纯文本：分隔线分块 + 物品行正则",
    mode: "text",
    sheetStrategy: "first",
    blockPattern: "━━━",
    itemPattern: "\\d+\\.\\s*(?<skuCode>[^\\s|]+)\\s*\\|\\s*(?<skuName>[^|]+)\\|\\s*(?<spec>[^|]+)\\|\\s*(?<quantity>\\d+)",
    mappings: {
      storeName: { source: "regex", pattern: "门店：\\s*([^\\s]+)" },
      receiverName: { source: "regex", pattern: "收货人：\\s*([^\\s]+)" },
      receiverPhone: { source: "regex", pattern: "电话：\\s*([0-9-]+)" },
      receiverAddress: { source: "regex", pattern: "地址：\\s*([^\\n]+)" }
    },
    assumptions: ["用于门店配送确认单类纯文本 Word，真实文件导入后需按分隔线和物品行格式微调。"]
  },
  {
    id: "weekly-compound-matrix",
    name: "周配送计划：日期 × 门店 + 复合单元格拆分",
    mode: "matrix",
    sheetStrategy: "first",
    headerRow: 1,
    dataStartRow: 2,
    matrixValueStartColumn: 2,
    matrixColumnRole: "date",
    matrixRowStoreMapping: { source: "index", index: 1 },
    compoundCellPattern: "(?<skuName>[^x\\n]+)x(?<quantity>\\d+)",
    mappings: {
      skuCode: { source: "static", value: "AUTO" }
    },
    assumptions: ["日期列范围需按实际文件列数设置 matrixValueEndColumn；复合单元格按 物品名x数量 拆分。"]
  },
  {
    id: "multi-pdf-blocks",
    name: "多单 PDF：分隔块 + 明细配对",
    mode: "text",
    sheetStrategy: "first",
    blockPattern: "---PAGE---|━━━",
    itemPattern: "\\b\\d+\\s+(?<skuCode>[A-Z0-9-]{4,})\\s+(?<skuName>[^\\s]+)\\s+(?<spec>[^\\s]+)\\s+(?:件|瓶|包|桶)\\s+(?<quantity>\\d+)\\b",
    mappings: {
      receiverName: { source: "regex", pattern: "收货人：\\s*([^\\s]+)" },
      receiverPhone: { source: "regex", pattern: "电话：\\s*([0-9-]+)" },
      receiverAddress: { source: "regex", pattern: "地址：\\s*([^\\s]+)" }
    },
    assumptions: ["用于同一 PDF 内多张签收单；真实文件需确认分隔符或页面边界文本。"]
  }
];
