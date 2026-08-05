# GitHub Actions 自动部署到 Vercel

工作流文件：`.github/workflows/deploy-vercel.yml`

## 一、它做什么

| 触发场景 | 行为 |
|---|---|
| `push` 到 `main` | 质量门禁 → **生产部署**（`--prod`）→ 冒烟校验 |
| 对 `main` 提 PR | 质量门禁 → **预览部署** → 在 PR 里评论预览地址（同一 PR 反复推送只更新同一条评论） |
| 手动 `workflow_dispatch` | 可选 production / preview；可勾选「跳过质量门禁」用于紧急发布 |

**质量门禁**＝`npm run typecheck` + `npm test`。门禁不过则**不部署**，避免把编译不过的代码推上线。

> 项目里的 DB 测试（`v4-db.test.ts`）在无 `DATABASE_URL` 时整组 skip，HTTP 测试（`v4-http.test.ts`）在探测不到本地服务时 skip，因此 CI 中无需额外配置数据库即可跑绿。

**为什么用 `vercel build` + `vercel deploy --prebuilt` 两步而不是直接 deploy**：构建在 GitHub Actions 里完成，构建失败就不会产生任何部署记录，也不会占用 Vercel 的构建额度；同时构建日志留在 Actions 里，便于排查。

## 二、需要的 Secrets

仓库 → Settings → Secrets and variables → Actions

| Secret | 值 | 状态 |
|---|---|---|
| `VERCEL_ORG_ID` | `.vercel/project.json` 的 `orgId`（`team_` 开头） | ✅ 已配置 |
| `VERCEL_PROJECT_ID` | `.vercel/project.json` 的 `projectId`（`prj_` 开头） | ✅ 已配置 |
| `VERCEL_TOKEN` | 需自行创建 | ⬜ **待配置** |

> 两个 ID 取自本地 `.vercel/project.json`（该目录已被 `.gitignore` 忽略，不会进仓库）。
> 本仓库为公开仓库，故文档中不写出具体 ID 值——它们已存入 GitHub Secrets，需要时用下面的命令重新读取：
>
> ```bash
> node -e "const p=require('./.vercel/project.json');console.log('orgId    =',p.orgId);console.log('projectId=',p.projectId)"
> ```

### 创建并配置 VERCEL_TOKEN

1. 打开 https://vercel.com/account/tokens
2. Create Token → Scope 选择 **0807exam 所属的 Team**（不要选 Personal，否则 `VERCEL_ORG_ID` 对不上）→ 有效期建议 1 年
3. 复制生成的令牌（只显示一次），然后任选一种方式写入：

```bash
# 方式 A：命令行（会提示粘贴，不留 shell 历史）
gh secret set VERCEL_TOKEN --repo lang430/0807exam

# 方式 B：网页
# Settings → Secrets and variables → Actions → New repository secret
```

### 应用运行时的环境变量放哪

**不要**放进 GitHub Secrets。`vercel pull` 会自动从 Vercel 项目拉取对应环境（production / preview）的环境变量供构建使用。所以 `POSTGRES_URL`、`DISPATCHER_TOKEN`、`V4_BATCH_SIZE` 等继续在 **Vercel 控制台 → Settings → Environment Variables** 维护即可，改完下次部署自动生效。

## 三、⚠️ 避免重复部署（重要）

Vercel 的 Git 集成默认会在 push 时自己触发一次部署。加上本工作流后，**同一次 push 会部署两次**——功能上无害，但会浪费构建额度，且两次部署的 URL 不同容易混淆。

三选一：

**方案 A（推荐）：关掉 Vercel 自动部署，由 Actions 独占**

在 `vercel.json` 增加：

```json
{
  "git": {
    "deploymentEnabled": {
      "main": false
    }
  }
}
```

> 本文档默认**没有**替你改 `vercel.json`——因为一旦 `VERCEL_TOKEN` 还没配好就合并这个改动，会出现「Vercel 不部署了，Actions 也部署不了」的空窗。**请先确认 Actions 首次跑通，再做这个改动。**

**方案 B：在 Vercel 控制台关闭**
Project → Settings → Git → 关闭 Production Branch 的自动部署。

**方案 C：保持两者并存**
接受重复部署。以 Actions 的部署为准（它经过了质量门禁）。

## 四、验证首次运行

```bash
# 1. 提交工作流
git add .github/workflows/deploy-vercel.yml docs/ci-cd-vercel.md
git commit -m "ci: 新增 GitHub Actions 自动部署到 Vercel"
git push origin main

# 2. 观察运行
gh run watch --repo lang430/0807exam

# 3. 查看结果（含部署地址，写在 Job Summary 里）
gh run view --repo lang430/0807exam --log
```

也可以先不推送，直接手动触发一次预览部署验证配置：

```bash
gh workflow run deploy-vercel.yml --repo lang430/0807exam -f target=preview
```

## 五、排查

| 现象 | 原因与处理 |
|---|---|
| `缺少必需的 Secret：VERCEL_TOKEN` | 按第二节创建令牌 |
| `Invalid request: target must be "preview" when specifying a gitBranch` | Vercel API 限制：`vercel pull` 传了 `--git-branch` 时 `--environment` 只能是 `preview`。工作流已按环境分支处理（production 不传分支），若自行改动此处需保留该判断 |
| `Error: Project not found` | 令牌 Scope 选成了 Personal，而 `VERCEL_ORG_ID` 是 team。重建令牌并选对 Team |
| 构建报缺少环境变量 | 该变量没在 Vercel 项目里配，或只配了 Production 没配 Preview。`vercel pull` 按环境拉取，两个环境要分别配 |
| 冒烟校验 warn 但部署成功 | 部署本身没问题，是 `/api/import-tasks` 未返回 200。多为数据库连接串未配或库不可达，查 Vercel 运行时日志 |
| PR 没有出现预览评论 | 来自 fork 的 PR 拿不到 Secrets，工作流会主动跳过部署（这是刻意的安全设计） |
| 想让纯文档提交不触发部署 | 取消工作流里 `paths-ignore` 两行的注释 |

## 六、与本项目 cron 的关系

`vercel.json` 里的 `crons`（每日 03:00 调用 `/api/import-dispatcher`，`0 3 * * *`）由 Vercel 平台在**部署生效后**自动接管，与本工作流无关，无需额外配置。注意 Vercel Hobby 计划对 cron 频率的限制（每个项目 cron 每天仅允许触发一次），故 cron 仅作兜底；主驱动仍是 `after()` 自链与轮询内联调度。
