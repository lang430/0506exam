import { orderFields, type OrderField, type OrderRow, type ParseRule, type SheetSnapshot, type ValidationIssue } from "@/lib/types";

const emptyRow = (source: string): OrderRow => ({
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
});

const text = (value: unknown): string => String(value ?? "").trim();

const rowHasContent = (row: string[]): boolean => row.some((cell) => text(cell));

const toNumber = (value: string): number | string => {
  const match = text(value).match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : text(value);
};

const makeHeaderMap = (row: string[]): Map<string, number> => {
  const map = new Map<string, number>();
  row.forEach((cell, index) => {
    const key = text(cell);
    if (key) map.set(key, index);
  });
  return map;
};

const readMapping = (
  field: OrderField,
  row: string[],
  headerMap: Map<string, number>,
  rule: ParseRule,
  sheetName: string,
  rawText = row.join(" "),
  groups: Record<string, string> = {}
): string => {
  if (groups[field]) return text(groups[field]);
  const mapping = rule.mappings[field];
  if (!mapping) return "";
  if (mapping.source === "static") return text(mapping.value);
  if (mapping.source === "sheet") return sheetName;
  if (mapping.source === "index") return text(row[(mapping.index ?? 1) - 1]);
  if (mapping.source === "regex" && mapping.pattern) return text(rawText.match(new RegExp(mapping.pattern))?.[1]);
  const index = mapping.header ? headerMap.get(mapping.header) : undefined;
  return index === undefined ? "" : text(row[index]);
};

const applyTailExtractions = (rows: string[][], rule: ParseRule, base: OrderRow): void => {
  for (const extraction of rule.tailExtractions ?? []) {
    for (const row of rows) {
      const labelIndex = row.findIndex((cell) => text(cell).includes(extraction.label));
      if (labelIndex >= 0) {
        const offset = extraction.offset ?? 1;
        const value = text(row[labelIndex + offset]);
        if (value) base[extraction.field] = value as never;
      }
    }
  }
};

const parseTable = (sheets: SheetSnapshot[], rule: ParseRule): OrderRow[] => {
  const selected = rule.sheetStrategy === "all" ? sheets : sheets.slice(0, 1);
  const result: OrderRow[] = [];
  for (const sheet of selected) {
    const headerIndex = Math.max((rule.headerRow ?? 1) - 1, 0);
    const dataStart = Math.max((rule.dataStartRow ?? rule.headerRow ?? 1) - 1, 0);
    const headerMap = makeHeaderMap(sheet.rows[headerIndex] ?? []);
    const tailBase = emptyRow(sheet.name);
    applyTailExtractions(sheet.rows, rule, tailBase);
    for (const row of sheet.rows.slice(dataStart)) {
      if (!rowHasContent(row)) continue;
      if (rule.stopWhenContains && row.join(" ").includes(rule.stopWhenContains)) break;
      const item = { ...tailBase, id: crypto.randomUUID(), source: sheet.name, errors: [] };
      for (const field of orderFields) {
        const value = readMapping(field, row, headerMap, rule, sheet.name);
        if (value) item[field] = field === "quantity" ? toNumber(value) as never : value as never;
      }
      if (item.skuCode || item.skuName) result.push(item);
    }
  }
  return result;
};

const parseMatrix = (sheets: SheetSnapshot[], rule: ParseRule): OrderRow[] => {
  const sheet = sheets[0];
  if (!sheet) return [];
  const headerIndex = Math.max((rule.headerRow ?? 1) - 1, 0);
  const dataStart = Math.max((rule.dataStartRow ?? 2) - 1, 0);
  const header = sheet.rows[headerIndex] ?? [];
  const headerMap = makeHeaderMap(header);
  const valueStart = Math.max((rule.matrixValueStartColumn ?? 1) - 1, 0);
  const valueEnd = Math.min(rule.matrixValueEndColumn ?? rowLength(sheet.rows), header.length || rowLength(sheet.rows));
  const fixedIndexes = new Set(Object.values(rule.mappings).map((mapping) => mapping?.index ? mapping.index - 1 : undefined));
  const result: OrderRow[] = [];
  for (const row of sheet.rows.slice(dataStart)) {
    if (!rowHasContent(row)) continue;
    for (let index = valueStart; index < valueEnd; index += 1) {
      if (fixedIndexes.has(index)) continue;
      const quantity = toNumber(row[index] ?? "");
      if (!quantity || Number(quantity) <= 0) continue;
      const item = emptyRow(sheet.name);
      for (const field of orderFields) {
        const value = readMapping(field, row, headerMap, rule, sheet.name);
        if (value) item[field] = field === "quantity" ? toNumber(value) as never : value as never;
      }
      item.storeName = text(header[index]);
      item.quantity = quantity;
      result.push(item);
    }
  }
  return result;
};

const rowLength = (rows: string[][]): number => Math.max(0, ...rows.map((row) => row.length));

const parseCards = (sheets: SheetSnapshot[], rule: ParseRule): OrderRow[] => {
  const sheet = sheets[0];
  if (!sheet) return [];
  const pattern = new RegExp(rule.boundaryPattern || "记录");
  const cards: string[][][] = [];
  let current: string[][] = [];
  for (const row of sheet.rows) {
    if (pattern.test(row.join(" "))) {
      if (current.length) cards.push(current);
      current = [row];
    } else if (current.length) {
      current.push(row);
    }
  }
  if (current.length) cards.push(current);
  const result: OrderRow[] = [];
  for (const card of cards) {
    const base = emptyRow(sheet.name);
    applyTailExtractions(card, rule, base);
    const itemHeaderIndex = card.findIndex((row) => row.join(" ").includes(rule.itemHeaderPattern || "物品编码"));
    if (itemHeaderIndex < 0) continue;
    const headerMap = makeHeaderMap(card[itemHeaderIndex] ?? []);
    for (const row of card.slice(itemHeaderIndex + 1)) {
      if (!rowHasContent(row)) continue;
      const item = { ...base, id: crypto.randomUUID(), errors: [] };
      for (const field of orderFields) {
        const value = readMapping(field, row, headerMap, rule, sheet.name);
        if (value) item[field] = field === "quantity" ? toNumber(value) as never : value as never;
      }
      if (item.skuCode || item.skuName) result.push(item);
    }
  }
  return result;
};

const parseText = (sheets: SheetSnapshot[], rule: ParseRule): OrderRow[] => {
  const content = sheets.flatMap((sheet) => sheet.rows.map((row) => row.join(" "))).join("\n");
  if (rule.itemPattern) {
    const result: OrderRow[] = [];
    const itemPattern = new RegExp(rule.itemPattern, "g");
    for (const match of content.matchAll(itemPattern)) {
      const item = emptyRow("文本解析");
      const groups = match.groups ?? {};
      for (const field of orderFields) {
        const value = readMapping(field, [match[0]], new Map(), rule, item.source, match[0], groups);
        if (value) item[field] = field === "quantity" ? toNumber(value) as never : value as never;
      }
      for (const field of orderFields) {
        if (item[field]) continue;
        const value = readMapping(field, [content], new Map(), rule, item.source, content);
        if (value) item[field] = field === "quantity" ? toNumber(value) as never : value as never;
      }
      if (item.skuCode || item.skuName) result.push(item);
    }
    return result;
  }
  const blocks = content.split(new RegExp(rule.boundaryPattern || "\\n\\s*\\n")).filter(Boolean);
  return blocks.map((block, index) => {
    const item = emptyRow(`文本块 ${index + 1}`);
    for (const field of orderFields) {
      const value = readMapping(field, [block], new Map(), rule, item.source, block);
      if (value) item[field] = field === "quantity" ? toNumber(value) as never : value as never;
    }
    return item;
  }).filter((item) => item.skuCode || item.skuName || item.storeName);
};

export const parseByRule = (sheets: SheetSnapshot[], rule: ParseRule): OrderRow[] => {
  if (rule.mode === "matrix") return parseMatrix(sheets, rule);
  if (rule.mode === "cards") return parseCards(sheets, rule);
  if (rule.mode === "text") return parseText(sheets, rule);
  return parseTable(sheets, rule);
};

export const validateRows = (rows: OrderRow[], existingCodes: Set<string>): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const seenSkuLine = new Map<string, number>();
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const add = (field: ValidationIssue["field"], message: string): void => {
      issues.push({ rowId: row.id, rowNumber, field, message });
    };
    if (!text(row.skuCode)) add("skuCode", "SKU物品编码必填");
    if (!text(row.skuName)) add("skuName", "SKU物品名称必填");
    if (!(Number(row.quantity) > 0)) add("quantity", "SKU发货数量必须为正数");
    if (!text(row.storeName) && !(text(row.receiverName) && text(row.receiverPhone) && text(row.receiverAddress))) add("row", "收货门店或收件人姓名、电话、地址二选一必填");
    if (text(row.receiverPhone) && !/^1[3-9]\d{9}$|^0\d{2,3}-?\d{7,8}$/.test(text(row.receiverPhone))) add("receiverPhone", "电话格式不正确");
    if (row.externalCode) {
      const skuLineKey = `${row.externalCode}::${row.skuCode}`;
      if (row.skuCode && seenSkuLine.has(skuLineKey)) add("externalCode", `与第 ${seenSkuLine.get(skuLineKey)} 行外部编码和 SKU 重复`);
      else if (row.skuCode) seenSkuLine.set(skuLineKey, rowNumber);
      if (existingCodes.has(row.externalCode)) add("externalCode", "与历史已导入外部编码重复");
    }
  });
  return issues;
};
