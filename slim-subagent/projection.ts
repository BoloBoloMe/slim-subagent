// ISSUE-04 投影层 (PRD §3 观测数据契约) — details + 调用侧展示快照 → RunNode 数组.
// 职责: 状态映射 (pending/active/终态, attention 聚合), modelSource 标注 (冲突时 final details 胜),
// endedAtMsSource 三级来源 (details → run.json → session.jsonl mtime 近似), logCursor 关联 operational logs,
// archived 投影 (run.json + session.jsonl). 纯函数, 不触发执行管线; 供 ISSUE-05 card / ISSUE-06 viewer 消费.
// 参考: milestone-04/prototype/types.ts (RunNode 契约同源), milestone-02/DECISIONS.md D001/D004/D005/D008.

import * as path from "node:path";
import * as fs from "node:fs";
import type { SingleDetails } from "./single.ts";
import type { ParallelDetails } from "./index.ts";
import { taskPreviewOf, currentLogFile } from "./log.ts";

// ---- PRD §3 契约类型 (与 prototype/types.ts 一致, 原样搬). ----

export type SlimUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
};

export type DisplayStatus =
  | "pending" // 仅 parallel child: 批次开始预建行, 未进 worker (未达 L30 scheduled)
  | "active"
  | "done"
  | "failed"
  | "timeout"
  | "budget"
  | "cancelled"
  | "attention"; // 聚合视角 (failed+timeout+budget+cancelled), 由 isAttention 判定, 单节点不直接产出

export interface RunNodeProgress {
  recentTools?: { tool: string; argsPreview: string; endMs: number }[];
  recentOutput?: string[];
  done?: number;
  total?: number;
}

export interface RunNodeDiagnostics {
  contextTokens?: number;
  contextPercent?: number | null;
  contextWindow?: number;
  usageBudget?: number;
  budgetAuto?: boolean;
  partialOutput?: string;
  hint?: string;
  sessionSaved?: boolean;
}

/** PRD §3 RunNode 契约 */
export interface RunNode {
  id: string; // single/resume: runId; parallel child: `${batchRunId}#${index}`; parallel root: batchRunId
  kind: "single" | "parallel-root" | "parallel-child" | "resume";
  parentId?: string;
  agent: string;
  taskPreview: string; // ≤120 字符, 单行化 (taskPreviewOf), 过 secret redaction; 完整 task 永不进节点
  status: DisplayStatus;
  isError?: boolean;
  startedAtMs?: number;
  endedAtMs?: number;
  endedAtMsSource?: "details" | "run.json" | "mtime-approx"; // 缺失时用 session.jsonl mtime 近似并标注
  usage?: SlimUsage;
  model?: string; // 优先 final details / run.json; active 早期可用调用侧 effective model; 未知 `—`
  modelSource?: "details" | "run.json" | "call-params" | "message" | "unknown";
  timeoutMsExplicit?: number; // 仅显式设置才填; 不显示默认 15min
  usageBudgetExplicit?: number; // 仅显式设置才填; 自动 70% 不进行
  contextPercent?: number | null; // 子代理口径; 未知 null
  stopReason?: string;
  errorMessage?: string; // 脱敏/截断
  runId?: string;
  sessionDir?: string;
  logCursor?: { file?: string; lastEventId?: string }; // 关联 operational logs
  progress?: RunNodeProgress;
  diagnostics?: RunNodeDiagnostics;
}

// ---- 投影输入 (研究排定的接缝面). ----

export interface ProjectionCallParams {
  agent?: string;
  task?: string;
  model?: string;
  timeoutMs?: number;
  usageBudget?: number;
  tasks?: { agent: string; task: string; model?: string; timeoutMs?: number; usageBudget?: number }[];
}

export interface ProjectionInput {
  toolCallId: string; // 节点键基 (M2-D004: toolCallId + mode + runId/index), 防 final 帧键漂移
  details: SingleDetails | ParallelDetails | { mode: "single" | "parallel"; results: unknown[]; progress: unknown[] };
  callParams?: ProjectionCallParams; // 调用侧展示快照 (renderCall/execute 入参), 仅展示字段, 冲突时 details 胜
}

// ---- 状态映射 (PRD §3 v1.3). ----

// 终态映射: timeout→"timeout", usage_budget→"budget", signal→"cancelled", exitCode!==0 或 isError→"failed", 否则→"done".
function terminalStatusOf(d: {
  processSignal?: string;
  stopReason?: string;
  exitCode?: number;
  isError?: boolean;
  errorMessage?: string;
}): DisplayStatus {
  if (d.processSignal) return "cancelled"; // PRD: signal → cancelled
  if (d.stopReason === "timeout") return "timeout";
  if (d.stopReason === "usage_budget") return "budget";
  if (d.exitCode !== undefined && d.exitCode !== 0) return "failed";
  if (d.isError === true) return "failed";
  if (d.errorMessage) return "failed";
  return "done";
}

// single/resume 状态: 无 pending; endedAtMs 未到 = live active; 到了 = 终态映射.
function singleStatusOf(d: {
  endedAtMs?: number;
  processSignal?: string;
  stopReason?: string;
  exitCode?: number;
  isError?: boolean;
  errorMessage?: string;
}): DisplayStatus {
  if (d.endedAtMs === undefined) return "active";
  return terminalStatusOf(d);
}

// archived 状态: run.json.finalStatus = result.stopReason ?? (done/failed); 无补丁无失败证据 → done.
function archivedStatusOf(finalStatus: unknown): DisplayStatus {
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
    case "done":
    case "stop":
    case undefined:
      return "done";
    default:
      return "done";
  }
}

export function isAttention(status: DisplayStatus): boolean {
  return status === "failed" || status === "timeout" || status === "budget" || status === "cancelled";
}

// ---- 辅助: 模型解析 (决策 4: details 胜 callParams; 未知 —). ----

function modelOf(detailsModel: string | undefined, callModel: string | undefined): { model: string; modelSource: "details" | "call-params" | "unknown" } {
  if (detailsModel !== undefined && detailsModel !== "") {
    return { model: detailsModel, modelSource: "details" };
  }
  if (callModel !== undefined && callModel !== "") {
    return { model: callModel, modelSource: "call-params" };
  }
  return { model: "—", modelSource: "unknown" };
}

function logCursorOf(): { file?: string } {
  // live 节点 best-effort 关联当日日志 (basename; lastEventId 留空, 本切片不消费).
  return { file: path.basename(currentLogFile()) };
}

// progress 快照字段映射: 输入 recentTools 的 args → 契约 argsPreview (原型同形).
function toRunNodeProgress(p: { recentTools?: { tool: string; args: string; endMs: number }[]; recentOutput?: string[] } | undefined): RunNodeProgress | undefined {
  if (!p) return undefined;
  const out: RunNodeProgress = {};
  if (Array.isArray(p.recentTools)) {
    out.recentTools = p.recentTools.map((t) => ({ tool: t.tool, argsPreview: t.args, endMs: t.endMs }));
  }
  if (Array.isArray(p.recentOutput)) out.recentOutput = [...p.recentOutput];
  return out;
}

// ---- single 分支 (kind=single/resume). ----

// 输入三形态: 最终 SingleDetails (可能无 mode) / live 快照 {mode:"single", results, progress} /
// 早期无 mode 单次 details. live 单次经 results[0] (SingleResult) 取 usage/model/进度.
function projectSingle(d: Record<string, unknown>, callParams: ProjectionCallParams | undefined): RunNode {
  const live = (Array.isArray(d.results) ? (d.results[0] as Record<string, unknown> | undefined) : undefined) ?? {};
  const liveProgress = (Array.isArray(d.progress) ? (d.progress[0] as { recentTools?: { tool: string; args: string; endMs: number }[]; recentOutput?: string[] } | undefined) : undefined);
  const agent = (d.agent as string | undefined) ?? (live.agent as string | undefined) ?? callParams?.agent ?? "";
  const taskRaw = (d.taskPreview as string | undefined) ?? (typeof live.task === "string" ? live.task : undefined) ?? callParams?.task ?? "";
  const runId = (d.runId as string | undefined) ?? (live.runId as string | undefined) ?? "";
  const sessionDir = (d.sessionDir as string | undefined) ?? (live.sessionDir as string | undefined) ?? "";
  // ISSUE-08 修复: live 流式帧的终态字段在 results[0] (SingleResult) 而非顶层 details;
  // 终态判据/错误字段都回退 live, 否则 live 帧永远映射 active (viewer 状态不更新, 需 reload 才变).
  const endedAtMs = (d.endedAtMs as number | undefined) ?? (live.endedAtMs as number | undefined);
  const { model, modelSource } = modelOf((d.model as string | undefined) ?? (live.model as string | undefined), callParams?.model);
  const usage = (live.usage as SlimUsage | undefined) ?? (d.usage as SlimUsage | undefined);
  const exitCode = (d.exitCode as number | undefined) ?? (live.exitCode as number | undefined);
  const stopReason = (d.stopReason as string | undefined) ?? (live.stopReason as string | undefined);
  const processSignal = (d.processSignal as string | undefined) ?? (live.processSignal as string | undefined);
  const errorMessage = (d.errorMessage as string | undefined) ?? (live.errorMessage as string | undefined);
  const isError = typeof exitCode === "number" && exitCode !== 0 ? true : errorMessage ? true : undefined;
  const contextPercent = (d.contextPercent as number | null | undefined) ?? null;
  // ISSUE-08 修复: usageBudgetExplicit 优先从 final details 推导 (budgetAuto=false → usageBudget), 退化调用侧快照.
  const explicitBudget = (d.budgetAuto === false && typeof d.usageBudget === "number") ? (d.usageBudget as number) : (typeof callParams?.usageBudget === "number" ? callParams.usageBudget : undefined);
  const resumed = d.resumed === true;
  return {
    id: runId || "—", // 无 runId 的 live 早期帧以占位, final 帧同键覆盖 (toolCallId+mode 侧由消费侧拼)
    kind: resumed ? "resume" : "single",
    agent,
    taskPreview: taskPreviewOf(taskRaw),
    status: singleStatusOf({ endedAtMs, processSignal, stopReason, exitCode, isError, errorMessage }),
    ...(isError ? { isError } : {}),
    ...(d.startedAtMs !== undefined ? { startedAtMs: d.startedAtMs as number } : {}),
    ...(endedAtMs !== undefined ? { endedAtMs, endedAtMsSource: "details" as const } : {}),
    ...(usage ? { usage } : {}),
    model,
    modelSource,
    ...(callParams?.timeoutMs !== undefined || (d.timeoutMsExplicit !== undefined) ? { timeoutMsExplicit: ((d.timeoutMsExplicit as number | undefined) ?? callParams?.timeoutMs) as number } : {}),
    ...(explicitBudget !== undefined ? { usageBudgetExplicit: explicitBudget } : {}),
    contextPercent,
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(runId ? { runId } : {}),
    ...(sessionDir ? { sessionDir } : {}),
    logCursor: logCursorOf(),
    ...(liveProgress ? { progress: toRunNodeProgress(liveProgress) } : {}),
    ...(d.contextTokens !== undefined || d.contextWindow !== undefined ? { diagnostics: { ...(d.contextTokens !== undefined ? { contextTokens: d.contextTokens as number } : {}), ...(contextPercent ? { contextPercent } : {}), ...(d.contextWindow !== undefined ? { contextWindow: d.contextWindow as number } : {}) } } : {}),
  };
}

// ---- parallel 分支 (root + children). ----

function projectParallel(d: Record<string, unknown>, callParams: ProjectionCallParams | undefined): RunNode[] {
  const results = (d.results as { index: number; agent: string; task: string; isError?: boolean; details: SingleDetails }[] | undefined) ?? [];
  const progress = (d.progress as { childIndex: number; agent: string; scheduled?: boolean; usage?: SlimUsage; model?: string; isError?: boolean; recentTools?: { tool: string; args: string; endMs: number }[]; recentOutput?: string[] }[] | undefined) ?? [];
  const batchRunId = (d.runId as string | undefined) ?? "";
  const total = Math.max(results.length, progress.length);
  const children: RunNode[] = [];
  let completedCount = 0;
  for (let i = 0; i < total; i++) {
    const pr = progress[i];
    const rr = results[i];
    // 完成判定: 占位槽 (exitCode -1 = running) 非真实; 真实结果含 settle 后 exitCode.
    const real = rr !== undefined && rr.details !== undefined && (rr.details as SingleDetails).exitCode !== -1;
    // pending 判据 (D008): scheduled===false 且未完成 (未达 L30, 未进 worker).
    const pending = !real && pr !== undefined && pr.scheduled === false;
    const status: DisplayStatus = pending ? "pending" : real ? terminalStatusOf(rr.details) : "active";
    if (status !== "pending" && status !== "active") completedCount++;
    const agent = pr?.agent ?? rr?.agent ?? callParams?.tasks?.[i]?.agent ?? "";
    const taskRaw = rr?.task ?? callParams?.tasks?.[i]?.task ?? "";
    const liveModel = pr?.model ?? (real ? rr.details.model : undefined);
    const { model, modelSource } = modelOf(liveModel, callParams?.tasks?.[i]?.model);
    const child: RunNode = {
      id: batchRunId ? `${batchRunId}#${i}` : `#${i}`,
      kind: "parallel-child",
      parentId: batchRunId || undefined,
      agent,
      taskPreview: taskPreviewOf(taskRaw),
      status,
      ...(real && rr.isError === true ? { isError: true } : real && typeof rr.details.exitCode === "number" && rr.details.exitCode !== 0 ? { isError: true } : {}),
      ...(real && rr.details.endedAtMs !== undefined ? { endedAtMs: rr.details.endedAtMs, endedAtMsSource: "details" as const } : {}),
      // pending 行从简 (D008): 无 usage (未产生不伪造) — 进度行零值 usage 不投影.
      ...(!pending && (pr?.usage ?? (real ? rr.details.usage : undefined)) ? { usage: pr?.usage ?? rr.details.usage } : {}),
      model,
      modelSource,
      // pending 行从简 (D008): 无 model/ctx/elapsed — model 未知 `—` 已覆盖.
      ...(real && rr.details.stopReason !== undefined ? { stopReason: rr.details.stopReason } : {}),
      ...(real && rr.details.errorMessage !== undefined ? { errorMessage: rr.details.errorMessage } : {}),
      ...(batchRunId ? { runId: batchRunId } : {}),
      ...(rr?.details?.sessionDir ? { sessionDir: rr.details.sessionDir } : {}),
      logCursor: logCursorOf(),
      ...(pr ? { progress: toRunNodeProgress(pr) } : {}),
    };
    children.push(child);
  }
  const root: RunNode = {
    id: batchRunId,
    kind: "parallel-root",
    agent: "parallel",
    taskPreview: "",
    status: completedCount >= total ? "done" : "active", // 根行摘要: 未全完成 → active, 全完成 → done
    ...(d.startedAtMs !== undefined ? { startedAtMs: d.startedAtMs as number } : {}),
    ...(batchRunId ? { runId: batchRunId } : {}),
    logCursor: logCursorOf(),
    progress: { done: completedCount, total },
  };
  return [root, ...children];
}

// ---- 入口: 判 shape 分叉. ----

// 判 shape 说明: 以 mode 优先 — mode="parallel" → parallel; mode=undefined 且带 results 数组
// (legacy live/stream) → parallel; 其余 (含 mode="single" 带 results 的 live 单次快照) → single.
// 若纯按 "有 results 即 parallel" 会误吞 live 单次快照 (TS-001 形态), mode 是唯一稳定判据.
export function projectSlimDetailsToRunNodes(input: ProjectionInput): RunNode[] {
  const d = input.details as Record<string, unknown> & { mode?: string };
  const mode = d.mode;
  const hasResults = Array.isArray(d.results);
  if (mode === "parallel" || (mode === undefined && hasResults)) {
    return projectParallel(d, input.callParams as ProjectionCallParams | undefined);
  }
  return [projectSingle(d, input.callParams as ProjectionCallParams | undefined)];
}

// ---- archived 投影 (PRD §3 投影来源 3: run.json + session.jsonl). ----

// single/resume: 读 <runDir>/run.json (首笔 + settle 补丁); endedAtMs 三级来源 (D005):
// run.json.endedAtMs → "run.json"; 缺省则 session.jsonl mtime 近似 → "mtime-approx"; 再缺省不填.
// parallel 批次 run.json: 仅产出 parallel-root 最小节点 (child 各别投影在 viewer 层, 本函数单节点面).
// 任何读取/解析失败 → undefined (不抛).
export function projectArchivedRunNode(runDir: string): RunNode | undefined {
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
  let endedAtMs: number | undefined;
  let endedAtMsSource: "run.json" | "mtime-approx" | undefined;
  if (typeof json.endedAtMs === "number") {
    endedAtMs = json.endedAtMs;
    endedAtMsSource = "run.json";
  } else {
    // 三级来源第 2 级: session.jsonl mtime 近似 (sessionFile 相对 runDir; 缺省 run-0/session.jsonl).
    const candidates = [
      typeof json.sessionFile === "string" ? json.sessionFile : null,
      "run-0/session.jsonl",
      "session.jsonl",
    ].filter((s): s is string => s !== null);
    for (const rel of candidates) {
      try {
        const st = fs.statSync(path.join(runDir, rel));
        if (st.isFile()) {
          endedAtMs = st.mtimeMs;
          endedAtMsSource = "mtime-approx";
          break;
        }
      } catch {
        // 候选路径不达, 试下一个
      }
    }
  }
  const startedAtMs = typeof json.startedAt === "string" ? Date.parse(json.startedAt) : undefined;
  const runJsonModel = typeof json.model === "string" && json.model !== "" ? json.model : undefined;
  // archived modelSource: 仅 run.json 一手来源可能; 无则标注 unknown (不伪造).
  const model = runJsonModel ?? "—";
  const modelSource: "run.json" | "unknown" = runJsonModel !== undefined ? "run.json" : "unknown";
  const usage = typeof json.usage === "object" && json.usage !== null ? (json.usage as SlimUsage) : undefined;
  const base = {
    logCursor: logCursorOf(),
    ...(startedAtMs && Number.isFinite(startedAtMs) ? { startedAtMs } : {}),
    ...(endedAtMs !== undefined && endedAtMsSource !== undefined ? { endedAtMs, endedAtMsSource } : {}),
    ...(usage ? { usage } : {}),
    model,
    modelSource,
  };
  if (json.mode === "parallel") {
    const tasks = Array.isArray(json.tasks) ? json.tasks : [];
    return {
      id: runId,
      kind: "parallel-root",
      parentId: undefined,
      agent: "parallel",
      taskPreview: "",
      status: archivedStatusOf(json.finalStatus),
      ...(runId ? { runId } : {}),
      sessionDir: runDir,
      ...base,
      progress: { done: tasks.length, total: tasks.length },
    };
  }
  return {
    id: runId,
    kind: "single",
    parentId: undefined,
    agent: typeof json.agent === "string" ? json.agent : "",
    taskPreview: "",
    status: archivedStatusOf(json.finalStatus),
    ...(runId ? { runId } : {}),
    sessionDir: runDir,
    ...base,
  };
}