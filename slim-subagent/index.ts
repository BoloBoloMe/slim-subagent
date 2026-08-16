// slim-subagent 扩展入口 — ISSUE-01 (TS-001~003) + ISSUE-02 (TS-001) + ISSUE-03 (timeout/diagnostics) + ISSUE-04 (usageBudget)
// + ISSUE-05 (parallel 并行) 切片.
// 本切片: onUpdate 流式接线 (M3-02 考察点 6) + run.json tools 快照 (EXECUTION.md 调和 14);
// ISSUE-05: tasks[] 并行分支 (M2-D004/M2-D008, 官方示例 mapWithConcurrencyLimit 整搬 + 聚合).
// 覆盖: registerTool 注册名 "subagent" (M2-D001) + schema 恰 10 参数 (M2-D008) + 描述 v3 原文 (M2-D010);
// action:"list" 发现 (M1-D009, M2-D007); execute 校验 (M2-D008 条件必填, M1-D009 error-driven 兜底);
// single 分支接入真实 spawn + timeout 管线 (single.ts) + usageBudget 触顶终止透传;
// parallel 分支: 并发 4/最大 8 + 批次 run.json (调和 12) + per-child run-<idx> session + 顶层默认/item 覆盖;
// resume (ISSUE-06): 分发到 resume.ts (寻址/校验/恢复 spawn/锁/结果标记, 见 resume.ts).

import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { renderRunCard } from "./card.ts";
import { projectSlimDetailsToRunNodes } from "./projection.ts";
import type { ProjectionInput } from "./projection.ts";
import { discoverAgents, formatAgentList } from "./agents.ts";
import type { AgentConfig } from "./agents.ts";
import { runSingleAgent, makeRunId, sessionRootDir, sessionsRootDir, resolveEffectiveUsageBudget } from "./single.ts";
import type { SingleDetails, StreamUpdateCallback, Usage } from "./single.ts";
import { runResume, runSessionGc } from "./resume.ts";
// ISSUE-01: 日志插桩 (仅加日志调用, 不改执行逻辑; 写失败静默吞, 见 log.ts).
import { logEvent, taskPreviewOf, runLogGc } from "./log.ts";
// ISSUE-08: 接线依赖 — viewer (store/组件/建批) + diagnose (runDiagnose).
import { SessionViewerComponent, createViewerStore, batchFromLiveNodes } from "./viewer.ts";
import type { DiagnoseContext } from "./viewer.ts";
import { runDiagnose } from "./diagnose.ts";

// ISSUE-05: 官方示例 index.ts:33-34 同款常量 (M1-D001(2): 并发 4 / 最大 8, 硬编码不可调).
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
// ISSUE-07: 官方示例 :36-37 同款常量 — parallel 汇总 per-task 输出字节上限.
const PER_TASK_OUTPUT_CAP = 50 * 1024;

// 工具描述: 阻塞语义 + 接口速记 + list/resume 操作语义 (schema 参数描述里没有的);
// 委派偏置 (独立且值得 / 默认委派 / 主会话职责) 由 promptSnippet 承担, 不重复.
const TOOL_DESCRIPTION =
  "调用后阻塞等待结果. 单次: agent + task; 并行: tasks[]; action:\"list\" 发现 agents; \"resume\" + id 恢复中止的运行; \"diagnose\" 诊断运行 (只读, 不重启).";

// M2-D008 参数 3: tasks item 结构.
const TaskItem = Type.Object({
  agent: Type.String({ description: "agent 名" }),
  task: Type.String({ description: "并行任务" }),
  model: Type.Optional(Type.String({ description: "覆盖 agent frontmatter 的 model" })),
  thinking: Type.Optional(Type.String({ description: "覆盖 agent frontmatter 的 thinking 深度" })),
  timeoutMs: Type.Optional(Type.Number({ description: "超时毫秒" })),
  usageBudget: Type.Optional(Type.Number({ description: "token 上限" })),
});

// schema 14 参数 (M2-D008 钉死 10 + ISSUE-08 增 diagnose 的 since/levelMin/limit/writeReport);
// 条件必填 (agent 在 action:"list" 时可省, task/tasks 互斥) 由 execute 校验承担 (TS-003), typebox 不表达.
const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "agent 名" })),
  task: Type.Optional(Type.String({ description: "单次任务; 与 tasks 互斥" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "parallel 任务数组, ≤8" })),
  model: Type.Optional(Type.String({ description: "覆盖 agent frontmatter 的 model" })),
  thinking: Type.Optional(Type.String({ description: "覆盖 agent frontmatter 的 thinking 深度 (off/minimal/low/medium/high/xhigh/max)" })),
  timeoutMs: Type.Optional(Type.Number({ description: "超时毫秒, 默认 900000" })),
  usageBudget: Type.Optional(Type.Number({ description: "累计 input+output+cacheWrite token 上限, 触顶中止" })),
  cwd: Type.Optional(Type.String({ description: "子代理工作目录, 默认继承父会话" })),
  action: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("resume"), Type.Literal("diagnose")], { description: "缺省 = 执行" })),
  id: Type.Optional(Type.String({ description: "resume 目标 run-id; diagnose 目标 (runId 前缀/尾段/batchRunId#index/today)" })),
  since: Type.Optional(Type.String({ description: "diagnose 时间窗: 24h|7d|all (缺省 24h)" })),
  levelMin: Type.Optional(Type.String({ description: "diagnose 最低日志级别: warn|error (缺省 warn)" })),
  limit: Type.Optional(Type.Number({ description: "diagnose 扫描日志条数上限 (缺省 2000)" })),
  writeReport: Type.Optional(Type.Boolean({ description: "diagnose 是否写报告文件到 ~/.pi/subagent_log/diagnose/" })),
});

// M2-D008 条件必填校验 (typebox 不表达, 由 execute 承担): task 与 tasks 互斥且至少其一;
// 单次 (task) 时 agent 必填 (review 修复项 1: 缺 agent 明确报错列用法, 不泄露内部 undefined);
// 未知 agent 报错并列候选名 (M1-D009 error-driven 兜底, 文本形态对齐官方示例 index.ts:276-283:
// `Unknown agent: "X". Available agents: ...`). 并行 tasks[].agent 的逐项检查随 spawn 属 ISSUE-02.
function validateExecuteParams(
  params: { agent?: unknown; task?: unknown; tasks?: unknown } | null | undefined,
  agents: AgentConfig[],
): string | undefined {
  const hasTask = typeof params?.task === "string" && params.task.trim() !== "";
  const hasTasks = Array.isArray(params?.tasks) && (params.tasks as unknown[]).length > 0;

  if (hasTask && hasTasks) {
    return "task 与 tasks 互斥, 只能二选一 (单次: agent + task; 并行: tasks[])";
  }
  if (!hasTask && !hasTasks) {
    return "缺省 action 时须提供 task 或 tasks 至少其一 (单次: agent + task; 并行: tasks[])";
  }

  // M2-D008 执行模式 agent 条件必填: 有 task 无 agent → 明确报错 (列用法, 不泄露内部 undefined).
  if (hasTask && typeof params?.agent !== "string") {
    return "单次执行须提供 agent 名 (action:\"list\" 可省): 用法 {agent: \"<agent 名>\", task: \"<任务>\"}";
  }
  if (hasTask && typeof params?.agent === "string") {
    const known = agents.some((a) => a.name === params.agent);
    if (!known) {
      const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
      return `Unknown agent: "${params.agent}". Available agents: ${available}.`;
    }
  }
  return undefined;
}

// ISSUE-05: parallel 聚合结果类型 — 每 child 独立 isError (M2-D004), details 透传 (runId/sessionDir, M2-D006).
export interface ParallelChildResult {
  index: number;
  agent: string;
  task: string;
  isError: boolean;
  text: string;
  details: SingleDetails;
}
export interface ParallelDetails {
  mode: "parallel";
  runId: string;
  results: ParallelChildResult[];
  progress: ParallelChildProgress[];
}
// ISSUE-03 (F1, M07 D013): per-child 实时进度快照 — 每个 child 预建一行,
// 运行中由 runSingleAgent onUpdate 透传 recentTools/recentOutput/usage/model/isError,
// 汇入聚合 details.progress (深拷贝快照, 防闭包污染).
export interface ParallelChildProgress {
  childIndex: number;
  agent: string;
  recentTools: { tool: string; args: string; endMs: number }[];
  recentOutput: string[];
  usage: Usage;
  model?: string;
  isError: boolean;
  // ISSUE-04 (D008): 调度信号 — 批次开始预建行时 false, L30 scheduled 时置 true (投影 pending/active 判据).
  scheduled?: boolean;
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}


// ISSUE-07 deferred (c): parallel 汇总 per-task 输出 50KB 截断 (官方 :36/:193-202 最小版, 字节安全).
// 导出: 单测直接断言 (TC-011).
export function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

function resultTextOf(res: AgentToolResult<unknown>): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

// EXECUTION.md 调和 12: 批次根 run.json — mode:"parallel" + tasks 快照 (各 child agent/model/tools + task);
// per-child 仅存 run-<idx>/session.jsonl 不写 run.json (原子写: 同目录 tmp + rename, 对齐 single writeRunJson).
function writeParallelRunJson(
  data: {
    runId: string;
    cwd: string;
    startedAt: string;
    tasks: { agent: string; task: string; model?: string; thinking?: string; tools?: string[] }[];
  },
  sessionDir: string,
): void {
  const runJson = {
    runId: data.runId,
    mode: "parallel",
    cwd: data.cwd,
    startedAt: data.startedAt,
    tasks: data.tasks,
  };
  const target = path.join(sessionDir, "run.json");
  const tmp = path.join(sessionDir, "run.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(runJson, null, 2) + "\n");
  fs.renameSync(tmp, target);
}

// ISSUE-05: 官方示例 index.ts:221-240 整搬 — 并发上限 worker 池, 结果按 index 保序, 全部跑完再汇总
// (M3-04 考察点 5: 无全局 Semaphore, limit 由 Math.max/min 钳制).
async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

// ISSUE-05: tasks[] 并行执行 (M2-D004 语义, 官方示例 index.ts:584-663 移植简化).
// 每 child 复用 single 管线 (runSingleAgent) 为执行单元; 全部跑完再汇总, 每任务独立 isError, 不 fail-fast;
// 聚合顶层不置 isError (官方同款), 每任务失败态在 details.results 独立暴露.
async function runParallelTasks(
  params: { tasks?: unknown; model?: unknown; thinking?: unknown; timeoutMs?: unknown; usageBudget?: unknown; cwd?: unknown },
  agents: AgentConfig[],
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: unknown, // M02 D001: 子代理模型窗口查询 (modelRegistry, 强制预算 + contextPercent 同源)
  onUpdate?: StreamUpdateCallback, // ISSUE-07 deferred (b): parallel onUpdate 聚合流
): Promise<AgentToolResult<ParallelDetails>> {
  const tasks = params.tasks as { agent?: unknown; task?: unknown; model?: unknown; thinking?: unknown; timeoutMs?: unknown; usageBudget?: unknown }[];
  // ISSUE-07 deferred (d): item 级 task 校验 (与 single 模式对齐 — 空串/非 string 显式报错, 不静默变空串).
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (typeof t !== "object" || t === null || typeof t.task !== "string" || t.task.trim() === "") {
      return {
        content: [{ type: "text", text: `tasks[${i}].task must be a non-empty string` }],
        details: { mode: "parallel", runId: "", results: [], progress: [] },
        isError: true,
      };
    }
  }
  // 官方示例 index.ts:584-590 (M2-D004 硬顶 8): 超限直接报错, 逐字文案.
  if (tasks.length > MAX_PARALLEL_TASKS) {
    // L29 (warn): 批任务超上限拒绝.
    logEvent({ level: "warn", event: "parallel.batch.too_many", mode: "parallel", data: { count: tasks.length, max: MAX_PARALLEL_TASKS } });
    return {
      content: [{ type: "text", text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
      details: { mode: "parallel", runId: "", results: [], progress: [] },
      isError: true,
    };
  }

  const batchRunId = makeRunId();
  // L28 (info): 并行批次开始.
  logEvent({ level: "info", event: "parallel.batch.start", mode: "parallel", batchRunId, data: { taskCount: tasks.length, concurrency: MAX_CONCURRENCY } });
  const batchRoot = sessionRootDir(batchRunId);
  fs.mkdirSync(batchRoot, { recursive: true });
  // M2-D008: 顶层 model/thinking/timeoutMs/usageBudget 作批默认, item 级字段覆盖 (undefined 回退顶层默认).
  const defaultModel = typeof params.model === "string" && params.model !== "" ? params.model : undefined;
  const defaultThinking = typeof params.thinking === "string" && params.thinking !== "" ? params.thinking : undefined;
  const defaultTimeout = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
  const defaultBudget = params.usageBudget as number | undefined;
  const resolved = tasks.map((t) => {
    const agent = agents.find((a) => a.name === t.agent);
    const model = typeof t.model === "string" && t.model !== "" ? t.model : defaultModel;
    const thinking = typeof t.thinking === "string" && t.thinking !== "" ? t.thinking : defaultThinking;
    const timeoutMs = typeof t.timeoutMs === "number" ? t.timeoutMs : defaultTimeout;
    const explicitBudget = (t.usageBudget as number | undefined) ?? defaultBudget;
    // 强制预算: 每 child 未显式传 budget → 自动 0.7 × 该 child 模型窗口 (与 single 同一解析函数).
    const eff = agent ? resolveEffectiveUsageBudget(explicitBudget, model ?? agent.model, ctx) : undefined;
    const usageBudget = eff?.budget;
    const budgetAuto = eff?.auto;
    return { item: t, agent, model, thinking, timeoutMs, usageBudget, budgetAuto };
  });

  // 批次 run.json (调和 12): tasks 快照含各 child agent/model/tools + task (model 取合并后生效值).
  writeParallelRunJson(
    {
      runId: batchRunId,
      cwd,
      startedAt: new Date().toISOString(),
      tasks: resolved.map((r) => {
        // model/thinking 取完全生效值 (item 覆盖 ?? 顶层默认 ?? agent frontmatter, 对齐 runSingleAgent effectiveModel/effectiveThinking).
        const effectiveModel = r.model ?? r.agent?.model;
        const effectiveThinking = r.thinking ?? r.agent?.thinking;
        return {
          agent: String(r.item.agent),
          task: typeof r.item.task === "string" ? r.item.task : "",
          ...(effectiveModel ? { model: effectiveModel } : {}),
          ...(effectiveThinking ? { thinking: effectiveThinking } : {}),
          ...(r.agent?.tools && r.agent.tools.length > 0 ? { tools: r.agent.tools } : {}),
        };
      }),
    },
    batchRoot,
  );

  // ISSUE-07 deferred (b): parallel onUpdate 聚合流 (官方 :596-608 最小版) — allResults 槽位 (exitCode -1 = running 占位)
  // + completedFlags 计数; 初始 1 次 + 每 child 完成后各 1 次. 不做 per-child 流式镜像 (最小版, 超出 :596-608 范围).
  const allResults: ParallelChildResult[] = tasks.map((t, i) => ({
    index: i, agent: typeof t.agent === "string" ? t.agent : "", task: typeof t.task === "string" ? t.task : "",
    isError: false, text: "(running...)", details: { usage: emptyUsage(), runId: batchRunId, sessionDir: path.join(batchRoot, `run-${i}`), exitCode: -1 },
  }));
  // ISSUE-03 (F1): per-child 进度预建行 (同 allResults 预建, pending → active 转换不丢行) —
  // childIndex/agent 固定, recentTools/recentOutput 空, usage 零值, isError false.
  const childProgress: ParallelChildProgress[] = tasks.map((t, i) => ({
    childIndex: i,
    agent: typeof t.agent === "string" ? t.agent : "",
    recentTools: [],
    recentOutput: [],
    usage: emptyUsage(),
    isError: false,
    scheduled: false, // ISSUE-04 (D008): 未进 worker = pending, L30 时点转 active
  }));
  const completedFlags = new Array<boolean>(tasks.length).fill(false);
  const emitParallelUpdate = () => {
    if (!onUpdate) return;
    const done = completedFlags.filter(Boolean).length;
    onUpdate({ content: [{ type: "text", text: `Parallel: ${done}/${tasks.length} done, ${tasks.length - done} running...` }], details: { mode: "parallel", runId: batchRunId, results: [...allResults], progress: childProgress.map((p) => ({ ...p, recentTools: [...p.recentTools], recentOutput: [...p.recentOutput] })) } });
  };
  emitParallelUpdate(); // 初始 1 次 (全部 running)

  const runChild = async (r: (typeof resolved)[number], index: number): Promise<ParallelChildResult> => {
    // ISSUE-04 (D008): L30 时点标记 scheduled (进 worker 即 active; 投影以此由 pending 转 active).
    childProgress[index].scheduled = true;
    // L30 (info): 子任务调度.
    logEvent({ level: "info", event: "parallel.child.scheduled", mode: "parallel", batchRunId, childIndex: index, agent: r.agent?.name ?? String(r.item.agent) });
    const t = r.item;
    const agent = r.agent;
    const task = typeof t.task === "string" ? t.task : "";
    // per-child 未知 agent → 该任务独立失败 (官方 runSingleAgent 同款, M1-D009 文案), 不阻塞整批 (M2-D004).
    if (!agent) {
      // L32 (error): 未知 agent — 该子任务独立失败, 不阻塞整批.
      logEvent({ level: "error", event: "parallel.child.unknown_agent", mode: "parallel", batchRunId, childIndex: index, agent: String(t.agent) });
      const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
      const failed: ParallelChildResult = { index, agent: String(t.agent), task, isError: true, text: `Unknown agent: "${String(t.agent)}". Available agents: ${available}.`, details: { usage: emptyUsage(), runId: "", sessionDir: "", exitCode: 1 } };
      allResults[index] = failed;
      childProgress[index].isError = true; // ISSUE-03: 未知 agent 分支无流式事件, 进度行直接标记失败
      completedFlags[index] = true;
      // L31 (info): 子任务完成 (unknown-agent 分支).
      logEvent({ level: "info", event: "parallel.child.completed", mode: "parallel", batchRunId, childIndex: index, agent: String(t.agent), data: { isError: true } });
      emitParallelUpdate();
      return failed;
    }
    const res = await runSingleAgent({
      agent,
      task,
      model: r.model,
      thinking: r.thinking,
      cwd,
      timeoutMs: r.timeoutMs,
      usageBudget: r.usageBudget,
      budgetAuto: r.budgetAuto,
      signal,
      ctx, // M02 D001: 子口径 — 窗口查询 (替代旧 getContextUsage 父口径)
      // 调和 12: per-child 共享批次 runId + run-<idx> 子目录, 不写 per-child run.json.
      runId: batchRunId,
      sessionDir: path.join(batchRoot, `run-${index}`),
      skipRunJson: true,
      onUpdate: (partial) => {
        // ISSUE-03 (F1): per-child 流式透传 — 取 child 单次 payload 的 progress 快照/results 槽位,
        // 更新 childProgress[index] 并转发聚合 emitParallelUpdate (节流交给消费侧, 不在此过滤).
        const snap = partial.details.progress?.[0];
        const childRes = partial.details.results?.[0];
        if (snap) {
          childProgress[index].recentTools = snap.recentTools;
          childProgress[index].recentOutput = snap.recentOutput;
        }
        if (childRes) {
          childProgress[index].usage = childRes.usage;
          childProgress[index].model = childRes.model;
          childProgress[index].isError = childRes.stopReason === "error" || childRes.exitCode !== 0;
        }
        emitParallelUpdate();
      },
    });
    const completed: ParallelChildResult = { index, agent: agent.name, task, isError: res.isError === true, text: resultTextOf(res), details: res.details };
    allResults[index] = completed;
    completedFlags[index] = true;
    // L31 (info): 子任务完成 (正常分支).
    logEvent({ level: "info", event: "parallel.child.completed", mode: "parallel", batchRunId, childIndex: index, agent: agent.name, data: { isError: res.isError === true, stopReason: res.details.stopReason } });
    emitParallelUpdate();
    return completed;
  };
  const results = await mapWithConcurrencyLimit(resolved, MAX_CONCURRENCY, async (r, index) => runChild(r, index));

  // M2-D004 汇总 (官方示例 :647-663 形态): 成功计数 + 逐任务状态标记 + per-task 输出 50KB 截断 (deferred c).
  const successCount = results.filter((r) => !r.isError).length;
  const summaries = results.map((r) => {
    const status = r.isError
      ? (r.details.stopReason && r.details.stopReason !== "stop" ? `failed (${r.details.stopReason})` : `failed (exit ${r.details.exitCode})`)
      : "completed";
    return `### [${r.agent}] ${status}\n\n${truncateParallelOutput(r.text)}`;
  });
  return {
    content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
    details: { mode: "parallel", runId: batchRunId, results },
  };
}

// ---- ISSUE-05: Inline Live Run Card (PRD §4.1 变体 C, M07 D001-D005/D008) — 渲染接线 ----
// card.ts 承担全部渲染 (纯函数层 renderRunNodeLines/renderParallelLines + 组件层 renderRunCard/spinner).
// renderCall 预执行帧已去掉 (用户拍板): pi 会把 renderCall 与 renderResult 叠加渲染, 静态预帧的
// model —/ctx — 占位与实际运行卡重复且误导; 运行卡只由 renderResult (projectSlimDetailsToRunNodes) 驱动.

// ---- ISSUE-08 接线: viewer store + overlay 状态 (toggle/fire-and-forget, M01 §4.1 硬约束) ----

const viewerStore = createViewerStore();
let viewerOpen = false;
let viewerClose: (() => void) | null = null;
let lastUi: ViewerUi | null = null; // d 键诊断时复用当前 UI

/** 接线所需 UI 最小面 (ctx.ui 的结构子集; jiti 直跑无类型强制, 仅文档). */
type ViewerUi = {
  custom<T>(factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component, options?: unknown): Promise<T>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
};

// 显示宽度 (CJK 记 2 列) 与折行 (诊断 overlay 用).
function dispLen2(s: string): number {
  let n = 0;
  for (const ch of Array.from(s)) n += (ch.codePointAt(0)! > 0x2e7f) ? 2 : 1;
  return n;
}
function wrapText2(s: string, width: number): string[] {
  if (width <= 0) return [""];
  const out: string[] = [];
  let cur = ""; let curLen = 0;
  for (const ch of s) {
    const w = dispLen2(ch);
    if (curLen + w > width) { out.push(cur); cur = ch; curLen = w; }
    else { cur += ch; curLen += w; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

/** 诊断结果 overlay (全屏, Esc 关闭, ↑/↓ PgUp/PgDn 滚动). */
class DiagnoseOverlay implements Component {
  private raw: string[];
  private scroll = 0;
  private lastWidth = 80;
  private tui: TUI;
  private done: (r: null) => void;
  constructor(raw: string[], tui: TUI, done: (r: null) => void) { this.raw = raw; this.tui = tui; this.done = done; }
  invalidate() {}
  private rows(): number { return Math.max(3, (this.tui.terminal.rows || 24) - 3); }
  private wrapped(width: number): string[] { return this.raw.flatMap((l) => wrapText2(l, width)); }
  private maxScroll(width: number): number { return Math.max(0, this.wrapped(width).length - (this.rows() - 2)); }
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, "escape")) { this.done(null); return; }
    const rows = this.rows();
    const ms = this.maxScroll(this.lastWidth);
    if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, "down")) this.scroll = Math.min(ms, this.scroll + 1);
    else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - rows);
    else if (matchesKey(data, "pageDown")) this.scroll = Math.min(ms, this.scroll + rows);
    else return;
    this.tui.requestRender();
  }
  render(width: number): string[] {
    this.lastWidth = width > 0 ? width : 80;
    const rows = this.rows();
    const wrapped = this.wrapped(this.lastWidth);
    this.scroll = Math.min(this.scroll, this.maxScroll(this.lastWidth));
    const out = ["── subagent diagnose (Esc 关闭) ──", ""];
    out.push(...wrapped.slice(this.scroll, this.scroll + rows - 2));
    return out;
  }
}

/** 打开/关闭 Session Viewer (toggle 语义; 打开 fire-and-forget, 不 await). */
function openViewer(ui: ViewerUi): void {
  lastUi = ui;
  if (viewerOpen && viewerClose) {
    viewerClose();
    viewerOpen = false; viewerClose = null;
    ui.notify("Session Viewer 已关闭", "info");
    return;
  }
  viewerOpen = true;
  void ui.custom<null>(
    (tui, theme, _kb, done) => {
      viewerClose = () => done(null);
      return new SessionViewerComponent({
        tui,
        theme,
        done,
        getLive: () => ({ batches: viewerStore.getBatches() }),
        onClose: () => { viewerOpen = false; viewerClose = null; },
        onDiagnose: (dctx) => { void runDiagnoseFor(dctx); },
      });
    },
    { overlay: true, overlayOptions: { width: "100%", anchor: "center", maxHeight: "100%", margin: { top: 1, bottom: 1 } } },
  );
}

/** 弹诊断结果 overlay (只读展示). */
function openDiagnoseOverlay(ui: ViewerUi, content: string): void {
  const lines = content.split("\n");
  void ui.custom<null>(
    (tui, _theme, _kb, done) => new DiagnoseOverlay(lines, tui, done),
    { overlay: true, overlayOptions: { width: "100%", anchor: "center", maxHeight: "100%", margin: { top: 1, bottom: 1 } } },
  );
}

/** viewer 内 d 键诊断: 关 viewer 后跑 diagnose 并弹结果. */
async function runDiagnoseFor(dctx: DiagnoseContext): Promise<void> {
  const ui = lastUi;
  const r = await runDiagnose({ id: dctx.runId });
  if (!ui) return;
  if (viewerClose) { viewerClose(); viewerOpen = false; viewerClose = null; }
  openDiagnoseOverlay(ui, r.content);
}

export default function (pi: ExtensionAPI) {
  // ISSUE-06 TS-003: session_start 挂点 — 按龄 GC 扫一次 (M2-D005, pi docs/extensions.md 事件表;
  // 测试直接调 runSessionGc hook 函数, 不依赖 pi 内部触发).
  (pi as { on?: (event: "session_start", handler: () => void) => void }).on?.("session_start", () => {
    // L40 (info): session_start 挂点 — 先扫 run 会话 GC, 后扫日志 GC (均 7 日按龄, 各自的 L41/L42/L43).
    logEvent({ level: "info", event: "gc.sessions.start" });
    runSessionGc();
    logEvent({ level: "info", event: "gc.logs.start" });
    runLogGc();
    // ISSUE-08 (D011): viewer 数据源磁盘回补最近 20 批 (GC 之后, 回补当前可见 run).
    try { viewerStore.backfill(sessionsRootDir()); } catch { /* 回补失败不阻断启动 */ }
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: TOOL_DESCRIPTION,
    // System Prompt 面 (与 resolve-skill 同机制): snippet 进 Available tools, guidelines 进 Guidelines.
    // snippet 是 Available tools 单行条目 (每轮常驻) — 承担委派偏置: 把判断从 "要不要派" 翻转为 "为什么不派";
    // 接口形状在 description, task 自包含在 G1, 各司其职零重复.
    promptSnippet: "独立且值得的任务默认委派给子代理, 主会话只留判断与整合.",
    promptGuidelines: [
      // 最大失败模式: task 引用本会话上下文 — 子代理是全新上下文的独立进程.
      "子代理是全新上下文的独立进程: task 必须自包含 (目标/相关文件路径/约束/skill使用建议), 不引用本会话内容.",
      // 真行为约束: 防并行写冲突 (并发 4/上限 8 由 schema 参数描述承担, 不重复).
      "并行适合只读工作 (审查/研究) 或写互不重叠产物的任务; 改动共享文件 (项目代码/配置) 须串行单写.",
      // 内置名册: 职能词 + 选型轴, 完整描述由 agents/*.md frontmatter 承担 (单一真相源);
      // reviewer 委派注意点 (须指定对象/范围/方向) 是描述里没有的操作知识, 必须内联.
      "内置 agents (均全工具, 职能分工): explorer (探查, 返回带出处的发现, 可写研究报告), worker (写/执行任务), reviewer (审查, 证据分级报告, 可写审核文档; 委派须指定被审对象/范围/方向). explorer/reviewer 可写产物但不修改被委派对象, 不执行变更.",
    ],
    parameters: SubagentParams,
    async execute(
      _toolCallId: string,
      _params: unknown,
      _signal: AbortSignal | undefined,
      onUpdate: StreamUpdateCallback | undefined, // M3-02 考察点 6: 流式更新回调透传 single 管线
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult> {
      const params = _params as
        | { action?: unknown; agent?: unknown; task?: unknown; tasks?: unknown; usageBudget?: unknown; model?: unknown; thinking?: unknown; timeoutMs?: unknown; cwd?: unknown; id?: unknown; since?: unknown; levelMin?: unknown; limit?: unknown; writeReport?: unknown }
        | null
        | undefined;

      // L01 (info): 工具调用开始 — 只记脱敏 taskPreview, 不落完整 task; mode 按 action/tasks 推导.
      const execMode: "single" | "parallel" | "list" | "resume" =
        params?.action === "list" ? "list"
        : params?.action === "resume" ? "resume"
        : Array.isArray(params?.tasks) && (params.tasks as unknown[]).length > 0 ? "parallel"
        : "single";
      logEvent({
        level: "info",
        event: "tool.execute.start",
        mode: execMode,
        toolCallId: _toolCallId,
        agent: typeof params?.agent === "string" ? params.agent : undefined,
        taskPreview: typeof params?.task === "string" ? taskPreviewOf(params.task) : undefined,
        timeoutMsExplicit: typeof params?.timeoutMs === "number" ? params.timeoutMs : undefined,
        usageBudgetExplicit: typeof params?.usageBudget === "number" ? params.usageBudget : undefined,
      });

      // ISSUE-08: onUpdate 包一层喂 viewer store (投影→建批→upsert; 失败不阻断流式).
      const feedOnUpdate: StreamUpdateCallback = (partial) => {
        try {
          const nodes = projectSlimDetailsToRunNodes({ toolCallId: _toolCallId, details: partial.details as ProjectionInput["details"] });
          const batch = batchFromLiveNodes(nodes);
          if (batch) viewerStore.upsert(batch);
        } catch { /* 投影/建批失败不阻断 */ }
        onUpdate?.(partial);
      };

      // ISSUE-08: action:"diagnose" — 只读诊断 (PRD §7), 不经执行模式校验层.
      if (params?.action === "diagnose") {
        const dr = await runDiagnose({
          id: typeof params.id === "string" && params.id !== "" ? params.id : undefined,
          since: params.since === "24h" || params.since === "7d" || params.since === "all" ? params.since : undefined,
          levelMin: params.levelMin === "warn" || params.levelMin === "error" ? params.levelMin : undefined,
          limit: typeof params.limit === "number" ? params.limit : undefined,
          writeReport: params.writeReport === true,
        });
        return { content: [{ type: "text", text: dr.content }], details: dr.details };
      }

      // TS-002: action:"list" (M1-D009 最小名册), agent 可省 (M2-D008).
      if (params?.action === "list") {
        const listAgents = discoverAgents();
        // L03 (info): list 发现成功 — count = 名册条数 (行为等价, 仅多一步中间量).
        logEvent({ level: "info", event: "agents.list.ok", mode: "list", data: { count: listAgents.length } });
        return {
          content: [{ type: "text", text: formatAgentList(listAgents) }],
          details: {},
        };
      }

      // TS-003 注释替换 (ISSUE-06): action:"resume" 不经执行模式校验层 (调和 #6: agent 忽略/仅 id+task 必填),
      // 直接分发 runResume (寻址/校验/恢复 spawn/结果标记均在 resume.ts; 锁/GC 见 TS-002/TS-003).
      if (params?.action === "resume") {
        return runResume(params, _ctx, _signal, feedOnUpdate);
      }
      const agents = discoverAgents();
      const validationError = validateExecuteParams(params, agents);
      if (validationError) {
        // L02 (warn): 参数校验失败 — 只记脱敏 preview + 报错文本, 照旧返回错误结果.
        logEvent({
          level: "warn",
          event: "tool.execute.validate_failed",
          agent: typeof params?.agent === "string" ? params.agent : undefined,
          taskPreview: typeof params?.task === "string" ? taskPreviewOf(params.task) : undefined,
          errorMessage: validationError,
        });
        return { content: [{ type: "text", text: validationError }], details: {}, isError: true };
      }

      // ISSUE-05: 并行/single 共用 cwd 与 ctx (M02 D001 子代理口径 — modelRegistry 查询, 替代 ISSUE-03 父口径 getContextUsage,
      // 强制预算 + details.contextPercent 同一窗口源).
      const cwd = typeof params?.cwd === "string" && params.cwd !== "" ? params.cwd : _ctx.cwd;

      // ISSUE-05: tasks[] 并行分支 (M2-D004/M2-D008; per-child 未知 agent 走独立失败, 不阻塞整批).
      if (Array.isArray(params?.tasks) && (params.tasks as unknown[]).length > 0) {
        return runParallelTasks(params, agents, cwd, _signal, _ctx, feedOnUpdate);
      }
      // 校验层已保证 agent 存在 (缺 agent/未知 agent 均已在 validateExecuteParams 拦截), 此处 find 必命中.
      const agent = agents.find((a) => a.name === (params?.agent as string))!;
      const task = typeof params?.task === "string" ? params.task : "";
      const model = typeof params?.model === "string" && params.model !== "" ? params.model : undefined;
      const thinking = typeof params?.thinking === "string" && params.thinking !== "" ? params.thinking : undefined;
      // ISSUE-03: timeoutMs 参数提取 — 原始数值透传 (0/负数/NaN/非整数由 runSingleAgent 校验层统一兜底报错,
      // 修复前被此处 >0 过滤成 undefined 静默按默认 15min 跑, 校验层不可达).
      const timeoutMs = typeof params?.timeoutMs === "number" ? params.timeoutMs : undefined;
      // ISSUE-04: usageBudget 原始值透传 (纯 number 正数由 runSingleAgent 校验层统一兜底报错, 不在此过滤 —
      // 过滤会掩盖 0/负数/NaN/非 number 等非法值, 校验层不可达).
      const explicitBudget = params?.usageBudget as number | undefined;
      // 强制预算 (用户协议): 未显式传 → 自动 0.7 × 子代理模型窗口 (window 查询 modelRegistry, 与父会话同源);
      // 载荷携带 budget/auto 供父会话诊断 (中止 content 亦报出).
      const eff = resolveEffectiveUsageBudget(explicitBudget, model ?? agent.model, _ctx);
      // TS-004: 取消监听 (AbortSignal) 透传 — abort → SIGTERM → 3s SIGKILL (M3-01 考察点 4);
      // 本切片: onUpdate 透传 (M3-02 考察点 6 触发点/payload 见 single.ts).
      return runSingleAgent({ agent, task, model, thinking, cwd, timeoutMs, usageBudget: eff.budget, budgetAuto: eff.auto, ctx: _ctx, signal: _signal, onUpdate: feedOnUpdate });
    },
    // renderCall 预执行帧去掉 (用户拍板): 返回空组件, 运行卡只由 renderResult 驱动.
    renderCall(_args, _theme, _context) {
      return new Text("", 0, 0);
    },
    // ISSUE-05: renderResult 接线 — details → projectSlimDetailsToRunNodes (ISSUE-04) → 卡组件;
    // 第 4 参 context (ToolRenderContext) 传给 spinner (未 settle 时 90ms invalidate 驱动重绘, settled 即停).
    renderResult(result, { expanded }, theme, context) {
      try {
        const nodes = projectSlimDetailsToRunNodes({
          toolCallId: (context as { toolCallId?: string } | undefined)?.toolCallId ?? "",
          details: (result.details ?? {}) as ProjectionInput["details"],
        });
        if (!nodes || nodes.length === 0) return new Text(theme.fg("muted", "(no run data)"), 0, 0);
        return renderRunCard(nodes, { density: "cozy", expanded }, context as { invalidate?: () => void } | undefined);
      } catch (e) {
        // L44 (warn): renderResult 异常 → 记日志 + 最简占位 (不影响主流程/返回).
        logEvent({ level: "warn", event: "render.update.failed", errorMessage: (e as Error).message });
        return new Text("subagent result", 0, 0);
      }
    },
  });

  // ---- ISSUE-08: 命令面 + 快捷键 (M07 D009) ----

  pi.registerCommand("agent-sessions", {
    description: "打开/关闭 subagent Session Viewer (Timeline + 子代理会话; Esc 关闭)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) { ctx.ui.notify("Session Viewer 需要 tui 模式", "warning"); return; }
      openViewer(ctx.ui as unknown as ViewerUi);
    },
  });

  pi.registerCommand("agent-diagnose", {
    description: "诊断 subagent 运行 (无参 = 最近 24h warn+; 可带 [runId 前缀|尾段|batch#idx|today] [24h|7d|all])",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const id = parts[0] || undefined;
      const since = (parts[1] === "24h" || parts[1] === "7d" || parts[1] === "all") ? (parts[1] as "24h" | "7d" | "all") : undefined;
      const dr = await runDiagnose({ id, since });
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify(dr.content.split("\n")[0] ?? "诊断完成", "info");
        return;
      }
      openDiagnoseOverlay(ctx.ui as unknown as ViewerUi, dr.content);
    },
  });

  pi.registerShortcut("alt+v", {
    description: "打开/关闭 subagent Session Viewer (capturing overlay, Esc 关闭)",
    handler: (ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) return;
      try { openViewer(ctx.ui as unknown as ViewerUi); } catch { /* 热载后旧 ctx 失效等, 忽略 */ }
    },
  });
}
