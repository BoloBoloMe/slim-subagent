// slim-subagent resume 执行 + session 按龄 GC — ISSUE-06 TS-001~003 切片.
// 范围: resume 寻址 (M3-03 考察点 1 移植规格 1-5) + 恢复 spawn (EXECUTION.md 调和 6/13/14:
// agent 忽略复用 run.json 原 agent, model 同用报错, 沿用原 runId 不新建目录, --tools 按快照重建)
// + 并发锁 (M3-03 考察点 3 最小锁, TS-002) + 按龄 GC (M2-D005: 7 天, session_start 挂点, 锁豁免).
// 不实现: parallel 组合恢复 (调和 12 报错), 内存态寻址, index 参数, buildRevivedAsyncTask 包装 (M3-03 删除项).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { discoverAgents } from "./agents.ts";
import type { AgentConfig } from "./agents.ts";
import {
  assembleSingleResult,
  emptyUsage,
  resolveEffectiveUsageBudget,
  resolveSkillExtensionPath,
  runProcess,
  sessionRootDir,
  sessionsRootDir,
  TASK_ARG_LIMIT,
  writeRunJsonSettle,
} from "./single.ts";
import type { SingleDetails, StreamUpdateCallback } from "./single.ts";
import { acquireSessionLease, releaseSessionLease, isLeaseActive } from "./session-lease.ts";
import type { LeaseOwner } from "./session-lease.ts";
// ISSUE-01: 日志插桩 (仅加日志调用, 不改执行逻辑; 写失败静默吞, 见 log.ts).
import { logEvent } from "./log.ts";

// M2-D005: GC 按龄 7 天 (对齐旧 artifacts cleanupDays=7).
const GC_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// 寻址结果 (run.json 消费面; 调和 13/14: sessionFile/model/thinking/tools 为恢复 spawn 重建依据).
export interface ResumedRunInfo {
  runId: string;
  agent: string;
  model?: string;
  thinking?: string;
  cwd: string;
  sessionFile: string; // 绝对路径
  tools?: string[];
  startedAt: string;
}

// M3-03 考察点 1 移植规格 2: 磁盘单源寻址 — sessions root 下按 run-id 前缀匹配 run.json (单源, 无内存态).
// 精确命中优先于前缀; 多命中歧义 (旧码文本); 无命中 "Run not found"; parallel 批次 (mode:"parallel") 报 v1 不支持.
export function findRunForResume(id: string): ResumedRunInfo {
  const root = sessionsRootDir();
  let runIds: string[] = [];
  try {
    runIds = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "run.json")));
  } catch {
    runIds = [];
  }
  const exact = runIds.filter((r) => r === id);
  // M6 修复 2 (用户裁决 b): 完整 runId 前缀 或 最后一个 "-" 后的随机尾段前缀 均可命中; 合并去重后判歧义.
  const byPrefix = runIds.filter((r) => r.startsWith(id));
  const byTail = runIds.filter((r) => r.slice(r.lastIndexOf("-") + 1).startsWith(id));
  const matches = exact.length > 0 ? exact : [...new Set([...byPrefix, ...byTail])];
  if (matches.length === 0) throw new Error("Run not found");
  if (matches.length > 1) {
    throw new Error(`Ambiguous run id prefix '${id}' matched: ${matches.join(", ")}. Provide a longer id.`);
  }
  const runId = matches[0]!;
  const runJson = JSON.parse(fs.readFileSync(path.join(root, runId, "run.json"), "utf-8")) as {
    agent?: unknown;
    model?: unknown;
    thinking?: unknown;
    cwd?: unknown;
    sessionFile?: unknown;
    tools?: unknown;
    startedAt?: unknown;
    mode?: unknown;
  };
  // 调和 12: parallel 批次 run.json 带 mode:"parallel" → v1 收敛报错.
  if (runJson.mode === "parallel") throw new Error("v1 仅支持 single resume (parallel 批次不支持恢复)");
  if (typeof runJson.agent !== "string" || runJson.agent === "") {
    throw new Error(`Run '${runId}' run.json 缺 agent 字段, 无法恢复`);
  }
  // M3-03 考察点 1 移植规格 3: session 文件校验 (.jsonl + 存在, 文本沿旧码 subagent-executor.ts:672-675).
  const relSessionFile = typeof runJson.sessionFile === "string" && runJson.sessionFile !== "" ? runJson.sessionFile : "run-0/session.jsonl";
  const sessionFile = path.resolve(path.join(root, runId, relSessionFile));
  if (path.extname(sessionFile) !== ".jsonl") {
    throw new Error(`Foreground run '${runId}' session file must be a .jsonl file: ${sessionFile}`);
  }
  if (!fs.existsSync(sessionFile)) {
    throw new Error(`Foreground run '${runId}' session file does not exist: ${sessionFile}`);
  }
  return {
    runId,
    agent: runJson.agent,
    ...(typeof runJson.model === "string" && runJson.model !== "" ? { model: runJson.model } : {}),
    ...(typeof runJson.thinking === "string" && runJson.thinking !== "" ? { thinking: runJson.thinking } : {}),
    cwd: typeof runJson.cwd === "string" && runJson.cwd !== "" ? runJson.cwd : process.cwd(),
    sessionFile,
    ...(Array.isArray(runJson.tools) ? { tools: runJson.tools.filter((t): t is string => typeof t === "string") } : {}),
    startedAt: typeof runJson.startedAt === "string" ? runJson.startedAt : "",
  };
}

// 恢复 spawn 参数 (考察点 1 移植规格 4 + 调和 14): --session 原文件 + --model/--tools 按 run.json 快照
// (agent 定义事后被删/改不影响恢复) + --append-system-prompt 原 agent prompt 重建 + follow-up 原文追加
// (接受中断 turn 重复, M3 §四 #5).
function buildResumeArgs(opts: {
  model?: string;
  thinking?: string;
  tools?: string[];
  sessionFile: string;
  promptFile: string | null;
  tmpDir: string;
  task: string;
}): string[] {
  const args: string[] = ["--mode", "json", "-p", "--session", opts.sessionFile];
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
  args.push("--no-skills", "--no-extensions");
  const resolveSkillExt = resolveSkillExtensionPath();
  if (resolveSkillExt) args.push("-e", resolveSkillExt);
  if (opts.promptFile) args.push("--append-system-prompt", opts.promptFile);
  if (opts.task.length > TASK_ARG_LIMIT) {
    const taskFile = path.join(opts.tmpDir, "task-resume.txt");
    fs.writeFileSync(taskFile, opts.task, "utf-8");
    args.push("@" + taskFile);
  } else {
    args.push("Task: " + opts.task);
  }
  return args;
}

// execute (resume) 主入口: 参数校验 (调和 6: id+task 必填, model 同用报错) → 寻址/校验 → 恢复 spawn
// → 复用 single 结果回收全路径 (assembleSingleResult) + resumed:true + 原 runId/sessionDir (调和 13).
// 错误一律转 isError 结果 (不 throw), 对齐 index.ts 校验层形态.
export async function runResume(
  params: { id?: unknown; task?: unknown; model?: unknown; thinking?: unknown; timeoutMs?: unknown; usageBudget?: unknown; cwd?: unknown },
  ctx: { cwd?: unknown }, // M02 D001: 子口径 — 仅 cwd 消费 (modelRegistry 查询在 resolveEffectiveUsageBudget/assembleSingleResult 共用)
  signal?: AbortSignal,
  onUpdate?: StreamUpdateCallback,
): Promise<AgentToolResult<SingleDetails>> {
  const err = (text: string): AgentToolResult<SingleDetails> => ({
    content: [{ type: "text", text }],
    details: { usage: emptyUsage(), runId: "", sessionDir: "" },
    isError: true,
  });
  // TC-003: 参数校验.
  const id = typeof params.id === "string" && params.id.trim() !== "" ? params.id.trim() : undefined;
  if (!id) return err('action:"resume" 须提供 id (run-id, 支持前缀匹配)');
  const task = typeof params.task === "string" ? params.task : undefined;
  if (!task || task.trim() === "") return err('action:"resume" 须提供 task (follow-up 文本)');
  if (typeof params.model === "string" && params.model.trim() !== "") {
    return err('action:"resume" 不接受 model 覆盖 (复用原 run 的 model)');
  }
  if (typeof params.thinking === "string" && params.thinking.trim() !== "") {
    return err('action:"resume" 不接受 thinking 覆盖 (复用原 run 的 thinking)');
  }
  // timeoutMs/usageBudget 可覆盖 (对齐 single 校验层语义, 非法值同文案报错).
  if (params.timeoutMs !== undefined && params.timeoutMs !== null) {
    if (typeof params.timeoutMs !== "number" || !Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0 || !Number.isInteger(params.timeoutMs)) {
      return err("timeoutMs must be a positive integer");
    }
  }
  if (params.usageBudget !== undefined && params.usageBudget !== null) {
    if (typeof params.usageBudget !== "number" || !Number.isFinite(params.usageBudget) || params.usageBudget <= 0) {
      return err("usageBudget must be a positive number");
    }
  }
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
  const usageBudget = typeof params.usageBudget === "number" ? params.usageBudget : undefined;

  // 寻址 + session 校验 (TC-002/TC-004).
  // L33 (info): resume 寻址开始.
  logEvent({ level: "info", event: "resume.find.start", mode: "resume", data: { id } });
  let run: ResumedRunInfo;
  try {
    run = findRunForResume(id);
  } catch (e) {
    const message = (e as Error).message;
    // L34/L35: 寻址失败按文案分类 — Ambiguous 歧义 warn, not found 缺失 error.
    if (message.includes("Ambiguous")) {
      logEvent({ level: "warn", event: "resume.find.ambiguous", mode: "resume", data: { id, message } });
    } else if (message.includes("not found")) {
      logEvent({ level: "error", event: "resume.find.not_found", mode: "resume", data: { id, message } });
    }
    return err(message);
  }

  // 原 agent 定义重建 --append-system-prompt (调和 6: agent 参数忽略, 复用 run.json 原 agent).
  const agents = discoverAgents();
  const agent = agents.find((a) => a.name === run.agent);
  if (!agent) {
    return err(`Resume failed: agent definition "${run.agent}" not found (needed to rebuild the system prompt).`);
  }

  const cwd = typeof params.cwd === "string" && params.cwd !== "" ? params.cwd : run.cwd;

  // 强制预算 (用户协议): resume (含收尾) 同样强制 — 未显式传 budget → 自动 0.7 × 原 run 模型窗口.
  const eff = resolveEffectiveUsageBudget(usageBudget, run.model ?? agent.model, ctx);

  // TS-002: spawn 前 acquire 锁 (M3-03 考察点 3 规格 3: resume 全流程持有; 活冲突报错不排队, stale 回收重试 ≤2).
  let lease: LeaseOwner;
  try {
    lease = acquireSessionLease(run.sessionFile, run.runId);
    // L36 (info): 会话锁获取成功.
    logEvent({ level: "info", event: "resume.lease.acquired", mode: "resume", runId: run.runId, data: { sessionFile: run.sessionFile } });
  } catch (e) {
    const message = (e as Error).message;
    // L37 (warn): 锁冲突/获取失败.
    logEvent({ level: "warn", event: "resume.lease.conflict", mode: "resume", data: { id, message } });
    return err(message);
  }
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      releaseSessionLease(run.sessionFile, lease);
    }
  };
  // process.once("exit") 兜底: 异常退出时锁残留, 由下次抢占按 stale 回收 (规格 3).
  const onExit = () => release();
  process.once("exit", onExit);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  try {
    let promptFile: string | null = null;
    if (agent.systemPrompt.trim()) {
      const safeName = agent.name.replace(/[^\w.-]+/g, "_");
      promptFile = path.join(tmpDir, `prompt-${safeName}.md`);
      fs.writeFileSync(promptFile, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
    }
    const args = buildResumeArgs({ model: run.model, thinking: run.thinking, tools: run.tools, sessionFile: run.sessionFile, promptFile, tmpDir, task });
    // L38 (info): resume 子进程 spawn 前 (与 single.spawn.start 同构载荷).
    logEvent({ level: "info", event: "resume.spawn.start", mode: "resume", runId: run.runId, agent: run.agent, model: run.model, timeoutMsExplicit: timeoutMs, usageBudgetExplicit: eff.budget });
    // M02 D002: spawn 前捕获 (与 resume settle 补丁 endedAtMs 配对).
    const startedAtMs = Date.now();
    const result = await runProcess(agent, task, args, cwd, timeoutMs, signal, eff.budget, eff.auto, onUpdate);
    // M02 D005: resume settle 补丁写 (sessionDir = 原 run 目录, 复用 single 同源写入函数).
    writeRunJsonSettle(sessionRootDir(run.runId), {
      endedAtMs: result.endedAtMs ?? Date.now(),
      finalStatus: result.stopReason ?? (result.exitCode === 0 ? "done" : "failed"),
      usage: result.usage,
    });
    // L39 (info): resume 结果收尾.
    logEvent({ level: "info", event: "resume.result.final", mode: "resume", runId: run.runId, agent: run.agent, data: { resumed: true } });
    return assembleSingleResult(result, {
      runId: run.runId,
      sessionDir: sessionRootDir(run.runId),
      sessionFile: run.sessionFile, // resume 硬前提已在寻址校验过存在 → sessionSaved=true
      agent: run.agent,
      usageBudget: eff.budget,
      budgetAuto: eff.auto,
      ctx,
      model: run.model ?? agent.model,
      task,
      timeoutMs,
      startedAtMs,
      resumed: true,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true }); // temp prompt 文件 close 后清理
    process.removeListener("exit", onExit);
    release(); // 子进程 exit 后 finally release (TS-002 TC-007).
  }
}

// M2-D005: 按龄 GC — 扫 sessions/ 下所有 run.json, startedAt 超 7 天且无活跃锁 → 删 run 目录.
// 挂点: 扩展 session_start 事件 (index.ts 注册); 测试直接调本函数 (ISSUE-06 TS-003 接缝).
// 成功 run 不删 (调和 2: 成功也保留, 统一按龄); parallel 批次 run.json 同样有 startedAt, 一并覆盖.
export function runSessionGc(): void {
  const root = sessionsRootDir();
  let runIds: string[];
  try {
    runIds = fs.readdirSync(root);
  } catch (e) {
    // L43 (error, scan): sessions 根不存在/读取失败 → 记日志后照旧 return (无事可做).
    logEvent({ level: "error", event: "gc.failed", errorCode: "scan", errorMessage: (e as Error).message });
    return; // sessions 根不存在 → 无事可做
  }
  for (const runId of runIds) {
    const sessionDir = path.join(root, runId);
    const runJsonPath = path.join(sessionDir, "run.json");
    if (!fs.existsSync(runJsonPath)) continue; // 无 run.json 目录不碰 (非本扩展产物)
    try {
      const runJson = JSON.parse(fs.readFileSync(runJsonPath, "utf-8")) as { startedAt?: unknown; sessionFile?: unknown };
      const startedAt = typeof runJson.startedAt === "string" ? Date.parse(runJson.startedAt) : NaN;
      if (Number.isNaN(startedAt)) continue; // 坏 startedAt → 跳过 (不误删)
      if (Date.now() - startedAt <= GC_AGE_MS) continue; // 龄期内 → 保留
      // 锁豁免 (TS-002): 有活跃锁 (owner pid 活) 的 run 跳过.
      const relSessionFile = typeof runJson.sessionFile === "string" && runJson.sessionFile !== "" ? runJson.sessionFile : undefined;
      if (relSessionFile && isLeaseActive(path.join(sessionDir, relSessionFile))) {
        // L42 (warn): 活跃锁豁免 → 跳过保留 (延续既有继续语义).
        logEvent({ level: "warn", event: "gc.skip.active_lease", data: { runId, path: sessionDir } });
        continue;
      }
      fs.rmSync(sessionDir, { recursive: true, force: true });
      // L41 (info): 按龄删除成功.
      logEvent({ level: "info", event: "gc.delete.ok", data: { runId, path: sessionDir } });
    } catch (e) {
      // L43 (error, delete): 坏 run.json/删除异常 → 跳过该 run (不中断整轮 GC).
      logEvent({ level: "error", event: "gc.failed", errorCode: "delete", errorMessage: (e as Error).message });
    }
  }
}
