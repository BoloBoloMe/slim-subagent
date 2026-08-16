// slim-subagent 日志骨架 — ISSUE-01 (PRD §6.1/§6.2 最小闭环).
// 职责: append-only JSONL writer (按日分文件 subagent-YYYYMMDD.log, 根目录 logRootDir() = <agentDir 父级>/subagent_log)
// + level 体系 (trace..fatal, PI_SUBAGENT_LOG_LEVEL, 默认 info+; error/fatal 恒写)
// + 脱敏 (taskPreviewOf/taskHashOf/redactSecret, 永不落完整 task/prompt/session/secret)
// + 7 日 GC (runLogGc: subagent-*.log 按文件名日期算龄, diagnose/*.md 按 mtime; protectedFiles 跳过记 L42).
// 纪律 (M08 D001/D003 + 任务书决策 5): 日志写入失败静默吞掉, 绝不影响子代理执行.
// 纯 node 内置 (fs/path/crypto), 无第三方依赖. 日志点 L01-L10/L25-L27/L40-L44 挂载见 index/single/resume/agents.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ---- level 体系 (PRD §6.2: trace < debug < info < warn < error < fatal). ----

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

const LOG_LEVEL_ENV = "PI_SUBAGENT_LOG_LEVEL";

// 解析运行级别: env 非法/缺省回退 info.
export function logLevelFromEnv(): LogLevel {
  const raw = process.env[LOG_LEVEL_ENV]?.trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(raw ?? "") ? (raw as LogLevel) : "info";
}

// 某级别是否落盘: 级别 >= 运行级别; error/fatal 恒写 (任务书决策 3).
export function levelEnabled(level: LogLevel): boolean {
  if (level === "error" || level === "fatal") return true;
  return LEVELS.indexOf(level) >= LEVELS.indexOf(logLevelFromEnv());
}

// ---- 目录与按日文件名 (任务书决策 1/2). ----

// 日志根目录 = agentDir (~/.pi/agent) 的父级 + subagent_log → 正常 ~/.pi/subagent_log;
// 测试 withHome 下 = $HOME/.pi/subagent_log (隔离). getAgentDir 每次调用读 env, 无缓存.
export function logRootDir(): string {
  return path.join(path.dirname(getAgentDir()), "subagent_log");
}

function dateStampOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// 当日日志文件绝对路径 (subagent-YYYYMMDD.log, YYYYMMDD = 本地日期).
export function currentLogFile(): string {
  return path.join(logRootDir(), `subagent-${dateStampOf(new Date())}.log`);
}

// ---- 脱敏 (任务书决策 4). ----

export const TASK_PREVIEW_MAX = 120;
const REDACTED = "[REDACTED]";

// 常见 secret 形态遮蔽规则表 (单点实现, 可扩展): sk- 前缀令牌 / Bearer 令牌 / key=value 类.
// key 保留, 值替换为 [REDACTED]; 大小写不敏感 (Bearer/Token 大写亦可遮蔽).
const REDACT_SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, // sk- 前缀令牌 (OpenAI 系含 sk-proj- 连字符形态)
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\b(?:token|secret|api[_-]?key|apikey|password|passwd|pwd|access[_-]?token|auth(?:orization)?)\s*[=:]\s*[^&\s;'",`]+/gi,
];

// 遮蔽 secret 形态, 值替换为 [REDACTED] (key=value 类保留原 key 便于诊断关联; 无分隔符形态整段替换).
export function redactSecret(text: string): string {
  let out = text;
  for (const pattern of REDACT_SECRET_PATTERNS) {
    out = out.replace(pattern, (m) => {
      const eq = m.search(/[=:]/);
      if (eq > 0) return `${m.slice(0, eq + 1)}${REDACTED}`;
      return REDACTED;
    });
  }
  return out;
}

// 稳定 task hash: sha256(原文) 前 12 位 hex (原文不变 hash 不变, 不依赖脱敏后的 preview).
export function taskHashOf(task: string): string {
  return crypto.createHash("sha256").update(task).digest("hex").slice(0, 12);
}

// task 脱敏预览 (PRD §6.2 与 §3 同规则): ≤120 字符 + 换行折叠为空格 + 过 secret redaction.
export function taskPreviewOf(task: string): string {
  const cleaned = redactSecret(task).replace(/\s+/g, " ").trim();
  return cleaned.length > TASK_PREVIEW_MAX ? cleaned.slice(0, TASK_PREVIEW_MAX) : cleaned;
}

// ---- SubagentLog schema (PRD §6.2 最小闭环子集, 骨架阶段字段). ----

export type SubagentLogMode = "single" | "parallel" | "resume" | "list" | "diagnose";

export interface SubagentLog {
  ts: string; // ISO
  level: LogLevel;
  event: string; // 稳定事件名 (L01..L44 表)
  eventId: string; // uuid
  pid: number;
  mode?: SubagentLogMode;
  toolCallId?: string;
  runId?: string;
  batchRunId?: string;
  childIndex?: number;
  nodeId?: string;
  agent?: string;
  model?: string;
  status?: string;
  timeoutMsExplicit?: number;
  usageBudgetExplicit?: number;
  contextPercent?: number | null;
  usage?: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number }>;
  taskHash?: string;
  taskPreview?: string; // 不记录完整 task; 与 §3 同规则 (≤120/单行化/redaction)
  error?: { code?: string; message: string }; // message 过 secret redaction; stack 骨架阶段不暴露
  data?: Record<string, unknown>; // 已脱敏、有界 (调用方保证)
}

// logEvent 初始化参数: 语言层收口 (task → 自动 taskHash/taskPreview; errorMessage → 自动 redaction; 填 ts/eventId/pid).
export interface LogEventInit {
  level: LogLevel;
  event: string;
  mode?: SubagentLogMode;
  toolCallId?: string;
  runId?: string;
  batchRunId?: string;
  childIndex?: number;
  nodeId?: string;
  agent?: string;
  model?: string;
  status?: string;
  timeoutMsExplicit?: number;
  usageBudgetExplicit?: number;
  contextPercent?: number | null;
  usage?: SubagentLog["usage"];
  task?: string; // 原文 task → 内部算 taskHash + taskPreview (脱敏)
  taskPreview?: string; // 已脱敏 preview, 直接记录 (与 task 二选一)
  errorMessage?: string; // 过 redactSecret 后写入 error.message
  errorCode?: string;
  data?: Record<string, unknown>;
}

// ---- writer: append-only JSONL, 每行一个合法 JSON 对象 (任务书决策 2/5). ----

// 单条落盘; 写失败静默吞掉 (mkdir/append 任一异常都不外抛).
export function writeLog(entry: SubagentLog): void {
  try {
    const file = currentLogFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // 日志写入失败不影响子代理执行 (任务书决策 5): 静默丢弃.
  }
}

// 收口入口: level 过滤 + 必填字段组装 (ts/eventId/pid) + 脱敏 (task/errorMessage).
export function logEvent(init: LogEventInit): void {
  try {
    if (!levelEnabled(init.level)) return;
    const entry: SubagentLog = {
      ts: new Date().toISOString(),
      level: init.level,
      event: init.event,
      eventId: crypto.randomUUID(),
      pid: process.pid,
    };
    // 可选字段按需透传 (undefined 不落盘, 保持 JSONL 最小面).
    const passThrough: (keyof LogEventInit)[] = [
      "mode", "toolCallId", "runId", "batchRunId", "childIndex", "nodeId", "agent", "model", "status",
      "timeoutMsExplicit", "usageBudgetExplicit", "contextPercent", "usage",
    ];
    for (const key of passThrough) {
      const value = (init as Record<string, unknown>)[key];
      if (value !== undefined) (entry as Record<string, unknown>)[key] = value;
    }
    // task 原文 → taskHash + taskPreview (taskPreview 参数优先: 调用方已脱敏, 直接使用).
    if (init.task !== undefined) {
      entry.taskHash = taskHashOf(init.task);
      entry.taskPreview = taskPreviewOf(init.task);
    } else if (init.taskPreview !== undefined) {
      entry.taskPreview = init.taskPreview;
    }
    if (init.errorMessage !== undefined) {
      entry.error = { ...(init.errorCode !== undefined ? { code: init.errorCode } : {}), message: redactSecret(init.errorMessage) };
    }
    if (init.data !== undefined) entry.data = init.data;
    writeLog(entry);
  } catch {
    // logEvent 自身任何异常静默吞掉 (级别解析/组装失败不阻塞调用方).
  }
}

// ---- 7 日 GC (任务书决策 6). ----

const LOG_GC_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// 文件名日期 YYYYMMDD → 本地日零点; 坏格式返回 undefined (疑似非本扩展产物, 不碰).
function parseDateStamp(s: string): Date | undefined {
  if (!/^\d{8}$/.test(s)) return undefined;
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6)) - 1;
  const d = Number(s.slice(6, 8));
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return undefined;
  return new Date(y, mo, d);
}

// GC: 扫 logRootDir() 下 subagent-*.log (按文件名日期算龄) 与 diagnose/*.md (按 mtime);
// 超 7 天且不在 protectedFiles → 删 + L41; 在 protectedFiles → 跳过 + L42; 扫描/删除异常 → L43.
// 真实 session→log 关联 (logCursor) 留 ISSUE-04; protectedFiles 由调用方 (测试/未来 session GC) 传入.
export function runLogGc(protectedFiles?: ReadonlySet<string>): void {
  const root = logRootDir();
  if (!fs.existsSync(root)) return;
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch (e) {
    logEvent({ level: "error", event: "gc.failed", errorCode: "scan", errorMessage: `runLogGc scan failed: ${(e as Error).message}` });
    return;
  }
  for (const name of names) {
    const abs = path.join(root, name);
    try {
      if (name.startsWith("subagent-") && name.endsWith(".log")) {
        const stamp = name.slice("subagent-".length, "subagent-".length + 8);
        const fileDate = parseDateStamp(stamp);
        if (fileDate === undefined) continue; // 坏文件名日期 → 不碰
        if (Date.now() - fileDate.getTime() <= LOG_GC_AGE_MS) continue; // 龄期内 → 保留
        if (protectedFiles?.has(abs)) {
          logEvent({ level: "warn", event: "gc.skip.active_lease", runId: undefined, data: { path: abs, kind: "log", reason: "protected" } });
          continue;
        }
        fs.rmSync(abs, { force: true });
        logEvent({ level: "info", event: "gc.delete.ok", data: { path: abs, kind: "log" } });
      } else if (name === "diagnose" && fs.statSync(abs).isDirectory()) {
        // 诊断报告目录内 md 按 mtime 算龄 (PRD §6.1).
        for (const md of fs.readdirSync(abs)) {
          const mdPath = path.join(abs, md);
          const st = fs.statSync(mdPath);
          if (!st.isFile()) continue;
          if (Date.now() - st.mtimeMs <= LOG_GC_AGE_MS) continue;
          if (protectedFiles?.has(mdPath)) {
            logEvent({ level: "warn", event: "gc.skip.active_lease", data: { path: mdPath, kind: "diagnose", reason: "protected" } });
            continue;
          }
          fs.rmSync(mdPath, { force: true });
          logEvent({ level: "info", event: "gc.delete.ok", data: { path: mdPath, kind: "diagnose" } });
        }
      }
    } catch (e) {
      // 单对象扫描/删除异常 → L43 (不中断整轮 GC).
      logEvent({ level: "error", event: "gc.failed", errorCode: "delete", errorMessage: `runLogGc ${abs} failed: ${(e as Error).message}` });
    }
  }
}