# 进度日志

## 2026-06-05
- 创建计划文件，准备读取项目要求和样例文件。
- 已读取考试 HTML 和 demos 清单，确认需要从零搭建 Next.js 应用。
- 抽样读取 Excel 时遇到 `UnicodeEncodeError`，原因是控制台默认编码不是 UTF-8；后续命令显式设置 `PYTHONIOENCODING=utf-8`。
- 已新增 Next.js 项目骨架、规则引擎、AI 规则 API、订单 API 和主工作台页面。
- 本地服务 `http://127.0.0.1:3000` 已启动，浏览器 DOM 验证首屏控件正常。
- 浏览器截图工具调用超时，未取得截图；改用 DOM 和控制台日志进行页面冒烟验证。
- Python here-string 读取中文文件名再次出现编码退化，已停止重复尝试，改用 Node/ExcelJS 验证样例。
- 已通过 `npx tsx scripts/verify-demos.mjs` 验证 5 个 Excel demo：尾部信息、多 Sheet、标准明细、卡片式、矩阵转置均解析成功且 0 校验错误。
- 已通过 `npm run typecheck`、`npm run build`、`npm audit --json`；安全审计 0 漏洞。
- 当前目录不是 Git 仓库，`git status` 不可用。
- 最终复验通过：`npm run typecheck`、`npm run build`、`npx tsx scripts/verify-demos.mjs`、`http://127.0.0.1:3000` 返回 200。
- 继续开发后补齐：服务端规则持久化 `/api/rules`、规则复制/删除、全量错误展示、历史分页、预览分批加载、1000 行性能验证脚本。
- 复验通过：`npx tsx scripts/verify-performance.mjs` 解析 1000 行约 33 ms；浏览器 DOM 确认复制、删除、加载更多、分页控件存在。
- 继续补齐 `.xls` 支持和 PDF 默认规则：`@e965/xlsx` 审计 0 漏洞，PDF demo 解析 41 行、0 校验错误。
- 最新复验通过：`npm run typecheck`、`npm run build`、`npm audit --json`、`npx tsx scripts/verify-demos.mjs`、`npx tsx scripts/verify-performance.mjs`。
- 已接入 Supabase/Postgres 环境变量和 AIHUBMIX 环境变量；运行时只读取 Vercel 后台注入的服务端环境变量，不依赖 `.env.local`。
- 已新增并执行 `database.sql`，确认 `parse_rules`、`import_batches`、`imported_orders` 存在且 RLS 开启；`/api/rules` 已返回 `database` 模式。
- AIHUBMIX 接口实测可连通，但当前 `coding-minimax-m3-free` 返回非纯 JSON；`/api/ai-rules` 已做 JSON 提取失败降级，返回 200 和启发式规则。
- 已按规则加入 5 个候选模型：`xiaomi-mimo-v2.5-pro-free`、`xiaomi-mimo-v2.5-free`、`coding-glm-5.1-free`、`coding-minimax-m2.7-free`、`coding-minimax-m3-free`。
- 已加入 AI 请求配额：每分钟 5 次、每天 500 次；数据库模式写入 `ai_usage_events`，并用事务 advisory lock 做并发保护。
- 实测候选模型顺序尝试：前三个模型供应商返回 429，后两个返回非规则 JSON；接口最终降级但保持 200，不中断流程。
- 重新通读 `考试要求-文件版本.html` 后补齐：进度条处理条数/总条数、提交进度、历史提交时间筛选、Enter/Tab 单元格移动。
- 新增 `scripts/verify-requirements.mjs`，覆盖 Next App Router、手动规则、创建/复制/删除、上传格式、进度条、表格编辑、全量错误、导出、数据库、AI 限流、默认规则等关键要求。
- 最新复验通过：`npm run typecheck`、`npm run build`、`npm audit --json`、`npx tsx scripts/verify-demos.mjs`、`npx tsx scripts/verify-performance.mjs`、`npx tsx scripts/verify-requirements.mjs`；浏览器 DOM 复验关键控件存在。
