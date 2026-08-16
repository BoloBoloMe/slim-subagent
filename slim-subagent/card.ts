// ISSUE-05 Inline Live Run Card (PRD §4.0/§4.1 + M07 D001-D005/D008).
// 职责: 变体 C 分段展开 — 状态行 + recentTools(≤3) 逐条行 + output 预览行 (single);
// parallel 聚合行 + child 双行树形 + pending 预建行; spinner 动效 (90ms invalidate, settled 即停);
// §4.0 必填字段与窄行省略 (cost→CH→cap→timeout→recent→task→usage, 死保 status/model/ctx/elapsed);
// CH 段 (cozy 且 cacheRead>0); 密度开关 (cozy 全字段 / compact 预省 cost/CH/cap/timeout).
// 分层: 纯函数层 (renderRunNodeLines/renderParallelLines/computeCh/formatStatusIcon) 不依赖 pi-tui,
// 是 TDD 接缝 (test/card.test.ts); 组件层 (renderRunCard/RunCardComponent + spinner) 收 context.invalidate.
// 参考: milestone-05/prototype/index.ts (cCard/spinner 机制, 搬运逻辑不搬运原型债); 卡上无按钮/copy (D010).

import type { Component } from "@earendil-works/pi-tui";
import type { DisplayStatus, RunNode, SlimUsage } from "./projection.ts";

// ---------------------------------------------------------------------------
// 常量与终端宽度工具
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"; // 10 帧, 90ms 轮转
const SPINNER_MS = 90;
const HINT = "alt+v 会话 · /agent-diagnose 诊断"; // D009 卡尾固定提示
const INDENT_S = "   "; // single 明细行缩进
const INDENT_C = "   "; // parallel child 状态行缩进
const INDENT_CC = "     "; // parallel child 明细行缩进

// §4.0 窄行省略优先级 (D003: cost→CH→cap→timeout→recent→task→usage; stop 为行尾辅助段, 最优先丢).
const DROP_STOP = -1;
const DROP_COST = 0;
const DROP_CH = 1;
const DROP_CAP = 2;
const DROP_TIMEOUT = 3;
const DROP_RECENT = 4;
const DROP_TASK = 5;
const DROP_USAGE = 6;

export type CardDensity = "cozy" | "compact";

/** 显示宽度: 全角字符记 2 列 (Braille/CJK 等). */
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
  const chars = Array.from(s);
  if (dispLen(s) <= max) return s;
  let acc = 0;
  const out: string[] = [];
  for (const ch of chars) {
    const w = dispLen(ch);
    if (acc + w > max - 1) break;
    acc += w;
    out.push(ch);
  }
  return out.join("") + "…";
}

/** token 缩写 (PRD 示例像素参照: 1 位小数 k, ≥1M 退 M). */
function fmtT(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** cap 预算缩写 (整数 k, 与 PRD 示例 `cap 50k` 同形). */
function fmtCap(n: number): string {
  if (n < 1000) return String(n);
  return `${Math.round(n / 1000)}k`;
}

/** 运行时长 mm:ss / h:mm:ss; 无 startedAtMs → "" (不伪造). */
function elapsedStr(node: RunNode): string {
  const start = node.startedAtMs;
  if (start === undefined) return "";
  const end = node.endedAtMs ?? Date.now();
  const s = Math.max(0, Math.floor((end - start) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** 子代理口径 ctx (PRD §2.9): 有数据必显, 未知 `—` 不伪造. */
function ctxStr(node: RunNode): string {
  if (node.contextPercent === undefined || node.contextPercent === null) return "ctx —";
  return `ctx ${node.contextPercent}%`;
}

function isTerminal(status: DisplayStatus): boolean {
  return status !== "active" && status !== "pending";
}

// ---------------------------------------------------------------------------
// 纯函数层: 图标 / CH / 搜索与卡行
// ---------------------------------------------------------------------------

/** status → 行首图标. active=spinner 帧 (无帧给 ⠿ 占位, 组件层按时间替换); attention 聚合 ✗. */
export function formatStatusIcon(status: DisplayStatus, activeSpinnerFrame?: string): string {
  switch (status) {
    case "active":
      return activeSpinnerFrame ?? "⠿";
    case "done":
      return "✓";
    case "failed":
    case "timeout":
    case "budget":
    case "cancelled":
    case "attention":
      return "✗";
    case "pending":
      return "◌";
    default:
      return "⠿";
  }
}

/** CH 缓存命中率 (D004): cacheRead/(cacheRead+input); 无 cacheRead 数据 → undefined (不显示, 不伪造). */
export function computeCh(usage: SlimUsage | undefined): number | undefined {
  if (!usage || usage.cacheRead <= 0) return undefined;
  const denom = usage.cacheRead + usage.input;
  if (denom <= 0) return undefined;
  return usage.cacheRead / denom;
}

function statusLabel(status: DisplayStatus): string {
  switch (status) {
    case "pending":
      return "pending 等待并发槽";
    case "attention":
      return "attention";
    default:
      return status;
  }
}

interface Seg {
  plain: string;
  drop?: number; // 越先丢越小; undefined = 必留 (status/agent/model/ctx/elapsed)
}

function usageTokens(u: SlimUsage): string {
  let s = `↑${fmtT(u.input)} ↓${fmtT(u.output)}`;
  if (u.cacheRead > 0) s += ` R${fmtT(u.cacheRead)}`;
  if (u.cacheWrite > 0) s += ` W${fmtT(u.cacheWrite)}`;
  return s;
}

// 真 usage 判定: 运行中占位行 (零值快照) 不展示 tokens/cost/CH (勿刷 ↑0 ↓0 $0.0000).
function hasRealUsage(u: SlimUsage | undefined): boolean {
  return !!u && (u.input !== 0 || u.output !== 0 || u.cacheRead !== 0 || u.cacheWrite !== 0);
}

/** §4.0 窄行省略: 死保 status/model/ctx; 仍超宽时从行尾截断最后一段. */
function renderSegLine(segs: Seg[], maxWidth: number): string {
  const active = segs.filter((s) => s.plain.length > 0);
  const totalOf = () => active.reduce((a, s) => a + dispLen(s.plain), 0) + Math.max(0, active.length - 1) * 3;
  let total = totalOf();
  while (total > maxWidth) {
    let idx = -1;
    let best = Infinity;
    for (let i = 0; i < active.length; i++) {
      const d = active[i].drop;
      if (d === undefined) continue;
      if (d <= best) {
        best = d; // 等优先取最右
        idx = i;
      }
    }
    if (idx === -1) break;
    active.splice(idx, 1);
    total = totalOf();
  }
  if (active.length === 0) return "";
  if (total > maxWidth) {
    const others = active.slice(0, -1).reduce((a, s) => a + dispLen(s.plain), 0) + (active.length - 1) * 3;
    const last = active[active.length - 1];
    const t = truncate(last.plain, maxWidth - others);
    if (t === "") active.pop();
    else active[active.length - 1] = { ...last, plain: t };
  }
  // 兑底: 即便固定段 (status/model/ctx) 自身超宽, 最终整行截断到 maxWidth (超宽行会致 pi 崩溃).
  return truncate(active.map((s) => s.plain).join(" · "), maxWidth);
}

/** 节点状态行片段 (single 卡与 parallel child 共用; withRecentTask 仅 single 行尾内联 recent/task). */
function statusRowSegs(node: RunNode, density: CardDensity, withRecentTask: boolean): Seg[] {
  const segs: Seg[] = [
    { plain: `${formatStatusIcon(node.status)} ${node.agent}` },
    { plain: [statusLabel(node.status), elapsedStr(node)].filter(Boolean).join(" ") },
    { plain: `model ${node.model ?? "—"}` },
    { plain: ctxStr(node) },
  ];
  const u = hasRealUsage(node.usage) ? node.usage : undefined;
  if (u) {
    segs.push({ plain: usageTokens(u), drop: DROP_USAGE });
    const ch = computeCh(u);
    if (density === "cozy" && ch !== undefined) segs.push({ plain: `CH ${Math.round(ch * 100)}%`, drop: DROP_CH });
    if (density === "cozy") segs.push({ plain: `$${u.cost.toFixed(4)}`, drop: DROP_COST });
  }
  if (density === "cozy" && node.stopReason && node.status !== "done" && node.status !== "active") {
    segs.push({ plain: `stop ${node.stopReason}`, drop: DROP_STOP });
  }
  if (density === "cozy" && node.timeoutMsExplicit !== undefined) {
    segs.push({ plain: `timeout ${node.timeoutMsExplicit / 1000}s`, drop: DROP_TIMEOUT });
  }
  if (density === "cozy" && node.usageBudgetExplicit !== undefined) {
    segs.push({ plain: `cap ${fmtCap(node.usageBudgetExplicit)}`, drop: DROP_CAP });
  }
  if (withRecentTask) {
    const rt = node.progress?.recentTools ?? [];
    if (rt.length > 0) {
      const last = rt[rt.length - 1];
      segs.push({ plain: `recent: ${truncate(`${last.tool} ${last.argsPreview}`, 24)}`, drop: DROP_RECENT });
    }
    if (node.taskPreview.length > 0) segs.push({ plain: `task ${truncate(node.taskPreview, 30)}`, drop: DROP_TASK });
  }
  return segs;
}

/** 分段展开明细: recentTools ≤3 (expanded ≤10) 逐条 + last output 预览行. 修复: 整行截断到 width (前缀+后缀一并计入). */
function detailLines(node: RunNode, width: number, indent: string, expanded: boolean): string[] {
  const lines: string[] = [];
  const rt = node.progress?.recentTools ?? [];
  const limit = expanded ? Math.min(rt.length, 10) : Math.min(rt.length, 3);
  const start = Math.max(0, rt.length - limit);
  for (let i = start; i < rt.length; i++) {
    const t = rt[i];
    lines.push(truncate(`${indent}→ ${t.tool} ${t.argsPreview}`, width));
  }
  const out = node.progress?.recentOutput ?? [];
  if (out.length > 0) {
    lines.push(truncate(`${indent}last: "${out[out.length - 1]}"`, width));
  }
  return lines;
}

/** pending 预建行 (D008): 只 agent + taskPreview + pending 等待并发槽, 无 model/ctx/elapsed/usage.
 * 修复: 整行截断到 width (前缀可能已超宽, 不可用固定预算). */
function pendingLine(node: RunNode, indent: string, width: number): string {
  return truncate(`${indent}◌ ${node.agent} · pending 等待并发槽 · task ${node.taskPreview}`, width);
}

/**
 * single/resume Run Card (变体 C): 状态行 + recentTools 逐条 + output 预览 + 卡尾提示.
 * 窄行省略按 §4.0 (cost→CH→cap→timeout→recent→task→usage), status/model/ctx/elapsed 死保.
 */
export function renderRunNodeLines(node: RunNode, width: number, opts: { density: CardDensity; expanded?: boolean }): string[] {
  const lines: string[] = [];
  if (node.status === "pending") {
    lines.push(pendingLine(node, "", width)); // 防御: single 理论无 pending
  } else {
    lines.push(renderSegLine(statusRowSegs(node, opts.density, true), width));
    lines.push(...detailLines(node, width, INDENT_S, opts.expanded ?? false));
  }
  lines.push(INDENT_S + HINT);
  return lines;
}

/** parallel 聚合 usage: root.usage 优先, 缺省 child usage 汇总 (总览 total 段). */
function aggregateUsage(root: RunNode, children: RunNode[]): SlimUsage | undefined {
  if (root.usage) return root.usage;
  const used = children.filter((c) => c.usage);
  if (used.length === 0) return undefined;
  const sum: SlimUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  for (const c of used) {
    const u = c.usage!;
    sum.input += u.input;
    sum.output += u.output;
    sum.cacheRead += u.cacheRead;
    sum.cacheWrite += u.cacheWrite;
    sum.cost += u.cost;
    sum.turns += u.turns;
  }
  return sum;
}

function parallelAggRow(root: RunNode, children: RunNode[], density: CardDensity): Seg[] {
  const done = root.progress?.done ?? children.filter((c) => c.status === "done").length;
  const total = root.progress?.total ?? children.length;
  const segs: Seg[] = [
    { plain: "◐ parallel" },
    { plain: `${done}/${total} done` },
    { plain: [statusLabel(root.status), elapsedStr(root)].filter(Boolean).join(" ") },
  ];
  const agg = aggregateUsage(root, children);
  const u = hasRealUsage(agg) ? agg : undefined;
  if (u) {
    let tokens = `total ↑${fmtT(u.input)} ↓${fmtT(u.output)}`;
    if (u.cacheWrite > 0) tokens += ` W${fmtT(u.cacheWrite)}`;
    segs.push({ plain: tokens, drop: DROP_USAGE });
    const ch = computeCh(u);
    if (density === "cozy" && ch !== undefined) segs.push({ plain: `CH ${Math.round(ch * 100)}%`, drop: DROP_CH });
    if (density === "cozy") segs.push({ plain: `$${u.cost.toFixed(4)}`, drop: DROP_COST });
  }
  return segs;
}

/**
 * parallel Run Card: 聚合行 + 逐 child 双行树形 (状态行 + recent 明细行), pending 预建行.
 * 聚合总览 (done/total/elapsed/合计 tokens/cost/CH) 常驻, 按 §4.0 顺序窄行省略.
 */
export function renderParallelLines(root: RunNode, children: RunNode[], width: number, opts: { density: CardDensity; expanded?: boolean }): string[] {
  const lines: string[] = [renderSegLine(parallelAggRow(root, children, opts.density), width)];
  for (const c of children) {
    if (c.status === "pending") {
      lines.push(pendingLine(c, INDENT_C, width));
      continue;
    }
    lines.push(INDENT_C + renderSegLine(statusRowSegs(c, opts.density, false), Math.max(8, width - dispLen(INDENT_C))));
    lines.push(...detailLines(c, width, INDENT_CC, opts.expanded ?? false));
  }
  lines.push(INDENT_C + HINT);
  return lines;
}

// ---------------------------------------------------------------------------
// 组件层: RunCardComponent + spinner (90ms invalidate 驱动重绘, settled 即停, 帧未变不重绘)
// ---------------------------------------------------------------------------

interface CardRenderOptions {
  density?: CardDensity;
  expanded?: boolean;
  animate?: boolean;
}

let cardInvalidator: (() => void) | null = null;
let cardTimer: ReturnType<typeof setInterval> | null = null;
let lastFrameIdx = -1;

function frameIndexAt(now: number): number {
  return Math.floor(now / SPINNER_MS) % SPINNER_FRAMES.length;
}

/** 注册最新卡渲染上下文为 active spinner invalidator; 90ms 驱动一次重绘 (帧未变跳过, 防闪烁). */
export function startRunCardSpinner(invalidate: () => void): void {
  cardInvalidator = invalidate; // 同一张卡的历次 render 上下文只留最新
  if (cardTimer) return;
  cardTimer = setInterval(() => {
    const inv = cardInvalidator;
    if (!inv) {
      if (cardTimer) {
        clearInterval(cardTimer);
        cardTimer = null;
      }
      return;
    }
    const idx = frameIndexAt(Date.now());
    if (idx === lastFrameIdx) return; // 帧未变, 内容不变不重绘
    lastFrameIdx = idx;
    try {
      inv();
    } catch {
      cardInvalidator = null; // 失效上下文, 下轮停表
    }
  }, SPINNER_MS);
  cardTimer.unref?.();
}

/** settled (终态) 即停: 清 invalidator + 停表. */
export function stopRunCardSpinner(): void {
  cardInvalidator = null;
  if (cardTimer) {
    clearInterval(cardTimer);
    cardTimer = null;
  }
}

/** 是否有仍在转的 active/pending 节点 (终态判据). */
export function isRunCardSettled(nodes: RunNode[]): boolean {
  return nodes.every((n) => isTerminal(n.status));
}

/** 组件: build(width) → 行数组; active 行把 ⠿ 占位替换成当前 spinner 帧 (时间驱动). */
export class RunCardComponent implements Component {
  private build: (width: number) => string[];
  private animated: boolean;
  constructor(build: (width: number) => string[], animated: boolean) {
    this.build = build;
    this.animated = animated;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const w = width > 0 ? width : Math.max(40, process.stdout.columns || 80);
    // 兜底: 每行最终截断到终端宽度 (pi-tui 对超宽行会直接 uncaughtException 退出).
    const lines = this.build(w).map((l) => truncate(l, w));
    if (!this.animated) return lines;
    const frame = SPINNER_FRAMES[frameIndexAt(Date.now())];
    return lines.map((l) => (l.includes("⠿") ? l.split("⠿").join(frame) : l));
  }
}

/** Run Card 组件入口: 投影节点 → 纯函数行 → 组件; 未 settle 注册 spinner, settle 即停. */
export function renderRunCard(nodes: RunNode[], opts: CardRenderOptions = {}, context?: { invalidate?: () => void }): Component {
  const density: CardDensity = opts.density ?? "cozy";
  const expanded = opts.expanded ?? false;
  const animate = opts.animate ?? true;
  const root = nodes.find((n) => n.kind === "parallel-root");
  const children = root ? nodes.filter((n) => n.kind === "parallel-child") : [];
  const single = root ? nodes.find((n) => n.kind !== "parallel-root" && n.kind !== "parallel-child") : nodes[0];
  const build = (width: number): string[] => {
    if (root) return renderParallelLines(root, children, width, { density, expanded });
    if (single) return renderRunNodeLines(single, width, { density, expanded });
    return [];
  };
  const settled = isRunCardSettled(nodes);
  if (settled) stopRunCardSpinner();
  else if (animate && context?.invalidate) startRunCardSpinner(context.invalidate);
  const hasActive = nodes.some((n) => n.status === "active");
  return new RunCardComponent(build, hasActive && animate);
}