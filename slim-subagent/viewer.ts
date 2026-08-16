// ISSUE-06 Session Viewer (M13, PRD §5 + M07 D007/D008/D009/D011) — capturing 全屏 overlay.
// 结构: 纯函数层 (tolerant JSONL reader / 批次时间线构建 / 磁盘回补 20 批, 不依赖 pi-tui, TDD 接缝)
// + 内存 store (onUpdate 喂入, 同 id 覆盖, 不从磁盘反推运行中状态) + SessionViewerComponent (自绘 overlay).
// 候选伍: 组件状态实例化 — ViewerState 经 opts.state 注入 (缺省模块级共享, 重开不重置),
// 键盘流/滚动可自动化测试 (test/viewer-component.test.ts); 归档回补走 run-record.ts 接缝 (候选贰).
// 键盘流 (D008): Tab/Shift+Tab/←/→ 循环切 tab + 数字 1-9 直跳; ↑/↓ Timeline=选批次, 子代理 tab=滚动;
// PgUp/PgDn 翻页; Enter 仅 Timeline 确认换批; Esc/alt+v 关闭.
// 数据源 (D011): 首 tab Timeline (上早下晚, 默认最新批次), 子代理 tab 从 session.jsonl 容忍读取
// (损坏/未知行进 raw 不丢弃; GC 缺文件 → empty state 不崩), followLive 上翻解除回底恢复.
// 接线 (registerCommand/快捷键/toggle/onUpdate 喂入) 归 ISSUE-08, 本文件只导出组件与 store.

import * as path from "node:path";
import * as fs from "node:fs";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { Component, KeyId, TUI } from "@earendil-works/pi-tui";
import type { DisplayStatus, RunNode, SlimUsage } from "./projection.ts";
import { isAttention } from "./projection.ts";
// 归档读取经 run-record 接缝 (布局/状态映射/脱敏单一真相), 不再本地复刻.
import { readArchivedRun, liveSessionFileOf } from "./run-record.ts";

// ---------------------------------------------------------------------------
// 域类型: 批次时间线 + 子代理会话
// ---------------------------------------------------------------------------

export type ViewerMode = "single" | "parallel" | "resume";

/** 子代理会话: 元信息 + 会话文件 (transcript 懒读盘, live 与 disk 同源 session.jsonl) */
export interface ViewerAgent {
  id: string; // single/resume: runId; parallel child: `${batchId}#${index}`
  agent: string;
  taskPreview: string;
  model: string; // 未知 "—"
  status: DisplayStatus;
  isError?: boolean;
  errorMessage?: string;
  startedAtMs?: number;
  endedAtMs?: number;
  usage?: SlimUsage;
  // 底部状态区一行 (D007): ctx% / budget (显式 cap vs 自动 70%) / hint / log event ids
  contextPercent?: number | null;
  usageBudgetExplicit?: number;
  budgetAuto?: boolean;
  hint?: string;
  logEventIds?: string[];
  runId?: string;
  sessionDir?: string;
  /** session.jsonl 绝对路径; 缺文件 → 空 transcript, 不崩 */
  sessionFile?: string;
  source: "live" | "disk";
}

/** 批次 = 父会话历史上一次子代理工具调用 (single/resume 也算一个批次) */
export interface ViewerBatch {
  id: string; // single/resume: runId; parallel: batchRunId
  mode: ViewerMode;
  createdAtMs: number;
  task: string;
  agents: ViewerAgent[];
  total: number;
  done: number;
  failed: number;
  active: number;
  source: "live" | "disk";
}

export interface ViewerLiveData {
  batches: ViewerBatch[];
}

// ---------------------------------------------------------------------------
// 纯函数层 1: tolerant JSONL reader (M08-D003 ⑥)
//   合法 JSON → ok:true; 损坏/杂讯行 → ok:false 且 raw 原样保留 (不丢弃).
// ---------------------------------------------------------------------------

export type ParseResult = { ok: true; evt: unknown } | { ok: false; raw: string };

export function parseSessionJsonl(line: string): ParseResult {
  if (line === undefined || line === null) return { ok: false, raw: String(line) };
  try {
    return { ok: true, evt: JSON.parse(line) };
  } catch {
    return { ok: false, raw: line };
  }
}

// ---- transcript 归一化: 解析后的行 → 会话条目 (未知类型保留为 other, 不丢弃). ----

export interface TranscriptToolCall {
  name: string;
  argsPreview: string;
}

export interface TranscriptMessage {
  kind: "message";
  // session-format.md AgentMessage role 全集: user/assistant/toolResult/bashExecution/custom/…
  role: string;
  type: "user" | "assistant" | "toolResult" | "bashExecution" | string;
  ts: number;
  /** content 文本块拼装 (多块以 \n 分隔; 纯字符串整存) */
  text: string;
  toolName?: string;
  isError?: boolean;
  model?: string;
  toolCalls?: TranscriptToolCall[];
  thinking?: string;
}

export interface TranscriptOther {
  kind: "other";
  entryType: string;
  ts: number;
}

export type TranscriptEntry = TranscriptMessage | TranscriptOther;

/** content 块文本提取: user 纯字符串 / 数组 {type:"text"|"thinking"|…}; 未知块跳过 */
function contentTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
      .filter((t) => t !== "")
      .join("\n");
  }
  return "";
}

function toolCallsOf(content: unknown): TranscriptToolCall[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const out: TranscriptToolCall[] = [];
  for (const c of content) {
    if (c && typeof c === "object" && (c as { type?: string }).type === "toolCall") {
      const tc = c as { name?: unknown; arguments?: unknown };
      const args = tc.arguments;
      let argsPreview = "";
      try {
        argsPreview = typeof args === "string" ? args : JSON.stringify(args ?? {});
      } catch {
        argsPreview = String(args ?? {});
      }
      out.push({ name: typeof tc.name === "string" ? tc.name : "tool", argsPreview });
    }
  }
  return out.length > 0 ? out : undefined;
}

const KNOWN_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution", "custom"]);

/** 归一化层: 未知 entry 类型/角色 → kind:"other" (保留, 渲染层跳过), 不丢弃. */
export function sessionEntryOf(evt: unknown): TranscriptEntry {
  if (evt === null || typeof evt !== "object") return { kind: "other", entryType: "", ts: 0 };
  const o = evt as { type?: unknown; timestamp?: unknown; message?: unknown };
  const tsRaw = o.timestamp;
  const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : 0;
  const entryType = typeof o.type === "string" ? o.type : "";
  if (entryType !== "message") return { kind: "other", entryType, ts: Number.isFinite(ts) ? ts : 0 };
  const m = (o.message ?? {}) as { role?: unknown; content?: unknown; toolName?: unknown; isError?: unknown; model?: unknown };
  const role = typeof m.role === "string" ? m.role : "";
  if (!KNOWN_ROLES.has(role)) return { kind: "other", entryType, ts: Number.isFinite(ts) ? ts : 0 };
  const text = contentTextOf(m.content);
  const entry: TranscriptMessage = {
    kind: "message",
    role,
    type: role,
    ts: Number.isFinite(ts) ? ts : 0,
    text,
  };
  if (role === "assistant") {
    if (typeof m.model === "string") entry.model = m.model;
    const calls = toolCallsOf(m.content);
    if (calls) entry.toolCalls = calls;
    // thinking 块 → 摘要 (渲染层 dim 单行, 不展开)
    if (Array.isArray(m.content)) {
      const th = m.content.find((c) => c && typeof c === "object" && (c as { type?: string }).type === "thinking") as { thinking?: unknown } | undefined;
      if (th && typeof th.thinking === "string" && th.thinking !== "") entry.thinking = th.thinking;
    }
  } else if (role === "toolResult") {
    if (typeof m.toolName === "string") entry.toolName = m.toolName;
    entry.isError = m.isError === true;
  }
  return entry;
}

/** 读一行转录文件 (容忍损坏行, 空行跳过); 缺文件/读失败 → [] (empty state, 不崩). 按 size/mtime 缓存 (ISSUE-08 live 刷新). */
export function readSessionTranscriptLines(file: string): TranscriptEntry[] {
  let st: { size: number; mtimeMs: number };
  try {
    const s = fs.statSync(file);
    st = { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    transcriptCache.delete(file);
    return [];
  }
  const hit = transcriptCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.entries;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    transcriptCache.delete(file);
    return [];
  }
  const out: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    const r = parseSessionJsonl(line);
    if (!r.ok) continue; // 损坏行已 raw 保留在 parse 层, 转录渲染跳过
    const entry = sessionEntryOf(r.evt);
    if (entry.kind === "message") out.push(entry);
  }
  transcriptCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, entries: out });
  return out;
}

// ---------------------------------------------------------------------------
// 纯函数层 2: 批次时间线构建 + 状态摘要
// ---------------------------------------------------------------------------

/** 状态标签 (single/resume 摘要用; parallel 用计数) */
export function statusLabel(status: DisplayStatus): string {
  switch (status) {
    case "active": return "active";
    case "pending": return "pending";
    case "done": return "done";
    case "failed": return "failed";
    case "timeout": return "timeout";
    case "budget": return "budget";
    case "cancelled": return "cancelled";
    default: return "done";
  }
}

/**
 * 批次状态摘要: parallel → "2/4 done · 1 failed · 1 active"; single/resume → 单状态标签
 * (PRD §5: 行 = 时间 + 模式 + agent 列表 + 状态摘要).
 */
export function batchStatusSummary(b: Pick<ViewerBatch, "mode" | "agents" | "total" | "done" | "failed" | "active">): string {
  if (b.mode === "parallel") {
    const parts: string[] = [`${b.done}/${b.total} done`];
    if (b.failed > 0) parts.push(`${b.failed} failed`);
    if (b.active > 0) parts.push(`${b.active} active`);
    return parts.join(" · ");
  }
  return statusLabel(b.agents[0]?.status ?? "done");
}

/** 时间线构建: 上早下晚排序 (同刻按 id 稳定); single/resume 记录各自=一批. 不改入参. */
export function buildTimeline(records: ViewerBatch[]): ViewerBatch[] {
  return [...records].sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// 纯函数层 3: RunNode 快照 → 批次 (live 喂入路径, D011 不从磁盘反推运行态)
// ---------------------------------------------------------------------------

function liveAgentOf(node: RunNode): ViewerAgent {
  const sessionDir = node.sessionDir;
  return {
    id: node.id,
    agent: node.agent,
    taskPreview: node.taskPreview,
    model: node.model ?? "—",
    status: node.status,
    ...(node.isError !== undefined ? { isError: node.isError } : {}),
    ...(node.errorMessage !== undefined ? { errorMessage: node.errorMessage } : {}),
    ...(node.startedAtMs !== undefined ? { startedAtMs: node.startedAtMs } : {}),
    ...(node.endedAtMs !== undefined ? { endedAtMs: node.endedAtMs } : {}),
    ...(node.usage ? { usage: node.usage } : {}),
    ...(node.contextPercent !== undefined ? { contextPercent: node.contextPercent } : {}),
    ...(node.usageBudgetExplicit !== undefined ? { usageBudgetExplicit: node.usageBudgetExplicit } : {}),
    ...(node.diagnostics?.budgetAuto !== undefined ? { budgetAuto: node.diagnostics.budgetAuto } : {}),
    ...(node.diagnostics?.hint !== undefined ? { hint: node.diagnostics.hint } : {}),
    ...(node.logCursor?.lastEventId !== undefined ? { logEventIds: [node.logCursor.lastEventId] } : {}),
    ...(node.runId !== undefined ? { runId: node.runId } : {}),
    ...(sessionDir ? { sessionDir, sessionFile: liveSessionFileOf(node.kind, sessionDir) } : {}),
    source: "live",
  };
}

/** RunNode[] → ViewerBatch (single/resume → 单 agent 批; parallel-root → 多 agent 批). 占位帧 (无 runId) → undefined. */
export function batchFromLiveNodes(nodes: RunNode[]): ViewerBatch | undefined {
  const root = nodes[0];
  if (!root) return undefined;
  if (root.id === "—" || root.id === "" || root.id === undefined) return undefined; // live 早期无 runId 帧不建批
  if (root.kind === "parallel-root") {
    const children = nodes.filter((n) => n.kind === "parallel-child" && n.parentId !== undefined);
    const agents = children.map(liveAgentOf);
    return {
      id: root.id,
      mode: "parallel",
      createdAtMs: root.startedAtMs ?? Date.now(),
      task: "",
      agents,
      total: children.length,
      done: children.filter((c) => c.status === "done").length,
      failed: children.filter((c) => isAttention(c.status)).length,
      active: children.filter((c) => c.status === "active" || c.status === "pending").length,
      source: "live",
    };
  }
  const agent = liveAgentOf(root);
  return {
    id: root.id,
    mode: root.kind === "resume" ? "resume" : "single",
    createdAtMs: root.startedAtMs ?? Date.now(),
    task: root.taskPreview,
    agents: [agent],
    total: 1,
    done: root.status === "done" ? 1 : 0,
    failed: isAttention(root.status) ? 1 : 0,
    active: root.status === "active" || root.status === "pending" ? 1 : 0,
    source: "live",
  };
}

// ---------------------------------------------------------------------------
// 纯函数层 4: 磁盘回补 20 批 (D011) — 归档读取走 run-record 接缝, 缺/坏文件跳过
// ---------------------------------------------------------------------------

/** 单个 run 目录 → 批次 (disk)。run.json 缺/坏 → undefined (跳过不崩). */
export function batchFromRunDir(runDir: string): ViewerBatch | undefined {
  const rec = readArchivedRun(runDir);
  if (!rec) return undefined;
  if (rec.mode === "parallel") {
    // parallel 回补: 子 agent 状态用批次 finalStatus 传播 (子无 run.json); taskPreview 已在接缝脱敏.
    const agents: ViewerAgent[] = rec.children.map((c) => ({
      id: `${rec.runId}#${c.index}`,
      agent: c.agent,
      taskPreview: c.taskPreview,
      model: c.model ?? "—",
      status: rec.status,
      ...(c.endedAtMs !== undefined ? { endedAtMs: c.endedAtMs } : {}),
      runId: rec.runId,
      sessionDir: c.sessionDir,
      sessionFile: c.sessionFile,
      source: "disk",
    }));
    const total = agents.length;
    return {
      id: rec.runId,
      mode: "parallel",
      createdAtMs: rec.createdAtMs,
      task: "",
      agents,
      total,
      done: rec.status === "done" ? total : 0,
      failed: isAttention(rec.status) ? total : 0,
      active: 0,
      source: "disk",
    };
  }
  const agent: ViewerAgent = {
    id: rec.runId,
    agent: rec.agent,
    taskPreview: "",
    model: rec.model ?? "—",
    status: rec.status,
    ...(rec.usage ? { usage: rec.usage } : {}),
    ...(rec.endedAtMs !== undefined ? { endedAtMs: rec.endedAtMs } : {}),
    runId: rec.runId,
    sessionDir: runDir,
    sessionFile: rec.sessionFile,
    source: "disk",
  };
  const st = rec.status;
  return {
    id: rec.runId,
    mode: rec.mode === "resume" ? "resume" : "single",
    createdAtMs: rec.createdAtMs,
    task: "",
    agents: [agent],
    total: 1,
    done: st === "done" ? 1 : 0,
    failed: isAttention(st) ? 1 : 0,
    active: st === "active" || st === "pending" ? 1 : 0,
    source: "disk",
  };
}

/** 扫描 sessions 根目录, 只回补最近 limit 批 (默认 20); 缺/坏文件跳过; 目录不可读 → [] (D011). */
export function backfillRecentBatches(sessionsRoot: string, limit = 20): ViewerBatch[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsRoot);
  } catch {
    return [];
  }
  const candidates: ViewerBatch[] = [];
  for (const e of entries) {
    if (!e.startsWith("run-")) continue;
    const b = batchFromRunDir(path.join(sessionsRoot, e));
    if (b) candidates.push(b);
  }
  candidates.sort((a, b) => b.createdAtMs - a.createdAtMs); // 最新在前
  const recent = candidates.slice(0, Math.max(0, limit));
  return buildTimeline(recent); // 时间线序: 上早下晚
}

// ---------------------------------------------------------------------------
// 内存 store (D011): onUpdate 喂入 (live) + 磁盘回补 (disk) 同池; 同 id 覆盖; 排序在读取侧
// ---------------------------------------------------------------------------

export class ViewerStore {
  private map = new Map<string, ViewerBatch>();

  upsert(batch: ViewerBatch): void {
    if (!batch || !batch.id) return;
    this.map.set(batch.id, batch);
  }

  /** 磁盘回补 20 批由接线侧调用 (ISSUE-08): 与 live 批同池, live 同 id 覆盖 disk. */
  backfill(sessionsRoot: string, limit = 20): void {
    for (const b of backfillRecentBatches(sessionsRoot, limit)) this.upsert(b);
  }

  remove(id: string): void {
    this.map.delete(id);
  }

  get(id: string): ViewerBatch | undefined {
    return this.map.get(id);
  }

  getBatches(): ViewerBatch[] {
    return buildTimeline([...this.map.values()]);
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}

export function createViewerStore(): ViewerStore {
  return new ViewerStore();
}

// ---------------------------------------------------------------------------
// overlay 组件 (capturing, 自绘; pi-tui 无 ScrollView/Tab 组件)
// ---------------------------------------------------------------------------

/** 主题子集 (对接 pi Theme: getMarkdownTheme() 满足该接口) */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  inverse?(text: string): string;
}

/** 渲染行: 纯文本 + 主题色 (render 折行后统一着色, 避免 ANSI 被折行切断) */
interface ContentLine {
  plain: string;
  color?: string;
  bg?: string;
  bold?: boolean;
}

interface TabState {
  scroll: number;
  follow: boolean;
}

function initialTabState(follow: boolean): TabState {
  return { scroll: 0, follow };
}

/** viewer 状态 (候选伍: 状态实例化) — 组件经 opts.state 注入; 生产缺省模块级共享实例
 * (跨组件实例保留: Esc 重开 / ISSUE-08 toggle 重开不重置), 测试各建独立实例互不污染. */
export interface ViewerState {
  tabIndex: number;
  convCursor: number;
  confirmedBatchId: string | null;
  tabs: Record<string, TabState>; // key: "timeline" | agent id
}
export function createViewerState(): ViewerState {
  return { tabIndex: 0, convCursor: 0, confirmedBatchId: null, tabs: {} };
}
const defaultViewerState: ViewerState = createViewerState();

const TIMELINE_ID = "timeline";
const HDR_LINES = 2;
const TAB_LINES = 1;
const FTR_LINES = 1;

function isAgentTab(id: string): boolean {
  return id !== TIMELINE_ID;
}

// ISSUE-08: spinner 帧 (与 card.ts 同款 90ms 轮转) + 转录缓存 (PRD §9 按 path/size/mtime 缓存, 避免周期重读盘).
const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
function spinnerFrameAt(now: number): string {
  return SPINNER_FRAMES[Math.floor(now / 90) % SPINNER_FRAMES.length];
}
const transcriptCache = new Map<string, { size: number; mtimeMs: number; entries: TranscriptEntry[] }>();

// ---- 通用工具 (显示宽度按全角=2) ----

function dispLen(s: string): number {
  let n = 0;
  for (const ch of s) {
    n += ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
  }
  return n;
}

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (dispLen(s) <= max) return s;
  let acc = 0;
  const out: string[] = [];
  for (const ch of s) {
    const w = dispLen(ch);
    if (acc + w > max - 1) break;
    acc += w;
    out.push(ch);
  }
  return out.join("") + "…";
}

function wrapText(s: string, width: number): string[] {
  if (width <= 0) return [""];
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const ch of s) {
    const w = dispLen(ch);
    if (curLen + w > width) {
      out.push(cur);
      cur = ch;
      curLen = w;
    } else {
      cur += ch;
      curLen += w;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function fmtT(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function statusOf(status: DisplayStatus): { icon: string; label: string; color: string } {
  switch (status) {
    case "pending": return { icon: "◌", label: "pending", color: "muted" };
    case "active": return { icon: spinnerFrameAt(Date.now()), label: "active", color: "accent" };
    case "done": return { icon: "✓", label: "done", color: "success" };
    case "timeout": return { icon: "✗", label: "timeout", color: "warning" };
    case "budget": return { icon: "✗", label: "budget", color: "warning" };
    case "cancelled": return { icon: "✗", label: "cancelled", color: "warning" };
    case "failed": return { icon: "✗", label: "failed", color: "error" };
    default: return { icon: "⠿", label: status, color: "muted" };
  }
}

function agentList(b: ViewerBatch): string {
  return b.agents.map((a) => a.agent).join("/");
}

// ---- 组件 ----

export interface SessionViewerOpts {
  tui: TUI;
  theme: ThemeLike;
  done: (r: null) => void;
  /** overlay 关闭/销毁后回调 (幂等): 复位宿主模块状态 */
  onClose?: () => void;
  /** 数据源读取 (store 批次集; disk 回补由接线侧预调 store.backfill) */
  getLive: () => ViewerLiveData;
  /** 状态实例 (候选伍): 缺省模块级共享 defaultViewerState, 测试注入 createViewerState() 独立实例 */
  state?: ViewerState;
}

interface TabDef {
  id: string; // "timeline" | agent id
  label: string;
}

export class SessionViewerComponent implements Component {
  private opts: SessionViewerOpts;
  private state: ViewerState;
  /** 最近一次 render 的 overlay 宽度 (handleInput 用, 与 render 宽度一致) */
  private lastRenderWidth = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SessionViewerOpts) {
    this.opts = opts;
    this.state = opts.state ?? defaultViewerState;
    // 首次打开默认: 选中并确认最新批次 (时间线尾部, D007)
    const tl = opts.getLive().batches;
    if (tl.length > 0) {
      if (!tl.some((b) => b.id === this.state.confirmedBatchId)) {
        this.state.confirmedBatchId = tl[tl.length - 1].id;
        this.state.convCursor = tl.length - 1;
        this.state.tabIndex = 0;
      } else {
        this.state.convCursor = clamp(this.state.convCursor, 0, tl.length - 1);
      }
    }
    // ISSUE-08: 周期刷新 — 驱动 spinner 帧轮转 + 子会话内容 live 重读 (transcriptCache 保证未变不重读盘).
    this.refreshTimer = setInterval(() => {
      try { this.opts.tui.requestRender(); } catch { /* tui 已失效 (热载等), 停表 */ if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; } }
    }, 90);
    this.refreshTimer.unref?.();
  }

  invalidate(): void {}

  dispose(): void {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (this.opts.onClose) this.opts.onClose();
  }

  // ---- 数据 ----

  private batches(): ViewerBatch[] {
    return this.opts.getLive().batches;
  }

  private confirmedBatch(): ViewerBatch | null {
    const bs = this.batches();
    return bs.find((b) => b.id === this.state.confirmedBatchId) ?? null;
  }

  private currentTabs(): TabDef[] {
    const tabs: TabDef[] = [{ id: TIMELINE_ID, label: "Timeline" }];
    const b = this.confirmedBatch();
    if (b) {
      for (const a of b.agents) {
        const st = statusOf(a.status);
        tabs.push({ id: a.id, label: `${st.icon} ${a.agent}` });
      }
    }
    return tabs;
  }

  // ---- 键盘流 (D008) ----

  handleInput(data: string): void {
    if (isKeyRelease(data)) return; // kitty 协议 release 过滤 (保险)
    const tabs = this.currentTabs();

    if (matchesKey(data, "escape") || matchesKey(data, "alt+v")) { this.opts.done(null); return; }
    if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.state.tabIndex = (this.state.tabIndex + 1) % tabs.length;
      this.opts.tui.requestRender();
      return;
    }
    if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
      this.state.tabIndex = (this.state.tabIndex - 1 + tabs.length) % tabs.length;
      this.opts.tui.requestRender();
      return;
    }
    for (let i = 0; i < tabs.length && i < 9; i++) {
      if (matchesKey(data, String(i + 1) as KeyId)) {
        this.state.tabIndex = i;
        this.opts.tui.requestRender();
        return;
      }
    }

    const current = tabs[this.state.tabIndex]?.id ?? TIMELINE_ID;
    const isConv = current === TIMELINE_ID;

    if (matchesKey(data, "up")) {
      if (isConv) this.moveCursor(-1);
      else this.scrollBy(current, -1);
      return;
    }
    if (matchesKey(data, "down")) {
      if (isConv) this.moveCursor(1);
      else this.scrollBy(current, 1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      if (isConv) this.moveCursor(-this.contentRows());
      else this.scrollBy(current, -this.contentRows());
      return;
    }
    if (matchesKey(data, "pageDown")) {
      if (isConv) this.moveCursor(this.contentRows());
      else this.scrollBy(current, this.contentRows());
      return;
    }
    if (matchesKey(data, "enter")) {
      if (isConv) this.confirmCursor();
      return;
    }
    if (matchesKey(data, "home")) {
      if (isConv) { this.state.convCursor = 0; this.opts.tui.requestRender(); }
      else this.scrollToTop(current);
      return;
    }
    if (matchesKey(data, "end")) {
      if (isConv) { this.state.convCursor = Math.max(0, this.batches().length - 1); this.opts.tui.requestRender(); }
      else this.scrollToBottom(current);
      return;
    }
  }

  /** Timeline: 移动批次选择 */
  private moveCursor(delta: number): void {
    const n = this.batches().length;
    if (n === 0) return;
    this.state.convCursor = clamp(this.state.convCursor + delta, 0, n - 1);
    this.opts.tui.requestRender();
  }

  /** Timeline: Enter 确认 → 其余 tab 切换为该批次子代理 */
  private confirmCursor(): void {
    const bs = this.batches();
    if (bs.length === 0) return;
    const b = bs[clamp(this.state.convCursor, 0, bs.length - 1)];
    this.state.confirmedBatchId = b.id;
    this.state.tabIndex = clamp(this.state.tabIndex, 0, this.currentTabs().length - 1);
    this.opts.tui.requestRender();
  }

  private contentRows(): number {
    const termRows = this.opts.tui.terminal.rows || 24;
    return Math.max(3, termRows - 2 - HDR_LINES - TAB_LINES - FTR_LINES);
  }

  private currentWidth(): number {
    return this.lastRenderWidth > 0 ? this.lastRenderWidth : Math.max(20, this.opts.tui.terminal.columns || 80);
  }

  /** 内容 → 视觉行 (折行后) 全量数组: 滚动/页码按视觉行计 */
  private visualLines(tabId: string): string[] {
    const w = this.currentWidth();
    const out: string[] = [];
    for (const cl of this.buildContent(tabId, w)) out.push(...this.paintLine(cl, w));
    return out;
  }

  private totalLines(tabId: string): number {
    return this.visualLines(tabId).length;
  }

  private scrollBy(tabId: string, delta: number): void {
    const rows = this.contentRows();
    const total = this.totalLines(tabId);
    if (total <= rows) return;
    const ts = this.state.tabs[tabId] ?? initialTabState(true);
    const maxScroll = Math.max(0, total - rows);
    if (ts.follow && delta < 0) {
      ts.follow = false;
      ts.scroll = clamp(maxScroll + delta, 0, maxScroll);
    } else {
      ts.scroll = clamp(ts.scroll + delta, 0, maxScroll);
    }
    if (delta > 0 && ts.scroll >= maxScroll) ts.follow = true;
    this.state.tabs[tabId] = ts;
    this.opts.tui.requestRender();
  }

  private scrollToTop(tabId: string): void {
    const ts = this.state.tabs[tabId] ?? initialTabState(true);
    ts.follow = false;
    ts.scroll = 0;
    this.state.tabs[tabId] = ts;
    this.opts.tui.requestRender();
  }

  private scrollToBottom(tabId: string): void {
    const ts = this.state.tabs[tabId] ?? initialTabState(true);
    ts.follow = true;
    ts.scroll = Math.max(0, this.totalLines(tabId) - this.contentRows());
    this.state.tabs[tabId] = ts;
    this.opts.tui.requestRender();
  }

  /** 渲染期 follow 应用: 开 → 滚到底; 关 → clamp, 滚回底部自动恢复 (子代理 tab 语义, D007) */
  private applyFollow(tabId: string, total: number, rows: number): void {
    const ts = this.state.tabs[tabId] ?? initialTabState(true);
    const maxScroll = Math.max(0, total - rows);
    if (isAgentTab(tabId) && ts.follow) {
      ts.scroll = maxScroll;
    } else {
      ts.scroll = clamp(ts.scroll, 0, maxScroll);
      if (isAgentTab(tabId) && ts.scroll >= maxScroll) ts.follow = true;
    }
    this.state.tabs[tabId] = ts;
  }

  // ---- 渲染 ----

  render(width: number): string[] {
    const w = width > 0 ? width : this.currentWidth();
    this.lastRenderWidth = w;
    const termRows = this.opts.tui.terminal.rows || 24;
    const availH = Math.max(10, termRows - 2); // 全屏 overlay margin top/bottom = 1
    const contentRows = Math.max(3, availH - HDR_LINES - TAB_LINES - FTR_LINES);
    const tabs = this.currentTabs();
    const tabId = tabs[this.state.tabIndex]?.id ?? TIMELINE_ID;

    const out: string[] = [];
    for (const l of this.headerLines(w)) out.push(l);
    out.push(this.tabBarLine(tabs, w));
    const visual = this.visualLines(tabId);
    this.applyFollow(tabId, visual.length, contentRows);
    const sc = (this.state.tabs[tabId] ?? initialTabState(true)).scroll;
    out.push(...visual.slice(sc, sc + contentRows));
    while (out.length < HDR_LINES + TAB_LINES + contentRows) out.push("");
    out.push(this.footerLine(tabId, w));
    while (out.length < availH) out.push("");
    return out.slice(0, availH);
  }

  private paintLine(cl: ContentLine, width: number): string[] {
    const th = this.opts.theme;
    const chunks = wrapText(cl.plain, width);
    return chunks.map((ch) => {
      let t = ch;
      if (cl.bold) t = th.bold(t);
      if (cl.color) t = th.fg(cl.color, t);
      if (cl.bg) t = th.bg(cl.bg, t);
      return t;
    });
  }

  private headerLines(width: number): string[] {
    const th = this.opts.theme;
    const b = this.confirmedBatch();
    if (!b) return [truncate("Subagent Session Viewer · (无批次数据)", width), ""];
    const segs: string[] = [
      th.fg("accent", "Subagent Session Viewer"),
      th.fg("text", `批次 ${b.id}`),
      th.fg("text", `mode=${b.mode}`),
      th.fg("muted", fmtClock(b.createdAtMs)),
      th.fg("text", batchStatusSummary(b)),
      ...(b.source === "disk" ? [th.fg("muted", "disk")] : []),
    ];
    const l1 = truncate(segs.join(" · "), width);
    const l2 = th.fg("dim", truncate(`task: ${b.task || "—"} · agents: ${agentList(b)}`, width));
    return [l1, l2];
  }

  private tabBarLine(tabs: TabDef[], width: number): string {
    const th = this.opts.theme;
    const segs = tabs.map((t, i) => {
      const label = `[${t.label}]`;
      if (i === this.state.tabIndex) {
        const inner = th.fg("accent", label);
        return th.inverse ? th.inverse(inner) : inner;
      }
      return th.fg("muted", label);
    });
    let out = "";
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const sw = dispLen(tabs[i].label) + 2;
      if (i > 0 && acc + 1 + sw > width) break;
      if (i > 0) { out += " "; acc += 1; }
      out += s;
      acc += sw;
    }
    return out;
  }

  /** 底部一行 (D007): 子代理 tab = 键盘 hint + follow 状态 + ctx%/budget/hint/log ids; Timeline tab = 纯 hint */
  private footerLine(tabId: string, width: number): string {
    const th = this.opts.theme;
    const hint = `[Esc] 关闭 · [Tab/←→] 切tab · [1-${Math.min(9, this.currentTabs().length)}] 跳 · [↑↓] ${isAgentTab(tabId) ? "滚动" : "选批次"} · [PgUp/PgDn] 页 · [Enter] 确认`;
    const note = isAgentTab(tabId) ? this.statusNote(tabId) : "";
    const noteW = dispLen(note);
    const plain = truncate(hint, Math.max(0, width - noteW));
    let out = th.fg("dim", plain);
    if (isAgentTab(tabId) && note !== "" && dispLen(plain) + noteW <= width) {
      out += th.fg("muted", note);
    }
    return out;
  }

  /** 子代理 tab 底部状态区一段: follow · ctx% · budget(显式/自动) · hint · log event ids (D007) */
  private statusNote(agentId: string): string {
    const b = this.confirmedBatch();
    const agent = b?.agents.find((a) => a.id === agentId);
    if (!agent) return "";
    const segs: string[] = [];
    const ts = this.state.tabs[agentId] ?? initialTabState(true);
    segs.push(ts.follow ? "follow 开" : "已暂停 follow");
    const ctx = agent.contextPercent;
    segs.push(ctx !== undefined && ctx !== null ? `ctx ${Math.round(ctx * 10) / 10}%` : "ctx —");
    if (agent.usageBudgetExplicit !== undefined) segs.push(`cap ${fmtT(agent.usageBudgetExplicit)}`);
    else if (agent.budgetAuto) segs.push("auto 70%");
    if (agent.hint) segs.push(`hint "${truncate(agent.hint, 32)}"`);
    if (agent.logEventIds && agent.logEventIds.length > 0) {
      const ids = agent.logEventIds.slice(0, 5).join(",");
      segs.push(`logs ${ids}${agent.logEventIds.length > 5 ? "…" : ""}`);
    }
    return ` · ${segs.join(" · ")}`;
  }

  // ---- 内容构建 ----

  private buildContent(tabId: string, _w: number): ContentLine[] {
    if (tabId === TIMELINE_ID) return buildConversationContent(this.batches(), this.state.convCursor, this.state.confirmedBatchId);
    const b = this.confirmedBatch();
    const agent = b?.agents.find((a) => a.id === tabId);
    if (!agent) return [{ plain: "(无会话数据)", color: "muted" }];
    return buildAgentTranscript(b!, agent);
  }
}

// ---- Timeline tab: 批次时间线 (上早下晚, ↑/↓ 选, Enter 确认) ----

function buildConversationContent(batches: ViewerBatch[], cursor: number, confirmedId: string | null): ContentLine[] {
  const lines: ContentLine[] = [];
  if (batches.length === 0) {
    lines.push({ plain: "(无批次数据)", color: "muted" });
    return lines;
  }
  lines.push({ plain: "父会话发起的子代理批次 · 从早到晚 (↑/↓ 选择 · Enter 确认)", color: "dim" });
  lines.push({ plain: "".padEnd(60, "─"), color: "dim" });
  batches.forEach((b, i) => {
    const isCursor = i === cursor;
    const isConfirmed = b.id === confirmedId;
    const sel = isCursor ? "▸" : " ";
    const conf = isConfirmed ? "●" : " ";
    const prefix = `${sel}${conf} `;
    const st = b.mode === "parallel"
      ? { icon: "◐", label: "parallel", color: b.failed > 0 ? "error" : b.active > 0 ? "accent" : "success" }
      : statusOf(b.agents[0]?.status ?? "done");
    const modeStr = b.mode === "parallel" ? "parallel" : b.mode;
    const row = `${prefix}#${i + 1}  ${fmtClock(b.createdAtMs)}  ${modeStr.padEnd(8)}  ${agentList(b).padEnd(36)}  ${batchStatusSummary(b)}`;
    const line: ContentLine = { plain: row, color: isCursor ? "text" : st.color };
    if (isCursor) {
      line.bg = "userMessageBg";
      line.color = "userMessageText";
      line.bold = true;
    }
    lines.push(line);
  });
  return lines;
}

// ---- 子代理 tab: pi transcript 风格会话 (user bg 块 / assistant 纯文本 / 工具调用 bg 块) ----

function buildAgentTranscript(batch: ViewerBatch, agent: ViewerAgent): ContentLine[] {
  const lines: ContentLine[] = [];
  const st = statusOf(agent.status);
  const started = agent.startedAtMs ?? 0;
  const dur = agent.endedAtMs !== undefined ? fmtDur(agent.endedAtMs - started) : started > 0 ? fmtDur(Date.now() - started) : "—";
  lines.push({
    plain: `${st.icon} ${agent.agent} · ${st.label} · ${dur} · model ${agent.model || "—"} · ${batch.id}`,
    color: st.color,
  });
  if (agent.taskPreview) lines.push({ plain: `task: ${agent.taskPreview}`, color: "dim" });
  lines.push({ plain: "" });

  const entries = agent.sessionFile ? readSessionTranscriptLines(agent.sessionFile) : [];
  if (entries.length === 0) {
    // PRD 验收 7: 子代理完成前完整 transcript 不可用; GC 缺文件 → 可理解 empty state, 不崩
    lines.push({
      plain: agent.status === "active" ? "(会话进行中, transcript 可能不完整)" : "(无会话记录: session 缺失或已 GC)",
      color: "muted",
    });
  } else {
    for (const e of entries) {
      if (e.kind !== "message") continue;
      if (e.type === "user") {
        lines.push({ plain: `[user] ${fmtDur(e.ts)}`, color: "dim" });
        for (const para of e.text.split("\n")) lines.push({ plain: `  ${para}`, color: "userMessageText", bg: "userMessageBg" });
        lines.push({ plain: "" });
      } else if (e.type === "assistant") {
        lines.push({ plain: `[assistant] ${fmtDur(e.ts)}${e.model ? ` · ${e.model}` : ""}`, color: "dim" });
        for (const para of e.text.split("\n")) lines.push({ plain: `  ${para}` });
        if (e.thinking) lines.push({ plain: `  ⟠ thinking: ${truncate(e.thinking.replace(/\s+/g, " ").trim(), 100)}`, color: "dim" });
        for (const tc of e.toolCalls ?? []) {
          lines.push({ plain: `  → ${tc.name} ${tc.argsPreview}`, color: "toolTitle", bold: true, bg: "toolPendingBg" });
        }
        lines.push({ plain: "" });
      } else if (e.type === "toolResult") {
        const bg = e.isError ? "toolErrorBg" : "toolSuccessBg";
        lines.push({ plain: `  ↳ ${e.toolName ?? "tool"}${e.isError ? " ✗" : " ✓"}`, color: "toolTitle", bold: true, bg });
        for (const l of e.text.split("\n")) lines.push({ plain: `    ${l}`, color: "toolOutput", bg });
        lines.push({ plain: "" });
      } else if (e.type === "bashExecution") {
        const bg = "toolSuccessBg";
        const first = e.text.split("\n")[0] ?? "";
        lines.push({ plain: `  $ ${first}`, color: "toolTitle", bold: true, bg });
        for (const l of e.text.split("\n").slice(1)) lines.push({ plain: `    ${l}`, color: "toolOutput", bg });
        lines.push({ plain: "" });
      }
      // 其余角色 (custom 等) 渲染跳过, 不丢弃
    }
  }

  // 终态注记
  if (agent.status === "active") {
    lines.push({ plain: `${spinnerFrameAt(Date.now())} running... (会话进行中, follow 滚动)`, color: "accent" });
  } else if (isAttention(agent.status)) {
    lines.push({ plain: `${st.icon} ${agent.status}: ${(agent.errorMessage ?? agent.taskPreview) || "(无错误信息)"}`, color: "error" });
  } else {
    lines.push({ plain: `${st.icon} 会话结束 (${st.label})`, color: st.color });
  }
  if (agent.usage) {
    const u = agent.usage;
    lines.push({ plain: `usage ↑${fmtT(u.input)} ↓${fmtT(u.output)} · $${(u.cost ?? 0).toFixed(4)} · turns ${u.turns}`, color: "muted" });
  }
  return lines;
}