# 万能导入 V4：下单主链路异步事件驱动重构

V2「万能导入解析系统」的生产级重构：把同步阻塞式下单链路改造为**异步事件驱动 + 批量处理 + 全链路可观测**的导入链路。10,000 行运单从任务创建到入库完成 **8.6 秒**（目标 ≤60s），上传接口服务端处理 **182~400ms**（目标 P95 ≤1s）。

- 在线地址：https://0506exam.vercel.app
- 提交说明与文档：`docs/` 目录（重构假设说明 / 架构设计文档 / 接口文档 / 压测报告）+ `提交说明.md`（V2 大模型调用说明）
- V4 需求拆分：`V4需求拆分与开发任务.md`

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
| V4_BATCH_SIZE | 处理单元行数（默认 1000，生产 2500） |
| V4_SKU_CHECK_TIMEOUT_MS | SKU 主数据查询超时（默认 3000，超时触发降级） |
| V2_API_TOKEN | V3 契约接口鉴权令牌（V2 既有，勿动） |
| AI_API_KEY / AI_BASE_URL / AI_MODEL | V2 AI 规则生成（可选，不在 V4 主链路） |

数据库初始化：应用层首次访问自动幂等建表（`lib/v4/schema.ts`）；手工执行可用 `database.sql`（V2）+ `database-v4.sql`（V4 增量）。

## 压测与验收

```bash
npm run seed     # 幂等：清理旧压测数据 → 20,000 SKU → 压测规则 → 10,000 行压测 Excel（含 170 个预埋错误）
npm run loadtest -- --base-url https://0506exam.vercel.app   # 压测并输出报告
npm test         # 自动化测试（29 项：纯逻辑 + 数据库集成 + HTTP，覆盖题面 10.1 全部场景）
```

验收步骤：

1. `npm run seed` 后确认 `sku_master` 20,000 条、`test-data/10000-orders.xlsx` 生成；
2. 打开 https://0506exam.vercel.app/tasks 上传压测文件（规则选"压测标准表"），观察 1.5s 级进度刷新；
3. 任务终态 PARTIAL_SUCCESS：成功 9830 / 失败 170（E001×120 + E003×30 + E004×20）；
4. 错误明细按批次/错误码筛选、分页、导出 CSV；`/monitor` 查看吞吐与阶段耗时；`/traces` 按 task_id 查看时间线；
5. `npm run loadtest` 自动完成上述校验并输出 `test-data/loadtest-report.json` 与 `docs/压测报告.md` 结论。

## 故障模拟

| 故障 | 模拟方式 | 预期行为 |
|---|---|---|
| SKU 校验依赖超时 | 临时设 `V4_SKU_CHECK_TIMEOUT_MS=1` 后上传 | 任务 degraded=true，详情页橙色警示，跳过 E001，其余校验正常（测试场景 10 覆盖） |
| Worker 中断/批次卡死 | 处理中强制结束函数实例 | 2 分钟后卡死批次自动回收重试；任务页轮询触发兜底调度接续 |
| 消息投递失败 | 队列写入异常 | Outbox 指数退避重试，5 次后转死信（status=failed）不丢记录 |
| 重复上传/重复消费 | 同一文件二次上传；重放已完成批次 | 上传返回 duplicate_of 提示；重复消费不重复入库、不重复累计进度（测试场景 5 覆盖） |
| 队列/数据库不可用 | 断开数据库变量 | 监控看板红色告警（503 + alertLevel=critical） |
| 手动兜底 | `curl -X POST -H "Authorization: Bearer $DISPATCHER_TOKEN" https://0506exam.vercel.app/api/import-dispatcher` | 立即执行一轮调度 |

## 清理策略

- 压测运单：`LT` 前缀，loadtest 每轮自动清理；主数据：`SKU_` 前缀，seed 重跑先删后插；
- `npm run seed -- --deep`：额外清空 V4 运行数据（错误明细/性能日志/trace/Outbox/任务）；
- 生产建议：event_outbox 的 sent 记录与 batch_performance_log 按月归档（当前规模无需，见重构假设说明第 11 节）。

## 事件版本策略

事件信封 `schema_version=1`；新增字段向后兼容，消费者必须忽略未知字段（`readPayloadField`）；重大语义变更升级版本号并在 `docs/架构设计文档.md` 第 4 节登记。

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
