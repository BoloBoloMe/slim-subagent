// run-record.ts — 归档运行读取 (架构深化: 统一归档读取接缝).
// 一个深模块拥有三件事, 替代此前散在 projection.ts/viewer.ts 且已漂移的双份实现:
//   ① sessions 目录布局约定 (写侧 single.ts/index.ts 与读侧 viewer 共用, 单一真相);
//   ② run.json finalStatus → DisplayStatus 映射 (唯一实现; 原 projection 版把 "active" 判 done, viewer 版判 active);
//   ③ 归档读取 + 脱敏收口 (parallel child task 一律过 taskPreviewOf — 原 viewer 回补直渲原始 task, 可含密钥).
// 依赖类别: 本地可替代 (文件系统; 测试用真临时目录, 无 mock).

import * as fs from "node:fs";
import * as path from "node:path";
import { taskPreviewOf } from "./log.ts";
import type { DisplayStatus, SlimUsage } from "./projection.ts";

// ---------------------------------------------------------------------------
// ① 目录布局约定 (单一真相)
// ---------------------------------------------------------------------------

/** single/resume run 目录内 session 文件相对路径 (run.json 首笔 sessionFile 字段同值). */
export const SINGLE_SESSION_REL = "run-0/session.jsonl";

/** parallel child 目录名: run-<idx> (批次根目录下). */
export function childRunDirName(index: number): string {
  return `run-${index}`;
}

/** parallel child 会话目录 (批次根/run-<idx>). */
export function childSessionDirOf(batchRoot: string, index: number): string {
  return path.join(batchRoot, childRunDirName(index));
}

/** live 节点 sessionDir → session 文件: parallel-child 的 sessionDir 即 run-<idx> (session.jsonl 直落); single/resume 走 run-0 子目录. */
export function liveSessionFileOf(kind: "single" | "parallel-root" | "parallel-child" | "resume", sessionDir: string): string {
  return path.join(sessionDir, kind === "parallel-child" ? "session.jsonl" : SINGLE_SESSION_REL);
}

/** 归档 single/resume run 目录的 session 文件三级候选: sessionFile 字段 → run-0 缺省 → 同目录; 首个存在者, 皆缺回 run-0 缺省路径. */
export function archivedSessionFileOf(runDir: string, sessionFileField?: unknown): string {
  const fallback = path.join(runDir, SINGLE_SESSION_REL);
  const candidates = [
    ...(typeof sessionFileField === "string" ? [path.join(runDir, sessionFileField)] : []),
    fallback,
    path.join(runDir, "session.jsonl"),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // 候选路径不达, 试下一个
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// ② 归档状态映射 (唯一实现; 无补丁无失败证据 → done)
// ---------------------------------------------------------------------------

export function archivedStatusOf(finalStatus: unknown): DisplayStatus {
  switch (finalStatus) {
    case "timeout":
      return "timeout";
    case "usage_budget":
      return "budget";
    case "cancelled":
      return "cancelled";
    case "error":
    case "failed":
    case "aborted":
      return "failed";
    case "active":
      return "active";
    default:
      return "done"; // 含 "done"/"stop"/undefined/未知值
  }
}

// ---------------------------------------------------------------------------
// ③ 归档读取
// ---------------------------------------------------------------------------

function fileMtimeOrUndef(p: string): number | undefined {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/** parallel child 归档视图 (task 已脱敏, 原始 task 不出本模块). */
export interface ArchivedChildRun {
  index: number;
  agent: string;
  taskPreview: string; // ≤120/单行化/已过 secret redaction
  model?: string;
  sessionDir: string; // 批次根/run-<idx>
  sessionFile: string;
  endedAtMs?: number; // child session.jsonl mtime
}

export interface ArchivedRun {
  runId: string;
  mode: string; // run.json mode, 缺省 "single"
  status: DisplayStatus; // archivedStatusOf(finalStatus)
  finalStatus: unknown;
  agent: string; // single/resume; parallel 批次为 ""
  model?: string;
  usage?: SlimUsage;
  startedAtMs?: number; // startedAt 解析 (有限才填)
  createdAtMs: number; // startedAt → runDir mtime → 0 (viewer 时间线排序键)
  endedAtMs?: number;
  endedAtMsSource?: "run.json" | "mtime-approx"; // 无补丁 → session.jsonl mtime 近似并标注
  sessionFile?: string; // single/resume 解析后绝对路径
  children: ArchivedChildRun[]; // parallel
  taskCount: number; // parallel tasks 数 (single 为 0)
}

/**
 * 读单个 run 目录 → 归档视图. run.json 缺/坏 → undefined (跳过不崩).
 * single/resume: endedAtMs 三级来源 — run.json.endedAtMs ("run.json") → session.jsonl mtime ("mtime-approx") → 不填.
 * parallel: 批次 run.json 无 settle 补丁 (per-child skipRunJson), finalStatus 恒 undefined → status "done";
 * child 状态随批次传播, child endedAtMs 取各自 session.jsonl mtime.
 */
export function readArchivedRun(runDir: string): ArchivedRun | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(runDir, "run.json"), "utf-8");
  } catch {
    return undefined;
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const runId = typeof json.runId === "string" && json.runId !== "" ? json.runId : path.basename(runDir);
  const startedAtParsed = typeof json.startedAt === "string" ? Date.parse(json.startedAt) : NaN;
  const startedAtMs = Number.isFinite(startedAtParsed) ? startedAtParsed : undefined;
  const createdAtMs = startedAtMs ?? fileMtimeOrUndef(runDir) ?? 0;
  const mode = typeof json.mode === "string" ? json.mode : "single";
  const model = typeof json.model === "string" && json.model !== "" ? json.model : undefined;
  const usage = typeof json.usage === "object" && json.usage !== null ? (json.usage as SlimUsage) : undefined;
  const status = archivedStatusOf(json.finalStatus);

  if (mode === "parallel") {
    const tasks = Array.isArray(json.tasks) ? json.tasks : [];
    const children: ArchivedChildRun[] = tasks.map((t, i) => {
      const task = t as Record<string, unknown>;
      const sessionDir = childSessionDirOf(runDir, i);
      const sessionFile = path.join(sessionDir, "session.jsonl");
      const childModel = typeof task.model === "string" && task.model !== "" ? task.model : undefined;
      const endedAtMs = fileMtimeOrUndef(sessionFile);
      return {
        index: i,
        agent: typeof task.agent === "string" ? task.agent : "",
        // 脱敏收口: 原始 task 不过 taskPreviewOf 不得上观测面 (与 live 路径 projection.taskPreviewOf 同规).
        taskPreview: typeof task.task === "string" ? taskPreviewOf(task.task) : "",
        ...(childModel ? { model: childModel } : {}),
        sessionDir,
        sessionFile,
        ...(endedAtMs !== undefined ? { endedAtMs } : {}),
      };
    });
    return {
      runId,
      mode,
      status,
      finalStatus: json.finalStatus,
      agent: "",
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      createdAtMs,
      ...(typeof json.endedAtMs === "number" ? { endedAtMs: json.endedAtMs, endedAtMsSource: "run.json" as const } : {}),
      children,
      taskCount: tasks.length,
    };
  }

  const sessionFile = archivedSessionFileOf(runDir, json.sessionFile);
  let endedAtMs: number | undefined;
  let endedAtMsSource: "run.json" | "mtime-approx" | undefined;
  if (typeof json.endedAtMs === "number") {
    endedAtMs = json.endedAtMs;
    endedAtMsSource = "run.json";
  } else {
    const mtime = fileMtimeOrUndef(sessionFile);
    if (mtime !== undefined) {
      endedAtMs = mtime;
      endedAtMsSource = "mtime-approx";
    }
  }
  return {
    runId,
    mode,
    status,
    finalStatus: json.finalStatus,
    agent: typeof json.agent === "string" ? json.agent : "",
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    createdAtMs,
    ...(endedAtMs !== undefined ? { endedAtMs, endedAtMsSource } : {}),
    sessionFile,
    children: [],
    taskCount: 0,
  };
}
