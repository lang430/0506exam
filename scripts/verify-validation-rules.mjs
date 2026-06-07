import { validateRows } from "../lib/rule-engine.ts";

const rows = [
  {
    id: "row-1",
    externalCode: "DUP-001",
    storeName: "银泰店",
    receiverName: "",
    receiverPhone: "",
    receiverAddress: "",
    skuCode: "SKU001",
    skuName: "牛肉卷",
    quantity: 1,
    spec: "",
    remark: "",
    source: "测试",
    errors: []
  },
  {
    id: "row-2",
    externalCode: "DUP-001",
    storeName: "",
    receiverName: "王店长",
    receiverPhone: "12345",
    receiverAddress: "武汉银泰",
    skuCode: "SKU001",
    skuName: "牛肉卷",
    quantity: 2,
    spec: "",
    remark: "",
    source: "测试",
    errors: []
  },
  {
    id: "row-3",
    externalCode: "EXIST-001",
    storeName: "金桥店",
    receiverName: "",
    receiverPhone: "",
    receiverAddress: "",
    skuCode: "SKU003",
    skuName: "香肠",
    quantity: 1,
    spec: "",
    remark: "",
    source: "测试",
    errors: []
  }
];

const issues = validateRows(rows, new Set(["EXIST-001::SKU003"]));
const messages = issues.map((issue) => `${issue.rowNumber}:${issue.field}:${issue.message}`);

const checks = {
  duplicateInBatchMarksFirstRow: messages.some((message) => message.includes("1:externalCode") && message.includes("与第 2 行重复")),
  duplicateInBatchMarksSecondRow: messages.some((message) => message.includes("2:externalCode") && message.includes("与第 1 行重复")),
  duplicateWithExistingData: messages.some((message) => message.includes("3:externalCode") && message.includes("已存在数据重复")),
  invalidPhoneFormat: messages.some((message) => message.includes("2:receiverPhone") && message.includes("电话格式错误"))
};

const failed = Object.entries(checks).filter(([, value]) => !value);
console.log(JSON.stringify({ checks, issues, failed: failed.map(([name]) => name) }, null, 2));
if (failed.length) process.exit(1);
