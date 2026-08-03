import { describe, expect, it } from "vitest";
import { ErrorCodes, errorSuggestions, errorReasonDefaults } from "@/lib/v4/error-codes";
import { buildEnvelope, ImportEvents, readPayloadField, V4_EVENT_SCHEMA_VERSION } from "@/lib/v4/events";
import { maskAddress, maskName, maskPhone, maskRawValue } from "@/lib/v4/mask";
import { validateSlice } from "@/lib/v4/validate";
import type { OrderRow } from "@/lib/types";

/**
 * V4 纯逻辑测试（无数据库依赖，任何环境可跑）
 */

const makeRow = (overrides: Partial<OrderRow>): OrderRow => ({
  id: `row_${Math.random()}`,
  externalCode: "ORD-1",
  storeName: "测试门店",
  receiverName: "",
  receiverPhone: "",
  receiverAddress: "",
  skuCode: "SKU_00001",
  skuName: "测试商品",
  quantity: 3,
  spec: "500g",
  remark: "",
  source: "test",
  errors: [],
  ...overrides
});

describe("行级校验与错误码（场景 6/7/8 的校验基础）", () => {
  it("合法行 + 存在的 SKU 不产生错误", () => {
    const { errors, validRows } = validateSlice({
      slice: [makeRow({})],
      startRowNumber: 1,
      skuMasterSet: new Set(["SKU_00001"])
    });
    expect(errors).toHaveLength(0);
    expect(validRows).toHaveLength(1);
  });

  it("E001：SKU 不在主数据", () => {
    const { errors } = validateSlice({
      slice: [makeRow({})],
      startRowNumber: 1,
      skuMasterSet: new Set(["OTHER"])
    });
    expect(errors.some((e) => e.errorCode === ErrorCodes.SKU_NOT_FOUND)).toBe(true);
  });

  it("降级模式（skuMasterSet=null）跳过 E001", () => {
    const { errors } = validateSlice({ slice: [makeRow({})], startRowNumber: 1, skuMasterSet: null });
    expect(errors.some((e) => e.errorCode === ErrorCodes.SKU_NOT_FOUND)).toBe(false);
  });

  it("E002/E006：整行无 SKU 信息判为规则映射失败，且校验 A/B 组二选一", () => {
    const { errors } = validateSlice({
      slice: [makeRow({ skuCode: "", skuName: "", storeName: "" })],
      startRowNumber: 1,
      skuMasterSet: null
    });
    const codes = errors.map((e) => e.errorCode);
    expect(codes).toContain(ErrorCodes.RULE_MAPPING_FAILED);
    expect(codes).toContain(ErrorCodes.REQUIRED_FIELD_MISSING);
  });

  it("E002：仅缺 SKU 编码（名称存在）", () => {
    const { errors } = validateSlice({
      slice: [makeRow({ skuCode: "" })],
      startRowNumber: 1,
      skuMasterSet: null
    });
    const missing = errors.find((e) => e.errorCode === ErrorCodes.REQUIRED_FIELD_MISSING);
    expect(missing?.fieldName).toBe("skuCode");
  });

  it("E003：电话格式错误", () => {
    const { errors } = validateSlice({
      slice: [makeRow({ receiverName: "张三", receiverPhone: "12345", receiverAddress: "地址" })],
      startRowNumber: 1,
      skuMasterSet: null
    });
    expect(errors.some((e) => e.errorCode === ErrorCodes.PHONE_FORMAT_INVALID)).toBe(true);
  });

  it("E004：数量非正数", () => {
    const { errors } = validateSlice({
      slice: [makeRow({ quantity: 0 })],
      startRowNumber: 1,
      skuMasterSet: null
    });
    expect(errors.some((e) => e.errorCode === ErrorCodes.QUANTITY_NOT_POSITIVE)).toBe(true);
  });

  it("E005：同批次外部编码 + SKU 重复，标注与哪一行重复", () => {
    const { errors } = validateSlice({
      slice: [makeRow({}), makeRow({})],
      startRowNumber: 1,
      skuMasterSet: null
    });
    const dup = errors.find((e) => e.errorCode === ErrorCodes.EXTERNAL_CODE_DUPLICATE);
    expect(dup).toBeTruthy();
    expect(dup?.errorReason).toContain("第 1 行");
  });

  it("E005：与已入库数据重复", () => {
    const { errors } = validateSlice({
      slice: [makeRow({})],
      startRowNumber: 1,
      skuMasterSet: null,
      existingKeys: new Set(["ORD-1::SKU_00001"])
    });
    expect(errors.some((e) => e.errorCode === ErrorCodes.EXTERNAL_CODE_DUPLICATE)).toBe(true);
  });

  it("错误码均配有可读原因与修复建议", () => {
    for (const code of Object.values(ErrorCodes)) {
      expect(errorReasonDefaults[code]).toBeTruthy();
      expect(errorSuggestions[code]).toBeTruthy();
    }
  });
});

describe("敏感数据脱敏（场景 8/考点 4）", () => {
  it("手机号保留前 3 后 4", () => {
    expect(maskPhone("13812345678")).toBe("138****5678");
  });
  it("地址仅保留前 6 字符", () => {
    expect(maskAddress("上海市浦东新区张江路100号")).toBe("上海市浦东新******");
  });
  it("姓名保留姓氏", () => {
    expect(maskName("张三丰")).toBe("张**");
  });
  it("maskRawValue 按字段分派", () => {
    expect(maskRawValue("receiverPhone", "13812345678")).toContain("****");
    expect(maskRawValue("skuCode", "SKU_00001")).toBe("SKU_00001");
  });
});

describe("事件契约（考点 1：事件信封与版本）", () => {
  it("信封包含必备字段且 schema_version=1", () => {
    const envelope = buildEnvelope(ImportEvents.ImportBatchCreated, "task_x", "trace_x", { task_id: "task_x", unit_id: "unit_001" });
    expect(envelope.event_id).toMatch(/^evt_/);
    expect(envelope.event_type).toBe("ImportBatchCreated");
    expect(envelope.schema_version).toBe(V4_EVENT_SCHEMA_VERSION);
    expect(envelope.aggregate_id).toBe("task_x");
    expect(envelope.trace_id).toBe("trace_x");
    expect(envelope.occurred_at).toBeTruthy();
  });
  it("消费者忽略未知字段（向后兼容读取）", () => {
    expect(readPayloadField({ a: 1 }, "a", 0)).toBe(1);
    expect(readPayloadField({ a: 1 }, "unknown", "fallback")).toBe("fallback");
    expect(readPayloadField(null, "a", 9)).toBe(9);
  });
});

describe("批次边界（上传分片设计）", () => {
  it("最后一批为开放区间，预估偏差不丢行", () => {
    const estimatedRows = 10001;
    const size = 1000;
    const totalBatches = Math.max(1, Math.ceil(estimatedRows / size));
    const ranges = Array.from({ length: totalBatches }, (_, index) => {
      const startRow = index * size;
      return { start: startRow, end: index === totalBatches - 1 ? -1 : startRow + size };
    });
    expect(ranges[0]).toEqual({ start: 0, end: 1000 });
    expect(ranges.at(-1)).toEqual({ start: 10000, end: -1 });
    // 解析结果若少于预估（如 10000 行），开放区间保证覆盖全部
    const parsedCount = 10000;
    const lastSlice = Array.from({ length: parsedCount }).slice(ranges.at(-1)!.start, ranges.at(-1)!.end === -1 ? undefined : ranges.at(-1)!.end);
    expect(lastSlice.length).toBe(0); // 10000 行时第 11 批为空批而非丢行
  });
});
