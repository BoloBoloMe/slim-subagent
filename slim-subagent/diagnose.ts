// slim-subagent diagnose — ISSUE-07 (PRD §7 + §10 验收 11-14).
// 职责: 只读诊断分析器 — target 解析 (runId 前缀/随机尾段/batchRunId#index/today, 歧义报错列候选) +
// 日志证据收集 (logRoot 下 subagent-*.log, 按 since/levelMin 过滤, 按 runId/nodeId/toolCallId 聚类) +
// sessions 关联 (run.json/session.jsonl / parallel child run-<idx>) + 启发式 findings (PRD §7.2 类别清单)
// + 中文结论 content + details (findings/evidenceRefs/reportPath) + writeReport 落 <logRoot>/diagnose/*.md.
// 纪律 (PRD §7.2/§11): 不自动修复/不重启 run/不改代码; 只读; 证据默认脱敏 (完整 task/prompt/tool result/secret 不落).
// 公开入口 runDiagnose 供 index.ts (ISSUE-08) 注册 action:"diagnose"; 本文件不碰 index.ts/schema.
// 纯 node 内置 (fs/path/os), 无第三方依赖; 复用 log.ts 的 logRootDir/redactSecret.

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { LogLevel } from "./log.ts";
import { logRootDir, redactSecret } from "./log.ts";

// ---- Finding schema (PRD §7.3). ----

export type DiagnoseSeverity = "fatal" | "error" | "warn" | "info";
export type DiagnoseCategory =
  | "spawn" | "validate" | "timeout" | "budget" | "protocol" | "model"
  | "resume" | "parallel" | "gc" | "render" | "unknown";
export type DiagnoseConfidence = "low" | "medium" | "high";

export interface DiagnoseEvidence {
  logEventIds: string[];
  logFile?: string;
  sessionFiles?: string[]; // sessionsRoot 相对引用 (<runId>/run-0/session.jsonl), 不落完整宿主路径
  lineHints?: string[]; // 已脱敏的短线索 (eventId 之外的可读载荷摘要)
}

export interface DiagnoseFinding {
  id: string;
  severity: DiagnoseSeverity;
  title: string;
  category: DiagnoseCategory;
  runIds: string[];
  nodeIds?: string[];
  evidence: DiagnoseEvidence;
  suspectedCause: string;
  recommendedFix: string; // 面向用户/后续 agent 的可执行建议
  confidence: DiagnoseConfidence;
  needsCodeChange: boolean; // true=建议改 slim-subagent/pi; false=用法/配置/重试
}

// ---- 公开调用面 (index.ts ISSUE-08 注册 action:"diagnose" 路由至此). ----

export type DiagnoseSince = "24h" | "7d" | "all";
export type DiagnoseLevelMin = "warn" | "error";

export interface DiagnoseParams {
  id?: string; // runId 前缀 | 随机尾段 | batchRunId#index | today
  since?: DiagnoseSince;
  levelMin?: DiagnoseLevelMin;
  limit?: number; // 扫描日志条数上限 (默认 2000, PRD §9)
  writeReport?: boolean;
}

export interface DiagnoseOpts {
  logRoot?: string; // 缺省 log.ts logRootDir() 同源
  sessionsRoot?: string; // 缺省 single.ts sessionsRootDir() 同源
  now?: Date; // 时间基准注入 (测试/可重复)
}

export interface DiagnoseResult {
  content: string; // 简洁中文结论 (Top findings + 建议下一步)
  details: {
    findings: DiagnoseFinding[];
    evidenceRefs: string[]; // "<logFile>#<eventId>" 可定位引用
    reportPath?: string;
  };
}

// ---- 目录缺省值 (与 log.ts/single.ts 同源). ----

function defaultSessionsRoot(): string {
  return path.join(getAgentDir(), "slim-subagent", "sessions"); // single.ts sessionsRootDir() 同源
}

// ---- target 解析 (纯函数, TS-001 接缝). ----

export type ResolvedTarget =
  | { kind: "default"; requested: undefined }            // 缺省 = 最近 24h error/fatal + 相关 run
  | { kind: "run"; requested: string; runIds: string[] } // 前缀/尾段/today 解析出的 runId 集
  | { kind: "batch-child"; requested: string; batchRunId: string; childIndex: number; childSession?: string };

const MAX_PARALLEL_CHILD = 1024;

function dateStampOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// 读 sessions root 下含 run.json 的 runId 目录列表 (坏目录跳过; 根不可读 → 空).
function listSessionRunIds(sessionsRoot: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsRoot);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    try {
      if (!fs.existsSync(path.join(sessionsRoot, name, "run.json"))) continue;
    } catch {
      continue;
    }
    out.push(name);
  }
  return out;
}

// 磁盘单源寻址 (对齐 resume.ts findRunForResume): 精确 > 前缀 + 尾段 (去重) > 歧义. 返回 0/1/多 命中.
function matchRunIds(sessionsRoot: string, id: string): string[] {
  const runIds = listSessionRunIds(sessionsRoot);
  const exact = runIds.filter((r) => r === id);
  if (exact.length > 0) return exact;
  const byPrefix = runIds.filter((r) => r.startsWith(id));
  const byTail = runIds.filter((r) => r.slice(r.lastIndexOf("-") + 1).startsWith(id));
  return [...new Set([...byPrefix, ...byTail])];
}

// target 解析: id 支持 runId 前缀/随机尾段/batchRunId#index/today; 歧义抛错列候选 (PRD §7.2-1).
// 纯函数 (可测): 仅依赖 sessionsRoot 磁盘 + opts.now.
export function resolveTarget(id: string | undefined, sessionsRoot: string, opts?: { now?: Date }): ResolvedTarget {
  if (id === undefined || id.trim() === "") return { kind: "default", requested: undefined };
  const requested = id.trim();

  // today: 当日 run-YYYYMMDD-* 全部目录 (含 parallel 批次根).
  if (requested === "today") {
    const now = opts?.now ?? new Date();
    const stamp = dateStampOf(now);
    const runIds = listSessionRunIds(sessionsRoot).filter((r) => r.startsWith(`run-${stamp}-`));
    return { kind: "run", requested, runIds };
  }

  // batchRunId#index (PRD §7.1): '#' 分隔; 批次寻址走前缀/尾段规则.
  if (requested.includes("#")) {
    const hashIdx = requested.indexOf("#");
    const batchPart = requested.slice(0, hashIdx).trim();
    const idxPart = requested.slice(hashIdx + 1).trim();
    if (batchPart === "") throw new Error(`Invalid diagnose target '${requested}': batch id empty`);
    if (!/^\d+$/.test(idxPart)) throw new Error(`Invalid diagnose target '${requested}': child index must be a non-negative integer`);
    const childIndex = Number(idxPart);
    if (childIndex > MAX_PARALLEL_CHILD) throw new Error(`Invalid diagnose target '${requested}': child index too large`);
    const matches = matchRunIds(sessionsRoot, batchPart);
    if (matches.length === 0) throw new Error(`Run not found for diagnose target '${requested}'`);
    if (matches.length > 1) {
      throw new Error(`Ambiguous run id prefix '${batchPart}' matched: ${matches.join(", ")}. Provide a longer id.`);
    }
    const batchRunId = matches[0]!;
    const childSession = path.join(sessionsRoot, batchRunId, `run-${childIndex}`, "session.jsonl");
    return {
      kind: "batch-child",
      requested,
      batchRunId,
      childIndex,
      ...(fs.existsSync(childSession) ? { childSession } : {}),
    };
  }

  const matches = matchRunIds(sessionsRoot, requested);
  if (matches.length === 0) throw new Error("Run not found");
  if (matches.length > 1) {
    throw new Error(`Ambiguous run id prefix '${requested}' matched: ${matches.join(", ")}. Provide a longer id.`);
  }
  return { kind: "run", requested, runIds: matches };
}

// ---- 日志收集 (只读, since/levelMin 过滤, 上限截断). ----

export interface DiagnoseLogLine {
  ts: string; // ISO
  level: LogLevel;
  event: string;
  eventId: string;
  pid?: number;
  mode?: string;
  toolCallId?: string;
  runId?: string;
  batchRunId?: string;
  childIndex?: number;
  nodeId?: string;
  agent?: string;
  model?: string;
  timeoutMsExplicit?: number;
  usageBudgetExplicit?: number;
  status?: string;
  error?: { code?: string; message?: string };
  data?: Record<string, unknown>;
  file: string; // 日志文件名 basename
  lineNumber: number;
}

const LEVEL_ORDER: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
const WINDOW_MS: Record<DiagnoseSince, number> = { "24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000, all: Number.POSITIVE_INFINITY };
export const DIAGNOSE_DEFAULT_LIMIT = 2000; // PRD §9 默认扫描上限

const DAILY_MS = 24 * 60 * 60 * 1000;

function levelAtOrAbove(level: LogLevel, min: LogLevel): boolean {
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(min);
}

// 读 logRoot 下全部在窗日志并解析为 DiagnoseLogLine (坏行跳过), 按 since/levelMin 过滤, 至多 limit 条.
export function collectLogLines(
  logRoot: string,
  opts: { since?: DiagnoseSince; levelMin?: DiagnoseLevelMin; limit?: number; now?: Date },
): { lines: DiagnoseLogLine[]; truncated: boolean } {
  const since = opts.since ?? "24h";
  const levelMin = opts.levelMin ?? "warn";
  const limit = opts.limit ?? DIAGNOSE_DEFAULT_LIMIT;
  const now = (opts.now ?? new Date()).getTime();
  let files: string[];
  try {
    files = fs.readdirSync(logRoot).filter((f) => /^subagent-\d{8}\.log$/.test(f)).sort().reverse(); // 新→旧, limit 截断保留最新
  } catch {
    return { lines: [], truncated: false };
  }
  const lines: DiagnoseLogLine[] = [];
  let truncated = false;
  // 文件名级粗筛: 只在窗口±1 日内的文件才读 (行级再做精确过滤).
  const windowMs = WINDOW_MS[since];
  const out: DiagnoseLogLine[] = [];
  for (const file of files) {
    const m = file.match(/^subagent-(\d{8})\.log$/);
    if (!m) continue;
    const stamp = m[1]!;
    const y = Number(stamp.slice(0, 4));
    const mo = Number(stamp.slice(4, 6)) - 1;
    const d = Number(stamp.slice(6, 8));
    if (mo < 0 || mo > 11 || d < 1 || d > 31) continue;
    const fileDay = new Date(y, mo, d).getTime();
    if (since !== "all" && (fileDay < now - windowMs - DAILY_MS || fileDay > now + DAILY_MS)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(logRoot, file), "utf-8");
    } catch {
      continue;
    }
    const rawLines = raw.split("\n");
    for (let i = 0; i < rawLines.length; i++) {
      const text = rawLines[i]!.trim();
      if (text === "") continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue; // 坏行跳过 (容错)
      }
      const level = obj.level as LogLevel | undefined;
      if (level === undefined || !levelAtOrAbove(level, levelMin)) continue;
      const ts = typeof obj.ts === "string" && obj.ts !== "" ? obj.ts : "";
      if (ts === "" || Number.isNaN(Date.parse(ts))) continue;
      if (Math.abs(Date.parse(ts) - now) > windowMs) continue; // 行级精确窗口
      const line: DiagnoseLogLine = {
        ts,
        level,
        event: typeof obj.event === "string" ? obj.event : "unknown",
        eventId: typeof obj.eventId === "string" ? obj.eventId : "",
        file,
        lineNumber: i + 1,
      };
      const num = (k: string): number | undefined => (typeof obj[k] === "number" ? (obj[k] as number) : undefined);
      const str = (k: string): string | undefined => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
      line.pid = num("pid");
      line.mode = str("mode");
      line.toolCallId = str("toolCallId");
      line.runId = str("runId");
      line.batchRunId = str("batchRunId");
      line.childIndex = num("childIndex");
      line.nodeId = str("nodeId");
      line.agent = str("agent");
      line.model = str("model");
      line.timeoutMsExplicit = num("timeoutMsExplicit");
      line.usageBudgetExplicit = num("usageBudgetExplicit");
      line.status = str("status");
      const err = obj.error;
      if (err && typeof err === "object") {
        const e = err as Record<string, unknown>;
        line.error = {
          ...(typeof e.code === "string" ? { code: e.code } : {}),
          ...(typeof e.message === "string" ? { message: e.message } : {}),
        };
      }
      if (obj.data && typeof obj.data === "object") line.data = obj.data as Record<string, unknown>;
      out.push(line);
      if (out.length >= limit) return { lines: out, truncated: true };
    }
  }
  return { lines: out, truncated };
}

// ---- sessions 关联 (只读, 只取证据所需路径引用, 相对引用不落完整宿主路径). ----

function dstr(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

// 给定 runId, 返回存在性 session 文件相对引用 (sessionsRoot 相对; 默认 run-0/session.jsonl, run.json sessionFile 优先).
function sessionFilesForRun(sessionsRoot: string, runId: string): string[] {
  const dir = path.join(sessionsRoot, runId);
  const runJsonPath = path.join(dir, "run.json");
  let rel: string | undefined;
  try {
    const runJson = JSON.parse(fs.readFileSync(runJsonPath, "utf-8")) as Record<string, unknown>;
    rel = dstr(runJson.sessionFile);
  } catch {
    rel = undefined;
  }
  const candidates = rel !== undefined ? [rel] : ["run-0/session.jsonl"];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const cand of candidates) {
    if (seen.has(cand)) continue;
    seen.add(cand);
    if (!/\.jsonl$/.test(cand)) continue;
    if (fs.existsSync(path.join(sessionsRoot, runId, cand))) out.push(`${runId}/${cand}`);
  }
  return out;
}

// parallel child: batchRoot/run-<idx>/session.jsonl.
function sessionFilesForChild(sessionsRoot: string, batchRunId: string, childIndex: number): string[] {
  const rel = `run-${childIndex}/session.jsonl`;
  return fs.existsSync(path.join(sessionsRoot, batchRunId, rel)) ? [`${batchRunId}/${rel}`] : [];
}

// ---- 启发式分析 (TS-002/TS-003 接缝). ----

export interface AnalyzeOpts {
  sessionsRoot: string;
}

interface Cluster {
  runIds: Set<string>;
  nodeIds: Set<string>;
  lines: DiagnoseLogLine[];
}

// 聚类键: runId → (batchRunId#childIndex) → batchRunId → nodeId → toolCallId → 孤儿 cluster.
function clusterKey(line: DiagnoseLogLine): string {
  if (line.runId) return line.runId;
  if (line.batchRunId !== undefined && line.childIndex !== undefined) return `${line.batchRunId}#${line.childIndex}`;
  if (line.batchRunId) return line.batchRunId;
  if (line.nodeId) return line.nodeId;
  if (line.toolCallId) return line.toolCallId;
  return "__orphan__";
}

interface FindingDraft {
  severity: DiagnoseSeverity;
  category: DiagnoseCategory;
  title: string;
  cause: string;
  fix: string;
  confidence: DiagnoseConfidence;
  needsCodeChange: boolean;
  match: (line: DiagnoseLogLine) => boolean;
  hintOf: (line: DiagnoseLogLine) => string | undefined;
  /** 同簇上下文事件 (非独立 trigger 但并入证据, 如 timeout.armed). */
  contextEvents?: string[];
}

// 脱敏辅助: 任何进入 evidence/content 的字符串一律二次过 redactSecret (证据默认脱敏, TS-003).
const H = (v: unknown): string | undefined => (v === undefined ? undefined : redactSecret(String(v)));
const DN = (data: Record<string, unknown> | undefined, k: string): string | undefined =>
  typeof (data as Record<string, unknown> | undefined)?.[k] === "number" ? String((data as Record<string, unknown>)[k]) : undefined;
const DI = (data: Record<string, unknown> | undefined, k: string): string | undefined => H((data as Record<string, unknown> | undefined)?.[k]);

// 事件 → finding 草稿: 每簇按事件类别出草稿, 每类合并多条证据 (TS-002 区分显式/自动靠事件载荷).
function draftsForCluster(cluster: Cluster): FindingDraft[] {
  const byEvent = new Map<string, DiagnoseLogLine[]>();
  for (const line of cluster.lines) {
    const list = byEvent.get(line.event) ?? [];
    list.push(line);
    byEvent.set(line.event, list);
  }
  const first = (ev: string): DiagnoseLogLine | undefined => byEvent.get(ev)?.[0];
  const firstMsg = (ev: string): string | undefined => H(first(ev)?.error?.message);
  const has = (ev: string): boolean => byEvent.has(ev);

  const drafts: FindingDraft[] = [];

  // spawn failed (L10 fatal; ENOENT 区分环境/代码).
  if (has("single.spawn.failed")) {
    const l = first("single.spawn.failed")!;
    const isEnoent = /ENOENT/i.test(l.error?.message ?? "");
    drafts.push({
      severity: "fatal",
      category: "spawn",
      title: isEnoent ? "子代理 spawn 失败: 可执行文件/路径不存在 (ENOENT)" : "子代理 spawn 失败",
      cause: `pi 子进程启动失败${l.error?.message ? `: ${H(l.error.message)}` : ""}${l.agent ? ` (agent=${H(l.agent)})` : ""}`,
      fix: "检查 pi 可执行解析链 (env PI_SUBAGENT_PI_BINARY/argv0/包 bin/PATH) 与 agent 目录完整性后重试; 若持续, 带错误文案报 defect",
      confidence: isEnoent ? "high" : "medium",
      needsCodeChange: !isEnoent,
      match: (ln) => ln.event === "single.spawn.failed",
      hintOf: () => [`agent=${H(l.agent)}`, firstMsg("single.spawn.failed")].filter(Boolean).join(" "),
    });
  }
  // agents discover failed (agent 目录扫描异常).
  if (has("agents.discover.failed")) {
    drafts.push({
      severity: "error",
      category: "spawn",
      title: "agent 发现失败 (agents discover failed)",
      cause: `agent 目录扫描/加载异常: ${firstMsg("agents.discover.failed") ?? "未知"}`,
      fix: "检查 agent 配置文件语法与目录权限; 修复后重试",
      confidence: "medium",
      needsCodeChange: false,
      match: (ln) => ln.event === "agents.discover.failed",
      hintOf: () => firstMsg("agents.discover.failed"),
    });
  }
  // unknown agent / validate failed (validate 类别).
  if (has("parallel.child.unknown_agent")) {
    const l = first("parallel.child.unknown_agent")!;
    drafts.push({
      severity: "error",
      category: "validate",
      title: "parallel 子任务引用了不存在的 agent",
      cause: `child #${l.childIndex ?? "?"}: agent=${H(l.agent) ?? "?"} 未注册`,
      fix: "检查调用方 agent 名拼写与已注册 agent 列表, 修正后重发",
      confidence: "high",
      needsCodeChange: false,
      match: (ln) => ln.event === "parallel.child.unknown_agent",
      hintOf: () => `agent=${H(l.agent)}`,
    });
  }
  if (has("tool.execute.validate_failed")) {
    drafts.push({
      severity: "error",
      category: "validate",
      title: "subagent 参数校验失败 (validate failed)",
      cause: `调用参数未过 schema: ${firstMsg("tool.execute.validate_failed") ?? "未知"}`,
      fix: "按工具 schema 修正 action/agent/task 等参数后重发",
      confidence: "high",
      needsCodeChange: false,
      match: (ln) => ln.event === "tool.execute.validate_failed",
      hintOf: () => firstMsg("tool.execute.validate_failed"),
    });
  }
  // timeout (L19 error): 显式/自动区分依赖 timeout.armed (info) 或 fired 行 timeoutMsExplicit —
  // 两者在 diagnose levelMin≥warn 下常缺失 (日志挂载缺口) → 三态: 显式已知/自动已知/未知如实标注.
  if (has("timeout.fired")) {
    const l = first("timeout.fired")!;
    const armed = byEvent.get("timeout.armed")?.[0];
    const explicitKnown = armed?.data?.explicit === true || l.timeoutMsExplicit !== undefined;
    const autoKnown = armed?.data?.explicit === false;
    const state: "explicit" | "auto" | "unknown" = explicitKnown ? "explicit" : autoKnown ? "auto" : "unknown";
    drafts.push({
      severity: "error",
      category: "timeout",
      title: state === "explicit"
        ? "子代理超时 (显式 timeoutMs 触发)"
        : state === "auto"
          ? "子代理超时 (自动缺省超时触发)"
          : "子代理超时",
      cause: state === "unknown"
        ? `运行超时${DN(l.data, "timeoutMs") ? ` (timeoutMs=${DN(l.data, "timeoutMs")}ms)` : ""} — 该 fired 行未带 timeoutMsExplicit, 且 timeout.armed (info) 在 levelMin≥warn 过滤下缺失, 暂无法区分显式/自动 (已知日志挂载缺口)`
        : `运行超时${DN(l.data, "timeoutMs") ? ` (timeoutMs=${DN(l.data, "timeoutMs")}ms)` : ""} — ${state === "explicit" ? "本次为调用方显式设置" : "本次未显式设置, 走自动缺省"}${l.agent ? ` (agent=${H(l.agent)})` : ""}`,
      fix: state === "explicit"
        ? "任务耗时超过显式 timeoutMs: 增大 timeoutMs 或拆分任务; 若已最大仍超时, 排查模型/tool 卡点"
        : state === "auto"
          ? "接近自动缺省超时上限: 显式设置合理 timeoutMs 或拆分任务; 会话已尽量落盘, 可 resume 续跑"
          : "任务耗时超时上限: 显式设置合理 timeoutMs 或拆分任务; 会话已尽量落盘, 可 resume 续跑",
      confidence: state === "unknown" ? "medium" : "high",
      needsCodeChange: false,
      match: (ln) => ln.event === "timeout.fired",
      contextEvents: ["timeout.armed"], // armed 行并入证据 (TS-002: 证据含 armed+fired; levelMin≥warn 时无 armed)
      hintOf: (ln) => [`timeoutMs=${DN(ln.data, "timeoutMs")}`, state].filter(Boolean).join(" "),
    });
  }
  // usage_budget (L17 abort / L16 warn 80%): 区分显式 cap 与自动 70% (data.budgetAuto, PRD §7.2-4);
  // budget 行自带 budgetAuto (error 级可见), 缺失时如实标未知.
  const budgetState = (l: DiagnoseLogLine): "explicit" | "auto" | "unknown" =>
    String(l.data?.budgetAuto) === "true" ? "auto" : String(l.data?.budgetAuto) === "false" ? "explicit" : "unknown";
  if (has("usage_budget.abort")) {
    const l = first("usage_budget.abort")!;
    const st = budgetState(l);
    drafts.push({
      severity: "error",
      category: "budget",
      title: st === "auto" ? "usage budget 触顶 (自动 70% 预算)" : st === "explicit" ? "usage budget 触顶 (显式 cap)" : "usage budget 触顶",
      cause: `tokens 达上限${DN(l.data, "used") ? ` (used=${DN(l.data, "used")})` : ""}${DN(l.data, "budget") ? ` / cap=${DN(l.data, "budget")}` : ""} — ${st === "auto" ? "未显式传 usageBudget, 为自动 70% 模型窗口" : st === "explicit" ? "调用方显式设置 usageBudget" : "日志未含 budgetAuto 标记, 显式/自动未知"}${l.agent ? ` (agent=${H(l.agent)})` : ""}`,
      fix: st === "auto"
        ? "自动预算 (70% 窗口) 触顶: 任务体量接近窗口上限, 可显式提高 usageBudget 或减小任务/prompt"
        : st === "explicit"
          ? "显式 usageBudget 触顶: 任务 token 需求超 cap, 提高 usageBudget 或减小任务/prompt"
          : "usageBudget 触顶: 提高 usageBudget 或减小任务/prompt",
      confidence: st === "unknown" ? "medium" : "high",
      needsCodeChange: false,
      match: (ln) => ln.event === "usage_budget.abort",
      hintOf: (ln) => [`used=${DN(ln.data, "used")}`, `budget=${DN(ln.data, "budget")}`, `state=${budgetState(ln)}`].filter(Boolean).join(" "),
    });
  }
  if (has("usage_budget.warn_80pct")) {
    const l = first("usage_budget.warn_80pct")!;
    const st = budgetState(l);
    drafts.push({
      severity: "warn",
      category: "budget",
      title: st === "auto" ? "usage budget 接近上限 (自动预算 80%)" : st === "explicit" ? "usage budget 接近上限 (显式 cap 80%)" : "usage budget 接近上限 (80%)",
      cause: `tokens 已达预算 80%${DN(l.data, "budget") ? ` (cap=${DN(l.data, "budget")})` : ""} — ${st === "auto" ? "自动 70% 窗口" : st === "explicit" ? "显式 cap" : "显式/自动未知"}, 下一轮可能触顶中止`,
      fix: "若任务还需较长运行, 提前提高 usageBudget 或拆分任务, 避免触顶中止中断会话",
      confidence: st === "unknown" ? "low" : "medium",
      needsCodeChange: false,
      match: (ln) => ln.event === "usage_budget.warn_80pct",
      hintOf: (ln) => [`used=${DN(ln.data, "used")}`, `budget=${DN(ln.data, "budget")}`, `state=${budgetState(ln)}`].filter(Boolean).join(" "),
    });
  }
  // protocol (L13 output_limit; aggregate projection ok:false 邻接证据).
  if (has("protocol.output_limit")) {
    const l = first("protocol.output_limit")!;
    drafts.push({
      severity: "error",
      category: "protocol",
      title: "协议输出超上限 (protocol output limit)",
      cause: `stdout 单行/聚合超限${DN(l.data, "limitBytes") ? ` (limit=${DN(l.data, "limitBytes")}B, observed=${DN(l.data, "observedBytes") ?? "?"}B)` : ""}${l.agent ? ` (agent=${H(l.agent)})` : ""}`,
      fix: "输出过大触发 failProtocol (上限在 slim-subagent 管线): 让 agent 分段输出/减小产出; 上限确需放宽则改实现",
      confidence: "high",
      needsCodeChange: true,
      match: (ln) => ln.event === "protocol.output_limit",
      hintOf: (ln) => [`stream=${DI(ln.data, "stream")}`, `limitBytes=${DN(ln.data, "limitBytes")}`, `observedBytes=${DN(ln.data, "observedBytes")}`].filter(Boolean).join(" "),
    });
  } else if ((byEvent.get("aggregate.projection") ?? []).some((ln) => ln.data?.ok === false)) {
    drafts.push({
      severity: "error",
      category: "protocol",
      title: "聚合投影失败 (aggregate projection)",
      cause: "超长行无法完成聚合投影, 将走 failProtocol 终止",
      fix: "同 protocol output limit: 分段输出/减小产出; 上限确需放宽则改实现",
      confidence: "medium",
      needsCodeChange: true,
      match: (ln) => ln.event === "aggregate.projection" && ln.data?.ok === false,
      hintOf: (ln) => `projectedBytes=${DN(ln.data, "projectedBytes")}`,
    });
  }
  // model / empty output.
  if (has("result.empty_output")) {
    drafts.push({
      severity: "error",
      category: "model",
      title: "子代理空输出 (empty output)",
      cause: "进程结束未产出有效助手输出 (exitCode=1): 可能模型无响应或输出被吞",
      fix: "重试该任务; 若复现, 换 model 或检查模型端错误; 打开 Session Viewer 二次确认会话内容",
      confidence: "medium",
      needsCodeChange: false,
      match: (ln) => ln.event === "result.empty_output",
      hintOf: (ln) => `exitCode=${DN(ln.data, "exitCode")}`,
    });
  }
  if (has("stdout.line.non_json")) {
    drafts.push({
      severity: "warn",
      category: "model",
      title: "stdout 出现非 JSON 行 (解析容忍)",
      cause: `非 JSON 行计数 ${DN(first("stdout.line.non_json")?.data, "count") ?? "?"} — 已按非 JSON 容忍路径处理`,
      fix: "若频发干扰解析, 检查 agent 输出约定; 偶发可忽略",
      confidence: "low",
      needsCodeChange: false,
      match: (ln) => ln.event === "stdout.line.non_json",
      hintOf: (ln) => `count=${DN(ln.data, "count")}`,
    });
  }
  // resume (not_found / ambiguous / lease conflict).
  if (has("resume.find.not_found")) {
    const l = first("resume.find.not_found")!;
    drafts.push({
      severity: "error",
      category: "resume",
      title: "resume 目标未找到 (not found)",
      cause: `请求 resume id=${DI(l.data, "id") ?? "?"} 无对应 run — 可能 runId 输错或已被 7 日 GC 清理`,
      fix: "用 list/目录核对存在的 runId 后重试; 若原 run 已被 GC 清理则无法恢复, 重发任务",
      confidence: "high",
      needsCodeChange: false,
      match: (ln) => ln.event === "resume.find.not_found",
      hintOf: (ln) => `id=${DI(ln.data, "id")}`,
    });
  }
  if (has("resume.find.ambiguous")) {
    const l = first("resume.find.ambiguous")!;
    drafts.push({
      severity: "warn",
      category: "resume",
      title: "resume 目标歧义 (ambiguous)",
      cause: `resume id=${DI(l.data, "id") ?? "?"} 前缀命中多个 run${l.error?.message ? `: ${H(l.error.message)}` : ""}`,
      fix: "提供更长 runId 前缀消除歧义后重试",
      confidence: "high",
      needsCodeChange: false,
      match: (ln) => ln.event === "resume.find.ambiguous",
      hintOf: (ln) => `id=${DI(ln.data, "id")}`,
    });
  }
  if (has("resume.lease.conflict")) {
    const l = first("resume.lease.conflict")!;
    drafts.push({
      severity: "warn",
      category: "resume",
      title: "resume 会话锁冲突 (lease conflict)",
      cause: `会话被另一进程占用${l.error?.message ? `: ${H(l.error.message)}` : ""}(id=${DI(l.data, "id") ?? "?"})`,
      fix: "确认无其他 resume/运行占用后重试; stale 锁会被下次抢占回收",
      confidence: "medium",
      needsCodeChange: false,
      match: (ln) => ln.event === "resume.lease.conflict",
      hintOf: (ln) => `id=${DI(ln.data, "id")}`,
    });
  }
  // parallel (>8 拒绝).
  if (has("parallel.batch.too_many")) {
    const l = first("parallel.batch.too_many")!;
    drafts.push({
      severity: "warn",
      category: "parallel",
      title: "并行批次超上限被拒绝 (>8)",
      cause: `请求 tasks=${DN(l.data, "count") ?? "?"} 超过 max=${DN(l.data, "max") ?? "8"}`,
      fix: "拆分为 ≤8 的多个批次顺序提交",
      confidence: "high",
      needsCodeChange: false,
      match: (ln) => ln.event === "parallel.batch.too_many",
      hintOf: (ln) => `count=${DN(ln.data, "count")}, max=${DN(ln.data, "max")}`,
    });
  }
  // GC (scan/delete 异常).
  if (has("gc.failed")) {
    drafts.push({
      severity: "error",
      category: "gc",
      title: "日志/会话 GC 异常",
      cause: `GC 扫描或删除失败: ${cluster.lines.filter((ln) => ln.event === "gc.failed").map((ln) => H(ln.error?.message)).filter(Boolean).join("; ") || "未知"}`,
      fix: "检查 subagent_log/sessions 目录权限与损坏文件; 复现时带 gc.failed 报 defect",
      confidence: "medium",
      needsCodeChange: true,
      match: (ln) => ln.event === "gc.failed",
      hintOf: (ln) => [ln.error?.code ? `code=${ln.error.code}` : undefined, H(ln.error?.message)].filter(Boolean).join(" "),
    });
  }
  // render (L44 渲染异常, 不影响执行).
  if (has("render.update.failed")) {
    drafts.push({
      severity: "warn",
      category: "render",
      title: "渲染/回调异常 (render update failed)",
      cause: `onUpdate/render 阶段抛错: ${cluster.lines.filter((ln) => ln.event === "render.update.failed").map((ln) => H(ln.error?.message) ?? DI(ln.data, "onUpdate")).filter(Boolean).join("; ") || "未知"}`,
      fix: "不影响执行结果; 复现时带 render.update.failed 完整错误报 defect",
      confidence: "medium",
      needsCodeChange: true,
      match: (ln) => ln.event === "render.update.failed",
      hintOf: (ln) => H(ln.error?.message) ?? "render error",
    });
  }
  // final_drain.forced (终止管线强制阶段) — 已有 timeout.fired 根因时不重复.
  if (has("final_drain.forced") && !has("timeout.fired")) {
    const drains = cluster.lines.filter((ln) => ln.event === "final_drain.forced");
    const signals = drains.map((ln) => DI(ln.data, "signal")).filter(Boolean).join(",");
    if (signals !== "") {
      drafts.push({
        severity: "warn",
        category: "timeout",
        title: "终局 drain 强制终止 (进程未及时退出)",
        cause: `收到 terminal 事件后进程未在宽限内退出, 强制 ${signals}`,
        fix: "子进程未干净退出 — 重试并观察; 若复现, 带 final_drain.forced 证据报 defect",
        confidence: "low",
        needsCodeChange: false,
        match: (ln) => ln.event === "final_drain.forced",
        hintOf: (ln) => `signal=${DI(ln.data, "signal")}`,
      });
    }
  }
  // signal 终止: 用户 abort (提示级) / 意外信号 (错误级). 已有 timeout/budget 根因时不追加杂讯.
  const hasRootCause = ["timeout.fired", "usage_budget.abort", "final_drain.forced"].some((ev) => has(ev));
  const cancelled = has("signal.abort_requested");
  if (cancelled && !hasRootCause) {
    const l = first("signal.abort_requested")!;
    drafts.push({
      severity: "info",
      category: "unknown",
      title: "子代理运行被中止 (AbortSignal)",
      cause: `父会话请求取消${l.agent ? ` (agent=${H(l.agent)})` : ""}`,
      fix: "非故障 — 需要继续时重新发起 (可 resume 已完成部分)",
      confidence: "high",
      needsCodeChange: false,
      match: (ln) => ln.event === "signal.abort_requested",
      hintOf: (ln) => `aborted=${DI(ln.data, "aborted")}`,
    });
  } else if (!cancelled && !hasRootCause) {
    const settled = (byEvent.get("process.close.settled") ?? []).find(
      (ln) => typeof ln.data?.processSignal === "string" && ln.data.processSignal !== "",
    );
    if (settled) {
      drafts.push({
        severity: "error",
        category: "unknown",
        title: "子代理进程被信号终止",
        cause: `close 时 processSignal=${DI(settled.data, "processSignal")}${settled.agent ? ` (agent=${H(settled.agent)})` : ""}`,
        fix: "排查外部 kill/系统 OOM/异常退出; 重试或 resume",
        confidence: "low",
        needsCodeChange: false,
        match: (ln) => ln.event === "process.close.settled" && typeof ln.data?.processSignal === "string" && ln.data.processSignal !== "",
        hintOf: (ln) => `processSignal=${DI(ln.data, "processSignal")}${settled.agent ? ` agent=${H(settled.agent)}` : ""}`,
      });
    }
  }
  return drafts;
}

// 聚合: 聚类 → draft → finding (合并同 draft 事件证据). runIds/nodeIds 取自簇内行.
export function analyzeLogs(
  lines: DiagnoseLogLine[],
  opts: AnalyzeOpts,
): { findings: DiagnoseFinding[]; evidenceRefs: string[] } {
  const sessionsRoot = opts.sessionsRoot;
  const clusters = new Map<string, Cluster>();
  for (const line of lines) {
    const key = clusterKey(line);
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = { runIds: new Set(), nodeIds: new Set(), lines: [] };
      clusters.set(key, cluster);
    }
    if (line.runId) cluster.runIds.add(line.runId);
    if (line.nodeId) cluster.nodeIds.add(line.nodeId);
    if (line.batchRunId !== undefined && line.childIndex !== undefined) cluster.nodeIds.add(`${line.batchRunId}#${line.childIndex}`);
    if (line.batchRunId) cluster.runIds.add(line.batchRunId);
    cluster.lines.push(line);
  }

  const findings: DiagnoseFinding[] = [];
  const evidenceRefs = new Set<string>();
  let n = 0;
  for (const cluster of clusters.values()) {
    const drafts = draftsForCluster(cluster);
    for (const draft of drafts) {
      let matched = cluster.lines.filter(draft.match);
      if (draft.contextEvents) {
        matched = [...matched, ...cluster.lines.filter((ln) => draft.contextEvents!.includes(ln.event))];
      }
      const logEventIds = matched.map((ln) => ln.eventId).filter((id) => id !== "");
      const file = matched[0]?.file ?? cluster.lines[0]?.file;
      const hintLines = matched
        .map(draft.hintOf)
        .filter((h): h is string => Boolean(h))
        .map((h) => redactSecret(h).slice(0, 200));
      // sessions 关联: run 目录 + parallel child (batch#idx → run-<idx>) 存在性引用.
      const sessionFiles = new Set<string>();
      for (const runId of cluster.runIds) {
        for (const sf of sessionFilesForRun(sessionsRoot, runId)) sessionFiles.add(sf);
      }
      for (const node of cluster.nodeIds) {
        const m = node.match(/^(.+)#(\d+)$/);
        if (m) for (const sf of sessionFilesForChild(sessionsRoot, m[1]!, Number(m[2]!))) sessionFiles.add(sf);
      }
      n += 1;
      findings.push({
        id: `find-${n}`,
        severity: draft.severity,
        title: draft.title,
        category: draft.category,
        runIds: [...cluster.runIds],
        ...(cluster.nodeIds.size > 0 ? { nodeIds: [...cluster.nodeIds] } : {}),
        evidence: {
          logEventIds,
          ...(file ? { logFile: file } : {}),
          ...(sessionFiles.size > 0 ? { sessionFiles: [...sessionFiles] } : {}),
          ...(hintLines.length > 0 ? { lineHints: hintLines } : {}),
        },
        suspectedCause: redactSecret(draft.cause).slice(0, 500),
        recommendedFix: redactSecret(draft.fix),
        confidence: draft.confidence,
        needsCodeChange: draft.needsCodeChange,
      });
      for (const eventId of logEventIds) evidenceRefs.add(`${file}#${eventId}`);
    }
  }

  // 稳定排序: severity 高→低, 同 severity 按生成序.
  const sevRank: Record<DiagnoseSeverity, number> = { fatal: 0, error: 1, warn: 2, info: 3 };
  findings.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.id.localeCompare(b.id));
  return { findings, evidenceRefs: [...evidenceRefs] };
}

// ---- content 与报告组装 (中文, 默认脱敏). ----

const SEV_LABEL: Record<DiagnoseSeverity, string> = { fatal: "致命", error: "错误", warn: "警告", info: "提示" };
const CAT_LABEL: Record<DiagnoseCategory, string> = {
  spawn: "启动失败", validate: "校验", timeout: "超时", budget: "预算", protocol: "协议",
  model: "模型/输出", resume: "恢复", parallel: "并行", gc: "GC", render: "渲染", unknown: "未知",
};

function targetLabel(target: ResolvedTarget): string {
  if (target.kind === "default") return "最近 24h 内告警/错误 (缺省目标)";
  if (target.kind === "batch-child") return `parallel child ${target.batchRunId}#${target.childIndex}`;
  return target.runIds.length > 0
    ? `run${target.runIds.length > 1 ? `s(${target.runIds.join(",")})` : ` ${target.runIds[0]}`}`
    : `today (${target.requested}, 当日无会话)`;
}

function buildContent(
  target: ResolvedTarget,
  since: DiagnoseSince,
  levelMin: DiagnoseLevelMin,
  scanned: number,
  truncated: boolean,
  findings: DiagnoseFinding[],
): string {
  const head =
    `诊断目标: ${targetLabel(target)}\n` +
    `时间窗: ${since === "all" ? "全部" : since}, 最低级别: ${levelMin}, 扫描日志 ${scanned} 条${truncated ? " (已截断, 请收窄范围)" : ""}`;
  if (findings.length === 0) {
    return `${head}\n\n未发现异常证据 (insufficient_evidence) — 时间窗内无匹配 warn+/error/fatal 日志; 不编造问题, 可扩大 since 或降低 levelMin 再试.`;
  }
  const lines = [head, "", `发现 ${findings.length} 项:`];
  for (const f of findings) {
    const runPart = f.runIds.length > 0 ? ` [run: ${f.runIds.join(",")}]` : "";
    const nodePart = f.nodeIds ? ` [node: ${f.nodeIds.join(",")}]` : "";
    lines.push(`- [${SEV_LABEL[f.severity]}] ${f.title} (${CAT_LABEL[f.category]})${runPart}${nodePart}`);
    lines.push(`  原因: ${f.suspectedCause}`);
    lines.push(`  建议: ${f.recommendedFix}${f.needsCodeChange ? " [需改代码]" : ""} (置信 ${f.confidence})`);
  }
  const topFixes = [...new Set(findings.map((f) => f.recommendedFix))].slice(0, 3);
  lines.push("", "建议下一步:");
  topFixes.forEach((fix, i) => lines.push(`${i + 1}. ${fix}`));
  if (findings.some((f) => f.evidence.sessionFiles?.length)) {
    lines.push("", "提示: 需要查看具体会话内容时, 打开 Session Viewer 确认后二次 reveal (Diagnose 默认不输出完整 task/tool result).");
  }
  return lines.join("\n");
}

function buildReport(
  target: ResolvedTarget,
  since: DiagnoseSince,
  levelMin: DiagnoseLevelMin,
  scanned: number,
  truncated: boolean,
  findings: DiagnoseFinding[],
  evidenceRefs: string[],
  generatedAt: string,
): string {
  const head =
    `# subagent diagnose 报告\n\n` +
    `- 生成: ${generatedAt}\n` +
    `- 目标: ${targetLabel(target)}\n` +
    `- 时间窗: ${since === "all" ? "全部" : since}, 最低级别: ${levelMin}\n` +
    `- 扫描: ${scanned} 条${truncated ? " (已截断)" : ""}\n`;
  const body = findings.map((f, i) => {
    const ev = f.evidence;
    return (
      `## ${i + 1}. [${SEV_LABEL[f.severity]}] ${f.title} (${CAT_LABEL[f.category]})\n\n` +
      `- id: ${f.id}\n- category: ${f.category}\n- severity: ${f.severity}\n` +
      `- runIds: ${f.runIds.join(", ") || "—"}\n${f.nodeIds ? `- nodeIds: ${f.nodeIds.join(", ")}\n` : ""}` +
      `- confidence: ${f.confidence}\n- needsCodeChange: ${f.needsCodeChange}\n\n` +
      `### 证据\n\n- 日志文件: ${ev.logFile ?? "—"}\n- logEventIds: ${ev.logEventIds.join(", ") || "—"}\n` +
      `- sessionFiles: ${ev.sessionFiles?.join(", ") || "—"}\n- lineHints: ${ev.lineHints?.join(" | ") || "—"}\n\n` +
      `### 疑似原因\n\n${f.suspectedCause}\n\n### 建议修复\n\n${f.recommendedFix}\n`
    );
  }).join("\n---\n\n");
  const refs = evidenceRefs.length > 0 ? `\n## 证据引用 (logFile#eventId)\n\n${evidenceRefs.map((r) => `- ${r}`).join("\n")}\n` : "";
  const footer = "\n(本报告由 Diagnose 生成, 默认脱敏: 不含完整 task/prompt/tool result/secret. 7 日 GC 自动清理.)\n";
  return `${head}\n${findings.length > 0 ? body : "未发现异常证据 (insufficient_evidence).\n"}${refs}${footer}`;
}

function reportTimeStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function reportTargetSlug(target: ResolvedTarget): string {
  if (target.kind === "default") return "recent-24h";
  if (target.kind === "batch-child") return `${target.batchRunId}#${target.childIndex}`;
  return target.runIds.length === 1 ? target.runIds[0]! : target.requested;
}

// 写报告仅当 writeReport:true; 目录 <logRoot>/diagnose/, 文件名 YYYYMMDD-HHMMSS-<target>.md (PRD §7.2-6).
// 7 日 GC 由 log.ts runLogGc 统一承担 (diagnose/*.md 按 mtime, 本文件无需自管).
function writeDiagnoseReport(logRoot: string, target: ResolvedTarget, report: string, now: Date): string {
  const dir = path.join(logRoot, "diagnose");
  fs.mkdirSync(dir, { recursive: true });
  const slug = reportTargetSlug(target).replace(/[^\w@#.-]+/g, "_").slice(0, 80);
  const file = path.join(dir, `${reportTimeStamp(now)}-${slug}.md`);
  fs.writeFileSync(file, report, "utf-8");
  return file;
}

// ---- 公开入口 (index.ts ISSUE-08 注册 action:"diagnose" 路由至此). ----

export async function runDiagnose(
  params: DiagnoseParams,
  opts?: DiagnoseOpts,
): Promise<DiagnoseResult> {
  // 参数校验 (非法值给中文错误 content, 不抛 — 对齐 index.ts 校验层 isError 的 content 侧形态).
  if (params.since !== undefined && params.since !== "24h" && params.since !== "7d" && params.since !== "all") {
    return { content: `diagnose 参数 since 非法: "${String(params.since)}" (应为 24h|7d|all)`, details: { findings: [], evidenceRefs: [] } };
  }
  if (params.levelMin !== undefined && params.levelMin !== "warn" && params.levelMin !== "error") {
    return { content: `diagnose 参数 levelMin 非法: "${String(params.levelMin)}" (应为 warn|error)`, details: { findings: [], evidenceRefs: [] } };
  }
  if (params.limit !== undefined && (typeof params.limit !== "number" || !Number.isInteger(params.limit) || params.limit <= 0)) {
    return { content: `diagnose 参数 limit 非法: "${String(params.limit)}" (应为正整数)`, details: { findings: [], evidenceRefs: [] } };
  }
  const now = opts?.now ?? new Date();
  const since: DiagnoseSince = params.since ?? "24h";
  const levelMin: DiagnoseLevelMin = params.levelMin ?? "warn";
  const limit = params.limit ?? DIAGNOSE_DEFAULT_LIMIT;

  // 解析 target (歧义抛错 → 中文错误回传并列出候选).
  let target: ResolvedTarget;
  try {
    target = resolveTarget(params.id, opts?.sessionsRoot ?? defaultSessionsRoot(), { now });
  } catch (e) {
    return { content: `诊断目标解析失败: ${(e as Error).message}`, details: { findings: [], evidenceRefs: [] } };
  }

  // 日志收集 (只读; logRoot 缺省 = log.ts logRootDir 同源).
  const logRoot = opts?.logRoot ?? logRootDir();
  const { lines, truncated } = collectLogLines(logRoot, { since, levelMin, limit, now });

  // 目标过滤 (default 全量; run/child 收窄到相关行 — PRD §7.2-2 聚类 + 关联).
  const scoped = lines.filter((line) => {
    if (target.kind === "default") return true;
    if (target.kind === "run") {
      return target.runIds.includes(line.runId ?? "") || target.runIds.includes(line.batchRunId ?? "");
    }
    return line.batchRunId === target.batchRunId && line.childIndex === target.childIndex;
  });

  const sessionsRoot = opts?.sessionsRoot ?? defaultSessionsRoot();
  const { findings, evidenceRefs } = analyzeLogs(scoped, { sessionsRoot });
  const content = buildContent(target, since, levelMin, scoped.length, truncated, findings);
  const details: DiagnoseResult["details"] = { findings, evidenceRefs };
  if (params.writeReport === true) {
    const report = buildReport(target, since, levelMin, scoped.length, truncated, findings, evidenceRefs, now.toISOString());
    details.reportPath = writeDiagnoseReport(logRoot, target, report, now);
  }
  return { content, details };
}