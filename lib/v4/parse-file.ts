import type { SheetSnapshot } from "@/lib/types";

/**
 * 服务端文件解析：把上传的原始文件读成规则引擎可消费的 SheetSnapshot[]。
 * 复用 V2 前端的解析库（@e965/xlsx / mammoth / pdfjs-dist），保证规则语义一致。
 */

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
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const XLSX = await import("@e965/xlsx");
    const workbook = XLSX.read(Buffer.from(buffer), { type: "buffer" });
    let count = 0;
    for (const name of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, defval: "", raw: false });
      count += rows.filter((row) => row.some((cell) => String(cell ?? "").trim())).length;
    }
    return count;
  }
  const sheets = await readSheetsFromBuffer(fileName, buffer);
  return sheets.reduce((sum, sheet) => sum + sheet.rows.filter((row) => row.some((cell) => cell.trim())).length, 0);
};
