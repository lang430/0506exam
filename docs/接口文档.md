# V4 接口文档

基础地址（生产）：`https://0807v4.vercel.app`

## 1. 上传并创建导入任务

`POST /api/import-tasks`　`multipart/form-data`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| file | File | 是 | .xlsx / .xls / .docx / .pdf |
| ruleId | string | 是 | parse_rules 中已保存的解析规则 ID |

响应 `202`（目标：服务端处理 P95 ≤1s）：

```json
{
  "task_id": "task_3542c09d03194670ab1c31b8",
  "trace_id": "trace_b8f45ccc938a4d31",
  "status": "PENDING",
  "total_rows": 10001,
  "total_batches": 5,
  "batch_size": 2500,
  "duplicate_of": "task_xxx（24 小时内同哈希任务，可为 null）",
  "upload_ms": 284
}
```

错误：`400` 参数/规则缺失；`415` 文件格式不支持（E008）；`503` 数据库未配置。

## 2. 查询任务进度

`GET /api/import-tasks/:taskId`（前端 1~2s 轮询；非终态任务轮询时会顺带触发兜底调度）

```json
{
  "task_id": "task_xxx",
  "file_name": "10000-orders.xlsx",
  "status": "PARTIAL_SUCCESS",
  "status_raw": "partial_success",
  "total_rows": 10000,
  "processed_rows": 10000,
  "success_rows": 9830,
  "failed_rows": 170,
  "total_batches": 5,
  "completed_batches": 5,
  "failed_batches": 0,
  "degraded": false,
  "trace_id": "trace_xxx",
  "error_message": null,
  "throughput_per_sec": 1234.5,
  "eta_seconds": 0,
  "recent_errors": [{ "error_code": "E001", "count": 120 }],
  "created_at": "...", "completed_at": "..."
}
```

任务列表：`GET /api/import-tasks`（最近 50 条）。错误：`404` 任务不存在（非法 task_id 保护）。

## 3. 查询错误明细

`GET /api/import-tasks/:taskId/errors?batch=&error_code=&page=&page_size=`

```json
{
  "task_id": "task_xxx", "page": 1, "page_size": 50, "total": 170,
  "errors": [{
    "batch_index": 0, "row_number": 1234, "field_name": "skuCode",
    "raw_value": "SKU_BAD_00123", "error_code": "E001",
    "error_reason": "SKU 不存在于主数据：SKU SKU_BAD_00123 不在主数据中",
    "suggestion": "请核对 SKU 编码是否存在于商品主数据...", "unit_id": "unit_001"
  }]
}
```

导出失败明细 CSV：`GET /api/import-tasks/:taskId/errors-export`

## 4. 查询批次性能

`GET /api/import-tasks/:taskId/batches`

返回 `batches`（单元状态/行范围/重试次数/成功失败行/SKU 校验是否跳过）与 `performance`（parse/rule/validate/insert/total 毫秒耗时）。

## 5. Trace 检索

- `GET /api/traces?task_id=&file_name=&error_code=&row_from=&row_to=` —— 按条件检索命中的任务与其 trace_id；
- `GET /api/traces/:traceId?task_id=&batch=&row_from=&row_to=&error_code=` —— 时间线事件 + 批次耗时 + 失败节点明细。

## 6. 监控聚合

`GET /api/import-monitor/summary`

```json
{
  "generatedAt": "...",
  "throughput": [{ "minute": "19:02", "rows": 9830 }],
  "queueDepth": { "pendingBatches": 0, "readyBatches": 0, "processingBatches": 0, "waitingRows": 0, "outboxPending": 0, "alertLevel": "ok" },
  "stagePercentiles": { "parse": { "p50": 0, "p95": 0, "p99": 0 }, "rule": {}, "validate": {}, "insert": {} },
  "errorDistribution": [{ "errorCode": "E001", "count": 120 }],
  "recentTasks": []
}
```

数据库/队列不可用时返回 `503 + alertLevel: "critical"`（看板红色告警）。

## 7. 调度端点（内部，Bearer 鉴权）

`POST /api/import-dispatcher`　Header：`Authorization: Bearer $DISPATCHER_TOKEN`

执行一轮调度：Outbox 投递 → 卡死恢复 → 批次消费（自链式直到积压清空）。无令牌/错误令牌返回 `401`。

## 错误码表

| 错误码 | 含义 | 用户修复建议（摘要） |
|---|---|---|
| E001 | SKU 不存在 | 核对主数据或修正拼写 |
| E002 | 必填字段缺失 | 补齐必填字段（含 A/B 组二选一） |
| E003 | 电话格式错误 | 11 位手机号或区号座机 |
| E004 | 数量不是正数 | 修正为大于 0 的数字 |
| E005 | 外部编码重复 | 删除重复行或修正外部编码 |
| E006 | 规则映射失败 | 检查解析规则字段映射 |
| E007 | 数据库写入失败 | 系统侧问题，查看批次日志/重试 |
| E008 | 文件格式不支持 | 使用 xlsx/xls/docx/pdf |
