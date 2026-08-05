# 万能导入 V4：下单主链路异步事件驱动重构

## 📋 提交物清单（强制，点击跳转到对应文件）

| # | 提交物 | 对应文件 / 地址（点击跳转） | 说明 |
|---|---|---|---|
| 1 | 在线地址（Vercel 可访问 URL） | [https://0807v4.vercel.app/tasks](https://0807v4.vercel.app/tasks) | 生产部署，公开可访问 |
| 2 | 源码仓库（GitHub / GitLab / Gitee） | [github.com/lang430/0807exam](https://github.com/lang430/0807exam) | 已推送，英文命名 |
| 3 | 压测数据脚本（生成 20,000 条 SKU 主数据） | [scripts/seed-data.ts](scripts/seed-data.ts) | `npm run seed` 幂等 |
| 4 | 10,000 行压测 Excel 文件 | [test-data/10000-orders.xlsx](test-data/10000-orders.xlsx) | 含 170 个预埋错误 |
| 5 | 压测报告（证明 10,000 行总耗时 ≤ 60s） | [docs/load-test-report.md](docs/load-test-report.md) · [原始 JSON](test-data/loadtest-report.json) | 端到端 11s，服务端 ≤400ms |
| 6 | 架构设计文档（异步流程图 / Outbox / 批量策略） | [docs/architecture-design.md](docs/architecture-design.md) | 完整 |
| 7 | 《重构假设说明》（覆盖第六章模块十一要求） | [docs/refactoring-assumptions.md](docs/refactoring-assumptions.md) | 完整 |
| 8 | 接口文档（上传 / 任务 / 错误 / Trace / 监控聚合） | [docs/api-documentation.md](docs/api-documentation.md) | 完整 |
| 9 | README（本地启动 / 环境变量 / 部署 / 压测 / 故障模拟） | [README.md](README.md) | 本文件 |
| 10 | 演示账号或访问说明（导入页 / 任务页 / 监控页） | [DELIVERABLES.md · Access Notes](DELIVERABLES.md#access-notes) | 全页面公开，无需账号 |

> 全部交付物索引另见 [DELIVERABLES.md](DELIVERABLES.md)；V2 大模型调用说明见 [SUBMISSION-NOTES.md](SUBMISSION-NOTES.md)。

V2「万能导入解析系统」的生产级重构：把同步阻塞式下单链路改造为**异步事件驱动 + 批量处理 + 全链路可观测**的导入链路。10,000 行运单从任务创建到入库完成 **11 秒**（目标 ≤60s），上传接口服务端处理 **150~400ms**（目标 P95 ≤1s）。

- 在线地址：https://0807v4.vercel.app/tasks
- **交付物清单**：`DELIVERABLES.md`（十项提交物索引，英文命名）
- 文档：`docs/` 目录 —— refactoring-assumptions（重构假设说明）/ architecture-design（架构设计）/ api-documentation（接口文档）/ load-test-report（压测报告）/ v4-task-breakdown（需求拆分）
- V2 大模型调用说明：`SUBMISSION-NOTES.md`

## 数据交付物（20,000 条 SKU 主数据 + 10,000 行压测 Excel）

### 1. 压测数据脚本（生成 20,000 条 SKU 主数据）

- 文件：[`scripts/seed-data.ts`](scripts/seed-data.ts)（题面模块一强制交付物）
- 执行：`npm run seed`（幂等，可重复执行，不产生脏数据）
- 作用：
  1. 清理旧压测数据（`SKU_` 前缀主数据 + `LT` 前缀运单，可选 `--deep` 清空全部 V4 运行数据）；
  2. 灌入 **20,000 条 SKU 主数据**（`SKU_00001` ~ `SKU_20000`，含名称/规格/单位），批量 2000/批；
  3. 灌入压测专用解析规则（走 `parse_rules` 规则引擎，不硬编码解析）；
  4. 生成 10,000 行压测 Excel（见下）。
- 依赖：需配置数据库连接（`DATABASE_URL` / `POSTGRES_URL` 等，见「环境变量」）。

### 2. 10,000 行压测 Excel 文件

- 文件：[`test-data/10000-orders.xlsx`](test-data/10000-orders.xlsx)
- 结构：单 Sheet「压测运单」，10 列，含表头共 10,001 行 = **10,000 行数据**（已用 ExcelJS 校验：数据行数 = 10,000）。
- 列：`外部编码` / `收货门店` / `收件人姓名` / `收件人电话` / `收件人地址` / `SKU物品编码` / `SKU物品名称` / `SKU发货数量` / `SKU规格型号` / `备注`。
- 数据来源：SKU 从 20,000 条主数据随机抽取；外部编码 `LT-A00001` 起，每单 5 行。
- 预埋错误（脚本配置，用于验证错误定位能力）：非法 SKU ×120（E001）、非法电话 ×30（E003）、非正数量 ×20（E004），共 **170**。
- 重新生成：`npm run seed`（需数据库；脚本 [`scripts/seed-data.ts`](scripts/seed-data.ts) 第 4 步产出）。

> 说明：仓库提交的 `10000-orders.xlsx` 已包含 10,000 行数据；若需确保预埋错误为完整 170 条（120+30+20），重新执行 `npm run seed` 即可按脚本逻辑重新生成。

## 功能地图

| 页面/入口 | 说明 |
|---|---|
| `/` | V2 导入工作台（预览编辑 + 手动/同步提交，保留不动） |
| `/tasks` | 异步导入：上传文件 + 选规则 → 立即返回 task_id；任务列表 3s 刷新 |
| `/tasks/[id]` | 任务详情：进度条、吞吐、ETA、降级警示、错误明细筛选分页、失败明细 CSV 导出、批次执行情况（1.5s 轮询，轮询即自愈） |
| `/monitor` | 监控看板：实时吞吐、队列积压预警、阶段耗时 P50/P95/P99、错误类型分布 |
| `/traces` | 全链路 Trace 检索：task_id/文件名/错误码/行号范围 → 时间线 + 失败节点详情 |

## 本地启动

```bash
npm install
# 配置 .env.local（POSTGRES_URL 等数据库变量 + DISPATCHER_TOKEN）
npm run dev          # http://127.0.0.1:3000
```

注意：本地运行时服务端数据库查询受跨洋延迟影响，接口耗时不代表生产水平（生产 Vercel 与 Supabase 同区，上传服务端处理 <400ms）。

## 环境变量

全部通过 Vercel Environment Variables 配置，仓库不含任何真实密钥（`.env*.local` 已 gitignore）。

| 变量 | 说明 |
|---|---|
| POSTGRES_URL / POSTGRES_PRISMA_URL / POSTGRES_URL_NON_POOLING / DATABASE_URL | Postgres 连接串（按此优先级读取；生产用 Supabase Pooler 6543） |
| DISPATCHER_TOKEN | 调度端点 Bearer 令牌（必配；缺失时调度端点 fail-closed 返回 401） |
| CRON_SECRET | Vercel Cron 调用 `/api/import-dispatcher` 的 Bearer 令牌（必配，否则每日 cron 兜底 401 不执行） |
| V4_BATCH_SIZE | 处理单元行数（默认 500；Vercel Hobby 建议保持 500 避免单批被 10s 硬上限 kill；本次压测/生产部署设为 2500，见压测报告） |
| V4_SKU_CHECK_TIMEOUT_MS | SKU 主数据查询超时（默认 3000，超时触发降级） |
| V4_STUCK_BATCH_SECONDS | 卡死批次恢复窗口（默认 30s；Hobby 下函数被 kill 后在此时间内回收重试） |
| V4_DISPATCHER_LEASE_SECONDS | 调度租约 TTL（默认 15s，必须 < stuck 阈值） |
| V4_DISPATCHER_BUDGET_MS | Dispatcher 端点单轮时间预算（生产 9000ms，Hobby 下必须 < 10s） |
| V4_DISPATCHER_MAX_BATCHES | Dispatcher 端点单轮最大批次数（默认 6，可覆盖 5 个有效批次和空尾批） |
| V4_DISPATCHER_TRIGGER_TIMEOUT_MS | 内部调度 HTTP 触发超时（默认且最高 10000ms，防止后台阻塞拖垮上传响应） |
| V4_QUEUE_BACKLOG_WARN_ROWS | 队列积压橙色预警阈值（默认 1000） |
| V2_API_TOKEN | V3 契约接口鉴权令牌（V2 既有，勿动） |
| AI_API_KEY / AI_BASE_URL / AI_MODEL | V2 AI 规则生成（可选，不在 V4 主链路） |

数据库初始化：应用层首次访问自动幂等建表（`lib/v4/schema.ts`）；手工执行可用 `database.sql`（V2）+ `database-v4.sql`（V4 增量）。

## 压测与验收

```bash
npm run seed     # 幂等：清理旧压测数据 → 20,000 SKU → 压测规则 → 10,000 行压测 Excel（含 170 个预埋错误）
npm run loadtest -- --base-url https://0807v4.vercel.app   # 压测并输出报告
npm test         # 自动化测试（29 项：纯逻辑 + 数据库集成 + HTTP，覆盖题面 10.1 全部场景）
```

验收步骤：

1. `npm run seed` 后确认 `sku_master` 20,000 条、`test-data/10000-orders.xlsx` 生成；
2. 打开 https://0807v4.vercel.app/tasks 上传压测文件（规则选"压测标准表"），观察 1.5s 级进度刷新；
3. 任务终态 PARTIAL_SUCCESS：成功 9830 / 失败 170（E001×120 + E003×30 + E004×20）；
4. 错误明细按批次/错误码筛选、分页、导出 CSV；`/monitor` 查看吞吐与阶段耗时；`/traces` 按 task_id 查看时间线；
5. `npm run loadtest` 自动完成上述校验并输出 `test-data/loadtest-report.json` 与 `docs/load-test-report.md` 结论。

## 故障模拟

| 故障 | 模拟方式 | 预期行为 |
|---|---|---|
| SKU 校验依赖超时 | 临时设 `V4_SKU_CHECK_TIMEOUT_MS=1` 后上传 | 任务 degraded=true，详情页橙色警示，跳过 E001，其余校验正常（测试场景 10 覆盖） |
| Worker 中断/批次卡死 | 处理中强制结束函数实例 | 2 分钟后卡死批次自动回收重试；任务页轮询触发兜底调度接续 |
| 消息投递失败 | 队列写入异常 | Outbox 指数退避重试，5 次后转死信（status=failed）不丢记录 |
| 重复上传/重复消费 | 同一文件二次上传；重放已完成批次 | 上传返回 duplicate_of 提示；重复消费不重复入库、不重复累计进度（测试场景 5 覆盖） |
| 队列/数据库不可用 | 断开数据库变量 | 监控看板红色告警（503 + alertLevel=critical） |
| 手动兜底 | `curl -X POST -H "Authorization: Bearer $DISPATCHER_TOKEN" https://0807v4.vercel.app/api/import-dispatcher` | 立即执行一轮调度 |

## 清理策略

- 压测运单：`LT` 前缀，loadtest 每轮自动清理；主数据：`SKU_` 前缀，seed 重跑先删后插；
- `npm run seed -- --deep`：额外清空 V4 运行数据（错误明细/性能日志/trace/Outbox/任务）；
- 生产建议：event_outbox 的 sent 记录与 batch_performance_log 按月归档（当前规模无需，见重构假设说明第 11 节）。

## 事件版本策略

事件信封 `schema_version=1`；新增字段向后兼容，消费者必须忽略未知字段（`readPayloadField`）；重大语义变更升级版本号并在 `docs/architecture-design.md` 第 4 节登记。

## 项目结构（V4 新增）

```
lib/v4/           schema 自动迁移 / 事件契约 / 队列与调度 / Worker / 校验 / 脱敏 / 监控聚合 / trace
app/api/import-tasks/     上传（POST）与任务/错误/批次/导出（GET）
app/api/import-dispatcher/ 调度端点（Bearer 鉴权）
app/api/import-monitor/    监控聚合
app/api/traces/            Trace 检索与时间线
app/tasks|monitor|traces/  前端页面（鲸天风格 #0fc6c2）
scripts/seed-data.ts       压测数据准备（强制交付物）
scripts/loadtest.mjs       压测脚本
scripts/worker-loop.mjs    本地常驻调度循环（开发用）
tests/                     29 项自动化测试
database-v4.sql            V4 增量 DDL
docs/                      重构假设说明 / 架构设计 / 接口文档 / 压测报告
```
