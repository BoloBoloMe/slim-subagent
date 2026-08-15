/**
 * subagent-panel-proto — 回放驱动
 *
 * 时序表 (M03 对照真实分布):
 *   single  7 步 [0,700,1400,1900,2500,3100,3800]ms   (对照 slim-subagent/single.ts:811-904)
 *   parallel 5 步 [0,1500,2300,3200,4000]ms           (对照 slim-subagent/index.ts:265-285)
 * M04 新增:
 *   storm             single, 40 步 @ ~50ms, 轮换 recentTools/recentOutput (连绘噪音考察)
 *   parallel-pending  parallel, 6 child, 并发槽 4, 2 个先 pending 后转 active
 *
 * 每次 buildDetails 返回完整 ProtoDetails {nodes: RunNode[] 全量快照};
 * JSONL 日志: 默认 /tmp/subagent-panel-proto/replay.log, PI_SUBAGENT_PROTO_LOG 可覆盖.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProtoDetails, ProtoRunNode, SlimUsage, DisplayStatus } from "./types.ts";

/** 热载标记: harness 会改 v1→v2 验证 /reload */
export const MARKER = "proto-v1";

const DEFAULT_LOG = "/tmp/subagent-panel-proto/replay.log";

export function getLogFile(): string {
  return process.env.PI_SUBAGENT_PROTO_LOG || DEFAULT_LOG;
}

export function logEvent(obj: Record<string, unknown>): void {
  try {
    const file = getLogFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...obj, marker: MARKER }) + "\n");
  } catch {
    // 日志落盘失败不阻塞回放 (L08 降级语义)
  }
}

export interface ReplayStepSpec {
  index: number;
  kind: string;
  atMs: number;
  text: string;
}

export interface ReplayDef {
  mode: "single" | "parallel";
  scenario: string;
  steps: ReplayStepSpec[];
  buildDetails: (stepIndex: number, startedAtMs: number) => ProtoDetails;
}

export const SINGLE_SCHEDULE = [0, 700, 1400, 1900, 2500, 3100, 3800];
export const SINGLE_KINDS = [
  "initial",
  "message_end",
  "tool_start",
  "tool_end",
  "tool_result_end",
  "message_end",
  "close",
];
export const PARALLEL_SCHEDULE = [0, 1500, 2300, 3200, 4000];
export const PARALLEL_KINDS = ["initial", "message_end", "message_end", "message_end", "close"];

export function createReplay(mode: "single" | "parallel", scenario: string): ReplayDef {
  if (mode === "single") {
    if (scenario === "storm") return createStormReplay();
    if (scenario === "failed") return createSingleReplay("failed");
    if (scenario === "timeout") return createSingleReplay("timeout");
    return createSingleReplay("success");
  }
  if (scenario === "parallel-pending") return createParallelPendingReplay();
  return createParallelReplay();
}

// ---------------------------------------------------------------------------
// single
// ---------------------------------------------------------------------------

interface SingleFake {
  agent: string;
  task: string;
  texts: string[]; // 每步 text
  usages: SlimUsage[];
  recentOutput: (string[] | undefined)[];
  recentTools: { tool: string; argsPreview: string }[] | undefined; // 出现在 tool_end
  activeTool: { name: string; argsPreview: string } | undefined; // 出现在 tool_start
  finalStatus: DisplayStatus;
  stopReason?: string;
  errorMessage?: string;
  timeoutMsExplicit?: number;
  usageBudgetExplicit?: number;
}

const SINGLE_FAKE: Record<string, SingleFake> = {
  success: {
    agent: "explorer",
    task: "搜索当前目录结构, 找到 3 个候选入口",
    texts: [
      "(running...)",
      "开始分析目录结构...",
      "read src/index.ts",
      "read src/index.ts 完成",
      "(running...)",
      "已读取 src/index.ts, 找到 3 个候选入口",
      "任务完成: 找到 3 个候选入口",
    ],
    usages: [
      { input: 1200, output: 400, cacheRead: 0, cacheWrite: 300, cost: 0.0031, turns: 0 },
      { input: 5200, output: 1400, cacheRead: 0, cacheWrite: 800, cost: 0.0112, turns: 1 },
      { input: 6100, output: 1600, cacheRead: 0, cacheWrite: 800, cost: 0.0135, turns: 1 },
      { input: 7000, output: 1900, cacheRead: 0, cacheWrite: 900, cost: 0.0161, turns: 1 },
      { input: 8900, output: 2200, cacheRead: 0, cacheWrite: 1200, cost: 0.0204, turns: 1 },
      { input: 12100, output: 3400, cacheRead: 0, cacheWrite: 800, cost: 0.0412, turns: 2 },
      { input: 12100, output: 3400, cacheRead: 0, cacheWrite: 800, cost: 0.0412, turns: 2 },
    ],
    recentOutput: [undefined, ["开始分析目录结构..."], undefined, undefined, undefined, ["开始分析目录结构...", "已读取 src/index.ts, 找到 3 个候选入口"], ["开始分析目录结构...", "已读取 src/index.ts, 找到 3 个候选入口"]],
    recentTools: [{ tool: "read", argsPreview: "src/index.ts" }],
    activeTool: { name: "read", argsPreview: "src/index.ts" },
    finalStatus: "done",
    timeoutMsExplicit: 300000, // PRD §4.1 样例: timeout 300s · cap 50k
    usageBudgetExplicit: 50000,
  },
  failed: {
    agent: "reviewer",
    task: "审查登录模块",
    texts: [
      "(running...)",
      "开始审查登录模块...",
      "grep pattern=user_session src/",
      "grep 完成",
      "(running...)",
      "发现疑似空指针风险 2 处",
      "审查失败: 登录模块存在 2 处未处理的空指针风险",
    ],
    usages: [
      { input: 900, output: 300, cacheRead: 0, cacheWrite: 100, cost: 0.0021, turns: 0 },
      { input: 4100, output: 1100, cacheRead: 0, cacheWrite: 500, cost: 0.0091, turns: 1 },
      { input: 4800, output: 1200, cacheRead: 0, cacheWrite: 500, cost: 0.0102, turns: 1 },
      { input: 5400, output: 1400, cacheRead: 0, cacheWrite: 600, cost: 0.0118, turns: 1 },
      { input: 6900, output: 1700, cacheRead: 0, cacheWrite: 700, cost: 0.0149, turns: 1 },
      { input: 8300, output: 2100, cacheRead: 0, cacheWrite: 600, cost: 0.0181, turns: 2 },
      { input: 8300, output: 2100, cacheRead: 0, cacheWrite: 600, cost: 0.0181, turns: 2 },
    ],
    recentOutput: [undefined, ["开始审查登录模块..."], undefined, undefined, undefined, ["开始审查登录模块...", "发现疑似空指针风险 2 处"], ["开始审查登录模块...", "发现疑似空指针风险 2 处"]],
    recentTools: [{ tool: "grep", argsPreview: "pattern=user_session src/" }],
    activeTool: { name: "grep", argsPreview: "pattern=user_session src/" },
    finalStatus: "failed",
    stopReason: "error",
    errorMessage: "审查失败: 登录模块存在 2 处未处理的空指针风险",
    timeoutMsExplicit: 300000,
  },
  timeout: {
    agent: "explorer",
    task: "深度搜索当前代码库",
    texts: [
      "(running...)",
      "开始深度搜索...",
      "find .",
      "find 完成",
      "(running...)",
      "搜索范围过大, 仍在遍历...",
      "运行超过 90s 超时",
    ],
    usages: [
      { input: 1500, output: 500, cacheRead: 0, cacheWrite: 200, cost: 0.0038, turns: 0 },
      { input: 6100, output: 1600, cacheRead: 0, cacheWrite: 700, cost: 0.0131, turns: 1 },
      { input: 7200, output: 1800, cacheRead: 0, cacheWrite: 700, cost: 0.0152, turns: 1 },
      { input: 8000, output: 2000, cacheRead: 0, cacheWrite: 900, cost: 0.0172, turns: 1 },
      { input: 9900, output: 2400, cacheRead: 0, cacheWrite: 1000, cost: 0.0211, turns: 1 },
      { input: 13200, output: 3100, cacheRead: 0, cacheWrite: 900, cost: 0.0284, turns: 2 },
      { input: 13200, output: 3100, cacheRead: 0, cacheWrite: 900, cost: 0.0284, turns: 2 },
    ],
    recentOutput: [undefined, ["开始深度搜索..."], undefined, undefined, undefined, ["开始深度搜索...", "搜索范围过大, 仍在遍历..."], ["开始深度搜索...", "搜索范围过大, 仍在遍历..."]],
    recentTools: [{ tool: "find", argsPreview: "." }],
    activeTool: { name: "find", argsPreview: "." },
    finalStatus: "timeout",
    stopReason: "timeout",
    errorMessage: "运行超过 90s 超时",
    timeoutMsExplicit: 90000, // M03: single timeout 有 timeout 90s
  },
};

function makeSingleNode(fake: SingleFake, i: number, base: number): ProtoRunNode {
  const at = SINGLE_SCHEDULE[i];
  const isFinal = i === SINGLE_SCHEDULE.length - 1;
  const progress = { recentTools: [] as { tool: string; argsPreview: string; endMs: number }[], recentOutput: [] as string[] };
  if (i >= 3 && fake.recentTools) {
    progress.recentTools = [{ ...fake.recentTools[0], endMs: at }];
  }
  if (fake.recentOutput[i]) progress.recentOutput = fake.recentOutput[i]!;
  const node: ProtoRunNode = {
    id: `run-proto-${base}`,
    kind: "single",
    agent: fake.agent,
    taskPreview: fake.task,
    status: isFinal ? fake.finalStatus : "active",
    isError: isFinal && fake.finalStatus !== "done",
    startedAtMs: base,
    usage: fake.usages[i],
    model: "openai/x",
    modelSource: isFinal ? "details" : "call-params",
    contextPercent: isFinal ? 18 : 18,
    progress,
  };
  if (fake.activeTool && i === 2) node.activeTool = { ...fake.activeTool, sinceMs: 0 };
  if (fake.timeoutMsExplicit !== undefined) node.timeoutMsExplicit = fake.timeoutMsExplicit;
  if (fake.usageBudgetExplicit !== undefined) node.usageBudgetExplicit = fake.usageBudgetExplicit;
  if (isFinal && fake.finalStatus !== "done") {
    node.stopReason = fake.stopReason;
    node.errorMessage = fake.errorMessage;
  }
  if (isFinal) node.endedAtMs = base + at;
  return node;
}

function createSingleReplay(scenario: "success" | "failed" | "timeout"): ReplayDef {
  const fake = SINGLE_FAKE[scenario];
  return {
    mode: "single",
    scenario,
    steps: SINGLE_SCHEDULE.map((atMs, i) => ({ index: i, kind: SINGLE_KINDS[i], atMs, text: fake.texts[i] })),
    buildDetails: (stepIndex, startedAtMs) => ({
      mode: "single",
      nodes: [makeSingleNode(fake, stepIndex, startedAtMs)],
    }),
  };
}

// ---------------------------------------------------------------------------
// parallel (4 child: worker/reviewer/explorer/linter)
// ---------------------------------------------------------------------------

interface ChildFake {
  agent: string;
  task: string;
  model?: string;
  contextPercent?: number | null;
  timeoutMsExplicit?: number;
  usageBudgetExplicit?: number;
  finishStatus?: "done" | "failed";
  finishAt?: number; // atMs 完成
  errorMessage?: string;
  stopReason?: string;
  recentTools?: { tool: string; argsPreview: string }[];
  recentOutput?: string[];
}

const PARALLEL_CHILDREN: ChildFake[] = [
  { agent: "worker", task: "重构 utils 模块", model: "a/fast", contextPercent: 12, timeoutMsExplicit: 60000, finishStatus: "done", finishAt: 1500, recentTools: [{ tool: "edit", argsPreview: "src/utils.ts" }], recentOutput: ["重构完成"] },
  { agent: "reviewer", task: "审查登录模块", model: "b/pro", contextPercent: 31, usageBudgetExplicit: 80000, finishStatus: "failed", finishAt: 2300, errorMessage: "审查失败: 登录模块存在 2 处未处理的空指针风险", stopReason: "error", recentTools: [{ tool: "grep", argsPreview: "login" }], recentOutput: ["发现 2 处空指针风险"] },
  { agent: "explorer", task: "搜索当前目录结构", model: "openai/x", contextPercent: 18, timeoutMsExplicit: 300000, finishStatus: "done", finishAt: 3200, recentTools: [{ tool: "read", argsPreview: "src/" }], recentOutput: ["找到 3 个候选入口"] },
  { agent: "linter", task: "运行 lint 检查", model: "openai/x", contextPercent: 22, finishStatus: "done", finishAt: 4000, recentTools: [{ tool: "bash", argsPreview: "pnpm lint" }], recentOutput: ["lint 通过"] },
];

const CHILD_USAGE: Record<number, SlimUsage> = {
  0: { input: 8100, output: 2000, cacheRead: 0, cacheWrite: 900, cost: 0.0161, turns: 2 },
  1: { input: 6800, output: 1700, cacheRead: 0, cacheWrite: 700, cost: 0.0142, turns: 2 },
  2: { input: 7400, output: 1900, cacheRead: 0, cacheWrite: 800, cost: 0.0153, turns: 2 },
  3: { input: 4300, output: 1100, cacheRead: 0, cacheWrite: 500, cost: 0.0092, turns: 2 },
};

function childStatusAt(child: ChildFake, i: number): DisplayStatus {
  if (child.finishAt === undefined) return "active";
  if (child.finishStatus === "done" && child.finishAt <= PARALLEL_SCHEDULE[i]) return "done";
  if (child.finishStatus === "failed" && child.finishAt <= PARALLEL_SCHEDULE[i]) return "failed";
  return "active";
}

function makeParallelDetails(i: number, base: number, children: ChildFake[], scenario: string): ProtoDetails {
  const batchRunId = `batch-proto-${base}`;
  const at = PARALLEL_SCHEDULE[i];
  const isFinal = i === PARALLEL_SCHEDULE.length - 1;
  const doneCount = children.filter((c) => c.finishAt !== undefined && c.finishAt <= at).length;
  const failedCount = children.filter((c) => c.finishStatus === "failed" && c.finishAt !== undefined && c.finishAt <= at).length;
  const root: ProtoRunNode = {
    id: batchRunId,
    kind: "parallel-root",
    agent: "batch",
    taskPreview: `并行执行 ${children.length} 个子代理任务`,
    status: isFinal ? "done" : "active",
    startedAtMs: base,
    model: "openai/x",
    modelSource: "call-params",
    contextPercent: 18,
    usage: {
      input: 26600, output: 6700, cacheRead: 0, cacheWrite: 2900, cost: 0.0548, turns: 8,
    },
    progress: { done: doneCount, total: children.length },
  };
  if (isFinal) root.endedAtMs = base + at;
  const nodes: ProtoRunNode[] = [root];
  for (let ci = 0; ci < children.length; ci++) {
    const c = children[ci];
    const status = childStatusAt(c, i);
    const child: ProtoRunNode = {
      id: `${batchRunId}#${ci}`,
      kind: "parallel-child",
      parentId: batchRunId,
      agent: c.agent,
      taskPreview: c.task,
      status,
    };
    if (status === "done" || status === "failed") {
      child.endedAtMs = base + (c.finishAt ?? at);
      child.usage = CHILD_USAGE[ci];
      child.model = c.model;
      child.modelSource = "details";
      child.contextPercent = c.contextPercent ?? null;
      if (c.finishStatus === "failed") {
        child.isError = true;
        child.errorMessage = c.errorMessage;
        child.stopReason = c.stopReason;
      }
      if (c.recentTools) child.progress = { recentTools: c.recentTools.map((t) => ({ ...t, endMs: c.finishAt ?? at })), recentOutput: c.recentOutput ?? [] };
    } else if (status === "active") {
      child.startedAtMs = base; // 第一批即进 worker
      child.model = c.model;
      child.modelSource = "call-params";
      child.contextPercent = c.contextPercent ?? null;
      child.usage = { input: 1200 + ci * 300, output: 300 + ci * 100, cacheRead: 0, cacheWrite: 200, cost: 0.0021, turns: 1 };
    }
    if (c.timeoutMsExplicit !== undefined) child.timeoutMsExplicit = c.timeoutMsExplicit;
    if (c.usageBudgetExplicit !== undefined) child.usageBudgetExplicit = c.usageBudgetExplicit;
    nodes.push(child);
  }
  return { mode: "parallel", nodes, batchRunId, batch: { total: children.length, done: doneCount, failed: failedCount, concurrency: 4 }, usage: root.usage };
}

function createParallelReplay(): ReplayDef {
  return {
    mode: "parallel",
    scenario: "success",
    steps: PARALLEL_SCHEDULE.map((atMs, i) => {
      const done = PARALLEL_CHILDREN.filter((c) => c.finishAt !== undefined && c.finishAt <= atMs).length;
      const total = PARALLEL_CHILDREN.length;
      const running = total - done;
      return {
        index: i,
        kind: PARALLEL_KINDS[i],
        atMs,
        text: done === total ? `Parallel: ${done}/${total} done, batch finished.` : `Parallel: ${done}/${total} done, ${running} running...`,
      };
    }),
    buildDetails: (stepIndex, startedAtMs) => makeParallelDetails(stepIndex, startedAtMs, PARALLEL_CHILDREN, "success"),
  };
}

// ---------------------------------------------------------------------------
// parallel-pending (6 child, 并发槽 4, 后排先 pending)
// ---------------------------------------------------------------------------

export const PENDING_SCHEDULE = [0, 1500, 2300, 3200, 4000, 4700, 5400];
export const PENDING_KINDS = ["initial", "child_done", "child_failed", "child_done", "child_done", "child_done", "close"];

const PENDING_CHILDREN: ChildFake[] = [
  { agent: "worker", task: "重构 utils 模块", model: "a/fast", contextPercent: 12, timeoutMsExplicit: 60000, finishStatus: "done", finishAt: 1500, recentTools: [{ tool: "edit", argsPreview: "src/utils.ts" }], recentOutput: ["重构完成"] },
  { agent: "reviewer", task: "审查登录模块", model: "b/pro", contextPercent: 31, usageBudgetExplicit: 80000, finishStatus: "failed", finishAt: 2300, errorMessage: "审查失败: 登录模块存在 2 处未处理的空指针风险", stopReason: "error", recentTools: [{ tool: "grep", argsPreview: "login" }], recentOutput: ["发现 2 处空指针风险"] },
  { agent: "explorer", task: "搜索当前目录结构", model: "openai/x", contextPercent: 18, timeoutMsExplicit: 300000, finishStatus: "done", finishAt: 3200, recentTools: [{ tool: "read", argsPreview: "src/" }], recentOutput: ["找到 3 个候选入口"] },
  { agent: "linter", task: "运行 lint 检查", model: "openai/x", contextPercent: 22, finishStatus: "done", finishAt: 4000, recentTools: [{ tool: "bash", argsPreview: "pnpm lint" }], recentOutput: ["lint 通过"] },
  { agent: "worker", task: "清理临时文件", model: "openai/x", contextPercent: null, finishStatus: "done", finishAt: 4700, recentTools: [{ tool: "bash", argsPreview: "rm -rf tmp" }], recentOutput: ["清理完成"] },
  { agent: "explorer", task: "收集测试用例", model: "openai/x", contextPercent: null, finishStatus: "done", finishAt: 5400, recentTools: [{ tool: "find", argsPreview: "test/" }], recentOutput: ["收集 12 个用例"] },
];

/** pending→active 转 active 的调度时刻 (并发槽 4: c0 完成 → c4 进槽; c1 完成 → c5 进槽) */
const PENDING_ACTIVATE_AT: Record<number, number> = { 4: 1500, 5: 2300 };

function makePendingDetails(i: number, base: number): ProtoDetails {
  const batchRunId = `batch-pending-${base}`;
  const at = PENDING_SCHEDULE[i];
  const isFinal = i === PENDING_SCHEDULE.length - 1;
  const doneCount = PENDING_CHILDREN.filter((c) => c.finishAt !== undefined && c.finishAt <= at).length;
  const failedCount = PENDING_CHILDREN.filter((c) => c.finishStatus === "failed" && c.finishAt !== undefined && c.finishAt <= at).length;
  const root: ProtoRunNode = {
    id: batchRunId,
    kind: "parallel-root",
    agent: "batch",
    taskPreview: `并行执行 ${PENDING_CHILDREN.length} 个子代理任务 (并发 4)`,
    status: isFinal ? "done" : "active",
    startedAtMs: base,
    model: "openai/x",
    modelSource: "call-params",
    contextPercent: 18,
    usage: { input: 31200, output: 9100, cacheRead: 0, cacheWrite: 4200, cost: 0.2210, turns: 12 },
    progress: { done: doneCount, total: PENDING_CHILDREN.length },
  };
  if (isFinal) root.endedAtMs = base + at;
  const nodes: ProtoRunNode[] = [root];
  for (let ci = 0; ci < PENDING_CHILDREN.length; ci++) {
    const c = PENDING_CHILDREN[ci];
    const activateAt = PENDING_ACTIVATE_AT[ci];
    // 并发槽 4 内的 child 第一批即 active; 后排 (ci>=4) 先 pending, 槽位释放后转 active
    let status: DisplayStatus = ci >= 4 ? "pending" : "active";
    if (activateAt !== undefined && activateAt <= at) status = "active";
    if (c.finishAt !== undefined && c.finishAt <= at) status = c.finishStatus === "failed" ? "failed" : "done";
    const child: ProtoRunNode = {
      id: `${batchRunId}#${ci}`,
      kind: "parallel-child",
      parentId: batchRunId,
      agent: c.agent,
      taskPreview: c.task,
      status,
    };
    if (status === "done" || status === "failed") {
      child.endedAtMs = base + (c.finishAt ?? at);
      child.usage = CHILD_USAGE[ci % 4];
      child.model = c.model;
      child.modelSource = "details";
      child.contextPercent = c.contextPercent ?? null;
      if (c.finishStatus === "failed") {
        child.isError = true;
        child.errorMessage = c.errorMessage;
        child.stopReason = c.stopReason;
      }
      if (c.recentTools) child.progress = { recentTools: c.recentTools.map((t) => ({ ...t, endMs: c.finishAt ?? at })), recentOutput: c.recentOutput ?? [] };
    } else if (status === "active") {
      child.startedAtMs = base + (activateAt ?? 0); // 转 active 时刻
      child.model = c.model;
      child.modelSource = "call-params";
      child.contextPercent = c.contextPercent ?? null;
      child.usage = { input: 900 + ci * 200, output: 200 + ci * 100, cacheRead: 0, cacheWrite: 100, cost: 0.0018, turns: 1 };
    }
    // pending: 无 model/ctx/elapsed/usage (PRD §4.1), 不伪造
    if (c.timeoutMsExplicit !== undefined) child.timeoutMsExplicit = c.timeoutMsExplicit;
    if (c.usageBudgetExplicit !== undefined) child.usageBudgetExplicit = c.usageBudgetExplicit;
    nodes.push(child);
  }
  return { mode: "parallel", nodes, batchRunId, batch: { total: PENDING_CHILDREN.length, done: doneCount, failed: failedCount, concurrency: 4 }, usage: root.usage };
}

function createParallelPendingReplay(): ReplayDef {
  const texts = PENDING_SCHEDULE.map((atMs, i) => {
    const d = makePendingDetails(i, 0);
    const st = d.nodes.slice(1).map((n) => n.status).join("/");
    return `pending#${i} [${st}]`;
  });
  return {
    mode: "parallel",
    scenario: "parallel-pending",
    steps: PENDING_SCHEDULE.map((atMs, i) => ({ index: i, kind: PENDING_KINDS[i], atMs, text: texts[i] })),
    buildDetails: (stepIndex, startedAtMs) => makePendingDetails(stepIndex, startedAtMs),
  };
}

// ---------------------------------------------------------------------------
// storm (single, 40 步 @ ~50ms, 轮换 recentTools/recentOutput 暴露连绘噪音)
// ---------------------------------------------------------------------------

const STORM_STEPS = 40;
const STORM_INTERVAL = 50;
const STORM_TOOLS = [
  { tool: "read", argsPreview: "src/index.ts" },
  { tool: "grep", argsPreview: '"subagent" src/' },
  { tool: "find", argsPreview: ". -name *.ts" },
  { tool: "ls", argsPreview: "src/components" },
];
const STORM_OUTPUTS = ["找到 3 个候选入口…", "分析模块依赖…", "lint 通过…"];

function makeStormDetails(i: number, base: number): ProtoDetails {
  const toolCount = i % 4; // 0..3 轮换 → 行数变化 → 连绘高度抖动
  const outCount = i % 3;
  const recentTools: { tool: string; argsPreview: string; endMs: number }[] = [];
  for (let t = 0; t < toolCount; t++) {
    const item = STORM_TOOLS[(i + t) % STORM_TOOLS.length];
    recentTools.push({ ...item, endMs: i * STORM_INTERVAL });
  }
  const recentOutput: string[] = [];
  for (let o = 0; o < outCount; o++) recentOutput.push(STORM_OUTPUTS[(i + o) % STORM_OUTPUTS.length]);
  const node: ProtoRunNode = {
    id: `run-storm-${base}`,
    kind: "single",
    agent: "explorer",
    taskPreview: "压力测试 recentTools/recentOutput 连绘 (16ms 节流)",
    status: "active",
    startedAtMs: base,
    usage: { input: 3000 + i * 220, output: 800 + i * 60, cacheRead: 0, cacheWrite: 400 + i * 30, cost: 0.004 + i * 0.0004, turns: 1 },
    model: "openai/x",
    modelSource: "call-params",
    contextPercent: 17 + (i % 4),
    progress: { recentTools, recentOutput },
  };
  if (i % 2 === 1) node.activeTool = { name: STORM_TOOLS[i % STORM_TOOLS.length].tool, argsPreview: STORM_TOOLS[i % STORM_TOOLS.length].argsPreview, sinceMs: 0 };
  return { mode: "single", nodes: [node] };
}

function createStormReplay(): ReplayDef {
  return {
    mode: "single",
    scenario: "storm",
    steps: Array.from({ length: STORM_STEPS }, (_, i) => ({
      index: i,
      kind: i === 0 ? "initial" : "update",
      atMs: i * STORM_INTERVAL,
      text: `storm #${i} t=${i % 4} o=${i % 3}`,
    })),
    buildDetails: (stepIndex, startedAtMs) => makeStormDetails(stepIndex, startedAtMs),
  };
}
