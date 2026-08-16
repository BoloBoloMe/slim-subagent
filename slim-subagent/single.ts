// slim-subagent single 执行管线 — ISSUE-02 TS-001/TS-003/TS-004 + ISSUE-03 TS-001~003 + ISSUE-04 TS-001~003 切片.
// 本切片: onUpdate 流式接线 (M3-02 考察点 6 触发点/payload) + run.json tools 快照 (EXECUTION.md 调和 14).
// 范围: 寻址 (M3-04 考察点 1) + spawn + 行解析 (M3-02 考察点 1/2) + close 结果构造 (M3-01 考察点 6, M3 §六) +
// timeout 定时器/诊断载荷 (ISSUE-03) + 非 JSON 容忍/rawStdoutTail/stderrTail 128KB/closeError 优先序/finalCode 语义/空输出判定 (TS-003)
// + 三阶段 drain (terminal stop/agent_settled → 1s SIGTERM → 3s SIGKILL, TS-004) + abort 取消 (TS-004) + session 落盘 (调和 1/3)
// + 16MB 单行上限 failProtocol + turn_end/agent_end 聚合投影 (M3-01 考察点 5, EXECUTION.md 调和 9)
// + usageBudget 触顶终止 (ISSUE-04: M2-D003 口径, M3-02 考察点 5 选项 B 挂点, 复用 timeout 三阶段终止管线).
// 覆盖: M2-D002(a) 正常载荷, M2-D002(b) 中止载荷, M2-D006 (runId+sessionDir), M1-D005 (timeout 15min+诊断),
// TS-003 错误与退出码, TS-004 终止时序 (M3-01 考察点 2/4), M1-D006 (token 上限运行中终止), M2-D003 (budget 口径).
// ISSUE-05: parallel per-child 支持 — 共享批次 runId + sessionDir 覆盖 + skipRunJson (调和 12: per-child 不写 run.json).
// 未含 (后续切片): argv 契约断言 (TS-002), resume (ISSUE-06), 渲染 (ISSUE-07).

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentConfig } from "./agents.ts";
// ISSUE-01: 日志插桩 (仅加日志调用, 不改执行逻辑; 写失败静默吞, 见 log.ts).
import { logEvent, taskPreviewOf } from "./log.ts";

// M3-02 考察点 2: message_end 事件 message 的解析所需最小面 (事件流来自 JSON.parse, 结构宽松).
interface AgentMessageLike {
  role: string;
  content: unknown[];
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
    totalTokens?: number;
  };
}

// M3 §六 + M3-02 考察点 2: usage 六字段 (cost = Σ u.cost?.total, turns = assistant 消息条数).
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

// M3 §六 SingleResult (本切片子集 + ISSUE-03).
export interface SingleResult {
  index: number;
  agent: string;
  task: string;
  exitCode: number;
  processSignal?: string; // close 时 signal (M3 §六 / M3-01 考察点 6)
  usage: Usage;
  messages: AgentMessageLike[];
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  error?: string;
  protocolError?: ProtocolOutputLimit; // M3-01 考察点 5: failProtocol 记录 (内部诊断, 不进 details)
  finalOutput?: string;
  partialOutput?: string; // ISSUE-03: 超时前已累积部分输出 (details 独立字段, M2-D002(b))
  contextTokens?: number;
  stderr: string;
  timedOut?: boolean;
  budgetExceeded?: boolean; // ISSUE-04: usageBudget 触顶中止标记 (settle 收口 stopReason/exitCode, isError 谓词用)
  timeoutMs?: number;
  endedAtMs?: number; // ISSUE-02 (M02 D002/D005): settle 收束时刻 (run.json settle 补丁同源), normal 也落
}

// M2-D002(a) 正常载荷 + M2-D002(b) 中止载荷 details.
// usage + runId + sessionDir (绝对路径, M2-D006);
// contextTokens/model/stopReason/errorMessage 为 M3 §六 SingleResult 字段, 经 details 露出供诊断与断言;
// exitCode/error/processSignal 同为 M3 §六 字段 (TS-003 错误路径断言面).
// ISSUE-03 诊断载荷: contextPercent/contextWindow/hint (M3-05 推荐字段清单).
export interface SingleDetails {
  usage: Usage;
  runId: string;
  sessionDir: string;
  exitCode: number;
  error?: string;
  processSignal?: string;
  contextTokens?: number;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  contextPercent?: number | null;
  contextWindow?: number;
  partialOutput?: string; // ISSUE-03: 中止载荷部分输出 (M2-D002(b)), 独立于 finalOutput 文本拼装
  sessionSaved?: boolean; // 中止载荷: session 文件是否落盘 (resume 硬前提, M5 观察 #3; 仅中止结果产出)
  usageBudget?: number; // 生效预算 (强制解析后): 显式或自动 70% 窗口 (正常载荷结构字段, 不进 content)
  budgetAuto?: boolean; // true = 自动 (未显式传 usageBudget), false = 显式
  hint?: string;
  resumed?: boolean; // ISSUE-06: resume 结果标记 (仅 resume 路径置 true, M3-03 考察点 1 移植规格 1)
  // M02 D002: final details 补丁字段 — mode/agent/taskPreview/timeoutMsExplicit/startedAtMs/endedAtMs (D002/D004).
  mode?: string;
  agent?: string;
  taskPreview?: string; // ≤120/单行化/redaction (D003 同一规则), 完整 task 永不进 details
  timeoutMsExplicit?: number; // 仅显式超时落
  startedAtMs?: number;
  endedAtMs?: number;
}

export type SingleToolResult = AgentToolResult<SingleDetails> & { isError?: boolean };

// M3-02 考察点 6: 流式更新 payload (官方示例 base {content, details:{mode,results}} + progress 快照, D001 第 9 项 TUI 最小渲染依赖).
export interface ProgressSnapshot {
  recentTools: { tool: string; args: string; endMs: number }[];
  recentOutput: string[];
}
export interface StreamUpdateDetails {
  mode: "single" | "parallel"; // ISSUE-07 deferred (b): parallel onUpdate 聚合流复用同 payload 形态
  results: SingleResult[];
  progress: ProgressSnapshot[];
  runId?: string; // ISSUE-08: live 帧携带 runId (viewer store 建批 + 投影节点键)
  sessionDir?: string; // ISSUE-08: live 帧携带 sessionDir (viewer 会话 live 读盘)
  usageBudget?: number; // ISSUE-08: live 帧携带生效预算 (投影 usageBudgetExplicit 推导)
  budgetAuto?: boolean;
  contextPercent?: number | null; // ISSUE-08: live 帧携带子代理口径 ctx% (运行中即可展示)
}
export type StreamUpdateCallback = (partial: AgentToolResult<StreamUpdateDetails>) => void;

// M1-D005: timeout 默认 15min (900000ms).
// M1-D005: 恢复建议阈值 — 父会话上下文占用 > X% 判定进入 "迟钝区" (建议新起子代理而非 resume).
// 一处配置 (环境变量覆盖, 默认 30), 全局引用 (hint 分支/长版恢复指令都读本函数): 改一处处处变.
const RESUME_HINT_PERCENT_ENV = "PI_SUBAGENT_RESUME_HINT_PERCENT";
const DEFAULT_RESUME_HINT_PERCENT = 30;
function resumeHintPercent(): number {
  const raw = process.env[RESUME_HINT_PERCENT_ENV];
  if (raw === undefined) return DEFAULT_RESUME_HINT_PERCENT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : DEFAULT_RESUME_HINT_PERCENT;
}

// 强制预算 (用户协议): 每次启动子代理自动设 token 用量上限 = 子代理模型上下文窗口 × 比例 (默认 70%).
// 窗口运行时查 pi modelRegistry (与父会话同源, 含 settings/modelOverrides), 查不到用兜底默认.
// 标量偏置 (兜底窗口/比例) 用 env 可覆盖, 集中读, 处处引用 (改一处处处变).
const DEFAULT_MODEL_WINDOW_ENV = "PI_SUBAGENT_DEFAULT_WINDOW";
const DEFAULT_MODEL_WINDOW = 128000;
const BUDGET_RATIO_ENV = "PI_SUBAGENT_BUDGET_RATIO";
const DEFAULT_BUDGET_RATIO = 0.7;
function defaultModelWindow(): number {
  const raw = process.env[DEFAULT_MODEL_WINDOW_ENV];
  if (raw === undefined) return DEFAULT_MODEL_WINDOW;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1024 ? n : DEFAULT_MODEL_WINDOW;
}
function usageBudgetRatio(): number {
  const raw = process.env[BUDGET_RATIO_ENV];
  if (raw === undefined) return DEFAULT_BUDGET_RATIO;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULT_BUDGET_RATIO;
}
// 子代理模型窗口: ctx.modelRegistry.find("<provider>", "<modelId>") → pi-ai Model.contextWindow.
// (踩坑: getProvider 返回的 provider 不含 models 列表, 见 M07-RECOVERY-PROTOCOL.md §3.4 — 勿改回 getProvider 路径)
// 模型寻址 "<provider>/<model>" 与 --model 同形; 任何一步不可得 → 兜底默认窗口.
export function resolveModelWindow(ctx: unknown, model?: string): number {
  if (!model) return defaultModelWindow();
  try {
    const registry = (ctx as { modelRegistry?: { find?: (provider: string, modelId: string) => unknown } | undefined } | undefined)?.modelRegistry;
    const slash = model.indexOf("/");
    const providerId = slash === -1 ? model : model.slice(0, slash);
    const modelId = slash === -1 ? model : model.slice(slash + 1);
    // ModelRegistry.find(provider, modelId) → pi-ai Model (含 contextWindow, settings modelOverrides 可覆盖).
    const m = registry?.find?.(providerId, modelId) as { contextWindow?: number; context_window?: number } | undefined;
    const w = m?.contextWindow ?? (m as { context_window?: number } | undefined)?.context_window;
    return typeof w === "number" && w > 0 ? w : defaultModelWindow();
  } catch {
    return defaultModelWindow();
  }
}
// 强制预算解析: 显式 usageBudget → 原样 (auto=false); 未传 → 自动 0.7 × 模型窗口 (auto=true).
// 调用处 (single/parallel/resume) 统一走本函数, 载荷透传 budget/auto 供父会话与诊断.
export function resolveEffectiveUsageBudget(
  explicit: number | undefined,
  model: string | undefined,
  ctx: unknown,
): { budget: number; auto: boolean } {
  if (explicit !== undefined) return { budget: explicit, auto: false };
  return { budget: Math.max(1, Math.round(resolveModelWindow(ctx, model) * usageBudgetRatio())), auto: true };
}
const DEFAULT_TIMEOUT_MS = 900000;
// M3-01 考察点 3: timeout 三阶段终止信号延迟常量.
const TIMEOUT_SIGTERM_DELAY_MS = 1000;
const TIMEOUT_SIGKILL_DELAY_MS = 4000;
// M3-01 考察点 2/4: drain 三阶段常量 (terminal stop/agent_settled → 1s grace → SIGTERM → 3s SIGKILL) + 取消 SIGKILL 延迟.
const FINAL_STOP_GRACE_MS = 1000;
const HARD_KILL_MS = 3000;
const CANCEL_SIGKILL_DELAY_MS = 3000;

// M3-04 考察点 2: task 内联转 @file 的字符上限.
// 导出: ISSUE-06 resume follow-up 组装复用 (resume.ts).
export const TASK_ARG_LIMIT = 8000;

// M3-01 考察点 5/6: 有界尾部缓冲 (rawStdoutTail / stderrTail 各 128KB) + 空输出判定消息.
const MAX_TAIL_BYTES = 128 * 1024;
const EMPTY_OUTPUT_ERROR = "Subagent produced no output (possible model cold-start or empty response.)";
// ISSUE-07 deferred (a): progress 快照有界截断 (M3-02 考察点 6: recentTools ≤10 / recentOutput ≤50) + args 预览上限.
const MAX_RECENT_TOOLS = 10;
const MAX_RECENT_OUTPUT = 50;
const MAX_TOOL_ARGS_PREVIEW = 200;

// ---- M3-01 考察点 5 + EXECUTION.md 调和 9: 16MB 单行上限 (防御) + failProtocol + 聚合投影. ----
// 单行超上限 → failProtocol: 记录 protocolError + error=formatProtocolOutputLimit + SIGTERM → HARD_KILL_MS → SIGKILL;
// turn_end/agent_end 巨型聚合行 (并行图片 payload 撑爆单行) 由投影替换为保留 type/willRetry 的合成事件, 不误杀.
// MAX_PENDING_LINE_BYTES 默认 16MB (可注入): 测试用小值 env 覆盖 (ISSUE-02 风险提示, 不真造 16MB 行).
export const MAX_PENDING_LINE_BYTES = 16 * 1024 * 1024;
// 注入缝: SLIM_SUBAGENT_PENDING_LINE_BYTES env 为正整数时覆盖行上限 (惰性读取, 测试在 execute 前设 env);
// 非法/缺省回退 16MB. 与 PI_SUBAGENT_PI_BINARY/FAKE_PI_SCENARIO 同为测试注入 env 模式.
function readPendingLineLimit(): number {
  const fromEnv = Number(process.env.SLIM_SUBAGENT_PENDING_LINE_BYTES);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : MAX_PENDING_LINE_BYTES;
}
const MAX_PROTOCOL_DIAGNOSTIC_BYTES = 4096;
const MAX_PROJECTED_JSON_DEPTH = 256;
const MAX_CAPTURED_FIELD_LEN = 64;

// 旧码 ProtocolOutputLimit 同形 (failProtocol 诊断载荷).
interface ProtocolOutputLimit {
  code: "protocol_output_limit";
  stream: "stdout" | "stderr";
  limitBytes: number;
  observedBytes: number;
  diagnosticPrefix: string;
  diagnosticTail: string;
}

// 旧码 formatProtocolOutputLimit 原文 (failProtocol 报错形态).
function formatProtocolOutputLimit(limit: ProtocolOutputLimit): string {
  return `${limit.code}: child ${limit.stream} line exceeded ${limit.limitBytes} bytes (observed at least ${limit.observedBytes} bytes without a newline).`;
}

// 有界尾部缓冲: 只保留最近 limitBytes 字节 (供失败诊断; 按字符切割不拆多字节字符).
function makeBoundedTail(limitBytes: number): { push(text: string): void; text(): string } {
  let buffer = "";
  return {
    push(text: string): void {
      buffer += text;
      const bytes = Buffer.byteLength(buffer);
      if (bytes > limitBytes) {
        let remaining = bytes - limitBytes;
        let start = 0;
        for (let i = 0; i < buffer.length; i++) {
          remaining -= Buffer.byteLength(buffer[i]);
          start = i + 1;
          if (remaining <= 0) break;
        }
        buffer = buffer.slice(start);
      }
    },
    text(): string {
      return buffer;
    },
  };
}

// EXECUTION.md 调和 3: run-<YYYYMMDD-HHMMSS>-<6位随机>.
// 导出: ISSUE-05 parallel 批次 runId 生成 (调度处, index.ts).
export function makeRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `run-${ts}-${crypto.randomBytes(3).toString("hex")}`;
}

// EXECUTION.md 调和 1: session root = ~/.pi/agent/slim-subagent/sessions.
// 导出: sessionsRootDir 供 ISSUE-06 resume 寻址/GC 扫描 (resume.ts).
export function sessionsRootDir(): string {
  return path.join(getAgentDir(), "slim-subagent", "sessions");
}
export function sessionRootDir(runId: string): string {
  return path.join(sessionsRootDir(), runId);
}

function sessionPaths(runId: string): { sessionDir: string; sessionFile: string } {
  const sessionDir = sessionRootDir(runId);
  return { sessionDir, sessionFile: path.join(sessionDir, "run-0", "session.jsonl") };
}

// ISSUE-02 #2: run.json {runId, agent, model?, thinking?, cwd, startedAt, sessionFile} (原子写: 同目录 tmp + rename).
// ISSUE-02 #4 (M02 D005): settle 完成后二次原子写 — 读原 run.json (不存在则 return), 合并 endedAtMs/finalStatus/usage 摘要,
// tmp+rename 同目录原子替换; 全程 try/catch, 失败只降级 warn (L07 settle 标记), 绝不 throw (不阻塞终止管线).
// 导出: resume.ts 复用 (resume settle 补丁写同源).
export function writeRunJsonSettle(
  sessionDir: string,
  patch: { endedAtMs: number; finalStatus: string | undefined; usage: Usage },
): void {
  try {
    const runJsonPath = path.join(sessionDir, "run.json");
    if (!fs.existsSync(runJsonPath)) return; // per-child/无 run.json 批次 → 无首笔则无补丁 (调用侧已按 skipRunJson 过滤)
    const existing = JSON.parse(fs.readFileSync(runJsonPath, "utf-8")) as Record<string, unknown>;
    const merged = {
      ...existing,
      endedAtMs: patch.endedAtMs,
      ...(patch.finalStatus !== undefined ? { finalStatus: patch.finalStatus } : {}),
      // D005: usage 摘要 (Session Viewer 需 elapsed/usage 一手证据; 不覆盖首笔字段之外的结构).
      usage: patch.usage,
    };
    const tmp = path.join(sessionDir, "run.json.settle.tmp");
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
    fs.renameSync(tmp, runJsonPath);
  } catch (e) {
    logEvent({ level: "warn", event: "run.json.write.failed", errorMessage: (e as Error).message, data: { settle: true } });
  }
}

function writeRunJson(
  data: { runId: string; agent: string; model?: string; thinking?: string; cwd: string; startedAt: string; tools?: string[] },
  sessionDir: string,
): void {
  const runJson = {
    runId: data.runId,
    agent: data.agent,
    ...(data.model ? { model: data.model } : {}),
    ...(data.thinking ? { thinking: data.thinking } : {}),
    cwd: data.cwd,
    startedAt: data.startedAt,
    // EXECUTION.md 调和 14: tools 快照 (agent 定义解析后的工具面, resume spawn 按快照重建 --tools);
    // 无 tools 字段 = 全工具 (重建时不加 --tools, 对齐 agent 定义缺 tools 行为) — agent 无 tools 时省略字段.
    ...(data.tools && data.tools.length > 0 ? { tools: data.tools } : {}),
    sessionFile: "run-0/session.jsonl",
  };
  const target = path.join(sessionDir, "run.json");
  const tmp = path.join(sessionDir, "run.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(runJson, null, 2) + "\n");
  fs.renameSync(tmp, target);
}

// ---- M3-04 考察点 1: pi 可执行 4 级寻址链 (env 覆盖 → standalone 可执行 → argv[1] CLI 脚本 → 包 bin 解析 → PATH 兜底). ----

// M3-04 考察点 1: pi 包常量 + 从入口文件向上找包根 (package.json name 匹配).
const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

function isRunnableNodeScript(p: string): boolean {
  return /\.(mjs|cjs|js)$/i.test(p) && fs.existsSync(p);
}

export function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
  let dir = path.dirname(entryPoint);
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg?.name === PI_CODING_AGENT_PACKAGE) return dir;
      } catch {
        // 坏 package.json 不致命, 继续向上
      }
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

// 第 3 级 b: import.meta.resolve 向上找包根, 读 package.json bin 拼 CLI 脚本路径.
function resolvePiPackageBin(): string | undefined {
  try {
    const resolved = import.meta.resolve(PI_CODING_AGENT_PACKAGE);
    let dir = path.dirname(fileURLToPath(resolved));
    for (;;) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg?.name === PI_CODING_AGENT_PACKAGE && pkg.bin) {
          const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi ?? Object.values(pkg.bin)[0];
          if (typeof bin === "string") return path.join(dir, bin);
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

// 导出供寻址链测试 (TS-002 顺带修); deps 仅暴露 execPath/argv1 两个可选注入点 (M3-04 规格裁剪面), 缺省 = 进程值.
export function getPiInvocation(
  args: string[],
  deps?: { execPath?: string; argv1?: string },
): { command: string; args: string[] } {
  const execPath = deps?.execPath ?? process.execPath;
  const argv1 = deps?.argv1 ?? process.argv[1];
  // L08 (debug): 命中寻址级 + 命令 basename (只插桩, 不改寻址返回值/顺序; debug 默认不落盘).
  const noteResolved = (level: string, command: string): void =>
    logEvent({ level: "debug", event: "pi.invocation.resolved", data: { level, command: path.basename(command) } });

  // (a) env 覆盖 (PI_SUBAGENT_PI_BINARY) — 最高优先, 测试注入 fake pi 即走此级.
  const envOverride = process.env.PI_SUBAGENT_PI_BINARY?.trim();
  if (envOverride) {
    // Windows 无 shebang 机制, .mjs/.js/.cjs 脚本不可直接 spawn → 用当前 node 执行 (POSIX 下行为等价).
    if (/\.(m|c)?js$/i.test(envOverride)) {
      noteResolved("env", execPath);
      return { command: execPath, args: [envOverride, ...args] };
    }
    noteResolved("env", envOverride);
    return { command: envOverride, args };
  }

  // (b) standalone 独立 pi 可执行.
  const execName = path.basename(execPath).toLowerCase();
  if (/^pi(\.exe)?$/i.test(execName)) {
    noteResolved("standalone", execPath);
    return { command: execPath, args };
  }

  // (c) argv[1] CLI 脚本 (pi 以 node 加载扩展时 argv[1] 即 pi CLI 入口).
  // 规格 (M3-04 考察点 1): realpath 后仍 runnable 且向上找 package.json name 匹配才命中, 否则落下一级.
  if (argv1 && !argv1.startsWith("/$bunfs/root/") && isRunnableNodeScript(argv1)) {
    try {
      const canonical = fs.realpathSync(argv1);
      if (isRunnableNodeScript(canonical) && findPiPackageRootFromEntry(canonical)) {
        noteResolved("cli", execPath);
        return { command: execPath, args: [canonical, ...args] };
      }
    } catch {
      // realpath 失败 (入口不可达/损坏) → 落到下一级
    }
  }

  // (d) 包 bin 解析兜底.
  const packageBin = resolvePiPackageBin();
  if (packageBin) {
    noteResolved("package-bin", execPath);
    return { command: execPath, args: [packageBin, ...args] };
  }

  // PATH 兜底.
  noteResolved("path", "pi");
  return { command: "pi", args };
}

// ---- M3-04 考察点 2 保留段 + EXECUTION.md 调和 8: args 组装. ----
// base ["--mode","json","-p"], 恒 --session <per-run 文件>, --model 有才加, --tools csv 有才加,
// 恒 --no-skills + --no-extensions (调和 8) + 显式 -e resolve-skill 例外 (--no-extensions 下显式 -e 仍生效,
// 使全部子代理可用 resolve_skill; 文件缺失静默跳过), --append-system-prompt <temp 0600 文件>, Task: <task> (>8000 转 @file).
// resolve-skill 扩展路径: user 级 ~/.pi/agent/extensions/resolve-skill.ts (与父会话同源单一真相, 不 vendoring).
export function resolveSkillExtensionPath(): string | undefined {
  const p = path.join(getAgentDir(), "extensions", "resolve-skill.ts");
  return fs.existsSync(p) ? p : undefined;
}

function buildPiArgs(opts: {
  agent: AgentConfig;
  task: string;
  model?: string;
  thinking?: string;
  sessionFile: string;
  promptFile: string | null;
  tmpDir: string;
}): string[] {
  const args: string[] = ["--mode", "json", "-p", "--session", opts.sessionFile];
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  if (opts.agent.tools && opts.agent.tools.length > 0) args.push("--tools", opts.agent.tools.join(","));
  args.push("--no-skills", "--no-extensions");
  const resolveSkillExt = resolveSkillExtensionPath();
  if (resolveSkillExt) args.push("-e", resolveSkillExt);
  if (opts.promptFile) args.push("--append-system-prompt", opts.promptFile);
  if (opts.task.length > TASK_ARG_LIMIT) {
    const safeName = opts.agent.name.replace(/[^\w.-]+/g, "_");
    const taskFile = path.join(opts.tmpDir, `task-${safeName}.txt`);
    fs.writeFileSync(taskFile, opts.task, "utf-8");
    args.push("@" + taskFile);
  } else {
    args.push("Task: " + opts.task);
  }
  return args;
}

// ---- 行解析 (M3-02 考察点 1/2) 与 close 结果构造 (M3-01 考察点 6 主路径). ----

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function hasTextContent(msg: AgentMessageLike): boolean {
  return (msg.content ?? []).some((p) => p.type === "text" && typeof p.text === "string" && p.text.trim() !== "");
}

// ISSUE-07 deferred (a): content 文本拼接 (recentOutput 行来源, 考察点 2).
function extractTextFromContent(content: unknown[]): string {
  return (content ?? []).map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : "")).join("");
}

// ISSUE-07 deferred (a): tool_execution_start args 截断预览 (考察点 1b).
function previewToolArgs(args: unknown): string {
  if (args === undefined) return "";
  let s: string;
  try {
    s = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return s.length > MAX_TOOL_ARGS_PREVIEW ? `${s.slice(0, MAX_TOOL_ARGS_PREVIEW)}...` : s;
}

// M3-02 考察点 4: 从后向前找最后一条有效 assistant 文本 (跳过 errorMessage / stopReason==="error").
function getFinalOutput(messages: AgentMessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    if (msg.errorMessage || msg.stopReason === "error") continue;
    const parts = (msg.content ?? []).filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && typeof p.text === "string" && p.text.trim() !== "",
    );
    if (parts.length > 0) return parts.map((p) => p.text).join("\n");
  }
  return "";
}

// M3-01 考察点 3: trySignalChild — 进程可能已退出, kill 抛错时 catch 返回 false.
function trySignalChild(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals): boolean {
  try {
    return proc.kill(signal);
  } catch {
    return false;
  }
}

// ---- M3-01 考察点 5: turn_end/agent_end 巨型聚合行投影 (旧码 PI_AGGREGATE_EVENT_PROJECTOR 移植). ----
// pi JSON 模式先发粒度事件再发聚合 turn_end/agent_end (重复载荷); 并行图片读取可使单条聚合记录超行上限,
// 而每个粒度事件都合法. 只把语法合法且冗余的记录替换为运行方消费的生命周期字段 (type/willRetry), 不误杀.
// 旧码为完整 JSON tokenizer; slim 移植同构状态机, 数字语法稍宽松 (对防御目的无影响: 投影输出由本函数构造, 恒合法).
interface AggregateProjection {
  push(text: string): boolean;
  finish(): string | undefined;
}

type ProjContainer = { kind: "object" | "array"; state: string; key?: string };

function createAggregateProjection(): AggregateProjection {
  // 输入已是 string (行读取器已 toString), 无需 TextDecoder 再解码.
  const stack: ProjContainer[] = [];
  let rootClosed = false;
  let inString = false;
  let stringRole: "key" | "value" | undefined;
  let stringValue = "";
  let captureString = false;
  let escaped = false;
  let unicodeDigits = 0;
  let unicodeValue = "";
  let literal: { expected: string; index: number; value: boolean | null } | undefined;
  let inNumber = false;
  let valid = true;
  let eventType: string | undefined;
  let willRetry: boolean | undefined;

  const parent = (): ProjContainer | undefined => stack[stack.length - 1];

  // 顶层 type (字符串) / willRetry (布尔) 捕获; 嵌套层不捕获 (旧码 isTopLevelField 同款).
  const completeValue = (value?: string | boolean | null): void => {
    const c = parent();
    if (!c) {
      rootClosed = true;
      return;
    }
    if (c.kind === "object") {
      if (stack.length === 1 && c.key === "type" && typeof value === "string") eventType = value;
      if (stack.length === 1 && c.key === "willRetry" && typeof value === "boolean") willRetry = value;
      c.key = undefined;
      c.state = "comma-or-end";
    } else c.state = "comma-or-end";
  };

  const startValue = (char: string): boolean => {
    const c = parent();
    const key = c?.kind === "object" ? c.key : undefined;
    if (char === "{" || char === "[") {
      if (stack.length >= MAX_PROJECTED_JSON_DEPTH) return false;
      stack.push(char === "{" ? { kind: "object", state: "key-or-end" } : { kind: "array", state: "value-or-end" });
      return true;
    }
    if (char === '"') {
      inString = true;
      stringRole = "value";
      stringValue = "";
      captureString = key === "type" && stack.length === 1;
      escaped = false;
      unicodeDigits = 0;
      return true;
    }
    if (char === "t") literal = { expected: "true", index: 1, value: true };
    else if (char === "f") literal = { expected: "false", index: 1, value: false };
    else if (char === "n") literal = { expected: "null", index: 1, value: null };
    else if (char === "-" || (char >= "0" && char <= "9")) inNumber = true;
    else return false;
    return true;
  };

  const closeContainer = (): boolean => {
    stack.pop();
    completeValue();
    return true;
  };

  const openString = (): boolean => {
    const c = parent();
    if (!c || c.kind !== "object") return false;
    inString = true;
    stringRole = "key";
    stringValue = "";
    // 旧码同款: key 字符串仅在顶层累积 (嵌套 key 不消费, 空值无害); captureString 须在此显式重置,
    // 否则沿用上一值字符串的 capture 状态, 顶层 key 不累积 → type/willRetry 永远捕获不到.
    captureString = stack.length === 1;
    escaped = false;
    unicodeDigits = 0;
    return true;
  };

  const processChar = (char: string): boolean => {
    if (inString) {
      if (unicodeDigits > 0) {
        if (!/[0-9a-fA-F]/.test(char)) return false;
        unicodeValue += char;
        unicodeDigits--;
        if (unicodeDigits === 0 && captureString) {
          if (stringValue.length >= MAX_CAPTURED_FIELD_LEN) return false;
          stringValue += String.fromCharCode(Number.parseInt(unicodeValue, 16));
        }
        return true;
      }
      if (escaped) {
        escaped = false;
        if (char === "u") {
          unicodeDigits = 4;
          unicodeValue = "";
          return true;
        }
        if (!'"\\/bfnrt'.includes(char)) return false;
        if (captureString) {
          if (stringValue.length >= MAX_CAPTURED_FIELD_LEN) return false;
          stringValue += ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[char] ?? char;
        }
        return true;
      }
      if (char === "\\") {
        escaped = true;
        return true;
      }
      if (char === '"') {
        inString = false;
        if (stringRole === "key") {
          const c = parent();
          if (!c || c.kind !== "object") return false;
          c.key = stringValue;
          c.state = "colon";
        } else completeValue(captureString ? stringValue : undefined);
        return true;
      }
      if (char.charCodeAt(0) < 0x20) return false;
      if (captureString) {
        if (stringValue.length >= MAX_CAPTURED_FIELD_LEN) return false;
        stringValue += char;
      }
      return true;
    }
    if (literal) {
      if (char !== literal.expected[literal.index]) return false;
      literal.index++;
      if (literal.index === literal.expected.length) {
        const v = literal.value;
        literal = undefined;
        completeValue(v);
      }
      return true;
    }
    if (inNumber) {
      if (char === "," || char === "}" || char === "]" || char === " " || char === "\t" || char === "\r" || char === "\n") {
        inNumber = false;
        completeValue();
        return processChar(char);
      }
      if (!/[0-9eE.+-]/.test(char)) return false;
      return true;
    }
    if (char === " " || char === "\t" || char === "\r" || char === "\n") return true;
    const c = parent();
    if (!c) return rootClosed ? false : startValue(char);
    if (c.kind === "object") {
      if (c.state === "key-or-end" || c.state === "key") {
        if (char === "}" && c.state === "key-or-end") return closeContainer();
        if (char !== '"') return false;
        return openString();
      }
      if (c.state === "colon") {
        if (char !== ":") return false;
        c.state = "value";
        return true;
      }
      if (c.state === "value") return startValue(char);
      if (char === ",") {
        c.state = "key";
        return true;
      }
      if (char === "}") return closeContainer();
      return false;
    }
    if (c.state === "value-or-end" || c.state === "value") {
      if (char === "]" && c.state === "value-or-end") return closeContainer();
      return startValue(char);
    }
    if (char === ",") {
      c.state = "value";
      return true;
    }
    if (char === "]") return closeContainer();
    return false;
  };

  const processText = (text: string): boolean => {
    for (const char of text) if (!processChar(char)) return false;
    return true;
  };

  return {
    push(text: string) {
      if (!valid) return false;
      valid = processText(text);
      return valid;
    },
    finish() {
      if (inNumber) {
        inNumber = false;
        completeValue();
      }
      if (!valid || inString || literal || stack.length !== 0 || !rootClosed) return undefined;
      if (eventType === "turn_end") return '{"type":"turn_end"}';
      if (eventType === "agent_end" && typeof willRetry === "boolean") return JSON.stringify({ type: "agent_end", willRetry });
      return undefined;
    },
  };
}

// 旧码 PI_AGGREGATE_EVENT_PROJECTOR.accepts 同款: 只接受 turn_end/agent_end 前缀的巨型聚合行.
function acceptsAggregatePrefix(prefix: string): boolean {
  return prefix.startsWith('{"type":"turn_end"') || prefix.startsWith('{"type":"agent_end"');
}

export async function runProcess(
  agent: AgentConfig,
  task: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  usageBudget?: number, // ISSUE-04: token 上限 (已由 runSingleAgent 校验层保证正数或 undefined)
  budgetAuto?: boolean, // ISSUE-02 L16/L17: 预算自动/显式标记 (仅日志载荷, 不影响执行)
  onUpdate?: StreamUpdateCallback, // M3-02 考察点 6: 流式更新回调
): Promise<SingleResult> {
  const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result: SingleResult = {
    index: 0,
    agent: agent.name,
    task,
    exitCode: 0,
    usage: emptyUsage(),
    messages: [],
    stderr: "",
    timeoutMs: effectiveTimeout,
  };
  // M3-01 考察点 1: spawn 配置常量照搬.
  const invocation = getPiInvocation(args);
  const proc = spawn(invocation.command, invocation.args, {
    cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return await new Promise<SingleResult>((resolve) => {
    let buffer = "";
    // M3-01 考察点 5: 行上限本次运行固定快照 (env 可注入小值, 测试用; 默认 16MB).
    const maxPendingLineBytes = readPendingLineLimit();
    let pendingLineBytes = 0;
    let assistantError: string | undefined;
    let settled = false;
    // M3-01 考察点 5: 非 JSON stdout 行尾部缓冲 + stderr 尾部缓冲 (各 128KB, 失败诊断用).
    const rawStdoutTail = makeBoundedTail(MAX_TAIL_BYTES);
    const stderrTail = makeBoundedTail(MAX_TAIL_BYTES);
    // ISSUE-03: timeout 定时器句柄.
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let sigtermTimer: ReturnType<typeof setTimeout> | undefined;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    // M3-01 考察点 5: failProtocol 终止定时器 + 行读取状态 (limitExceeded 后停止处理 stdout).
    let protocolHardKillTimer: ReturnType<typeof setTimeout> | undefined;
    let limitExceeded = false;
    let projecting = false;
    let projection: AggregateProjection | undefined;
    let projectedBytes = 0;
    let projectedPrefix = "";
    let projectedTail = "";

    // ISSUE-07 deferred (a): tool_execution 进度累积 (考察点 1b) — start 记 currentTool, end 落 recentTools (≤10 有界); 两者触发 onUpdate (考察点 6).
    const recentTools: { tool: string; args: string; endMs: number }[] = [];
    const recentOutput: string[] = [];
    let currentTool: string | undefined;
    let currentToolArgs = "";

    const clearTimeoutTimers = () => {
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined; }
      if (sigtermTimer) { clearTimeout(sigtermTimer); sigtermTimer = undefined; }
      if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = undefined; }
    };

    // M3-01 考察点 2: drain 状态机闭包变量 (childExited/lifecycleFinished/processClosed → settled 等价).
    let childExited = false;
    let forcedTerminationSignal = false;
    let cleanTerminalAssistantStopReceived = false;
    let agentSettledReceived = false;
    let finalDrainTimer: ReturnType<typeof setTimeout> | undefined;
    let finalHardKillTimer: ReturnType<typeof setTimeout> | undefined;
    // M3-01 考察点 4: 取消监听移除句柄 (finish/settle 时 removeEventListener).
    let removeAbortListener: (() => void) | undefined;
    // ISSUE-02 L11-L24 采样状态 (高频防护: 仅首/尾或首次超阈值记, 防刷盘).
    let loggedInitialUpdate = false; // L11: emitUpdate 初始采样已记
    let pendingFinalUpdate = false; // L11: 下一次 emitUpdate 为 settle 最终次
    let nonJsonLineCount = 0; // L12: 非 JSON 行计数
    let nonJsonWarned = false; // L12: 首次 >3 已记
    let assistantMessageCount = 0; // L15: assistant message_end 采样
    let budgetWarned80 = false; // L16: 预算 80% 提示已记

    const clearFinalDrainTimers = () => {
      if (finalDrainTimer) { clearTimeout(finalDrainTimer); finalDrainTimer = undefined; }
      if (finalHardKillTimer) { clearTimeout(finalHardKillTimer); finalHardKillTimer = undefined; }
    };

    // M3-01 考察点 2 逻辑步骤 (M4 直接照做): 1s grace → SIGTERM → 3s SIGKILL; 守卫防重复启动;
    // 两 timer 均 unref (不独占事件循环). 与 timeout 三阶段管线 (考察点 3) 独立共存:
    // timeout 先触发时 drain 定时器照常存在, 但 close 时两套定时器都清理, 不互相污染.
    const startFinalDrain = () => {
      if (childExited || settled || finalDrainTimer) return;
      // L22 (info): final drain 启动 (terminal stop/agent_settled 后 1s grace 强制收尾).
      logEvent({ level: "info", event: "final_drain.start", mode: "single", agent: result.agent, data: { graceMs: FINAL_STOP_GRACE_MS } });
      finalDrainTimer = setTimeout(() => {
        if (settled) return;
        const termSent = signalChild("SIGTERM");
        if (!termSent) return;
        forcedTerminationSignal = true;
        // L23 (warn): drain 强制阶段 — SIGTERM 置真处.
        logEvent({ level: "warn", event: "final_drain.forced", mode: "single", agent: result.agent, data: { signal: "SIGTERM" } });
        if (!cleanTerminalAssistantStopReceived && !agentSettledReceived && !assistantError) {
          result.error = result.error ?? `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its terminal event. Forcing termination.`;
        }
        finalHardKillTimer = setTimeout(() => {
          if (settled) return;
          forcedTerminationSignal = signalChild("SIGKILL") || forcedTerminationSignal;
          // L23 (warn): drain 强制阶段 — SIGKILL 处.
          logEvent({ level: "warn", event: "final_drain.forced", mode: "single", agent: result.agent, data: { signal: "SIGKILL" } });
        }, HARD_KILL_MS);
        finalHardKillTimer.unref?.();
      }, FINAL_STOP_GRACE_MS);
      finalDrainTimer.unref?.();
    };

    // M3-01 考察点 3 + ISSUE-04: 三阶段终止序列共用 (timeout / usageBudget 触顶同款):
    // SIGINT @0ms → SIGTERM @+1000ms → SIGKILL @+4000ms (子进程有机会优雅收尾, 逐步升级).
    // L21 (warn): trySignalChild 包装 — 每次发信号记日志 (ok=返回), 行为等价.
    const signalChild = (sig: NodeJS.Signals): boolean => {
      const ok = trySignalChild(proc, sig);
      logEvent({ level: "warn", event: "process.signal.sent", mode: "single", agent: result.agent, data: { signal: sig, ok } });
      return ok;
    };

    const startAbortSequence = () => {
      signalChild("SIGINT"); // 阶段 1: 立即 SIGINT
      sigtermTimer = setTimeout(() => { // 阶段 2: +1000ms → SIGTERM
        signalChild("SIGTERM");
      }, TIMEOUT_SIGTERM_DELAY_MS);
      sigkillTimer = setTimeout(() => { // 阶段 3: +4000ms → SIGKILL
        signalChild("SIGKILL");
      }, TIMEOUT_SIGKILL_DELAY_MS);
    };

    // M3-01 考察点 3: timeout 定时器 — 父进程定时, 子进程无感知.
    timeoutTimer = setTimeout(() => {
      if (result.budgetExceeded) return; // ISSUE-04: 先触发者胜 (budget 已触顶, timeout 不再发)
      result.timedOut = true;
      // L19 (error): timeout 触发 (timedOut 置真处).
      logEvent({ level: "error", event: "timeout.fired", mode: "single", agent: result.agent, timeoutMsExplicit: timeoutMs, data: { timeoutMs: effectiveTimeout } });
      result.error = `Subagent timed out after ${effectiveTimeout}ms.`;
      startAbortSequence();
    }, effectiveTimeout);
    // L18 (info/debug): timeout 定时器武装 — 显式 timeoutMs 记 info, 自动缺省记 debug.
    logEvent({
      level: timeoutMs !== undefined ? "info" : "debug",
      event: "timeout.armed",
      mode: "single",
      agent: result.agent,
      timeoutMsExplicit: timeoutMs,
      data: { timeoutMs: effectiveTimeout, explicit: timeoutMs !== undefined },
    });

    // M3-02 考察点 6: 流式更新 emit — 触发点 spawn 初始 + tool_execution_start/end + message_end + tool_result_end + close 最终; 官方口径直接带 live result/messages.
    const emitUpdate = (textOverride?: string) => {
      // L11 (info): 采样 — spawn 初始那次与 settle 最终那次记 info, 中间 emitUpdate 不记 (高频防刷盘).
      if (!loggedInitialUpdate) {
        loggedInitialUpdate = true;
        logEvent({ level: "info", event: "single.update.emit", mode: "single", agent: result.agent, data: { sample: "init", results: 1 } });
      } else if (pendingFinalUpdate) {
        pendingFinalUpdate = false;
        logEvent({ level: "info", event: "single.update.emit", mode: "single", agent: result.agent, data: { sample: "final", results: 1 } });
      }
      if (!onUpdate) return;
      const text = textOverride ?? (getFinalOutput(result.messages) || "(running...)");
      try {
        onUpdate({
          content: [{ type: "text", text }],
          details: {
            mode: "single",
            results: [result],
            // progress 快照 (考察点 6: 深拷贝 + 有界截断 ≤10 recentTools / ≤50 recentOutput), 防闭包引用被后续事件污染.
            progress: [{ recentTools: recentTools.slice(-MAX_RECENT_TOOLS), recentOutput: recentOutput.slice(-MAX_RECENT_OUTPUT) }],
          },
        });
      } catch (e) {
        // L44 (warn): onUpdate 回调抛错 → 记日志后回退 (吞掉, 不阻断执行管线).
        logEvent({ level: "warn", event: "render.update.failed", data: { onUpdate: true, error: (e as Error).message } });
      }
    };
    emitUpdate(); // spawn 后立即 1 次 (初始 "(running...)", TUI 即时反馈 — 旧码保留项)

    // M3-02 考察点 1: 事件处理清单 (消费 tool_execution_start/end 进度 + message_end + tool_result_end 防御 + agent_settled/agent_end drain 挂钩).
    const processLine = (line: string) => {
      if (!line.trim()) return;
      let evt: { type?: string; message?: AgentMessageLike; willRetry?: unknown; toolName?: unknown; args?: unknown };
      try {
        evt = JSON.parse(line);
      } catch {
        // M3-02 考察点 3: 非 JSON 行静默跳过, 原行入 rawStdoutTail 供失败诊断 (exit 0 时完全无害).
        rawStdoutTail.push(line + "\n");
        // L12 (warn): 非 JSON 行计数 — 首次超过 3 记一次, 之后不再记 (防刷).
        nonJsonLineCount++;
        if (nonJsonLineCount > 3 && !nonJsonWarned) {
          nonJsonWarned = true;
          logEvent({ level: "warn", event: "stdout.line.non_json", mode: "single", agent: result.agent, data: { count: nonJsonLineCount } });
        }
        return;
      }
      // ISSUE-07 deferred (a): tool_execution_start/end → progress 累积 + onUpdate (考察点 1b/6).
      if (evt?.type === "tool_execution_start") {
        currentTool = typeof evt.toolName === "string" ? evt.toolName : undefined;
        currentToolArgs = previewToolArgs(evt.args);
        emitUpdate();
      } else if (evt?.type === "tool_execution_end") {
        if (currentTool) {
          recentTools.push({ tool: currentTool, args: currentToolArgs, endMs: Date.now() });
          if (recentTools.length > MAX_RECENT_TOOLS) recentTools.shift();
        }
        currentTool = undefined;
        currentToolArgs = "";
        emitUpdate();
      }
      if (evt?.type === "message_end" && evt.message) {
        const msg = evt.message;
        result.messages.push(msg); // 全角色 push
        if (msg.role !== "assistant") {
          emitUpdate(); // message_end 后 1 次 (考察点 6; 官方示例同点: 非 assistant 消息也触发)
          return;
        }

        // M3-02 考察点 2: usage 六字段累加 + contextTokens 最新 totalTokens (非累加).
        result.usage.turns++;
        const u = msg.usage;
        if (u) {
          result.usage.input += u.input || 0;
          result.usage.output += u.output || 0;
          result.usage.cacheRead += u.cacheRead || 0;
          result.usage.cacheWrite += u.cacheWrite || 0;
          result.usage.cost += u.cost?.total || 0;
          if (typeof u.totalTokens === "number") result.contextTokens = u.totalTokens;
        }
        // L15 (info): message_end usage 采样 — 第 1 次 + 每 5 次 assistant 记 (高频防刷盘).
        assistantMessageCount++;
        if (assistantMessageCount === 1 || assistantMessageCount % 5 === 0) {
          logEvent({
            level: "info",
            event: "message_end.usage",
            mode: "single",
            agent: result.agent,
            model: result.model,
            data: {
              input: result.usage.input,
              output: result.usage.output,
              cacheRead: result.usage.cacheRead,
              cacheWrite: result.usage.cacheWrite,
              cost: result.usage.cost,
              turns: result.usage.turns,
              contextTokens: result.contextTokens,
            },
          });
        }
        // ISSUE-04 (M3-02 考察点 5 选项 B): usage 累加后立即比对 (挂点: 累加之后 fireUpdate 之前, 同步无异步间隙),
        // used = input + output + cacheWrite (M2-D003, cacheRead 不计), used >= usageBudget 触顶 → 复用 timeout 终止管线.
        // 守卫: 已触顶/已 timeout 不重发; terminal stop 已收到后不再触发 (结果已干净完成, 风险提示 2 选守卫).
        if (usageBudget !== undefined && !result.budgetExceeded && !result.timedOut && !cleanTerminalAssistantStopReceived) {
          const used = result.usage.input + result.usage.output + result.usage.cacheWrite;
          if (used >= usageBudget) {
            // L17 (error): budget 触顶 — 记 error 后照旧启动终止序列.
            logEvent({ level: "error", event: "usage_budget.abort", mode: "single", agent: result.agent, data: { used, budget: usageBudget, budgetAuto } });
            result.budgetExceeded = true;
            result.error = `Usage budget exhausted: reported tokens ${used} reached limit ${usageBudget}.`;
            startAbortSequence();
          } else if (used >= 0.8 * usageBudget && !budgetWarned80) {
            // L16 (warn): 预算 80% 提示 — 每个 run 只记一次 (采样防刷).
            budgetWarned80 = true;
            logEvent({ level: "warn", event: "usage_budget.warn_80pct", mode: "single", agent: result.agent, data: { used, budget: usageBudget, budgetAuto } });
          }
        }
        if (msg.model && !result.model) result.model = msg.model; // 首个 assistant 消息
        // EXECUTION.md 调和 11: 中止标记优先 — 未触 timeout/usageBudget 中止才写模型级 stopReason (超时/触顶后到达的 message_end 不覆写).
        if (!result.timedOut && !result.budgetExceeded && msg.stopReason) result.stopReason = msg.stopReason;
        if (msg.errorMessage) {
          result.errorMessage = msg.errorMessage;
          assistantError = msg.errorMessage;
        }
        // ISSUE-07 deferred (a): recentOutput 累积 (考察点 2: 文本行追加, 总上限 50).
        const outLines = extractTextFromContent(msg.content).split("\n");
        if (outLines.some((l) => l.trim() !== "")) recentOutput.push(...outLines.slice(-10));
        while (recentOutput.length > MAX_RECENT_OUTPUT) recentOutput.shift();
        // terminal 判定 (stopReason==="stop" 且无 toolCall): 干净完成时错误不残留 (M3-01 考察点 6);
        // 触发 drain (考察点 2: cleanTerminalAssistantStopReceived ||= !errorMessage + startFinalDrain).
        const toolCalls = (msg.content ?? []).filter((p) => p.type === "toolCall");
        if (msg.stopReason === "stop" && toolCalls.length === 0) {
          if (!msg.errorMessage && hasTextContent(msg)) assistantError = undefined;
          cleanTerminalAssistantStopReceived ||= !msg.errorMessage;
          startFinalDrain();
        }
        emitUpdate(); // assistant message_end 后 1 次 (usage 累加之后, 考察点 6; 官方示例同序)
      }
      if (evt?.type === "tool_result_end" && evt.message) {
        result.messages.push(evt.message); // 防御分支 (M3-02 考察点 7, pi 0.82.1 不发此事件)
        emitUpdate(); // tool_result_end 后 1 次 (考察点 6; 防御分支照官方示例保留)
      }
      // M3-01 考察点 2: agent_settled → drain 兜底 (某些路径 pi 不发标准 stop);
      // agent_end + willRetry → cancel-drain (slim 无 fallback, 防御保留, 不误杀已排定 drain).
      if (evt?.type === "agent_settled") {
        agentSettledReceived = true;
        startFinalDrain();
      } else if (evt?.type === "agent_end" && evt.willRetry === true) {
        clearFinalDrainTimers();
      }
    };

    // ---- M3-01 考察点 5: 行读取 (简化版 createBoundedLineReader) — 残段字节计数, 单行超限 → 投影或 fail. ----
    // failProtocol (旧码 execution.ts 同款): 记录 protocolError + error=formatProtocolOutputLimit;
    // 子进程未退 → 立即 SIGTERM, HARD_KILL_MS 后 SIGKILL (与 drain 同常量).
    const failProtocol = (observedBytes: number, prefix: string, tail: string): void => {
      if (limitExceeded) return;
      limitExceeded = true;
      result.protocolError = {
        code: "protocol_output_limit",
        stream: "stdout",
        limitBytes: maxPendingLineBytes,
        observedBytes,
        diagnosticPrefix: prefix,
        diagnosticTail: tail,
      };
      result.error = formatProtocolOutputLimit(result.protocolError);
      // L13 (error): 协议输出超限 — failProtocol 记录 (stream/limitBytes/observedBytes).
      logEvent({ level: "error", event: "protocol.output_limit", mode: "single", agent: result.agent, data: { stream: "stdout", limitBytes: maxPendingLineBytes, observedBytes } });
      if (!childExited) {
        signalChild("SIGTERM");
        protocolHardKillTimer = setTimeout(() => {
          if (!childExited) signalChild("SIGKILL");
        }, HARD_KILL_MS);
        protocolHardKillTimer.unref?.();
      }
    };

    const diagnosticTail = (prior: string, segment: string): string =>
      (prior + segment).slice(-MAX_PROTOCOL_DIAGNOSTIC_BYTES);

    // 追加一段 (行内容/残段): 超限 → 前缀命中聚合事件则进投影 (合法才合成, 否则 fail), 其余直接 fail;
    // 返回 false 表示已 failProtocol (调用方停止处理).
    const appendSegment = (segment: string): boolean => {
      if (segment.length === 0) return true;
      if (projecting) {
        projectedBytes += Buffer.byteLength(segment);
        projectedTail = diagnosticTail(projectedTail, segment);
        if (projection?.push(segment) !== true) {
          failProtocol(projectedBytes, projectedPrefix, projectedTail);
          return false;
        }
        return true;
      }
      const observedBytes = pendingLineBytes + Buffer.byteLength(segment);
      if (observedBytes > maxPendingLineBytes) {
        const prior = buffer;
        const prefix = (prior + segment).slice(0, MAX_PROTOCOL_DIAGNOSTIC_BYTES);
        const tail = diagnosticTail(prior, segment);
        if (acceptsAggregatePrefix(prefix)) {
          const candidate = createAggregateProjection();
          if (!candidate.push(prior) || !candidate.push(segment)) {
            failProtocol(observedBytes, prefix, tail);
            return false;
          }
          buffer = "";
          pendingLineBytes = 0;
          projecting = true;
          projection = candidate;
          projectedPrefix = prefix;
          projectedTail = tail;
          projectedBytes = observedBytes;
          return true;
        }
        failProtocol(observedBytes, prefix, tail);
        return false;
      }
      buffer += segment;
      pendingLineBytes = observedBytes;
      return true;
    };

    // 行收束: 投影行 → finish 合成事件 (非法 → fail); 普通行 → processLine.
    const finishLine = (): void => {
      if (projecting) {
        const projected = projection?.finish();
        if (projected === undefined) {
          // L14 (debug): 投影失败 — 先记 debug 再 failProtocol (L14→L13 序列).
          logEvent({ level: "debug", event: "aggregate.projection", mode: "single", agent: result.agent, data: { projectedBytes, ok: false } });
          failProtocol(projectedBytes, projectedPrefix, projectedTail);
        } else {
          logEvent({ level: "debug", event: "aggregate.projection", mode: "single", agent: result.agent, data: { projectedBytes, ok: true } });
          processLine(projected);
        }
      } else if (pendingLineBytes > 0) {
        processLine(buffer);
      }
      buffer = "";
      pendingLineBytes = 0;
      projecting = false;
      projection = undefined;
      projectedPrefix = "";
      projectedTail = "";
      projectedBytes = 0;
    };

    proc.stdout.on("data", (data: Buffer) => {
      if (limitExceeded) return;
      const text = data.toString();
      // 按 \n 逐段: 每段 (行内容) 先 append (超限检查/投影喂入), 再 finishLine (行收束).
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== "\n") continue;
        if (!appendSegment(text.slice(start, i))) return;
        finishLine();
        if (limitExceeded) return;
        start = i + 1;
      }
      appendSegment(text.slice(start));
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderrTail.push(data.toString()); // 128KB 尾部 (M3-01 考察点 6)
    });

    const settle = (code: number | null, signal: string | null) => {
      result.endedAtMs = Date.now(); // ISSUE-02 (M02 D005): settle 收束时刻 — 供 details.endedAtMs 与 run.json settle 补丁同源
      if (settled) return;
      settled = true;
      clearTimeoutTimers(); // ISSUE-03: 进程自然退出时清理所有定时器.
      clearFinalDrainTimers(); // TS-004: drain 定时器同清 (exit/close 均收束).
      if (protocolHardKillTimer) {
        clearTimeout(protocolHardKillTimer);
        protocolHardKillTimer = undefined;
      }
      removeAbortListener?.(); // 取消监听清理 (考察点 4: finish 时 removeEventListener).
      // M3-01 考察点 5: 残段 flush 仅在未超限时进行 — 超限后不再处理 stdout;
      // 投影残段在 close 收束 (finishLine): 投影合法 → 合成事件, 非法 → failProtocol (旧码 reader.end() 同款).
      if (!limitExceeded) {
        if (projecting) {
          finishLine();
        } else if (buffer.trim()) {
          processLine(buffer);
        }
      }

      // M3-01 考察点 6: closeError 优先序 (result.error 前置预设 → assistantError → signal → rawStdout → stderr)
      // 与 finalCode 语义 (M4 直接照做): forcedDrainAfterFinalSuccess 优先归 0;
      // 否则 forcedTerminationSignal || signal → code ?? 1, 干净完成 → code ?? 0.
      // forcedDrainAfterFinalSuccess 在 signal 错误判定之前计算 (原码同序):
      // terminal stop/agent_settled 已收到且无 closeError → 强杀收尾不报 "terminated by signal" 错误, 退出码归 0.
      let closeError = result.error ?? assistantError;
      const forcedDrainAfterFinalSuccess =
        Boolean(forcedTerminationSignal || signal) &&
        (cleanTerminalAssistantStopReceived || agentSettledReceived) &&
        !closeError;
      if (signal) {
        result.processSignal = signal;
        if (!closeError && signal && !result.timedOut && !forcedDrainAfterFinalSuccess) {
          closeError = `Subagent process terminated by signal ${signal}.`;
        }
      }
      const rawStdout = rawStdoutTail.text();
      const stderrText = stderrTail.text();
      if (code !== 0 && rawStdout.trim() && !closeError && !forcedDrainAfterFinalSuccess) closeError = rawStdout.trim();
      if (code !== 0 && stderrText.trim() && !closeError && !forcedDrainAfterFinalSuccess) closeError = stderrText.trim();
      result.exitCode = forcedDrainAfterFinalSuccess ? 0 : (forcedTerminationSignal || signal ? (code ?? 1) : (code ?? 0));
      if (!result.error && closeError) result.error = closeError;
      result.stderr = stderrText;
      // M3-01 考察点 6 close 后收尾: 已有 error 且 exitCode===0 → exitCode=1 (错误结果不许 0 退出码).
      if (result.error && result.exitCode === 0) result.exitCode = 1;
      // ISSUE-03/ISSUE-04 调和 11: 中止标记优先 — timedOut 强制 stopReason="timeout", budget 触顶强制 stopReason="usage_budget",
      // 均 exitCode 1 (子进程优雅 SIGINT 退出 (exit 0) 也归 1, M3-01 考察点 3/6; 优雅退出不得抹掉中止语义).
      if (result.timedOut) {
        result.stopReason = "timeout";
        result.exitCode = 1;
      } else if (result.budgetExceeded) {
        result.stopReason = "usage_budget";
        result.exitCode = 1;
      }
      // ISSUE-03/ISSUE-04: 部分输出独立采集 (details.partialOutput, M2-D002(b)) + 中止 finalOutput 拼装
      // (error + 有部分输出时拼部分输出, 同 timeout 拼装形态).
      const partialOutput = getFinalOutput(result.messages);
      result.partialOutput = partialOutput;
      if (result.timedOut) {
        result.finalOutput =
          `Subagent timed out after ${effectiveTimeout}ms.` +
          (partialOutput ? `\n\nPartial output before timeout:\n${partialOutput}` : "");
      } else if (result.budgetExceeded) {
        result.finalOutput =
          (result.error ?? "") +
          (partialOutput ? `\n\nPartial output before abort:\n${partialOutput}` : "");
      } else {
        result.finalOutput = partialOutput;
      }
      // M3-01 考察点 6 / M3-02 考察点 4: 空输出判定 — exitCode 0 且无错误且无输出 → exitCode 1 + 明确错误.
      if (result.exitCode === 0 && !result.error && !result.finalOutput) {
        result.exitCode = 1;
        result.error = EMPTY_OUTPUT_ERROR;
        // L26 (error): exit 0 但无输出 → 空输出判定 (runId 经前后事件关联, runProcess 无 runId 上下文).
        logEvent({ level: "error", event: "result.empty_output", agent: result.agent, data: { exitCode: 1 } });
      }
      // L25 (info): settle 收尾完成 — exitCode/stopReason/processSignal/usage 摘要.
      logEvent({
        level: "info",
        event: "process.close.settled",
        agent: result.agent,
        data: {
          exitCode: result.exitCode,
          stopReason: result.stopReason,
          processSignal: result.processSignal,
          usage: {
            input: result.usage.input,
            output: result.usage.output,
            cacheWrite: result.usage.cacheWrite,
            cost: result.usage.cost,
            turns: result.usage.turns,
          },
        },
      });

      pendingFinalUpdate = true; // L11: 标记下一次 emitUpdate 为 settle 最终次 (采样 data:{sample:"final"}).
      emitUpdate(result.finalOutput || result.error || "(no output)"); // close 后最终 1 次 (考察点 6)
      resolve(result);
    };

    // M3-01 考察点 2: exit 事件 → childExited + 清理 drain 定时器 (原码同款, close 前先到).
    proc.on("exit", () => {
      childExited = true;
      // L24 (info): 子进程 exit 事件.
      logEvent({ level: "info", event: "process.exit", mode: "single", agent: result.agent, data: {} });
      clearFinalDrainTimers();
      if (protocolHardKillTimer) {
        clearTimeout(protocolHardKillTimer);
        protocolHardKillTimer = undefined;
      }
    });
    proc.on("close", (code, signal) => settle(code, signal));
    proc.on("error", (err) => {
      result.error = err.message; // spawn 失败 (如 ENOENT): error.message + exit 1 (M3-01 考察点 6)
      // L10 (fatal): spawn 失败 (ENOENT 等) — 记错误消息 + exitCode 1.
      logEvent({ level: "fatal", event: "single.spawn.failed", agent: result.agent, errorMessage: err.message, data: { exitCode: 1 } });
      settle(1, null);
    });

    // M3-01 考察点 4: 取消 (AbortSignal → SIGTERM → CANCEL_SIGKILL_DELAY_MS 后 SIGKILL).
    // 取消不走独立 "aborted" 结果类型 — 走通用错误路径: close 后 signal 非空 →
    // "Subagent process terminated by signal SIGTERM." + exitCode 1 (除非 forcedDrainAfterFinalSuccess).
    if (signal) {
      const kill = () => {
        if (settled) return;
        // L20 (warn): abort 信号取消请求 (signal.aborted 或 addEventListener 触发时).
        logEvent({ level: "warn", event: "signal.abort_requested", mode: "single", agent: result.agent, data: { aborted: signal.aborted } });
        signalChild("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) {
            signalChild("SIGKILL");
          }
        }, CANCEL_SIGKILL_DELAY_MS); // 非 unref (原码同款: 兜底必须触发)
      };
      if (signal.aborted) {
        kill();
      } else {
        signal.addEventListener("abort", kill, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", kill);
      }
    }
  });
}

// 长版恢复指令 (零先验消费方主通道): 悬挂在中止载荷 content 尾部, 给出 判断规则 + 下一步调用步骤.
// sessionSaved=false (未落盘) → 无法 resume, 直接重发; sessionSaved=true → 按阈值给出恢复/新起建议 + 调用模板.
// 三步协议 (用户拍板): 1) 继续 → resume 续跑; 2) 判定不再继续启用 → resume 收尾 (终止任务+交接要点);
// 3) skill:handoff 自动生成交接文档 (文件名含 agent+runId 防重名覆盖) + 新子代理接手.
function buildRecoveryDirective(opts: {
  runId: string;
  agent: string;
  sessionSaved: boolean;
  percent: number | null;
  thresholdPercent: number;
}): string {
  const pct = opts.percent;
  const occupancy =
    pct === null
      ? "子代理会话上下文占用不可得 (按正常区处理)"
      : pct > opts.thresholdPercent
        ? `子代理会话上下文占用 ${pct}% (>${opts.thresholdPercent}% 迟钝区, 建议新起)`
        : `子代理会话上下文占用 ${pct}% (≤${opts.thresholdPercent}% 正常区, 建议恢复)`;
  if (!opts.sessionSaved) {
    return `${occupancy}; 本 run 未留下可恢复会话 (中止时无完整消息落盘), 无法 resume — 直接以新子代理重发任务.`;
  }
  return (
    `${occupancy}.\n` +
    `[1] 继续: 若任务目标未变且需继续, 调用 subagent 工具 action="resume", id="${opts.runId}", ` +
    `task="<重发原任务目标, 可补一句已达成部分>"; 恢复沿用原 model 与已落盘对话, 从最后一条完整消息续跑. ` +
    `(占用 >${opts.thresholdPercent}% 时新起通常更稳: 干净窗口, 已完成的文件副作用仍在磁盘.)\n` +
    `[2] 终止交接: 若判定不再继续启用本子代理 (方向已偏/重复触顶/已近完成需换手), 用同一 resume 机制收尾:\n` +
    `    a) resume 它, task="终止任务: 总结已完成与未完成, 清理临时状态, 输出交接要点";\n` +
    `    b) 随后用 skill: handoff 自动生成交接文档, 文件名带本会话名防重名覆盖: docs/handoff/YYYY-MM-DD-${opts.agent}-${opts.runId}.md;\n` +
    `    c) 新起子代理接手, 指引其先读该交接文档与必读推荐.\n` +
    `[3] 放弃: 忽略本提示即可, 会话目录保留 7 天后自动清理.`
  );
}

// ISSUE-06: 结果回收全路径提取 (M3-01 考察点 6 + M3-02 考察点 4 + ISSUE-03/04 诊断载荷收口) —
// single 与 resume 共用 (恢复 spawn 复用 single 结果回收, ISSUE-06 风险提示).
export function assembleSingleResult(
  result: SingleResult,
  opts: {
    runId: string;
    sessionDir: string;
    sessionFile: string;
    agent: string;
    usageBudget?: number; // 生效预算 (强制解析后): 显式或自动 70% 窗口
    budgetAuto?: boolean; // true = 自动 (未显式传 usageBudget), false = 显式
    ctx?: unknown; // M02 D001: 子代理模型窗口查询源 (modelRegistry)
    model?: string; // M02 D001: 调用侧生效模型 (effectiveModel), windowModel 优先级低于 result.model
    task?: string; // M02 D002: taskPreview 原材料 (complete task 永不进 details)
    timeoutMs?: number; // M02 D002: 显式超时 (仅显式落 timeoutMsExplicit)
    startedAtMs?: number; // M02 D002: spawn 前捕获的时刻
    resumed?: boolean; // ISSUE-06: resume 结果标记
  },
): SingleToolResult {
  const finalOutput = result.finalOutput ?? "";
  // M3-01 考察点 6: isError 构造 (官方 isFailedResult 口径; ISSUE-03/04 收口: 中止态纳入谓词).
  const isError =
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    result.stopReason === "timeout" ||
    result.stopReason === "usage_budget" ||
    result.timedOut === true ||
    result.budgetExceeded === true;
  // 结果文本: isError 时 errorMessage → stderr → finalOutput → "(no output)" (官方 getResultOutput 口径).
  const text = isError
    ? (result.errorMessage || result.stderr || finalOutput || "(no output)")
    : (finalOutput || "(no output)");

  // M02 D001: ctx% 一律子代理口径 — contextTokens(实际) / resolveModelWindow(推导窗口),
  // 窗口来源优先级运行 result.model (首个 assistant 消息实际模型) → 调用侧 effective model; 皆未知则 null/undefined.
  let contextPercent: number | null = null;
  let contextWindow: number | undefined;
  const contextTokens = result.contextTokens; // message_end 最新 totalTokens
  const windowModel = result.model ?? opts.model;
  contextWindow = windowModel !== undefined ? resolveModelWindow(opts.ctx, windowModel) : undefined;
  contextPercent =
    windowModel !== undefined && typeof contextTokens === "number" && contextWindow !== undefined && contextWindow > 0
      ? (contextTokens / contextWindow) * 100
      : null;
  let hint: string | undefined;
  const isAborted = result.timedOut || result.budgetExceeded;
  // hint 仅中止 (timeout/usageBudget) 结果产出 — 正常完成结果不得带 "建议 resume..." (误导已完成任务);
  // 阈值比较用子口径推导值 (D001: hint 评估子 session 的 resume 价值, 用父口径是 bug).
  if (isAborted && contextPercent !== null) {
    hint = contextPercent > resumeHintPercent()
      ? "上下文窗口占用较高 (超过迟钝区阈值), 建议新起子代理而非 resume."
      : "建议 resume 恢复任务, 复用已产生的部分输出.";
  }
  // 中止结果 hint 恒产出 — ctx 不可得 (或 percent 不可得) 时回退一句话
  // (中文, 含 "resume 恢复 / 新起子代理" 两选项指引, M2-D002(b)).
  if (isAborted && hint === undefined) {
    hint = "子代理已中止: 可 resume 恢复继续执行, 或新起子代理重跑任务.";
  }

  // M6 修复 1 (用户裁决): pi 只把 content 喂给模型, details 仅供 TUI — 中止结果把 details 关键字段拼进 content,
  // 否则模型拿不到 runId/diagnostics/hint (M1-D005 诊断载荷目的落空). 正常结果 content 保持纯净不拼.
  // 长版指令: 中止载荷自带 判断规则 + 恢复调用步骤 (零先验消费方主通道, text 模式下 details 不可见).
  const sessionSaved = isAborted ? fs.existsSync(opts.sessionFile) : false; // resume 硬前提: session 已落盘 (M5 观察 #3)
  // 预算行后缀: ratio 从 env 解析函数取 (与计算同源, 改 env 文案跟随); budgetAuto 缺省 (库直调未传) → 不标来源.
  const budgetSuffix =
    opts.budgetAuto === true
      ? ` (自动 = ${Math.round(usageBudgetRatio() * 100)}% × 模型窗口)`
      : opts.budgetAuto === false
        ? " (显式)"
        : "";
  const textOut = isAborted
    ? text +
      `\n\n---\nrunId: ${opts.runId} (恢复: action:"resume", id 用此值; 从头报前缀或报随机尾段均可)\nsessionDir: ${opts.sessionDir}\nusage: input ${result.usage.input} / output ${result.usage.output} / cacheWrite ${result.usage.cacheWrite} (cacheRead 不计入)\n预算: ${opts.usageBudget ?? "未设"} tokens${budgetSuffix}\n上下文: ${contextPercent ?? "未知"}% (${contextTokens ?? "未知"} tokens${result.model ? `, ${result.model}` : ""})\nhint: ${hint}\n` +
      buildRecoveryDirective({
        runId: opts.runId,
        agent: opts.agent,
        sessionSaved,
        percent: contextPercent,
        thresholdPercent: resumeHintPercent(),
      })
    : text;

  // L27 (info): single 结果回收完成 — runId/isError/stopReason/usage 摘要/contextPercent.
  // 注意: resume 管线也复用本函数 (resume L39 归 ISSUE-02, 本 ISSUE 不重复标记).
  logEvent({
    level: "info",
    event: "single.result.final",
    mode: "single",
    runId: opts.runId,
    agent: opts.agent,
    contextPercent,
    data: {
      isError,
      exitCode: result.exitCode,
      stopReason: result.stopReason,
      usage: {
        input: result.usage.input,
        output: result.usage.output,
        cacheWrite: result.usage.cacheWrite,
        cost: result.usage.cost,
        turns: result.usage.turns,
      },
    },
  });
  return {
    content: [{ type: "text", text: textOut }],
    details: {
      mode: "single", // M02 D002/D004: final 卡自洽 (live details 同形, 防节点键漂移)
      agent: opts.agent, // D002: renderResult 去硬编码 "subagent" 的契约面
      usage: result.usage,
      runId: opts.runId,
      sessionDir: opts.sessionDir,
      exitCode: result.exitCode,
      error: result.error,
      processSignal: result.processSignal,
      contextTokens,
      model: result.model,
      stopReason: result.stopReason,
      errorMessage: result.errorMessage,
      contextPercent,
      contextWindow,
      partialOutput: result.partialOutput,
      hint,
      ...(opts.usageBudget !== undefined ? { usageBudget: opts.usageBudget } : {}),
      ...(opts.budgetAuto !== undefined ? { budgetAuto: opts.budgetAuto } : {}),
      ...(isAborted ? { sessionSaved } : {}),
      ...(opts.resumed ? { resumed: true } : {}),
      // M02 D002: 补丁字段 — taskPreview ≤120/单行化/redaction (D003), 完整 task 永不进 details;
      // timeoutMsExplicit/startedAtMs/endedAtMs 有则落 (endedAtMs 取自 result, settle 时刻).
      ...(opts.task !== undefined ? { taskPreview: taskPreviewOf(opts.task) } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMsExplicit: opts.timeoutMs } : {}),
      ...(opts.startedAtMs !== undefined ? { startedAtMs: opts.startedAtMs } : {}),
      ...(result.endedAtMs !== undefined ? { endedAtMs: result.endedAtMs } : {}),
    },
    isError: isError || undefined,
  };
}

export async function runSingleAgent(opts: {
  agent: AgentConfig;
  task: string;
  model?: string; // 覆盖 agent frontmatter (M2-D008 参数 4)
  thinking?: string; // 思考深度覆盖 agent frontmatter (pi --thinking: off/minimal/low/medium/high/xhigh/max)
  cwd: string; // 子代理工作目录, 默认继承父会话 (M2-D008 参数 7)
  timeoutMs?: number; // ISSUE-03: 超时毫秒, 正整数, 缺省 900000 (15min)
  usageBudget?: number; // ISSUE-04: token 上限 (纯 number 正数, 触顶中止; 非法值校验报错)
  budgetAuto?: boolean; // 强制预算: true = 自动 (0.7 × 模型窗口), false = 显式传参
  signal?: AbortSignal; // TS-004: 取消监听 (M3-01 考察点 4: abort → SIGTERM → 3s SIGKILL)
  ctx?: unknown; // M02 D001: 子代理模型窗口查询源 (modelRegistry), 替代旧 getContextUsage 父口径
  onUpdate?: StreamUpdateCallback; // M3-02 考察点 6: 流式更新回调 (spawn/message_end/tool_result_end/close 触发点)
  // ISSUE-05 parallel per-child (EXECUTION.md 调和 12): 共享批次 runId + per-child 目录覆盖,
  // per-child 不写 run.json (批次 run.json 由调度器写).
  runId?: string; // 共享批次 runId (缺省各自生成)
  sessionDir?: string; // per-child session 目录 (缺省 <root>/<runId>/run-0)
  skipRunJson?: boolean; // 不写 per-child run.json (parallel 用)
}): Promise<SingleToolResult> {
  // ISSUE-03 TS-003: timeoutMs 校验 (正整数).
  if (opts.timeoutMs !== undefined && opts.timeoutMs !== null) {
    if (typeof opts.timeoutMs !== "number" || !Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0 || !Number.isInteger(opts.timeoutMs)) {
      return {
        content: [{ type: "text", text: "timeoutMs must be a positive integer" }],
        details: { usage: emptyUsage(), runId: "", sessionDir: "" },
        isError: true,
      };
    }
  }
  // ISSUE-04 TS-002: usageBudget 校验 (B 语义: 纯 number 正数; 非法值显式报错, 不静默忽略).
  const usageBudgetRaw = opts.usageBudget;
  let usageBudget: number | undefined;
  if (usageBudgetRaw !== undefined && usageBudgetRaw !== null) {
    if (typeof usageBudgetRaw !== "number" || !Number.isFinite(usageBudgetRaw) || usageBudgetRaw <= 0) {
      return {
        content: [{ type: "text", text: "usageBudget must be a positive number" }],
        details: { usage: emptyUsage(), runId: "", sessionDir: "" },
        isError: true,
      };
    }
    usageBudget = usageBudgetRaw;
  }

  const runId = opts.runId ?? makeRunId();
  // ISSUE-05 (调和 12): parallel per-child 目录覆盖 — sessionDir 显式传入时 session.jsonl 落该目录;
  // 单次模式走缺省 run-0 子目录.
  const { sessionDir, sessionFile } = opts.sessionDir
    ? { sessionDir: opts.sessionDir, sessionFile: path.join(opts.sessionDir, "session.jsonl") }
    : sessionPaths(runId);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true }); // run-<idx>/ 目录; session.jsonl 由 pi (fake) 写盘
  // L05 (info): runId/sessionDir 计算完成 (parallel child 经 skipRunJson 标记 child=true).
  logEvent({
    level: "info",
    event: "run.id.created",
    mode: "single",
    runId,
    agent: opts.agent.name,
    data: { sessionDir, child: opts.skipRunJson === true },
  });
  const effectiveModel = opts.model ?? opts.agent.model;
  const effectiveThinking = opts.thinking ?? opts.agent.thinking;
  if (!opts.skipRunJson) {
    try {
      writeRunJson({ runId, agent: opts.agent.name, model: effectiveModel, thinking: effectiveThinking, cwd: opts.cwd, startedAt: new Date().toISOString(), tools: opts.agent.tools }, sessionDir);
      // L06 (info): run.json 原子写成功.
      logEvent({ level: "info", event: "run.json.write.ok", mode: "single", runId, agent: opts.agent.name, data: { sessionFile } });
    } catch (e) {
      // L07 (error): run.json 写失败 → 记日志后继续 rethrow (不改现有执行语义).
      logEvent({ level: "error", event: "run.json.write.failed", mode: "single", runId, agent: opts.agent.name, errorMessage: (e as Error).message });
      throw e;
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  try {
    let promptFile: string | null = null;
    if (opts.agent.systemPrompt.trim()) {
      const safeName = opts.agent.name.replace(/[^\w.-]+/g, "_");
      promptFile = path.join(tmpDir, `prompt-${safeName}.md`);
      fs.writeFileSync(promptFile, opts.agent.systemPrompt, { encoding: "utf-8", mode: 0o600 }); // 0600 (M3-04 考察点 2)
    }
    const args = buildPiArgs({ agent: opts.agent, task: opts.task, model: effectiveModel, thinking: effectiveThinking, sessionFile, promptFile, tmpDir });
    // L09 (info): 即将 spawn (runProcess 调用前) — agent/model/runId/显式 timeoutMs/生效 usageBudget+budgetAuto.
    logEvent({
      level: "info",
      event: "single.spawn.start",
      mode: "single",
      runId,
      agent: opts.agent.name,
      model: effectiveModel,
      timeoutMsExplicit: opts.timeoutMs,
      usageBudgetExplicit: usageBudget,
      data: { budgetAuto: opts.budgetAuto },
    });
    // M02 D002: spawn 前捕获 (details.startedAtMs = 本次执行起点, 与 settle endedAtMs 配对算 elapsed).
    const startedAtMs = Date.now();
    // ISSUE-08: live onUpdate 注入 runId/sessionDir/usageBudget/budgetAuto/contextPercent
    // (viewer store 建批 + 会话 live 读盘 + cap/ctx% 运行中展示).
    const streamOnUpdate: StreamUpdateCallback | undefined = opts.onUpdate
      ? (partial) => {
          const r = partial.details.results?.[0];
          const windowModel = r?.model ?? effectiveModel;
          let cp: number | null = null;
          if (windowModel !== undefined && typeof r?.contextTokens === "number") {
            const w = resolveModelWindow(opts.ctx, windowModel);
            if (w > 0) cp = (r.contextTokens / w) * 100;
          }
          opts.onUpdate!({ ...partial, details: { ...partial.details, runId, sessionDir, usageBudget: opts.usageBudget, budgetAuto: opts.budgetAuto, contextPercent: cp } });
        }
      : undefined;
    const result = await runProcess(opts.agent, opts.task, args, opts.cwd, opts.timeoutMs, opts.signal, usageBudget, opts.budgetAuto, streamOnUpdate);

    // M02 D005: settle 完成后二次原子写 run.json 补 endedAtMs/finalStatus/usage;
    // per-child (skipRunJson) 跳过 — 批次 run.json 由调度器写, 补丁也归调度器.
    if (!opts.skipRunJson) {
      writeRunJsonSettle(sessionDir, {
        endedAtMs: result.endedAtMs ?? Date.now(),
        finalStatus: result.stopReason ?? (result.exitCode === 0 ? "done" : "failed"),
        usage: result.usage,
      });
    }

    return assembleSingleResult(result, {
      runId,
      sessionDir,
      sessionFile,
      agent: opts.agent.name,
      usageBudget: opts.usageBudget,
      budgetAuto: opts.budgetAuto,
      ctx: opts.ctx,
      model: effectiveModel,
      task: opts.task,
      timeoutMs: opts.timeoutMs,
      startedAtMs,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true }); // temp prompt 文件 close 后清理 (ISSUE-02 风险提示)
  }
}
