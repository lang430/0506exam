import { inflateRawSync } from "node:zlib";
import type { SheetSnapshot } from "@/lib/types";

/**
 * 服务端文件解析：把上传的原始文件读成规则引擎可消费的 SheetSnapshot[]。
 * 复用 V2 前端的解析库（@e965/xlsx / mammoth / pdfjs-dist），保证规则语义一致。
 */

/**
 * 快速统计 xlsx 行数（上传期预扫描专用）：
 * xlsx 本质是 zip 包，直接解析中央目录定位 xl/worksheets/sheetN.xml，
 * inflate 后计数 <row> 元素，跳过 SheetJS 全量单元格解析（实测快约 10 倍）。
 * 任何解析异常均抛出，由调用方回退到全量读取。
 */
export const countXlsxRowsFromZip = (buffer: Buffer): number => {
  // 从文件尾部反向查找 EOCD（End of Central Directory）
  let eocdOffset = -1;
  const minScan = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minScan; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("EOCD not found");
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let cursor = buffer.readUInt32LE(eocdOffset + 16);
  let totalRows = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("bad central directory");
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const fileName = buffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString("utf8");
    cursor += 46 + fileNameLength + extraLength + commentLength;
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(fileName)) continue;
    // 读取本地文件头，定位压缩数据
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error("bad local header");
    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const xml = (method === 8 ? inflateRawSync(compressed) : compressed).toString("utf8");
    const matches = xml.match(/<(?:[A-Za-z0-9]+:)?row(?=[\s/>])/g);
    totalRows += matches ? matches.length : 0;
  }
  return totalRows;
};

const excelCellText = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "object") {
    const record = value as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (record.text) return record.text;
    if (record.result != null) return String(record.result);
    if (record.richText) return record.richText.map((item) => item.text).join("");
  }
  return String(value);
};

const sheetRowsFromText = (name: string, content: string): SheetSnapshot[] => [{
  name,
  rows: content.split(/\r?\n/).map((line) => [line])
}];

export const isSupportedFile = (fileName: string): boolean =>
  /\.(xlsx|xls|docx|pdf)$/i.test(fileName);

export const readSheetsFromBuffer = async (fileName: string, buffer: Buffer | Uint8Array): Promise<SheetSnapshot[]> => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const XLSX = await import("@e965/xlsx");
    const workbook = XLSX.read(Buffer.from(buffer), { type: "buffer" });
    return workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false })
        .map((row) => row.map(excelCellText));
      return { name, rows };
    });
  }
  if (lower.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
    return sheetRowsFromText(fileName, result.value);
  }
  if (lower.endsWith(".pdf")) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true
    }).promise;
    const lines: string[] = [];
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      lines.push(`---PAGE--- ${content.items.map((item: { str?: string }) => item.str ?? "").join(" ")}`);
    }
    await doc.destroy();
    return sheetRowsFromText(fileName, lines.join("\n"));
  }
  throw new Error("E008: 仅支持 .xlsx / .xls / .docx / .pdf 文件");
};

/**
 * 上传期轻量预扫描：估算总行数用于建批与响应。
 * Excel 统计所有 Sheet 的非空行；文本类按行数估算。
 * 精确行数由 Worker 解析后回填（最后一批为开放区间，不会丢行）。
 */
export const preCountRows = async (fileName: string, buffer: Buffer | Uint8Array): Promise<number> => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) {
    try {
      return countXlsxRowsFromZip(Buffer.from(buffer));
    } catch {
      // zip 结构异常（如特殊工具生成）→ 回退全量读取
    }
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const XLSX = await import("@e965/xlsx");
    const workbook = XLSX.read(Buffer.from(buffer), { type: "buffer" });
    let count = 0;
    for (const name of workbook.SheetNames) {
      const ref = workbook.Sheets[name]?.["!ref"];
      if (!ref) continue;
      const range = XLSX.utils.decode_range(ref);
      count += range.e.r - range.s.r + 1;
    }
    return count;
  }
  const sheets = await readSheetsFromBuffer(fileName, buffer);
  return sheets.reduce((sum, sheet) => sum + sheet.rows.filter((row) => row.some((cell) => cell.trim())).length, 0);
};
