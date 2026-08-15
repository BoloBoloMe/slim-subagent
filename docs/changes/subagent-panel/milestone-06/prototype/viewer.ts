/**
 * subagent-panel-proto — M06b Session Viewer overlay 原型 (第二版, 信息组织返工)
 *
 * 形态 D: capturing overlay 全屏自绘面板 (M01 结论: 打开必须非阻塞 fire-and-forget;
 * capturing 收全部键盘; Esc=done(null)).
 *
 * 信息组织 (用户新设计):
 *   - tab 栏 = 子代理: 第一个 tab 固定 Conversation (批次时间线), 其余每个 tab 是
 *     所选 (确认) 批次的 1 个子代理 (agent 名), tab 内容 = 该子代理的会话 transcript
 *     (视觉风格对齐 pi 父会话历史区: 用户消息 bg 块 / 助手消息纯文本 / 工具调用 bg 块
 *     + bold toolTitle + toolOutput, 自绘近似).
 *   - Conversation tab: 父会话历史上发起过的所有子代理批次, 从早到晚 (上早下晚);
 *     每行 = 时间 + 模式 (single/parallel) + agent 列表 + 状态摘要 (如 2/4 done · 1 failed).
 *     ↑/↓ 移动选择, Enter 确认 → 其余 tab 切换为该批次的子代理. 默认选中最新批次.
 *
 * 键盘流 (用户拍板):
 *   Tab / Shift+Tab / ← / →  循环切 tab; 数字键 1-N 直跳;
 *   ↑/↓  Conversation tab = 选批次 / 子代理 tab = 滚动会话;
 *   PgUp / PgDn 翻页; Enter 仅 Conversation tab 确认选中; Esc 关闭;
 *   alt+v 再按一次 = 关闭 (toggle 语义, overlay 聚焦时直接拦截).
 *   已删除: r 回放键, w 宽度切换 (view-width 命令一并移除, 始终全屏).
 *
 * followLive 保留在子代理 tab (会话进行中的语义): follow 开时自动滚到底,
 * 用户上翻解除 (footer 显 "已暂停 follow"), 滚回底部恢复. Conversation tab 不需要.
 */
import type { Component, TUI, KeyId } from "@earendil-works/pi-tui";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { ProtoAgentSession, ProtoBatch, ProtoSessionMessage, ProtoSessionToolCall, ProtoTimeline } from "./types.ts";

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

export interface ViewerLiveData {
  timeline: ProtoTimeline | null;
}

export interface ViewerOpts {
  tui: TUI;
  theme: ThemeLike;
  done: (r: null) => void;
  getLive: () => ViewerLiveData;
  /** overlay 关闭/销毁后回调 (幂等): 复位 index.ts 模块状态 */
  onClose: () => void;
}

interface ThemeLike {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  inverse?(text: string): string;
}

/** 渲染行: 纯文本 + 主题色 (render 时折行后统一着色, 避免 ANSI 序列被折行切断) */
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

/** 模块级 viewer 状态 (跨组件实例保留: Esc 后重开 / reload 重置) */
interface ViewerState {
  tabIndex: number;
  convCursor: number;
  confirmedBatchId: string | null;
  tabs: Record<string, TabState>; // key: "conversation" | agent session id
}
const state: ViewerState = {
  tabIndex: 0,
  convCursor: 0,
  confirmedBatchId: null,
  tabs: {},
};

interface TabDef {
  id: string; // "conversation" | agent id
  label: string;
}

const CONVERSATION_ID = "conversation";
const HDR_LINES = 2;
const TAB_LINES = 1;
const FTR_LINES = 1;

function isAgentTab(id: string): boolean {
  return id !== CONVERSATION_ID;
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function dispLen(s: string): number {
  let n = 0;
  for (const ch of Array.from(s)) {
    const cp = ch.codePointAt(0)!;
    n += cp > 0x2e7f ? 2 : 1;
  }
  return n;
}

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (dispLen(s) <= max) return s;
  let acc = 0;
  const out: string[] = [];
  for (const ch of Array.from(s)) {
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
  for (const ch of Array.from(s)) {
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

function statusOf(status: string): { icon: string; label: string; color: string } {
  switch (status) {
    case "active": return { icon: "⠿", label: "active", color: "accent" };
    case "done": return { icon: "✓", label: "done", color: "success" };
    case "failed": return { icon: "✗", label: "failed", color: "error" };
    case "timeout": return { icon: "✗", label: "timeout", color: "warning" };
    case "budget": return { icon: "✗", label: "budget", color: "warning" };
    case "cancelled": return { icon: "✗", label: "cancelled", color: "warning" };
    case "pending": return { icon: "◌", label: "pending", color: "muted" };
    default: return { icon: "⠿", label: status, color: "muted" };
  }
}

function batchStatusSummary(b: ProtoBatch): string {
  if (b.mode === "single") {
    const st = statusOf(b.agents[0]?.status ?? "done");
    return `${st.label}`;
  }
  const parts: string[] = [`${b.done}/${b.total} done`];
  if (b.failed > 0) parts.push(`${b.failed} failed`);
  if (b.active > 0) parts.push(`${b.active} active`);
  return parts.join(" · ");
}

function agentList(b: ProtoBatch): string {
  return b.agents.map((a) => a.agent).join("/");
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export class SessionViewerComponent implements Component {
  private opts: ViewerOpts;
  /** 最近一次 render 的 overlay 宽度 (handleInput 用, 与 render 宽度一致) */
  private lastRenderWidth = 0;

  constructor(opts: ViewerOpts) {
    this.opts = opts;
    // 首次打开默认: 选中并确认最新批次 (时间线尾部)
    const tl = opts.getLive().timeline;
    if (tl && tl.batches.length > 0) {
      if (!tl.batches.some((b) => b.id === state.confirmedBatchId)) {
        state.confirmedBatchId = tl.batches[tl.batches.length - 1].id;
        state.convCursor = tl.batches.length - 1;
        state.tabIndex = 0;
      } else {
        // confirmed 保留, convCursor 若越界则收敛
        state.convCursor = clamp(state.convCursor, 0, tl.batches.length - 1);
      }
    }
  }

  invalidate(): void {}

  dispose(): void {
    // 幂等 (M01 §4.7): 无定时器/订阅; 仅复位宿主状态
    this.opts.onClose();
  }

  // ---- 数据 ----

  private timeline(): ProtoTimeline | null {
    return this.opts.getLive().timeline;
  }

  private batches(): ProtoBatch[] {
    return this.timeline()?.batches ?? [];
  }

  private confirmedBatch(): ProtoBatch | null {
    const tl = this.timeline();
    if (!tl) return null;
    return tl.batches.find((b) => b.id === state.confirmedBatchId) ?? null;
  }

  private currentTabs(): TabDef[] {
    const tabs: TabDef[] = [{ id: CONVERSATION_ID, label: "Conversation" }];
    const b = this.confirmedBatch();
    if (b) {
      for (const a of b.agents) {
        const st = statusOf(a.status);
        tabs.push({ id: a.id, label: `${st.icon} ${a.agent}` });
      }
    }
    return tabs;
  }

  // ---- 键盘流 ----

  handleInput(data: string): void {
    if (isKeyRelease(data)) return; // kitty 协议 release 过滤 (保险)
    const tabs = this.currentTabs();

    if (matchesKey(data, "escape") || matchesKey(data, "alt+v")) { this.opts.done(null); return; }
    if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      state.tabIndex = (state.tabIndex + 1) % tabs.length;
      this.opts.tui.requestRender();
      return;
    }
    if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
      state.tabIndex = (state.tabIndex - 1 + tabs.length) % tabs.length;
      this.opts.tui.requestRender();
      return;
    }
    for (let i = 0; i < tabs.length && i < 9; i++) {
      if (matchesKey(data, String(i + 1) as KeyId)) {
        state.tabIndex = i;
        this.opts.tui.requestRender();
        return;
      }
    }

    const current = tabs[state.tabIndex]?.id ?? CONVERSATION_ID;
    const isConv = current === CONVERSATION_ID;

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
      if (isConv) { state.convCursor = 0; this.opts.tui.requestRender(); }
      else this.scrollToTop(current);
      return;
    }
    if (matchesKey(data, "end")) {
      if (isConv) { state.convCursor = Math.max(0, this.batches().length - 1); this.opts.tui.requestRender(); }
      else this.scrollToBottom(current);
      return;
    }
  }

  /** Conversation tab: 移动批次选择 */
  private moveCursor(delta: number): void {
    const n = this.batches().length;
    if (n === 0) return;
    state.convCursor = clamp(state.convCursor + delta, 0, n - 1);
    this.opts.tui.requestRender();
  }

  /** Conversation tab: Enter 确认 → 其余 tab 切换为该批次的子代理 */
  private confirmCursor(): void {
    const bs = this.batches();
    if (bs.length === 0) return;
    const b = bs[clamp(state.convCursor, 0, bs.length - 1)];
    state.confirmedBatchId = b.id;
    state.tabIndex = clamp(state.tabIndex, 0, this.currentTabs().length - 1);
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
    const ts = state.tabs[tabId] ?? initialTabState(true);
    const maxScroll = Math.max(0, total - rows);
    if (ts.follow && delta < 0) {
      ts.follow = false;
      ts.scroll = clamp(maxScroll + delta, 0, maxScroll);
    } else {
      ts.scroll = clamp(ts.scroll + delta, 0, maxScroll);
    }
    if (delta > 0 && ts.scroll >= maxScroll) ts.follow = true;
    state.tabs[tabId] = ts;
    this.opts.tui.requestRender();
  }

  private scrollToTop(tabId: string): void {
    const ts = state.tabs[tabId] ?? initialTabState(true);
    ts.follow = false;
    ts.scroll = 0;
    state.tabs[tabId] = ts;
    this.opts.tui.requestRender();
  }

  private scrollToBottom(tabId: string): void {
    const ts = state.tabs[tabId] ?? initialTabState(true);
    ts.follow = true;
    ts.scroll = Math.max(0, this.totalLines(tabId) - this.contentRows());
    state.tabs[tabId] = ts;
    this.opts.tui.requestRender();
  }

  /** 渲染期 follow 应用: follow 开 → 滚到底; 关 → clamp, 滚回底部自动恢复 */
  private applyFollow(tabId: string, total: number, rows: number): void {
    const ts = state.tabs[tabId] ?? initialTabState(true);
    const maxScroll = Math.max(0, total - rows);
    if (isAgentTab(tabId) && ts.follow) {
      ts.scroll = maxScroll;
    } else {
      ts.scroll = clamp(ts.scroll, 0, maxScroll);
      if (isAgentTab(tabId) && ts.scroll >= maxScroll) ts.follow = true;
    }
    state.tabs[tabId] = ts;
  }

  // ---- 渲染 ----

  render(width: number): string[] {
    const w = width > 0 ? width : this.currentWidth();
    this.lastRenderWidth = w;
    const termRows = this.opts.tui.terminal.rows || 24;
    const availH = Math.max(10, termRows - 2); // overlay margin top/bottom = 1
    const contentRows = Math.max(3, availH - HDR_LINES - TAB_LINES - FTR_LINES);
    const tabs = this.currentTabs();
    const tabId = tabs[state.tabIndex]?.id ?? CONVERSATION_ID;

    const out: string[] = [];
    for (const l of this.headerLines(w)) out.push(l);
    out.push(this.tabBarLine(tabs, w));
    const visual = this.visualLines(tabId);
    this.applyFollow(tabId, visual.length, contentRows);
    const sc = (state.tabs[tabId] ?? initialTabState(true)).scroll;
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
      if (cl.color) t = th.fg(cl.color as any, t);
      if (cl.bg) t = th.bg(cl.bg as any, t);
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
    ];
    const l1 = truncate(segs.join(" · "), width);
    const l2 = th.fg("dim", truncate(`task: ${b.task} · agents: ${agentList(b)}`, width));
    return [l1, l2];
  }

  private tabBarLine(tabs: TabDef[], width: number): string {
    const th = this.opts.theme;
    const segs = tabs.map((t, i) => {
      const label = `[${t.label}]`;
      if (i === state.tabIndex) {
        const inner = th.fg("accent", label);
        return th.inverse ? th.inverse(inner) : inner;
      }
      return th.fg("muted", label);
    });
    const sep = " ";
    let out = "";
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const sw = dispLen(tabs[i].label) + 2;
      if (i > 0 && acc + 1 + sw > width) break;
      if (i > 0) { out += sep; acc += 1; }
      out += s;
      acc += sw;
    }
    return out;
  }

  private footerLine(tabId: string, width: number): string {
    const th = this.opts.theme;
    const hint = `[Esc] 关闭 · [Tab/←→] 切tab · [1-${Math.min(9, this.currentTabs().length)}] 跳 · [↑↓] ${tabId === CONVERSATION_ID ? "选批次" : "滚动"} · [PgUp/PgDn] 页 · [Enter] 确认`;
    let out = th.fg("dim", truncate(hint, width));
    if (isAgentTab(tabId)) {
      const ts = state.tabs[tabId] ?? initialTabState(true);
      const note = ts.follow ? " · follow 开" : " · 已暂停 follow";
      const noteW = dispLen(note);
      const plain = truncate(hint, Math.max(0, width - noteW));
      out = th.fg("dim", plain);
      if (dispLen(plain) + noteW <= width) {
        out += ts.follow ? th.fg("muted", note) : th.fg("warning", note);
      }
    }
    return out;
  }

  // ---- 内容构建 (tabId → ContentLine[]) ----

  private buildContent(tabId: string, _width: number): ContentLine[] {
    if (tabId === CONVERSATION_ID) return buildConversationContent(this.batches(), state.convCursor, state.confirmedBatchId);
    const b = this.confirmedBatch();
    const agent = b?.agents.find((a) => a.id === tabId);
    if (!agent) return [{ plain: "(无会话数据)", color: "muted" }];
    return buildAgentTranscript(agent, b?.id ?? "");
  }
}

// ---------------------------------------------------------------------------
// Conversation tab: 批次时间线 (早→晚, ↑/↓ 选, Enter 确认)
// ---------------------------------------------------------------------------

function buildConversationContent(batches: ProtoBatch[], cursor: number, confirmedId: string | null): ContentLine[] {
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
    const st = b.mode === "single"
      ? statusOf(b.agents[0]?.status ?? "done")
      : { icon: "◐", label: "parallel", color: b.failed > 0 ? "error" : "success" };
    const modeStr = b.mode === "single" ? "single" : "parallel";
    const row = `${prefix}#${i + 1}  ${fmtClock(b.createdAtMs)}  ${modeStr.padEnd(8)}  ${agentList(b).padEnd(36)}  ${batchStatusSummary(b)}`;
    const color = isCursor ? "text" : st.color;
    const line: ContentLine = { plain: row, color };
    if (isCursor) {
      line.bg = "userMessageBg";
      line.color = "userMessageText";
      line.bold = true;
    }
    lines.push(line);
  });
  return lines;
}

// ---------------------------------------------------------------------------
// 子代理 tab: pi transcript 风格会话 (user bg 块 / assistant 纯文本 / 工具 bg 块)
// ---------------------------------------------------------------------------

/** 按时间合并 messages + tools (缺失 ts 用前值递增), 保持 transcript 时序 */
interface TranscriptItem {
  ts: number;
  kind: "user" | "assistant" | "tool";
  msg?: ProtoSessionMessage;
  tool?: ProtoSessionToolCall;
}

function transcriptItems(agent: ProtoAgentSession): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let lastTs = 0;
  for (const m of agent.messages) {
    lastTs = Math.max(lastTs, m.tsOffsetMs ?? lastTs);
    items.push({ ts: lastTs, kind: m.role, msg: m });
  }
  lastTs = 0;
  for (const t of agent.tools) {
    lastTs = Math.max(lastTs, t.tsOffsetMs ?? lastTs);
    items.push({ ts: lastTs, kind: "tool", tool: t });
  }
  items.sort((a, b) => a.ts - b.ts);
  return items;
}

function buildAgentTranscript(agent: ProtoAgentSession, batchId: string): ContentLine[] {
  const lines: ContentLine[] = [];
  const st = statusOf(agent.status);
  // 会话头
  const dur = agent.endedAtMs !== undefined ? fmtDur(agent.endedAtMs - agent.startedAtMs) : fmtDur(Date.now() - agent.startedAtMs);
  lines.push({
    plain: `${st.icon} ${agent.agent} · ${st.label} · ${dur} · model ${agent.model} · ${batchId}`,
    color: st.color,
  });
  if (agent.taskPreview) lines.push({ plain: `task: ${agent.taskPreview}`, color: "dim" });
  lines.push({ plain: "" });

  for (const item of transcriptItems(agent)) {
    if (item.kind === "user" && item.msg) {
      lines.push({ plain: `[user] ${fmtDur(item.ts)}`, color: "dim" });
      for (const l of item.msg.text.split("\n")) {
        lines.push({ plain: `  ${l}`, color: "userMessageText", bg: "userMessageBg" });
      }
      lines.push({ plain: "" });
    } else if (item.kind === "assistant" && item.msg) {
      lines.push({ plain: `[assistant] ${fmtDur(item.ts)}`, color: "dim" });
      for (const l of item.msg.text.split("\n")) {
        lines.push({ plain: `  ${l}` });
      }
      lines.push({ plain: "" });
    } else if (item.kind === "tool" && item.tool) {
      const t = item.tool;
      const bg = t.ok ? "toolSuccessBg" : "toolErrorBg";
      lines.push({ plain: `  → ${t.name} ${t.argsPreview}`, color: "toolTitle", bold: true, bg });
      const outLines = t.output.split("\n");
      for (const l of outLines) {
        lines.push({ plain: `    ${l}`, color: "toolOutput", bg });
      }
      lines.push({ plain: "" });
    }
  }

  // 终态注记
  if (agent.status === "active") {
    lines.push({ plain: "⠿ running... (会话进行中, follow 滚动)", color: "accent" });
  } else if (agent.status === "failed" || agent.status === "timeout" || agent.status === "budget" || agent.status === "cancelled") {
    lines.push({ plain: `${st.icon} ${agent.status}: ${agent.errorMessage ?? agent.taskPreview}`, color: "error" });
  } else {
    lines.push({ plain: `${st.icon} 会话结束 (${st.label})`, color: st.color });
  }
  if (agent.usage) {
    const u = agent.usage;
    lines.push({
      plain: `usage ↑${fmtT(u.input)} ↓${fmtT(u.output)} · $${u.cost.toFixed(4)} · turns ${u.turns}`,
      color: "muted",
    });
  }
  return lines;
}
