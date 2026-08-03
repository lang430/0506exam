import type { OrderRow } from "@/lib/types";
import { ErrorCodes, errorReasonDefaults, errorSuggestions, type ErrorCode } from "@/lib/v4/error-codes";
import { maskRawValue } from "@/lib/v4/mask";

/**
 * V4 服务端批量校验：产出带错误码的行级错误对象。
 * 与 V2 validateRows 语义一致（必填、A/B 组二选一、电话格式、数量正数、外部编码重复），
 * 并新增 SKU 主数据存在性校验（E001，降级模式下跳过）。
 */

export interface RowError {
  rowNumber: number;
  fieldName: string;
  rawValue: string;
  errorCode: ErrorCode;
  errorReason: string;
  suggestion: string;
}

export interface ValidateSliceInput {
  /** 当前批次的行切片（已按全局顺序截取） */
  slice: OrderRow[];
  /** 切片首行的全局行号（1-based） */
  startRowNumber: number;
  /** SKU 主数据集合；null 表示降级模式，跳过 E001 校验 */
  skuMasterSet: Set<string> | null;
  /** 已存在于运单表的 externalCode::skuCode 键（批量 IN 查询得到），用于 E005 */
  existingKeys?: Set<string>;
}

const PHONE_PATTERN = /^1[3-9]\d{9}$|^(0\d{2,3}-?)?\d{7,8}$/;

const text = (value: unknown): string => String(value ?? "").trim();

const makeError = (
  rowNumber: number,
  fieldName: string,
  rawValue: string,
  errorCode: ErrorCode,
  detail?: string
): RowError => ({
  rowNumber,
  fieldName,
  rawValue: maskRawValue(fieldName, rawValue),
  errorCode,
  errorReason: detail ? `${errorReasonDefaults[errorCode]}：${detail}` : errorReasonDefaults[errorCode],
  suggestion: errorSuggestions[errorCode]
});

export const duplicateKeyOf = (row: Pick<OrderRow, "externalCode" | "skuCode" | "skuName">): string => {
  const externalCode = text(row.externalCode);
  if (!externalCode) return "";
  const skuKey = text(row.skuCode) || text(row.skuName);
  return skuKey ? `${externalCode}::${skuKey}` : externalCode;
};

export const validateSlice = (input: ValidateSliceInput): { errors: RowError[]; validRows: { row: OrderRow; rowNumber: number }[] } => {
  const { slice, startRowNumber, skuMasterSet, existingKeys } = input;
  const errors: RowError[] = [];
  const validRows: { row: OrderRow; rowNumber: number }[] = [];
  const seenInSlice = new Map<string, number>();

  slice.forEach((row, offset) => {
    const rowNumber = startRowNumber + offset;
    const rowErrors: RowError[] = [];
    const skuCode = text(row.skuCode);
    const skuName = text(row.skuName);
    const storeName = text(row.storeName);
    const receiverName = text(row.receiverName);
    const receiverPhone = text(row.receiverPhone);
    const receiverAddress = text(row.receiverAddress);

    if (!skuCode && !skuName) {
      rowErrors.push(makeError(rowNumber, "skuCode", "", ErrorCodes.RULE_MAPPING_FAILED, "规则未映射出 SKU 编码或名称"));
    } else {
      if (!skuCode) rowErrors.push(makeError(rowNumber, "skuCode", skuCode, ErrorCodes.REQUIRED_FIELD_MISSING, "SKU物品编码必填"));
      if (!skuName) rowErrors.push(makeError(rowNumber, "skuName", skuName, ErrorCodes.REQUIRED_FIELD_MISSING, "SKU物品名称必填"));
    }

    const quantity = Number(row.quantity);
    if (!(quantity > 0)) {
      rowErrors.push(makeError(rowNumber, "quantity", String(row.quantity ?? ""), ErrorCodes.QUANTITY_NOT_POSITIVE));
    }

    if (!storeName && !(receiverName && receiverPhone && receiverAddress)) {
      rowErrors.push(makeError(
        rowNumber,
        "receiverInfo",
        [storeName, receiverName, receiverPhone, receiverAddress].filter(Boolean).join(" / "),
        ErrorCodes.REQUIRED_FIELD_MISSING,
        "收货门店(A组)或收件人姓名+电话+地址(B组)二选一必填"
      ));
    }

    if (receiverPhone && !PHONE_PATTERN.test(receiverPhone)) {
      rowErrors.push(makeError(rowNumber, "receiverPhone", receiverPhone, ErrorCodes.PHONE_FORMAT_INVALID));
    }

    if (skuCode && skuMasterSet && !skuMasterSet.has(skuCode)) {
      rowErrors.push(makeError(rowNumber, "skuCode", skuCode, ErrorCodes.SKU_NOT_FOUND, `SKU ${skuCode} 不在主数据中`));
    }

    const duplicateKey = duplicateKeyOf(row);
    if (duplicateKey) {
      const firstRowNumber = seenInSlice.get(duplicateKey);
      if (firstRowNumber !== undefined) {
        rowErrors.push(makeError(rowNumber, "externalCode", text(row.externalCode), ErrorCodes.EXTERNAL_CODE_DUPLICATE, `与第 ${firstRowNumber} 行重复`));
      } else {
        seenInSlice.set(duplicateKey, rowNumber);
        if (existingKeys?.has(duplicateKey)) {
          rowErrors.push(makeError(rowNumber, "externalCode", text(row.externalCode), ErrorCodes.EXTERNAL_CODE_DUPLICATE, "与已入库运单重复"));
        }
      }
    }

    if (rowErrors.length) {
      errors.push(...rowErrors);
    } else {
      validRows.push({ row, rowNumber });
    }
  });

  return { errors, validRows };
};
