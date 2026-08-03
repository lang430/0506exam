/**
 * V4 行级错误码定义（题面模块六建议错误码）
 */

export const ErrorCodes = {
  SKU_NOT_FOUND: "E001",
  REQUIRED_FIELD_MISSING: "E002",
  PHONE_FORMAT_INVALID: "E003",
  QUANTITY_NOT_POSITIVE: "E004",
  EXTERNAL_CODE_DUPLICATE: "E005",
  RULE_MAPPING_FAILED: "E006",
  DB_WRITE_FAILED: "E007",
  FILE_FORMAT_UNSUPPORTED: "E008"
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** 错误码 → 用户可执行的修复建议（考点 4：错误可解释、可修复） */
export const errorSuggestions: Record<ErrorCode, string> = {
  E001: "请核对 SKU 编码是否存在于商品主数据；若为新品请先在主数据中建档，或修正拼写后重新导入。",
  E002: "请补齐该行缺失的必填字段（SKU编码、SKU名称、数量，以及收货门店或收件人三要素之一组）。",
  E003: "电话应为 11 位手机号或区号+座机号（如 021-12345678），请检查数字与分隔符。",
  E004: "发货数量必须是正数，请检查是否为 0、负数或包含非数字字符。",
  E005: "同一任务内出现重复的外部编码+SKU 组合，请删除重复行或修正外部编码。",
  E006: "规则未能从该行映射出 SKU 编码或名称，请检查解析规则的字段映射是否覆盖该列。",
  E007: "数据库写入失败，通常为系统侧问题；请查看批次性能日志或在任务详情页重试该批次。",
  E008: "不支持的文件格式，请上传 .xlsx / .xls / .docx / .pdf 文件。"
};

export const errorReasonDefaults: Record<ErrorCode, string> = {
  E001: "SKU 不存在于主数据",
  E002: "必填字段缺失",
  E003: "电话格式错误",
  E004: "数量不是正数",
  E005: "外部编码重复",
  E006: "规则映射失败",
  E007: "数据库写入失败",
  E008: "文件格式不支持"
};
