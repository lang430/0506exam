# 接口性能分析与优化记录

> 触发场景：`GET /api/import-tasks/task_850feea59427406780f2cd19` 接口超时。
> 本文记录根因定位、全接口性能扫描结论、以及已实施的优化措施。

---

## 一、超时根因：不是索引问题，是架构问题

### 现象
任务详情接口（前端 **1.5s 轮询一次**）响应缓慢直至网关超时。

### 根因
该接口在**返回响应前同步等待调度工作**：

```ts
// 优化前
if (["pending", "processing"].includes(task.status)) {
  await runDispatchCycle(sql, { maxBatches: 4, timeBudgetMs: 8_000 });
}
```

- 单批处理实测 **0.5s（缓存命中）~1.9s（首批含解析）**，4 批叠加即 **2~8 秒**；
- 前端每 **1.5s** 发起一次轮询，而每次轮询要阻塞数秒 → 请求持续堆积；
- 叠加 postgres 客户端 `max=1` 单连接，后续轮询还要排队等连接 → 雪崩式恶化，最终触发网关超时。

**本质**：把「高频只读的进度查询」和「重量级的批次处理」耦合在同一个请求生命周期里。

### 优化措施

| 措施 | 说明 |
|---|---|
| **停滞门控** | 新增活跃处理检测：仅当任务未终态**且无批次正在被处理**（`locked_at` 在 30s 窗口内无 `processing` 批次）时才内联调度。正常处理中的轮询**完全不做调度工作**。 |
| **收窄预算** | 停滞时的调度预算从 `4 批 / 8s` 收窄为 **`1 批 / 2.5s`**，最坏响应时间可控。 |
| **合并往返** | 任务主表 + 批次聚合 + 活跃检测由 **2 次查询合并为 1 次** `left join lateral`。 |
| **条件查询** | 错误分布仅在 `failed_rows > 0` 时才查询，成功路径省去一次往返。 |
| **按需回读** | 仅当真正推进了批次时才回读一次进度，被租约跳过时不回读。 |

### 效果

| 场景 | 优化前 | 优化后 |
|---|---|---|
| 正常处理中轮询（占绝大多数） | 2~8s | **~100ms**（2 次查询，且成功路径仅 1 次） |
| 调度停滞需自愈 | 2~8s | **≤2.5s**（硬上限） |
| 任务已终态 | 3 次查询 | 1~2 次查询 |

> 主驱动路径不变：上传 `after()` → 调度端点自链（30 批/50s）→ cron 兜底。
> 轮询内联调度**降级为纯自愈补位**，不再承担主要吞吐职责。

---

## 二、全接口性能扫描

### 🔴 严重：监控看板全表扫描最大表

`GET /api/import-monitor/summary` 的「实时吞吐」查询：

```sql
select ... from imported_orders
where created_at > now() - interval '5 minutes'
```

`imported_orders` 是**全库最大表**（每次导入写入 1 万行，且持续累积），而该表此前**只有一个业务键唯一索引** `(external_code, sku_code, line_no)`，完全无法服务 `created_at` 范围过滤 → **全表扫描**。

数据量越大越慢，是监控接口最主要的瓶颈。**已补索引**。

### 🟡 中等：缺失索引导致的额外排序/扫描

| 接口 | 查询模式 | 原索引为何无效 | 处理 |
|---|---|---|---|
| 监控·错误分布 | `where created_at > now() - 24h group by error_code` | 仅有 `error_code` 单列索引，不服务 `created_at` 范围过滤 | 补 `(created_at desc)` |
| 错误明细分页 | `where task_id = ? order by row_number limit/offset` | `(task_id, unit_id)`、`(task_id, batch_index)` 均不提供 `row_number` 有序性，需额外 Sort | 补 `(task_id, row_number)` |
| 任务列表 / 监控 recentTasks | `order by created_at desc limit 50` | `(status, created_at desc)` **前导列是 status**，无 status 过滤时无法用于全局时间排序 | 补 `(created_at desc)` |
| 慢批次 TOP10 | `where created_at > 24h order by total_duration_ms desc limit 10` | 仅 `(created_at desc)`，排序列未覆盖 | 补 `(created_at desc, total_duration_ms desc)` |
| 任务详情批次聚合 | `where task_id = ? ` 按 status 分类计数 | `(status, task_id)` **前导列是 status**，不服务单任务查询 | 补 `(task_id, status)` |

> 「前导列错位」是本次发现的共性问题：复合索引 `(A, B)` 无法服务只按 B 过滤/排序的查询。

### 🟢 良好：无需处理

| 接口 | 结论 |
|---|---|
| `POST /api/import-tasks`（上传） | 单事务写入，预检合并为 1 次查询，服务端 150~400ms |
| `GET /api/import-tasks/:id/batches` | 受批次数天然限制（单任务 4~10 批），且 `task_id` 前缀有索引 |
| `GET /api/import-tasks/:id/errors-export` | `limit 100000` 有界，且为按需下载、非轮询 |
| `GET /api/traces/:traceId` | `(trace_id, occurred_at)` 复合索引精确匹配 |
| 监控·阶段耗时百分位 | `(created_at desc)` 已覆盖 24h 过滤 |
| 监控·失败趋势 | `(status, created_at desc)` 前导列 status 有过滤，完全命中 |

### ⚠️ 已知设计权衡（非缺陷，记录备查）

1. **`GET /api/traces` 多条件检索**使用 `exists` 子查询 + `file_name ilike '%...%'`。
   前缀通配的 `ilike` 无法走 B-tree 索引。当前任务量级（几十~几百）下可接受；
   数据量上万后建议改用 `pg_trgm` 扩展 + GIN 索引。
2. **监控队列深度**聚合全表 `import_task_batches` 无 WHERE 条件。
   批次表增长受任务数限制（每任务仅 4~10 行），当前无需处理；
   长期建议对 `completed/failed` 批次做归档。
3. **postgres 客户端 `max=1`** 是刻意约束（实测多实例并发重事务会压垮小规格数据库），
   代价是同实例内查询串行。故**减少每请求的查询往返次数**比加并发更有效——
   这正是本次合并查询的思路来源。

---

## 三、本次新增索引清单

已同步写入 **`database-v4.sql`** 与 **`lib/v4/schema.ts`**（应用层幂等自动建表，保证新环境一致）。

```sql
-- 监控实时吞吐：消除最大表 imported_orders 的全表扫描（最关键）
create index if not exists imported_orders_created_at_idx
  on public.imported_orders (created_at desc);

-- 监控错误分布：24h 范围过滤
create index if not exists import_task_errors_created_at_idx
  on public.import_task_errors (created_at desc);

-- 错误明细分页：消除 row_number 额外排序
create index if not exists import_task_errors_task_row_idx
  on public.import_task_errors (task_id, row_number);

-- 任务列表 / 监控 recentTasks：全局按时间倒序
create index if not exists import_tasks_created_at_idx
  on public.import_tasks (created_at desc);

-- 慢批次 TOP10：过滤 + 排序覆盖
create index if not exists batch_performance_log_created_duration_idx
  on public.batch_performance_log (created_at desc, total_duration_ms desc);

-- 任务详情批次聚合：单任务按 status 分类计数
create index if not exists import_task_batches_task_status_idx
  on public.import_task_batches (task_id, status);
```

全部使用 `if not exists`，可在已有环境重复执行。

### 已在生产库实际执行 ✅

通过 `npm run db:indexes`（`scripts/apply-indexes.mjs`）对 Supabase PostgreSQL 17.6 执行完毕：

```
── 创建索引 ──
  ☑️  已存在  imported_orders_created_at_idx                  282 ms   ← V2 脚本已有
  ✅ 新建    import_task_errors_created_at_idx               258 ms
  ✅ 新建    import_task_errors_task_row_idx                1024 ms
  ✅ 新建    import_tasks_created_at_idx                     237 ms
  ✅ 新建    batch_performance_log_created_duration_idx      240 ms
  ✅ 新建    import_task_batches_task_status_idx             238 ms
完成：新建 5，已存在 1，失败 0
```

建索引后自动执行 `ANALYZE` 刷新统计信息，使计划器立即采用新索引。
脚本幂等，重复执行输出「已存在 6/6」。

**执行计划抽验（EXPLAIN ANALYZE 实测）**

| 查询 | 计划 | 实测耗时 |
|---|---|---|
| 监控实时吞吐（`imported_orders` 5min 窗口） | ✅ Index Scan | 0.091 ms |
| 任务列表（`order by created_at desc limit 50`） | ✅ Index Scan | 0.080 ms |
| 监控错误分布（24h `group by error_code`） | Seq Scan | 0.409 ms |

> 第三项仍走 Seq Scan 是**计划器的正确选择**——该表当前仅 650 行，顺序读整页比随机读索引更快。
> 索引已就位，数据量增长后计划器会自动切换。这不是缺陷。

**索引已被真实查询命中**（`pg_stat_user_indexes.idx_scan`，执行后数分钟内采集）：
`import_task_batches_task_status_idx` 46 次、`import_task_errors_task_row_idx` 22 次、
`import_tasks_created_at_idx` 17 次、`imported_orders_created_at_idx` 395 次——证明索引确实在服务线上查询。

---

## 四、移除无效索引：`imported_orders_payload_gin_idx`

巡检发现的**比缺索引更值得处理的问题**。

| 维度 | 事实 |
|---|---|
| 定义 | `CREATE INDEX ... ON imported_orders USING gin (payload)`，来自 V2 的 `database.sql` |
| 使用次数 | `idx_scan = 0` —— 上线至今**从未被任何查询命中** |
| 体积 | **8632 kB**，而该表堆体积仅 6968 kB —— 索引比数据本身还大 |
| 代码引用 | 全库检索无 `imported_orders.payload` 的 jsonb 包含/存在性查询；现存 `payload->>` 查询均作用于 `parse_rules` 表 |
| V4 脚本 | `database-v4.sql` 与 `lib/v4/schema.ts` **均未定义**它（纯 V2 遗留） |
| 写入代价 | GIN 是维护代价最高的索引类型：每插入一行需对整个 jsonb 分词并更新 posting list，而 `imported_orders` 正是单次导入写 1 万行的主写入路径 |

**处置**：已 `DROP`，并在 `database-v4.sql` 中写入显式 `drop index if exists`（附完整判定依据注释），
保证重新部署不会复活。应用层无任何代码会重建它。

### 关于写入耗时的实测（诚实记录：结论不成立）

曾尝试用「事务内插入 2000 行后 ROLLBACK」量化 GIN 的写入开销（`scripts/bench-insert.mjs`）：

| 轮次 | 含 GIN | 无 GIN |
|---|---|---|
| 第一批采样 | 1596 ms | 1400 ms（-12.3%） |
| 第二批采样 | — | 7153 ms / 9794 ms |

第二批在**已移除 GIN 的情况下反而慢 5 倍**，说明测量被跨境网络往返与 Supabase 共享实例负载完全主导，
微基准信噪比不足。**因此不采信「提升 12%」这个数字**。

移除该索引的依据不依赖压测，而是上表的硬事实：**零命中 + 无代码引用 + 非 V4 定义 + 索引大于数据 + GIN 写入代价最高**。
即便写入收益为零，回收 8.6 MB 空间、消除无谓的写放大也已足够。

---

## 五、表膨胀治理

`pg_stat_user_tables` 巡检发现多个热路径表死元组占比过高：

| 表 | 死元组占比 | 说明 |
|---|---|---|
| `dispatch_lease` | 90.9% | 每次调度都 UPDATE 租约，1 活行 / 10 死行 |
| `parse_rules` | 85.7% | autovacuum **从未运行过** |
| `import_tasks` | 42.6% | 每次进度推进都 UPDATE |
| `batch_performance_log` | 33.1% | — |
| `import_task_files` | 22.1% | — |
| `import_task_batches` | 20.5% | — |

死元组会让顺序扫描多读空页——在这几张小表上恰好都是计划器倾向 Seq Scan 的场景，影响被放大。

**处置**：`npm run db:vacuum` 全表 `VACUUM ANALYZE`（非阻塞）+ 对 <1MB 的膨胀小表 `VACUUM FULL`。
执行后**全部表死元组归零**。

> ⚠️ 判定逻辑上的一个坑：初版脚本用「行少但堆大」判膨胀，误将 `import_task_files`（存原始文件字节）
> 和 `imported_orders`（含 jsonb payload）判为膨胀——它们堆大是**正常的数据体积**。
> 若照此对大表执行 `VACUUM FULL` 会取 ACCESS EXCLUSIVE 锁阻塞线上读写。
> 现已改为只按死元组占比判定，且 `VACUUM FULL` 仅作用于 <1MB 的小表。

---

## 六、运维脚本

| 命令 | 作用 |
|---|---|
| `npm run db:indexes` | 应用性能索引 + ANALYZE + 落库验证 + EXPLAIN 抽验（幂等） |
| `npm run db:indexes -- --dry-run` | 仅打印将执行的 SQL |
| `npm run db:health` | 巡检：表规模、死元组占比、索引体积与使用次数（只读） |
| `npm run db:vacuum` | 巡检 + 回收死元组 |
| `npm run db:bench-insert` | 量化写入路径索引开销（跨境网络下噪声大，仅供同区域环境参考） |

脚本自动读取 `.env.local`，DDL 优先走 `POSTGRES_URL_NON_POOLING` 直连。

---

## 七、验证

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 报错 |
| `npx vitest run tests/v4-pure.test.ts` | 17/17 通过 |
| 索引定义一致性 | `database-v4.sql` 与 `schema.ts` 各 21 处，完全对齐 |
| 生产库索引落库 | 6/6 全部存在并已被查询命中 |
| 生产库死元组 | 全部归零 |
