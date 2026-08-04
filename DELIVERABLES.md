# Deliverables Checklist（V4 专项考核提交物清单）

Exam: V2 下单流程异步事件驱动重构与全链路可观测性实战（V4.0）
All deliverable file names follow English naming conventions.

| # | Deliverable | Location | Status |
|---|---|---|---|
| 1 | Online URL (Vercel deployment) | https://0807v4.vercel.app | ✅ Live |
| 2 | Source repository (GitHub) | https://github.com/lang430/0506exam | ✅ Pushed |
| 3 | Load-test data seed script (20,000 SKUs) | `scripts/seed-data.ts` | ✅ Idempotent, verified |
| 4 | 10,000-row load-test Excel file | `test-data/10000-orders.xlsx` | ✅ Committed (170 seeded errors) |
| 5 | Load-test report (≤60s proof) | `docs/load-test-report.md` (+ raw JSON: `test-data/loadtest-report.json`) | ✅ 11s 端到端（服务端处理 ≤400ms） |
| 6 | Architecture design document (async flow / Outbox / batching) | `docs/architecture-design.md` | ✅ Complete |
| 7 | Refactoring assumptions (Module-11, 12 required points) | `docs/refactoring-assumptions.md` | ✅ Complete |
| 8 | API documentation (upload / task / errors / trace / monitor) | `docs/api-documentation.md` | ✅ Complete |
| 9 | README (local run / env vars / deploy / load test / fault drills) | `README.md` | ✅ Complete |
| 10 | Demo account & access notes | This file, section below | ✅ Public access |

## Access Notes (Deliverable 10)

All pages are public; no account is required.

| Page | URL | What to verify |
|---|---|---|
| Async import (upload + task list) | https://0807v4.vercel.app/tasks | Upload file with a saved rule → task_id returned <1s |
| Task detail & progress | https://0807v4.vercel.app/tasks/{taskId} | 1.5s polling, throughput/ETA, degraded banner, error filters, CSV export |
| Monitor dashboard | https://0807v4.vercel.app/monitor | Throughput / queue backlog alerts / stage P50-P95-P99 / error distribution / slow batches TOP10 / failed-task trend |
| Trace search | https://0807v4.vercel.app/traces | Search by task_id / file name / batch / error code / row range → timeline + failed-node details |
| V2 workbench (kept) | https://0807v4.vercel.app/ | Manual preview-edit flow (V2 baseline, unchanged) |

Manual dispatch (ops fallback): `POST /api/import-dispatcher` with `Authorization: Bearer $DISPATCHER_TOKEN`.

## Acceptance Quick Path

```bash
npm install
npm run seed      # 20,000 SKUs + 10,000-row Excel (idempotent)
npm run loadtest -- --base-url https://0807v4.vercel.app
# Expected: PARTIAL_SUCCESS, success 9830 / failed 170, total ≤ 60s (report: 11s 端到端，服务端 upload_ms 150~400ms)
npm test          # 29 automated tests (Module 10.1 scenarios)
```

## Supporting (non-required) Files

| File | Purpose |
|---|---|
| `database.sql` / `database-v4.sql` | DB schema (V2 base + V4 incremental) |
| `scripts/loadtest.mjs` | Load-test runner (report generator) |
| `scripts/worker-loop.mjs` | Local resident dispatcher (dev only) |
| `tests/` | 29 automated tests (vitest) |
| `docs/v4-task-breakdown.md` | Requirements breakdown & dev task plan |
| `SUBMISSION-NOTES.md` | V2-era LLM invocation notes (model / prompt / API key config) |
