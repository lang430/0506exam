# V4 专项考核：需求拆分与开发任务清单

> 依据：`exam-v4-v2-async-event-driven-observability.md`（V4.0，2026/08/03）
> 目标项目：V2「万能导入解析系统」`D:\AI\0506exam`
> 建议时长 180 分钟，总分 100 分

---

## 〇、范围限定声明（最高优先级）

**本次考核范围**（仅 V2 下单主链路重构）：

文件上传 → 文件解析 → 规则引擎 → 数据校验 → 批量落库 → 任务进度追踪 → 错误定位 → 监控告警

**明确不做**（范围外，不投入精力）：

- V3 审批流程
- 异常工单状态机
- 品控暂扣
- 赔付审批
- 跨系统 Saga 分布式事务

**边界纪律**：

- `D:\AI\0702`（V3 项目）不做任何修改。
- V2 现有 `/api/v1/*` 契约接口（v3-contract、middleware Bearer 鉴权）是 V3 读取运单数据的通道，**不能破坏**，重构时保持其行为兼容。
- 不重写 V2 业务规则：解析规则引擎、字段映射、AI 生成规则能力必须复用，禁止另起硬编码解析。
- 不为压测文件/指定文件写死解析逻辑、固定行号、固定 SKU（作弊红线）。
- 提交代码中不得包含真实 API Key、数据库密码、Redis 连接串。

---

## 一、考核目标与分值分布

| 考点 | 分值 | 核心验收 |
|---|---:|---|
| 1. 异步事件驱动架构 | 20 | 上传 P95≤1s 返回 task_id；Outbox 同事务可靠投递；队列/Worker 重试；状态机准确 |
| 2. 批量处理与性能（核心） | 25 | 10,000 行全链路 ≤60s；复用规则引擎；批量校验 + 批量写入（禁止逐行） |
| 3. 幂等/重试/恢复（核心） | 15 | task_id+unit_id 重复消费不重复入库；卡死恢复；partial_success；重复上传策略 |
| 4. 错误精细化 | 10 | 行级错误表（批次/行号/字段/原始值/错误码/原因）；前端筛选分页；敏感脱敏 |
| 5. 全链路可观测（核心） | 20 | traceId 穿透；监控看板 4 区域；Trace 时间线检索；阶段性能日志；告警 |
| 6. 容灾降级与容量 | 5 | SKU 校验超时降级 + 明示；容量推导文档；清理策略 |
| 7. 提交质量 | 5 | README；自动化测试；代码质量 |

**量化硬指标**：

| 指标 | 目标 |
|---|---|
| 上传接口响应 | P95 ≤ 1 秒（只返回 task_id，不等处理） |
| 吞吐 | ≥ 10,000 单/分钟（10,000 行任务创建→入库完成 ≤ 60s） |
| 前端进度刷新 | ≤ 2 秒可见变化 |
| MTTD 故障定位 | ≤ 1 分钟（task_id/trace_id/行号 → 批次/字段/原始值/原因） |
| SKU 主数据 | ≥ 20,000 条 |
| 压测文件 | ≥ 10,000 行 |

**0 分红线**：无在线部署；无 20,000 SKU 灌入脚本；无 10,000 行压测 Excel；仍同步逐行 INSERT；写死解析逻辑；泄露真实密钥。

**≤50 分线**：上传超 1 秒；无队列/异步任务系统；无批量校验写入；无行级错误；无监控/Trace。

AI 大模型仅可辅助错误摘要/规则生成，**不得成为主链路成功的必要条件**，耗时不计入压测指标。

---

## 二、现状盘点（V2 与 V4 要求的差距）

### 2.1 当前 V2 同步链路

- 文件解析在**浏览器端**完成（@e965/xlsx / mammoth / pdfjs-dist），服务端拿不到原始文件。
- 规则执行、校验都在前端（`parseByRule` / `validateRows`）。
- 提交走 `POST /api/orders`：前端把全部行 JSON 一次性发给服务端，单事务 200 行一批 INSERT——本质仍是"一次请求完成全部写入"的同步模型。
- 无 SKU 主数据概念，无行级错误表，无任务/批次模型，无 trace，无监控页。

### 2.2 可直接复用的资产

| 资产 | 复用方式 |
|---|---|
| `lib/rule-engine.ts`（parseByRule/validateRows） | 纯 TS 同构代码，Worker 内直接复用，满足"不重写规则引擎"要求 |
| `lib/types.ts` | ParseRule/OrderRow 等类型沿用 |
| `/api/rules` + parse_rules 表 | 原样复用，上传接口接收 ruleId |
| `/api/ai-rules` | 保留，不在主链路，不计压测指标 |
| imported_orders 表 | 即题面所称 waybills 运单主表，需补 line_no 与业务去重唯一键，不破坏已有字段语义 |
| `/api/v1/*` + middleware | V3 契约通道，保持不动 |
| globals.css 鲸天风格（#0fc6c2） | 新增页面沿用同一设计语言 |
| exceljs 依赖 | 用于生成 10,000 行压测 Excel |

### 2.3 必须新建的能力

- 文件服务端存储（上传原始文件，供 Worker 复读）
- 7 张新表 + 索引（见任务 T1）
- 上传即返回的 `POST /api/import-tasks`
- Outbox + Dispatcher 可靠投递
- 队列 + Worker（批量校验/批量写入/幂等/重试）
- 任务进度、错误明细、批次性能、Trace、监控聚合共 6 组 API
- 前端 4 类新页面：任务列表/任务详情进度、错误明细、监控看板、Trace 检索
- 降级模式（SKU 校验超时 3s）
- seed 脚本、压测脚本、压测报告、自动化测试、4 份文档

---

## 三、模块需求拆分（11 个模块 → 开发任务）

### 模块一：压测数据自动准备（强制）→ T6

- `scripts/seed-data.ts` 一键执行：清理并灌入 ≥20,000 条 SKU（SKU_00001~SKU_20000，含名称/规格/单位）；生成 ≥10,000 行压测 Excel（如 `test-data/10000-orders.xlsx`），SKU 从主数据随机抽取，**故意混入少量非法 SKU**（用于验证 E001 错误定位）。
- 验收：可重复执行、无脏数据膨胀、README 说明命令与清理策略。

### 模块二：上传即返回 + 异步任务 → T2

- 接收文件 + 解析规则 ID；生成 task_id + trace_id；保存原始文件（或可复读引用）；预扫描得到总行数；创建 import_tasks；按处理单元写 Outbox 事件；**1 秒内返回** `{task_id, trace_id, status, total_rows, total_batches}`。
- 禁止上传接口同步跑完整导入；按钮防重复；重复上传去重策略需在设计说明中写明。
- 注意：10,000 行 Excel 的"预扫描总行数"本身有耗时风险，需设计轻量方案（见决策点 D4）。

### 模块三：Outbox 投递与入队 → T3

- 任务创建 + Outbox 写入**同一数据库事务**。
- Dispatcher 轮询 event_outbox 投递到队列；状态 pending/sent/failed；失败重试记 retry_count；宕机恢复后能续投；重复投递 Worker 幂等。
- **禁止**只在接口里直接 queue.add 而无本地可靠事件记录。

### 模块四：Worker 异步处理 → T4

单 Job 流程：读处理单元数据 → 复用 V2 规则引擎（字段映射/类型转换/默认值/跨行聚合）→ 收集 SKU 批量查 sku_master → 校验（必填/电话/数量正数/外部编码重复）→ 成功行批量 UPSERT → 失败行写 import_task_errors → 写 batch_performance_log → **原子**更新任务进度（不重复累计）→ 全部批次完成后汇总任务状态。

状态机：pending → processing → completed / partial_success / failed。

### 模块五：幂等与重复保护 → T4/T5

- task_id + batch_index/shard_id/message_id 重复消费不重复写入、不重复累计进度。
- UPSERT 基于稳定业务键：`external_order_no + sku_code + line_no`。
- 已完成处理单元再次消费时快速返回。

### 模块六：精细化错误 → T4/T5/T7

- import_task_errors 字段：task_id、batch_index、row_number（文件全局行号）、field_name、raw_value（脱敏）、error_code、error_reason、trace_id、created_at。
- 错误码：E001 SKU不存在、E002 必填缺失、E003 电话格式、E004 数量非正、E005 外部编码重复、E006 规则映射失败、E007 数据库写入失败、E008 文件格式不支持。
- 前端：按批次/错误类型筛选、分页、点击看原始值+原因+修复建议；禁止只显示"导入失败，请重试"。

### 模块七：任务进度与结果页 → T5/T7

- 展示：文件名、task_id、trace_id、状态、总行数、已处理、成功、失败、总批次、已完成批次、当前吞吐量、预计剩余时间、最近错误摘要、是否降级校验、导出失败明细。
- 轮询 1~2 秒或 SSE。

### 模块八：监控看板 → T8

4 个必备区域：

1. 实时吞吐量：过去 5 分钟每分钟成功入库行数（折线/柱状，真实聚合）。
2. 队列积压深度：等待批次数/行数；>5000 行橙色预警；队列不可用红色告警。
3. 阶段耗时分布：解析/规则/校验/写入的 P50、P95、P99。
4. 错误类型分布：各错误码占比，可跳转错误明细。

加分：慢批次 TOP10、失败任务趋势、连接数/并发展示、钉钉告警。

### 模块九：全链路 Trace 检索 → T8

- 搜索条件：task_id、trace_id、文件名、批次号、行号范围、错误码。
- 结果按时间线展示（上传→Outbox→入队→Worker 开始→校验→写入→完成）。
- 点击失败节点展示：批次号、行号、字段名、脱敏原始值、错误码、原因、所属规则、阶段耗时、是否重试、下一步建议。

### 模块十：容灾降级 → T9

- SKU 主数据查询超时 >3s 或连接短暂失败 → 降级：跳过 SKU 主数据校验，仅做本地格式校验。
- 降级不得静默：任务详情页固定警示文案；降级状态写任务记录与监控日志；记录哪些行未经 SKU 校验；服务恢复后新任务自动恢复；补校验策略在设计说明中说明。

### 模块十一：《重构假设说明》（强制）→ T10

12 个必答点：为何异步、处理单元大小设计、Worker 容量规划、万单/分钟推导、连接池与并发控制、Outbox 防丢消息、Job 幂等、部分失败为何成功行继续入库、降级触发条件、敏感数据脱敏、压测数据生成与清理、向产品/运维的提问。

---

## 四、数据模型任务 → T1

新增表（含题面 7.3 索引要求）：

| 表 | 关键字段 | 索引 |
|---|---|---|
| sku_master | sku_code unique, name, spec, unit | sku_code 唯一 |
| import_tasks | status, total/processed/success/failed_rows, total_batches, trace_id, degraded, completed_at | (status, created_at) |
| import_task_batches | task_id, unit_id, batch_index, start_row, end_row, status, retry_count, locked_at, completed_at | (task_id, unit_id) 唯一 |
| import_task_errors | task_id, unit_id, batch_index, row_number, field_name, raw_value, error_code, error_reason, trace_id | (task_id, unit_id)、(error_code) |
| event_outbox | aggregate_id, event_type, payload, status, retry_count, next_retry_at, sent_at | (status, next_retry_at) |
| batch_performance_log | parse/rule/validate/insert/total_duration_ms, status, trace_id | (task_id, unit_id) |
| trace_events | trace_id, task_id, unit_id, event_name, event_status, message, occurred_at | (trace_id, occurred_at) |

复用表改造：

- imported_orders（=题面 waybills）：新增 `line_no`，新增业务唯一键 `(external_code, sku_code, line_no)` 支撑幂等 UPSERT；补 `external_code` 索引（已有）。不破坏已有字段语义与 `/api/v1/*` 输出。
- parse_rules：不动。

事件契约：统一事件信封（event_id/event_type/schema_version/aggregate_id/trace_id/occurred_at/payload）；至少 8 个事件：ImportTaskCreated、ImportBatchCreated、ImportBatchStarted、ImportBatchSucceeded、ImportBatchFailed、ImportTaskCompleted、ImportTaskPartialSuccess、ImportTaskDegraded；schema_version 版本策略写入 README。

---

## 五、接口任务 → T5

| 接口 | 说明 |
|---|---|
| `POST /api/import-tasks` | multipart 上传文件+ruleId，创建任务+Outbox，≤1s 返回 task_id |
| `GET /api/import-tasks/:taskId` | 进度查询（状态/行数/批次/降级） |
| `GET /api/import-tasks/:taskId/errors?batch&error_code&page&page_size` | 错误明细分页筛选 |
| `GET /api/import-tasks/:taskId/batches` | 批次性能 |
| `GET /api/traces/:traceId` | Trace 时间线 |
| `GET /api/import-monitor/summary` | 监控聚合（吞吐/积压/阶段耗时/错误分布） |

鉴权边界：新接口默认与 V2 页面同域开放；`/api/v1/*` 的 Bearer 鉴权保持不动。

---

## 六、开发任务清单（分阶段）

### 阶段 P0：环境与前置（阻塞项）

- **T0.1** 确认凭据与账号：Vercel 登录态、Postgres（沿用 Supabase）、队列服务（见决策点 D1）、文件存储（D2）、Worker 部署平台（D3）。
- **T0.2** V2 项目 `git init` + 远端仓库（提交物硬要求）。
- **T0.3** 验证现网部署链路：`vercel` 部署当前 V2 可访问（先拿到基础在线地址，避免 0 分红线）。

### 阶段 P1：数据层

- **T1.1** 编写 V4 增量 SQL（7 张新表 + 索引 + imported_orders 改造），并入 database.sql，Supabase 执行验证。
- **T1.2** 事件信封与 8 个事件的 TS 类型定义（schema_version=1）。

### 阶段 P2：上传即返回

- **T2.1** 文件存储服务封装（按 D2 决策实现上传/读取抽象）。
- **T2.2** `POST /api/import-tasks`：multipart 接收 → 存文件 → 生成 task_id/trace_id → 单事务写 import_tasks + event_outbox（按处理单元拆分）→ 立即返回。
- **T2.3** 总行数方案落地（D4）：轻量预扫描或首批次回填，确保上传 P95≤1s。
- **T2.4** 重复上传去重策略实现 + 文档说明（如文件哈希查重）。

### 阶段 P3：Outbox 与队列

- **T3.1** Dispatcher：轮询 event_outbox（status=pending 且 next_retry_at 到期）→ 投递队列 → 标记 sent/failed + retry_count；支持宕机恢复续投。
- **T3.2** Dispatcher 触发机制（Vercel Cron 定时调用 / 常驻 Worker 内循环，随 D1/D3 决策）。
- **T3.3** 事件信封序列化与消费者幂等入口。

### 阶段 P4：Worker 核心链路（核心考点 2/3）

- **T4.1** Worker 骨架：消费 Job → 按 task_id+unit_id 领取批次（状态锁/乐观锁，防并发重复领取）。
- **T4.2** 读取原始文件对应行段（start_row~end_row），服务端复用 `parseByRule` 执行规则引擎。
- **T4.3** 批量 SKU 校验：收集本单元 SKU 去重后 `IN` 查询 sku_master（禁止逐行），3s 超时接降级开关。
- **T4.4** 批量校验：复用 validateRows 语义（必填/电话/数量/外部编码重复），映射错误码 E001~E008。
- **T4.5** 批量写入：成功行按 `(external_code, sku_code, line_no)` 批量 UPSERT（200~500/批，事务），禁止逐行 INSERT。
- **T4.6** 失败行写 import_task_errors（raw_value 脱敏：手机号中间 4 位掩码、地址截断打码）。
- **T4.7** 写 batch_performance_log（解析/规则/校验/写入/总耗时）。
- **T4.8** 原子进度更新：仅在批次状态"首次转 completed"时累加 processed/success/failed（防重试重复累计）。
- **T4.9** 幂等保护：已完成批次重复消费直接返回。
- **T4.10** Job 重试配置（可重试错误次数上限）+ 卡死恢复（定时扫描 locked_at 超时的 processing 批次，重置或标失败）。
- **T4.11** 任务终态聚合：全批次完成后汇总 completed / partial_success / failed。
- **T4.12** trace_events 埋点贯穿全流程（trace_id 穿透 API→Outbox→Queue→Worker→DB）。

### 阶段 P5：查询接口与前端

- **T5.1** 6 组查询 API（进度/错误/批次/Trace/监控聚合）。
- **T5.2** 任务列表 + 任务详情页：1~2s 轮询，展示 15 项进度字段 + 吞吐量 + 预计剩余时间 + 降级警示 + 失败明细导出（Excel）。
- **T5.3** 错误明细视图：批次/错误码筛选、分页、原始值+原因+修复建议。
- **T5.4** 监控看板：吞吐折线、积压预警（橙/红）、阶段耗时 P50/P95/P99、错误分布（可跳转）。
- **T5.5** Trace 时间线检索页：多条件搜索 + 时间线渲染 + 失败节点详情。
- **T5.6** 旧工作台（预览/编辑/手动提交）保留不破坏，新异步链路作为文件导入主入口（见决策点 D5）。
- **T5.7** 上传按钮防重复点击；UI 沿用 #0fc6c2 鲸天风格。

### 阶段 P6：容灾降级

- **T6.1** SKU 查询 3s 超时触发降级：task.degraded=true、ImportTaskDegraded 事件、前端固定警示文案。
- **T6.2** 记录未经 SKU 校验的行清单；恢复后新任务自动正常校验；补校验策略写入假设说明。

### 阶段 P7：压测数据与压测

- **T7.1** `scripts/seed-data.ts`：幂等清理 + 20,000 SKU 灌入（批量，控时）+ 生成 10,000 行压测 Excel（含少量非法 SKU）。
- **T7.2** 压测脚本（k6 或 Node）：上传 10,000 行文件 → 记录上传响应时间 → 轮询至完成 → 统计总耗时/成功/失败/500/504 → 判定 ≤60s。
- **T7.3** 压测报告：时间、环境、Worker 并发、连接池、SKU 数、行数、上传 P95、总耗时、单元 P50/P95、校验/写入耗时、错误率、连接数证据、看板截图、结论与瓶颈。

### 阶段 P8：测试与文档

- **T8.1** 引入测试框架（vitest）+ 12 项必测场景：上传 1s 返回、任务+Outbox 同事务、Dispatcher 恢复投递、Worker 成功执行、重复消费幂等、SKU 批量校验、部分失败成功行入库、错误按行记录、终态聚合、降级触发、Trace 时间线、非法 task_id 保护。
- **T8.2** README：本地启动、环境变量、部署、压测、故障模拟、清理策略、事件版本策略。
- **T8.3** 《重构假设说明》12 点全覆盖。
- **T8.4** 架构设计文档：异步流程图、Outbox、批量策略。
- **T8.5** 接口文档：6 组接口示例。
- **T8.6** 容量推导文档（4.3 要求 6 项：数据量/处理单元/并发模型/数据库压力/失败成本/性能结论）。

### 阶段 P9：部署验收

- **T9.1** 全量部署（Vercel + Worker 平台），环境变量配置（全部走环境变量，零硬编码密钥）。
- **T9.2** 对照评分表逐项自测（尤其 0 分红线与 ≤50 分线清单）。
- **T9.3** 回归确认 `/api/v1/*` 契约不受影响（V3 依赖，范围外但不可破坏）。

---

## 七、关键技术决策点（需确认）

| # | 决策点 | 选项 | 倾向 |
|---|---|---|---|
| D1 | 消息队列 | A. QStash（Serverless 原生，HTTP 推送，自带重试/死信，Vercel Marketplace 可集成）；B. BullMQ + Upstash Redis + 常驻 Worker；C. Inngest / Trigger.dev | A 最贴合 Vercel 无常驻进程环境；B 控制力最强但需额外部署 Worker |
| D2 | 原始文件存储 | A. Supabase Storage（已有数据库账号）；B. Vercel Blob；C. Postgres bytea | A/B 均可；C 最省事但大文件不推荐 |
| D3 | Worker 部署位置 | A. Vercel Serverless（配合 QStash 回调，无需常驻）；B. Railway/Render/Fly 常驻进程（题面允许，README 说明） | 随 D1 联动 |
| D4 | 上传 1s 内的总行数 | A. 上传时轻量预扫描（Excel 只读 sheet 行数）；B. 先建任务 total_rows=0，由首个 Worker 阶段回填 | 压测实测后定；A 体验好但有超时风险 |
| D5 | 新旧链路关系 | A. 新异步链路为主入口，旧预览/编辑流保留为手动通道；B. 完全替换 | 倾向 A，不破坏 V2 已有能力 |
| D6 | 重复上传策略 | A. 文件哈希相同且未过期则拒绝/返回已有任务；B. 允许重复并靠业务键幂等兜底 | A+B 组合 |
| D7 | 处理单元大小 | 500/1000/2000 行一批，动态分片 | 初步 1000 行/批 × 10 批，压测后调优，写入假设说明 |

---

## 八、提交物清单（对照题面十三章）

1. Vercel 在线 URL
2. 源码仓库（GitHub/GitLab/Gitee）
3. 20,000 SKU 灌入脚本
4. 10,000 行压测 Excel 文件
5. 压测报告（证明 ≤60s）
6. 架构设计文档（异步流程图、Outbox、批量策略）
7. 《重构假设说明》（模块十一 12 点）
8. 接口文档（上传/任务/错误/Trace/监控）
9. README（启动/环境变量/部署/压测/故障模拟）
10. 演示账号或访问说明（导入页、任务页、监控页）

---

## 九、主要风险

1. **凭据缺口**：Vercel 登录态、队列服务、对象存储凭据当前均未就绪（V2 遗留），P0 不解决则 0 分红线无法解除。
2. **上传 1 秒指标**：10,000 行 Excel 上传体积 + 预扫描可能逼近 1s，需要实测并准备"先返回后回填 total_rows"的备选。
3. **Serverless 环境约束**：Vercel 函数不能常驻，Dispatcher/Worker 的触发机制必须选 Serverless 友好方案（QStash/Cron）或外置常驻进程。
4. **规则引擎服务端化**：当前解析在浏览器端，Worker 复用 `parseByRule` 本身无障碍（纯函数），但文件读取（@e965/xlsx/mammoth/pdfjs Node 端）需验证 bundle 兼容性。
5. **进度原子累计**：重试场景最容易重复累计 processed_rows，必须把"批次状态首次完成"作为唯一累计触发点。
6. **不可破坏 V3 契约**：imported_orders 表结构改动（加 line_no/唯一键）需保证 `/api/v1/*` 输出不变。

---

## 十、80 分（高级工程师）得分策略

达标定义（题面十二章）：**核心链路完整，性能基本达标；允许少量监控或降级细节缺漏。**

### 10.1 逐考点目标得分（合计 ≈84，留 4 分缓冲）

| 考点 | 满分 | 目标 | 策略 |
|---|---:|---:|---|
| 1 异步事件驱动架构 | 20 | 18 | 五项全做：上传即返回、任务模型、Outbox 同事务+宕机恢复、队列/Worker 重试、状态机 |
| 2 批量处理与性能 | 25 | 22 | 核心，全做；压测 ≤60s 必须实测通过（超时该项只剩 3 分） |
| 3 幂等/重试/恢复 | 15 | 13 | 全做；重复上传策略用"文件哈希查重 + 业务键幂等兜底"并写入文档 |
| 4 错误精细化 | 10 | 9 | 全做；修复建议用错误码→建议文案映射表实现 |
| 5 全链路可观测 | 20 | 15 | traceId 穿透、看板 4 区域、Trace 时间线、性能日志全做；告警仅做看板内橙/红预警，不接钉钉 |
| 6 容灾降级与容量 | 5 | 3 | 降级触发+前端警示+容量推导+清理策略；降级任务补校验只说明不实现 |
| 7 提交质量 | 5 | 4 | README、关键链路测试、类型完整 |

### 10.2 战略性裁剪（80 分允许缺漏项）

- 监控加分项：慢批次 TOP10、失败任务趋势、钉钉机器人告警——不做（看板内保留阈值预警即可拿告警分）。
- 降级任务的后续补校验——假设说明中说明策略即可，不实现。
- SSE 推送——用 1~2s 轮询（题面明确允许）。
- V2 预览编辑页不做重构——V4 范围是下单主链路，旧工作台保留能用即可。

### 10.3 红线防御清单（每项都有归口任务）

| 红线 | 防御措施 | 归口 |
|---|---|---|
| 无在线部署 = 0 分 | Vercel 已登录、项目已关联，最终 `vercel --prod` 并实测首页/接口 | T9/P11 |
| 无 20,000 SKU 脚本 = 0 分 | scripts/seed-data.ts 幂等可重跑 | T7 |
| 无 10,000 行压测 Excel = 0 分 | seed 脚本生成 test-data/10000-orders.xlsx 并提交仓库 | T7 |
| 同步逐行 INSERT = 0 分 | 上传接口只建任务+Outbox；Worker 批量 UPSERT；代码评审自查 | T2/T4 |
| 写死解析逻辑 = 0 分 | 压测文件同样通过 parse_rules 规则引擎解析；seed 同时灌入"压测标准表"规则 | T7 |
| 泄露真实密钥 = 0 分 | .gitignore 已覆盖 .env*.local；所有凭据走 Vercel 环境变量；提交前 `git diff` 自查 | 全程 |
| 上传 >1s / 无队列 / 无批量 / 无行级错误 / 无监控 = ≤50 分 | 对应考点 1/2/4/5 任务为最高优先级 | T2/T4/T5/T8 |

### 10.4 执行顺序（按得分密度）

1. **P1 数据层**（T1）——一切的地基。
2. **P2 公共库**（T1.2/P2）——事件信封、trace、脱敏、队列与存储抽象。
3. **P3 上传即返回**（T2）——考点 1 的 5 分 + 红线。
4. **P4 Dispatcher + Worker**（T3/T4）——考点 2/3 共 40 分的主体，最高得分密度。
5. **P5 查询 API**（T5）——前端与压测的数据出口。
6. **P6 前端四页**（T5.2~T5.5）——考点 4/5 的展示载体。
7. **P7 降级**（T6）——2 分但实现便宜。
8. **P8 seed + 压测**（T7）——0 分红线交付物 + 考点 2 的 6 分实证。
9. **P9 自动化测试**（T8.1）——考点 7 的 2 分。
10. **P10 文档四件**（T8.2~T8.6）——假设说明为强制提交物。
11. **P11 部署验收**（T9）——0 分红线收口 + /api/v1 回归。
