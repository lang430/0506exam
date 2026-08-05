/**
 * 任务基础数据交接（上传页 → 详情页）
 *
 * 上传接口返回的 202 响应里已经包含了详情页首屏所需的全部基础字段
 * （task_id / trace_id / file_name / total_rows / total_batches / status）。
 * 把它顺手写进 sessionStorage，详情页挂载时即可零网络渲染出骨架和基础信息，
 * 完整任务信息与错误明细、批次数据再在后台异步补齐。
 *
 * 仅用于首屏提速，任何读取失败都必须安全降级为“正常走接口”。
 */

export interface TaskSeed {
  task_id: string;
  trace_id?: string;
  file_name?: string;
  status?: string;
  status_raw?: string;
  total_rows?: number;
  total_batches?: number;
  created_at?: string;
}

const SEED_PREFIX = "v4:task-seed:";
/** 交接数据只服务于“刚上传完的这次跳转”，过期即丢弃，避免展示陈旧快照。 */
const SEED_TTL_MS = 60_000;

const storage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null; // 隐私模式 / 禁用存储
  }
};

export const writeTaskSeed = (seed: TaskSeed): void => {
  const store = storage();
  if (!store || !seed?.task_id) return;
  try {
    store.setItem(`${SEED_PREFIX}${seed.task_id}`, JSON.stringify({ ...seed, _at: Date.now() }));
  } catch {
    /* 存储配额不足时忽略，详情页回退到接口加载 */
  }
};

export const readTaskSeed = (taskId: string): TaskSeed | null => {
  const store = storage();
  if (!store || !taskId) return null;
  try {
    const raw = store.getItem(`${SEED_PREFIX}${taskId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TaskSeed & { _at?: number };
    if (!parsed?.task_id) return null;
    if (Date.now() - Number(parsed._at ?? 0) > SEED_TTL_MS) {
      store.removeItem(`${SEED_PREFIX}${taskId}`);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};
