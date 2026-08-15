/**
 * subagent-panel-proto — 数据契约 (PRD §3 观测数据契约)
 *
 * 直接复用 slim-subagent 目标契约 (RunNode/SlimUsage/DisplayStatus);
 * M04 原型在 RunNode 上增加 activeTool 扩展字段 (工具卡渲染用, 非仓库字段).
 */

export type ProtoMode = "single" | "parallel";

export type SlimUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
};

export type DisplayStatus =
  | "pending" // 仅 parallel child: 批次开始预建行, 未进 worker
  | "active"
  | "done"
  | "failed"
  | "timeout"
  | "budget"
  | "cancelled"
  | "attention";

export interface ProtoProgress {
  recentTools?: { tool: string; argsPreview: string; endMs: number }[];
  recentOutput?: string[];
  done?: number;
  total?: number;
}

export interface ProtoDiagnostics {
  contextTokens?: number;
  contextPercent?: number | null;
  contextWindow?: number;
  usageBudget?: number;
  budgetAuto?: boolean;
  partialOutput?: string;
  hint?: string;
  sessionSaved?: boolean;
}

/** PRD §3 RunNode 契约 (最小可展示子集, 与仓库一致) */
export interface RunNode {
  id: string; // single/resume: runId; parallel child: `${batchRunId}#${index}`
  kind: "single" | "parallel-root" | "parallel-child" | "resume";
  parentId?: string;
  agent: string;
  taskPreview: string; // ≤120 字符, 单行化
  status: DisplayStatus;
  isError?: boolean;
  startedAtMs?: number;
  endedAtMs?: number;
  endedAtMsSource?: "details" | "run.json" | "mtime-approx";
  usage?: SlimUsage;
  model?: string; // 未知 `—`
  modelSource?: "details" | "run.json" | "call-params" | "message" | "unknown";
  timeoutMsExplicit?: number; // 仅显式设置才填
  usageBudgetExplicit?: number; // 仅显式设置才填; 自动 70% 不进 Panel 行
  contextPercent?: number | null; // 子代理口径; 未知 null
  stopReason?: string;
  errorMessage?: string;
  runId?: string;
  sessionDir?: string;
  logCursor?: { file?: string; lastEventId?: string };
  progress?: ProtoProgress;
  diagnostics?: ProtoDiagnostics;
}

/** M04 原型扩展字段: 当前 active 工具 (工具卡 activeTool 段用) */
export interface ProtoRunNode extends RunNode {
  activeTool?: { name: string; argsPreview: string; sinceMs?: number };
}

export interface ProtoBatchInfo {
  total: number;
  done: number;
  failed: number;
  concurrency: number;
}

/** onUpdate/final result.details 的完整快照 (面板 store 语义: 同 key 覆盖) */
export interface ProtoDetails {
  mode: ProtoMode;
  nodes: ProtoRunNode[]; // 全量快照, 首节点为 single node 或 parallel-root
  batchRunId?: string;
  batch?: ProtoBatchInfo;
  usage?: SlimUsage; // 顶层聚合 usage (parallel)
}
