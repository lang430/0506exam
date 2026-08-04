# V4 压测报告：万能导入异步事件驱动链路

## 基本信息

| 项目 | 值 |
|---|---|
| 测试时间 | 2026-08-03 20:10 ~ 20:30（UTC+8） |
| 部署环境 | Vercel Production：https://0807v4.vercel.app （us-east-1，Serverless，maxDuration=60s） |
| 数据库 | Supabase Postgres（us-east-1，Vercel Marketplace 集成，连接池模式 6543 + 直连 5432） |
| Worker 配置 | Vercel Serverless 三路径互补：上传接口 after() 触发 `/api/import-dispatcher`（主路径）+ 调度端点 after() 自链续跑（30 批/50s 一轮）+ 进度轮询响应前停滞门控内联调度（仅无批次处理中时，1 批/2.5s）；cron（每日 03:00）与本地 worker-loop 兜底；全局租约锁（dispatch_lease）保证同一时刻单处理器串行消费 |
| 并发与连接控制 | 每个函数实例 postgres 客户端 max=1；批次认领 FOR UPDATE SKIP LOCKED；禁止多实例并行消费（实测并行会压垮小规格数据库，详见重构假设说明） |
| SKU 主数据 | 20,000 条（SKU_00001~SKU_20000，scripts/seed-data.ts 灌入） |
| 压测文件 | test-data/10000-orders.xlsx，10,000 行运单（2,000 个外部编码 × 5 SKU 行） |
| 故意错误 | 120 行非法 SKU（E001）+ 30 行非法电话（E003）+ 20 行非正数量（E004），共 170 行 |
| 处理单元 | 2,500 行/批 × 4 批 + 1 个尾部开放批（V4_BATCH_SIZE=2500） |

## 压测结果

| 指标 | 结果 | 目标 | 结论 |
|---|---:|---|---|
| 10,000 行全链路耗时（上传返回 → 任务终态） | **11 秒**（上传接口 2.1 秒为压测机跨洋视角，服务端处理 150~400ms） | ≤ 60 秒 | ✅ 达标（余量 5 倍） |
| 任务终态 | PARTIAL_SUCCESS | completed / partial_success | ✅ |
| 成功行数 | 9,830 | 9,830 | ✅ 与预期完全一致 |
| 失败行数 | 170 | 170 | ✅ 与预埋错误完全一致 |
| 500 / 504 错误 | 无 | 无 | ✅ |
| SKU 校验降级 | 未触发 | — | 主数据查询 <3s，正常校验 |

### 上传接口响应时间（考点 1：P95 ≤ 1 秒）

压测机位于中国，Vercel/Supabase 位于美东，每次请求包含约 300~700ms 的跨洋 TCP/TLS 往返。采样数据反映"压测机视角"端到端时间；服务端耗时以接口返回的 `upload_ms` 字段为准：

| 口径 | 小文件（50 行 × 10 次） | 10,000 行大文件 |
|---|---|---|
| 压测机视角 P95（含跨洋网络） | 1051ms | 1191ms（单次） |
| **服务端处理 upload_ms** | **300~450ms** | **150~260ms**（3 轮实测） |

优化后上传关键路径：`formData 接收 → SHA256 → 规则/查重/活跃任务合并预检（1 次查询）→ zip 级行数统计（10k 行 26ms）→ 单事务写入文件+任务+批次+Outbox → 返回`。10,000 行文件的服务端处理从优化前 1016~1207ms 降至 150~260ms，满足 P95 ≤1s。

### 处理单元阶段耗时（batch_performance_log 真实记录）

| 批次 | 文件解析 | 规则引擎 | 批量校验 | 批量写入 | 总耗时 |
|---:|---:|---:|---:|---:|---:|
| unit_001 | 939ms | 134ms | 43ms | 613ms | 1873ms |
| unit_002 | 0ms（缓存） | 0ms（缓存） | 28ms | 444ms | 500ms |
| unit_003 | 0ms（缓存） | 0ms（缓存） | 22ms | 591ms | 640ms |
| unit_004 | 0ms（缓存） | 0ms（缓存） | 23ms | 326ms | 378ms |
| unit_005 | 0ms（空尾批） | 0ms | 0ms | 3ms | 28ms |

- 首批完整执行"读原始文件 + V2 规则引擎"并写入实例级解析缓存，后续批次命中缓存直接截取行区间（解析成本 0）；
- 批量校验：收集本批 SKU 去重后单次 `IN` 查询 sku_master，外部编码重复检测同为单次批量查询，无逐行查询；
- 批量写入：250 行/块的多行 VALUES UPSERT（on conflict 稳定业务键），无逐行 INSERT。

### 阶段耗时 P50/P95/P99

监控聚合接口 `/api/import-monitor/summary` 基于 batch_performance_log 的 percentile_cont 实时计算（近 24 小时窗口）。本次压测样本代表值：

| 阶段 | P50 | P95 | P99 |
|---|---:|---:|---:|
| 文件解析 | 0ms（缓存命中为主） | ~939ms（首批） | ~939ms |
| 规则引擎 | 0ms | ~134ms | ~134ms |
| 批量校验 | ~23ms | ~43ms | ~43ms |
| 批量写入 | ~444ms | ~613ms | ~613ms |

### 错误明细验证（错误定位能力）

170 条行级错误全部写入 import_task_errors，含批次号、文件全局行号、字段名、脱敏原始值、错误码、原因与修复建议；可通过 `/api/import-tasks/:taskId/errors?batch=&error_code=&page=` 筛选分页，任务页一键导出 CSV，Trace 页按行号/错误码检索直达失败节点。

### 监控看板证据（考点 5 / 提交物"监控看板日志"）

看板页面 `/monitor` 与聚合接口 `GET /api/import-monitor/summary` 同源，四大强制区数据均由 SQL 实时聚合，无前端造数。压测窗口内读数如下：

| 看板区域 | 数据来源 | 压测期间读数 | 说明 |
|---|---|---|---|
| **① 吞吐量** | `imported_orders` 按分钟聚合（近 60 分钟） | 峰值 **≈55,000 行/分钟**（10,000 行 / 11 秒） | 远超 10,000 单/分钟目标 |
| **② 队列积压预警** | `import_task_batches` 未终态批次 + `event_outbox` 待投递 | 任务创建瞬时 `waitingRows≈10,000`、`pendingBatches=5` → **触发 `warn` 橙色预警**（阈值 `QUEUE_BACKLOG_WARN_ROWS=5000`）；11 秒后归零转 `ok` | 预警链路在本次压测中真实触发并自动恢复 |
| **③ 阶段耗时 P50/P95/P99** | `batch_performance_log` 的 `percentile_cont`（近 24h） | 见上文"阶段耗时 P50/P95/P99"表：解析 P95≈939ms、规则 P95≈134ms、校验 P95≈43ms、写入 P95≈613ms | 四阶段独立计时，非估算 |
| **④ 错误分布** | `import_task_errors` 按 `error_code` 分组 | **E001 非法SKU 120 / E003 非法电话 30 / E004 非正数量 20**，合计 170 | 与预埋错误逐类精确吻合 |
| 慢批次 TOP10（增强） | `batch_performance_log` 按 `total_duration_ms` 倒序 | unit_001 1873ms > unit_003 640ms > unit_002 500ms > unit_004 378ms > unit_005 28ms | 首批含解析冷启动，符合预期 |
| 失败任务趋势（增强） | `import_tasks` 按天聚合失败数 | 压测窗口内 0 条 `FAILED` 终态 | 无 5xx、无批次耗尽重试 |

**机器可读证据**：`scripts/loadtest.mjs` 在任务达终态后自动拉取一次 `/api/import-monitor/summary`，将上述四大区完整快照（含 `throughput`、`queueDepth`、`stagePercentiles`、`errorDistribution`、`slowBatches`、`failedTaskTrend`、`peak_throughput_rows_per_min`）写入 `test-data/loadtest-report.json` 的 `monitor_summary` 字段；同时将实际批次口径写入 `observed_batching` 字段（批次数、单批行数、最大单批行数、重试批次数），用运行时观测值取代文档写死的批大小，避免口径歧义。重跑 `npm run loadtest` 即可再生成该证据，无需人工截图。

### 稳定性增强（本轮优化记录）

1. **上传幂等窗口**：60 秒内同文件哈希的活跃任务直接复用返回（`reused_task: true`），杜绝跨洋网络请求重放产生孪生任务；
2. **压测前静默**：loadtest 先把未终态任务及其批次/Outbox 标记失败再清理数据，避免前序任务延迟批次污染本轮结果；
3. **解析缓存 LRU**：上限 3 个任务，防止实例内存膨胀。
4. **调度模型演进**：早期仅依赖单一 `after()` 后台调度，实测 Vercel Hobby 计划的挂起实例会持有调度租约并阻塞后续循环（造成 90s 停滞）。最终收敛为**三路径互补**：① 上传接口 `after()` 触发 `POST /api/import-dispatcher`（主路径，零延迟）；② 调度端点单轮预算 30 批 / 50s，结束时仍有积压则 `after()` 自链续跑至清空；③ 任务进度轮询在响应前**内联**执行一轮调度（停滞门控：仅当无批次正在处理时，预算 1 批 / 2.5s，请求生命周期内必然释放租约，"只要有人看进度就推进"），彻底规避挂起实例长期持租约的风险。`vercel.json` cron 与本地 `scripts/worker-loop.mjs` 作为宕机/冻结兜底；租约 TTL 30s 仅作崩溃保护。

## 结论与已知瓶颈

1. **结论**：10,000 行全链路 11 秒（≤60s 目标的 18%），无 5xx，错误数与预埋完全一致，行级错误可定位、可导出、可检索。10,000 单/分钟目标达成，实测吞吐约 55,000 行/分钟。
2. **已知瓶颈 1**：首批仍需完整读文件+解析（~1s）。若进一步提升，可在上传事务后增加 prepare 阶段把解析结果分片持久化，本次为控制复杂度未做。
3. **已知瓶颈 2**：全局单处理器串行消费。10k 行规模下余量充足；吞吐目标提升至 5 万单/分钟时，应改为受控并发（租约分片 + 并发度上限）并升级数据库规格，详见重构假设说明第 12 节。
4. **已知瓶颈 3**：Vercel Hobby 函数 maxDuration 60s，单轮调度预算受其约束（调度端点 50s、轮询内联 2.5s 停滞门控）；通过"上传 after() 触发 + 调度端点自链 + 轮询自愈 + cron 兜底"四重路径保证任务最终完成。

## 复现命令

```bash
npm run seed     # 幂等：20,000 SKU + 10,000 行压测 Excel（含 170 预埋错误）
npm run loadtest -- --base-url https://0807v4.vercel.app
# 报告输出：test-data/loadtest-report.json
#   ├─ monitor_summary   监控看板四大区快照（吞吐/积压预警/阶段分位/错误分布 + 慢批次 + 失败趋势）
#   ├─ observed_batching 运行时批次口径（批次数/单批行数/最大单批行数/重试批次数）
#   └─ batch_performance 各处理单元四阶段耗时明细
```
