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
- 已接入 Supabase/Postgres 环境变量和 AIHUBMIX 环境变量，新增 `.env.local`（已加入 `.gitignore`）。
- 已新增并执行 `database.sql`，确认 `parse_rules`、`import_batches`、`imported_orders` 存在且 RLS 开启；`/api/rules` 已返回 `database` 模式。
- AIHUBMIX 接口实测可连通，但当前 `coding-minimax-m3-free` 返回非纯 JSON；`/api/ai-rules` 已做 JSON 提取失败降级，返回 200 和启发式规则。
