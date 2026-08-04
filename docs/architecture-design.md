# 架构设计文档：V2 下单主链路异步事件驱动重构

## 1. 总体架构

```
用户上传文件 + 规则ID
      │
      ▼
POST /api/import-tasks（≤1s 返回 task_id）
      │  单事务写入：
      │  import_task_files（原始文件 bytea）
      │  import_tasks（任务主表）
      │  import_task_batches（处理单元，N 个）
      │  event_outbox（Transactional Outbox 事件）
      │
      ├─ after() 触发 POST /api/import-dispatcher（主路径，零延迟）
      │
      ▼
runDispatchCycle（全局租约锁，单处理器）
      │
      ├─ dispatchOutbox：pending 事件投递（批次置 ready）
      ├─ recoverStuckBatches：卡死批次回收（2 分钟）
      └─ 循环认领 ready 批次（FOR UPDATE SKIP LOCKED）
             │
             ▼
      processBatch（Worker）
      ① 读原始文件 → 复用 V2 规则引擎 parseByRule（不重写业务规则）
      ② 截取本批行区间（末批开放区间）
      ③ 批量 SKU 校验（单次 IN 查询，3s 超时 → 降级跳过 E001）
      ④ 批量行级校验（必填/A/B组/电话/数量/重复 → E001~E006）
      ⑤ 成功行 250 行/块 UPSERT（稳定业务键幂等）
      ⑥ 失败行写 import_task_errors（脱敏原始值 + 修复建议）
      ⑦ 写 batch_performance_log（解析/规则/校验/写入/总耗时）
      ⑧ 条件状态门闩：首次 completed 才原子累计任务进度
      ⑨ finalizeTaskIfNeeded：全批次结束 → completed / partial_success / failed
      │
      ▼
前端：任务详情页 1.5s 轮询进度（轮询同时触发兜底调度）
      监控看板 / Trace 时间线 / 错误明细筛选分页导出
```

## 2. 核心设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 队列实现 | PG 原生任务队列（event_outbox + 批次状态机） | Vercel Hobby 无法常驻 Worker 也无付费队列集成；Outbox 本身即可靠事件源，批次表即队列体；满足题面"重试、状态追踪、失败记录"全部要求 |
| 并发控制 | dispatch_lease 租约锁，全局单处理器 | 实测多实例并行抢批压垮小规格数据库；首批 ~1.9s、缓存批 ~0.5s，吞吐余量 10 倍 |
| 文件存储 | Postgres bytea（import_task_files） | 零额外凭据；10k 行文件仅 ~500KB；Worker 复读原始文件保证批次自包含与幂等 |
| 解析执行 | 首批读全文件 + 规则引擎，按批截取行区间 | 批次完全自包含：任何批次可独立重试/恢复；规则引擎 10k 行解析仅 ~0.9s |
| 解析缓存 | 实例级 LRU（上限 3 任务）缓存规则引擎解析结果 | 单处理器串行消费时后续批次命中缓存（parse=0），单批 1.9s→0.5s |
| 触发机制 | 三路径互补：① 上传 after() 触发调度端点（主路径）；② 调度端点 after() 自链续跑（30 批/50s）；③ 进度轮询响应前停滞门控内联调度（仅无批次处理中时，1 批/2.5s）；cron（每日 03:00）+ worker-loop 兜底 | Hobby 计划 after() 随实例挂起且持租约阻塞其他循环（实测 90s 停滞）；三路径互补保证"上传即启动、有人看进度就推进、宕机有兜底"，且请求生命周期内必然释放租约 |
| 幂等 | 认领互斥 + 状态门闩 + 业务键 UPSERT | 四层防线，重复投递/重复消费零副作用 |

## 3. 数据模型（database-v4.sql 增量）

| 表 | 用途 | 关键索引 |
|---|---|---|
| sku_master | SKU 主数据（压测与校验） | sku_code 唯一 |
| import_tasks | 任务主表：状态/行数/trace_id/degraded | (status, created_at desc), file_sha256 |
| import_task_files | 原始文件存储 | PK task_id |
| import_task_batches | 处理单元状态机 pending→ready→processing→completed/failed | (task_id, unit_id) 唯一；(status, task_id) |
| import_task_errors | 行级错误：批次/行号/字段/脱敏原始值/错误码/原因/建议 | (task_id, unit_id)；error_code；(task_id, batch_index) |
| event_outbox | Transactional Outbox | (status, next_retry_at)；event_id 唯一 |
| batch_performance_log | 批次阶段耗时 | (task_id, unit_id)；created_at |
| trace_events | 链路时间线 | (trace_id, occurred_at)；task_id |
| dispatch_lease | 调度租约（单处理器锁） | PK key |
| imported_orders（V2 复用） | 运单主表，新增 line_no | 部分唯一键 (external_code, sku_code, line_no) |

## 4. 事件契约（schema_version=1）

统一信封：`{event_id, event_type, schema_version, aggregate_id, trace_id, occurred_at, payload}`

| 事件 | 生产者 | 消费者 | 说明 |
|---|---|---|---|
| ImportTaskCreated | 上传 API（Outbox） | Dispatcher | 任务已创建（审计/时间线） |
| ImportBatchCreated | 上传 API（Outbox） | Dispatcher | 批次待处理 → 置 ready 入队 |
| ImportBatchStarted | Worker | Trace | 批次开始处理 |
| ImportBatchSucceeded | Worker | Trace/任务聚合 | 批次完成（含成功/失败行数） |
| ImportBatchFailed | Worker | Trace/告警 | 批次失败（规则缺失、文件缺失等系统级错误） |
| ImportTaskCompleted | 聚合 | 监控 | 全部行成功 |
| ImportTaskPartialSuccess | 聚合 | 监控 | 部分行失败，成功行已入库 |
| ImportTaskDegraded | Worker | 监控/UI | SKU 校验降级发生 |

**版本策略**：新增字段向后兼容；消费者必须忽略未知字段（readPayloadField 宽松读取）；重大语义变更升级 schema_version 并在本节登记。

## 5. 状态机

```
任务 import_tasks.status：
  pending ──首批开始──▶ processing ──全批次结束──▶ completed
                              │                 ▶ partial_success（有失败行/失败批次）
                              │                 ▶ failed（全部批次失败或系统级错误）
批次 import_task_batches.status：
  pending ──Outbox投递──▶ ready ──认领(SKIP LOCKED)──▶ processing
    （未投递，与任务同事务创建）                          │──提交──▶ completed
                                                       │──重试超限/系统错误──▶ failed
  恢复：processing 且 locked_at 超过 2 分钟 → ready（重试）/ failed（死信，retry_count≥3）
Outbox event_outbox.status：
  pending ──投递成功──▶ sent；重试 5 次失败 ──▶ failed（死信）
```

## 6. 可观测性设计

- **traceId 穿透**：上传时生成 trace_id，贯穿任务、Outbox 事件、批次、错误明细、性能日志、trace_events；
- **监控看板**（/monitor）：实时吞吐（近 5 分钟入库行数/分钟）、队列积压深度（>5000 行橙色预警、数据库不可用红色告警）、阶段耗时 P50/P95/P99（percentile_cont 真实聚合）、错误类型分布（可跳转错误明细）；
- **Trace 检索**（/traces）：按 task_id/文件名/错误码/行号范围检索 → 时间线 + 批次耗时 + 失败节点（脱敏原始值/错误码/原因/建议）；
- **性能日志**：每批次记录解析/规则/校验/写入/总耗时与成功失败行数，是所有百分位指标的数据源。

## 7. 与 V2/V3 的边界

- **复用不重写**：lib/rule-engine.ts（parseByRule/validateRows 语义）、parse_rules 规则表、AI 规则生成、鲸天 UI 设计语言全部复用；
- **V2 手动链路保留**：预览编辑 + 同步提交（/api/orders）原样保留，与异步链路并存；
- **V3 契约不动**：/api/v1/* 接口与 V2_API_TOKEN 鉴权保持原状（范围限定声明）；imported_orders 仅新增 line_no 列，字段语义不变。
