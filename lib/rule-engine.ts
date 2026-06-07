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

const normalizeSheets = (sheets: SheetSnapshot[]): SheetSnapshot[] =>
  sheets.map((sheet) => ({
    ...sheet,
    rows: sheet.rows.map((row) => Array.isArray(row) ? row.map((cell) => text(cell)) : [])
  }));

const toNumber = (value: string): number | string => {
  const match = text(value).match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : text(value);
};

const rowDuplicateKey = (row: Pick<OrderRow, "externalCode" | "skuCode" | "skuName">): string => {
  const externalCode = text(row.externalCode);
  if (!externalCode) return "";
  const skuKey = text(row.skuCode) || text(row.skuName);
  return skuKey ? `${externalCode}::${skuKey}` : externalCode;
};

const makeHeaderMap = (row: string[]): Map<string, number> => {
  const map = new Map<string, number>();
  row.forEach((cell, index) => {
    const key = text(cell);
    if (key) map.set(key, index);
  });
  return map;
};

const matrixValueEndIndex = (header: string[], rows: string[][], rule: ParseRule): number => {
  const naturalEnd = Math.min(rule.matrixValueEndColumn ?? rowLength(rows), header.length || rowLength(rows));
  if (!rule.matrixStopHeaderPattern) return naturalEnd;
  const pattern = new RegExp(rule.matrixStopHeaderPattern);
  const start = Math.max((rule.matrixValueStartColumn ?? 1) - 1, 0);
  const stopIndex = header.findIndex((cell, index) => index >= start && pattern.test(text(cell)));
  return stopIndex >= 0 ? Math.min(stopIndex, naturalEnd) : naturalEnd;
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
  const valueEnd = matrixValueEndIndex(header, sheet.rows, rule);
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
      const columnLabel = text(header[index]);
      const rowStore = rule.matrixRowStoreMapping ? readMapping("storeName", row, headerMap, { ...rule, mappings: { storeName: rule.matrixRowStoreMapping } }, sheet.name) : "";
      if (rule.matrixColumnRole === "date") {
        item.storeName = rowStore;
        item.remark = [item.remark, columnLabel].filter(Boolean).join(" ");
      } else {
        item.storeName = columnLabel;
      }
      if (rule.compoundCellPattern) {
        const pattern = new RegExp(rule.compoundCellPattern, "g");
        for (const match of String(row[index] ?? "").matchAll(pattern)) {
          const compound = { ...item, id: crypto.randomUUID(), skuName: text(match.groups?.skuName), quantity: toNumber(text(match.groups?.quantity)), errors: [] };
          if (compound.skuName && Number(compound.quantity) > 0) result.push(compound);
        }
      } else {
        item.quantity = quantity;
        result.push(item);
      }
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
      if (rule.stopWhenContains && row.join(" ").includes(rule.stopWhenContains)) break;
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
    const blocks = rule.blockPattern ? content.split(new RegExp(rule.blockPattern)).filter((block) => block.trim()) : [content];
    const itemPattern = new RegExp(rule.itemPattern, "g");
    for (const block of blocks) for (const match of block.matchAll(itemPattern)) {
      const item = emptyRow("文本解析");
      const groups = match.groups ?? {};
      for (const field of orderFields) {
        const value = readMapping(field, [match[0]], new Map(), rule, item.source, match[0], groups);
        if (value) item[field] = field === "quantity" ? toNumber(value) as never : value as never;
      }
      for (const field of orderFields) {
        if (item[field]) continue;
        const value = readMapping(field, [block], new Map(), rule, item.source, block);
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
  const normalizedSheets = normalizeSheets(sheets);
  if (rule.mode === "matrix") return parseMatrix(normalizedSheets, rule);
  if (rule.mode === "cards") return parseCards(normalizedSheets, rule);
  if (rule.mode === "text") return parseText(normalizedSheets, rule);
  return parseTable(normalizedSheets, rule);
};

export const validateRows = (rows: OrderRow[], existingCodes: Set<string>): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const firstRowByDuplicateKey = new Map<string, number>();
  const duplicateRowsByDuplicateKey = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const duplicateKey = rowDuplicateKey(row);
    if (!duplicateKey) return;
    const firstRow = firstRowByDuplicateKey.get(duplicateKey);
    if (firstRow === undefined) {
      firstRowByDuplicateKey.set(duplicateKey, index + 1);
      return;
    }
    duplicateRowsByDuplicateKey.set(duplicateKey, [...(duplicateRowsByDuplicateKey.get(duplicateKey) ?? [firstRow]), index + 1]);
  });
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const add = (field: ValidationIssue["field"], message: string): void => {
      issues.push({ rowId: row.id, rowNumber, field, message });
    };
    if (!text(row.skuCode)) add("skuCode", "SKU物品编码必填");
    if (!text(row.skuName)) add("skuName", "SKU物品名称必填");
    if (!(Number(row.quantity) > 0)) add("quantity", "SKU发货数量必须为正数");
    if (!text(row.storeName) && !(text(row.receiverName) && text(row.receiverPhone) && text(row.receiverAddress))) add("row", "收货门店或收件人姓名、电话、地址二选一必填");
    const phone = text(row.receiverPhone);
    if (phone && !/^1[3-9]\d{9}$|^(0\d{2,3}-?)?\d{7,8}$/.test(phone)) add("receiverPhone", "电话格式错误");
    const duplicateKey = rowDuplicateKey(row);
    if (duplicateKey && existingCodes.has(duplicateKey)) add("externalCode", "外部编码与已存在数据重复");
    const duplicateRows = duplicateKey ? duplicateRowsByDuplicateKey.get(duplicateKey) : undefined;
    if (duplicateRows?.includes(rowNumber)) {
      const otherRows = duplicateRows.filter((item) => item !== rowNumber).join("、");
      add("externalCode", `外部编码同批次重复，与第 ${otherRows} 行重复`);
    }
  });
  return issues;
};
