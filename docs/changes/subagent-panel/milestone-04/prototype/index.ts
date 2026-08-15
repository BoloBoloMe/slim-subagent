/**
 * subagent-panel-proto — M04 Inline Run Card 原型 (基于 M03 骨架)
 *
 * 注册:
 *   - 假工具 `subagent_proto` {mode:"single"|"parallel", scenario?}
 *     execute 按真实触发点分布定时 onUpdate, details=ProtoDetails 全量快照
 *   - 命令 `/subagent-proto` (single/parallel/storm/parallel-pending 回放;
 *     variant a|b|c 变体切换; density compact|cozy 密度切换; status)
 *   - JSONL 日志 (replay.log, PI_SUBAGENT_PROTO_LOG 可覆盖), MARKER=proto-v1
 *
 * 渲染 (M04 考察点):
 *   renderCall  = 调用摘要行 (含 [proto] mode=... 标记)
 *   renderResult = Inline Run Card 三变体:
 *     A PRD 双行卡   B 单行致密 (PRD §4.0 窄行省略)   C 分段展开 (recentTools/last output)
 *   图标 ⠿(active) ◐(parallel root) ✓(done) ✗(failed) ◌(pending), 主题语义色.
 *   宽度: Component.render(width) 传入真实可用宽度, 兜底 process.stdout.columns.
 */
import type { Component } from "@earendil-works/pi-tui";
import { Box, Text } from "@earendil-works/pi-tui";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createReplay, getLogFile, logEvent, MARKER } from "./replay.ts";
import type { ProtoDetails, ProtoRunNode } from "./types.ts";

// ---------------------------------------------------------------------------
// 顶层热载标记 (moduleCache:false 重导入 → 新 marker 落盘)
// ---------------------------------------------------------------------------
try {
  logEvent({ event: "ext.loaded", pid: process.pid, ts: Date.now(), logFile: getLogFile() });
} catch {
  /* best-effort */
}

// ---------------------------------------------------------------------------
// M04 变体/密度模块级状态
// ---------------------------------------------------------------------------
type VariantId = "a" | "b" | "c";
type Density = "compact" | "cozy";
let currentVariant: VariantId = "a";
let currentDensity: Density = "cozy";

const VARIANT_NAMES: Record<VariantId, string> = {
  a: "PRD 双行卡",
  b: "单行致密",
  c: "分段展开",
};

// ---------------------------------------------------------------------------
// 通用工具函数
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 显示宽度: 全角字符记 2 列 */
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

function fmtT(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function elapsedStr(node: ProtoRunNode, now: number): string {
  const start = node.startedAtMs;
  if (start === undefined) return "";
  const end = node.endedAtMs ?? now;
  const s = Math.max(0, Math.floor((end - start) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function ctxStr(node: ProtoRunNode): string {
  if (node.contextPercent === undefined || node.contextPercent === null) return "ctx —";
  return `ctx ${node.contextPercent}%`;
}

function statusOf(node: ProtoRunNode): { icon: string; label: string; color: string } {
  switch (node.status) {
    case "active": return { icon: "⠿", label: "active", color: "accent" };
    case "done": return { icon: "✓", label: "done", color: "success" };
    case "failed": return { icon: "✗", label: "failed", color: "error" };
    case "timeout": return { icon: "✗", label: "timeout", color: "warning" };
    case "budget": return { icon: "✗", label: "budget", color: "warning" };
    case "cancelled": return { icon: "✗", label: "cancelled", color: "warning" };
    case "pending": return { icon: "◌", label: "pending 等待并发槽", color: "muted" };
    default: return { icon: "⠿", label: node.status, color: "muted" };
  }
}

interface Seg {
  plain: string;
  color: string;
  drop?: number; // 窄行省略优先级: 值越小越先丢; undefined=必留
}

function usageSegs(node: ProtoRunNode): { tokens: Seg; cost: Seg } | null {
  const u = node.usage;
  if (!u) return null;
  let tokens = `↑${fmtT(u.input)} ↓${fmtT(u.output)}`;
  if (u.cacheRead > 0) tokens += ` R${fmtT(u.cacheRead)}`;
  if (u.cacheWrite > 0) tokens += ` W${fmtT(u.cacheWrite)}`;
  return {
    tokens: { plain: tokens, color: "text", drop: 5 },
    cost: { plain: `$${u.cost.toFixed(4)}`, color: "muted", drop: 0 },
  };
}

function timeoutSeg(node: ProtoRunNode): Seg | null {
  if (node.timeoutMsExplicit === undefined) return null;
  return { plain: `timeout ${node.timeoutMsExplicit / 1000}s`, color: "muted", drop: 2 };
}

function capSeg(node: ProtoRunNode): Seg | null {
  if (node.usageBudgetExplicit === undefined) return null;
  return { plain: `cap ${fmtT(node.usageBudgetExplicit)}`, color: "muted", drop: 1 };
}

function stopSeg(node: ProtoRunNode): Seg | null {
  if (!node.stopReason || node.status === "done" || node.status === "active") return null;
  return { plain: `stop ${node.stopReason}`, color: "warning", drop: -1 };
}

/** PRD §4.0 窄行省略: 按优先级丢 cost→cap→timeout→recent→task→usageTokens, 保留 status/model/ctx/elapsed */
function renderSegLine(segs: Seg[], theme: ThemeLike, maxWidth: number): string {
  const active = segs.filter((s) => s.plain.length > 0);
  let total = active.reduce((a, s) => a + dispLen(s.plain), 0) + (active.length - 1) * 3;
  while (total > maxWidth) {
    let idx = -1;
    let bestDrop = Infinity;
    for (let i = 0; i < active.length; i++) {
      const s = active[i];
      if (s.drop === undefined) continue;
      if (s.drop < bestDrop) {
        bestDrop = s.drop;
        idx = i;
      } else if (s.drop === bestDrop) {
        idx = i; // 同优先级取最右
      }
    }
    if (idx === -1) break;
    active.splice(idx, 1);
    total = active.reduce((a, s) => a + dispLen(s.plain), 0) + (active.length - 1) * 3;
  }
  if (active.length === 0) return "";
  if (total > maxWidth && active.length > 0) {
    const others = active.slice(0, -1).reduce((a, s) => a + dispLen(s.plain), 0) + (active.length - 1) * 3;
    const last = active[active.length - 1];
    last.plain = truncate(last.plain, maxWidth - others);
  }
  return active.map((s) => theme.fg(s.color as any, s.plain)).join(theme.fg("muted", " · "));
}

function pendingLine(node: ProtoRunNode, theme: ThemeLike, indent: string, width: number): string {
  return indent + theme.fg("muted", `◌ ${node.agent} · pending 等待并发槽 · task ${truncate(node.taskPreview, Math.max(8, width - dispLen(indent) - 2))}`);
}

function opsHint(node: ProtoRunNode, theme: ThemeLike): string {
  const failed = node.status === "failed" || node.status === "timeout" || node.status === "budget";
  if (node.kind === "parallel-child" && node.status !== "done" && !failed) return theme.fg("dim", "[Open session]");
  if (failed) return theme.fg("dim", "[Open session] [Copy resume cmd] [Diagnose]");
  if (node.kind === "parallel-child") return theme.fg("dim", "[Open session]");
  return theme.fg("dim", "[Open session] [Copy runId] [Diagnose]");
}

function recentLine(node: ProtoRunNode, theme: ThemeLike, indent: string, width: number): string {
  const segs: string[] = [];
  const rt = node.progress?.recentTools ?? [];
  if (rt.length > 0) segs.push(`recent: ${rt.map((t) => `${t.tool} ${t.argsPreview}`).join(" · ")}`);
  const out = node.progress?.recentOutput ?? [];
  if (out.length > 0) segs.push(`last: "${truncate(out[out.length - 1], 40)}"`);
  if (segs.length === 0) return "";
  const line = `task ${node.taskPreview}` + (segs.length > 0 ? ` · ${segs.join(" · ")}` : "");
  return indent + theme.fg("text", truncate(line, Math.max(8, width - dispLen(indent))));
}

// ---------------------------------------------------------------------------
// 变体 A: PRD 双行卡 (§4.1 样例原样)
// ---------------------------------------------------------------------------
function statusRowSegs(node: ProtoRunNode, theme: ThemeLike, density: Density): Seg[] {
  const st = statusOf(node);
  const now = Date.now();
  const segs: Seg[] = [
    { plain: `${st.icon} ${node.agent}`, color: st.color },
    { plain: [st.label, elapsedStr(node, now)].filter(Boolean).join(" "), color: st.color },
    { plain: `model ${node.model ?? "—"}`, color: "text" },
    { plain: ctxStr(node), color: "text" },
  ];
  const us = usageSegs(node);
  if (us) {
    segs.push(us.tokens);
    if (density === "cozy") segs.push(us.cost);
  }
  const stop = stopSeg(node);
  if (stop && density === "cozy") segs.push(stop);
  const t = timeoutSeg(node);
  if (t && density === "cozy") segs.push(t);
  const c = capSeg(node);
  if (c && density === "cozy") segs.push(c);
  return segs;
}

function aSingleCard(details: ProtoDetails, theme: ThemeLike, width: number, density: Density): string[] {
  const node = details.nodes[0];
  const lines: string[] = [renderSegLine(statusRowSegs(node, theme, density), theme, width)];
  const recent = recentLine(node, theme, "   ", width);
  if (recent) lines.push(recent);
  lines.push("   " + opsHint(node, theme));
  return lines;
}

function aChildLine(child: ProtoRunNode, theme: ThemeLike, width: number, density: Density): string {
  if (child.status === "pending") return pendingLine(child, theme, "   ", width);
  const st = statusOf(child);
  const now = Date.now();
  const segs: Seg[] = [
    { plain: `${st.icon} ${child.agent}`, color: st.color },
    { plain: [st.label, elapsedStr(child, now)].filter(Boolean).join(" "), color: st.color },
    { plain: `model ${child.model ?? "—"}`, color: "text" },
    { plain: ctxStr(child), color: "text" },
  ];
  const us = usageSegs(child);
  if (us) {
    segs.push(us.tokens);
    if (density === "cozy") segs.push(us.cost);
  }
  const stop = stopSeg(child);
  if (stop && density === "cozy") segs.push(stop);
  const t = timeoutSeg(child);
  if (t && density === "cozy") segs.push(t);
  const c = capSeg(child);
  if (c && density === "cozy") segs.push(c);
  segs.push({ plain: opsHint(child, theme).replace(/\x1b\[[0-9;]*m/g, ""), color: "dim", drop: -2 });
  return "   " + renderSegLine(segs, theme, Math.max(8, width - 3));
}

function aParallelCard(details: ProtoDetails, theme: ThemeLike, width: number, density: Density): string[] {
  const root = details.nodes[0];
  const b = details.batch;
  const now = Date.now();
  const st = statusOf(root);
  const segs: Seg[] = [
    { plain: `◐ parallel`, color: "accent" },
    { plain: `${b?.done ?? 0}/${b?.total ?? 0} done`, color: "text" },
    { plain: [st.label, elapsedStr(root, now)].filter(Boolean).join(" "), color: st.color },
  ];
  if (details.usage) {
    const u = details.usage;
    let tokens = `total ↑${fmtT(u.input)} ↓${fmtT(u.output)}`;
    if (u.cacheWrite > 0) tokens += ` W${fmtT(u.cacheWrite)}`;
    segs.push({ plain: tokens, color: "text" });
    if (density === "cozy") segs.push({ plain: `$${u.cost.toFixed(4)}`, color: "muted" });
  }
  const lines: string[] = [renderSegLine(segs, theme, width)];
  for (const child of details.nodes.slice(1)) lines.push(aChildLine(child, theme, width, density));
  return lines;
}

// ---------------------------------------------------------------------------
// 变体 B: 单行致密 (严格 §4.0 窄行省略)
// ---------------------------------------------------------------------------
function bNodeSegs(node: ProtoRunNode, theme: ThemeLike, density: Density): Seg[] {
  const st = statusOf(node);
  const now = Date.now();
  const segs: Seg[] = [
    { plain: `${st.icon} ${node.agent}`, color: st.color },
    { plain: [st.label, elapsedStr(node, now)].filter(Boolean).join(" "), color: st.color },
    { plain: `model ${node.model ?? "—"}`, color: "text" },
    { plain: ctxStr(node), color: "text" },
  ];
  const us = usageSegs(node);
  if (us) {
    segs.push(us.tokens);
    if (density === "cozy") segs.push(us.cost);
  }
  const rt = node.progress?.recentTools ?? [];
  const out = node.progress?.recentOutput ?? [];
  if (density === "cozy") {
    // recent 压缩为尾段单片段
    let recent = "";
    if (rt.length > 0) recent = `last: ${rt[rt.length - 1].tool} ${rt[rt.length - 1].argsPreview}`;
    else if (out.length > 0) recent = `last: "${out[out.length - 1]}"`;
    if (recent) segs.push({ plain: recent, color: "dim", drop: 3 });
    segs.push({ plain: `task ${truncate(node.taskPreview, 30)}`, color: "text", drop: 4 });
    const t = timeoutSeg(node);
    if (t) segs.push(t);
    const c = capSeg(node);
    if (c) segs.push(c);
  } else {
    // compact: 预省略 recent (B 专属) + cost/cap/timeout
    segs.push({ plain: `task ${truncate(node.taskPreview, 30)}`, color: "text", drop: 4 });
  }
  return segs;
}

function bCard(details: ProtoDetails, theme: ThemeLike, width: number, density: Density): string[] {
  const lines: string[] = [];
  if (details.mode === "single") {
    const node = details.nodes[0];
    lines.push(renderSegLine(bNodeSegs(node, theme, density), theme, width));
  } else {
    const root = details.nodes[0];
    const b = details.batch;
    const now = Date.now();
    const st = statusOf(root);
    const segs: Seg[] = [
      { plain: `◐ parallel`, color: "accent" },
      { plain: `${b?.done ?? 0}/${b?.total ?? 0} done`, color: "text" },
      { plain: [st.label, elapsedStr(root, now)].filter(Boolean).join(" "), color: st.color },
    ];
    if (details.usage) {
      const u = details.usage;
      let tokens = `total ↑${fmtT(u.input)} ↓${fmtT(u.output)}`;
      if (u.cacheWrite > 0) tokens += ` W${fmtT(u.cacheWrite)}`;
      segs.push({ plain: tokens, color: "text" });
      if (density === "cozy") segs.push({ plain: `$${u.cost.toFixed(4)}`, color: "muted" });
    }
    lines.push(renderSegLine(segs, theme, width));
    for (const child of details.nodes.slice(1)) {
      if (child.status === "pending") {
        lines.push(pendingLine(child, theme, "   ", width));
      } else {
        lines.push("   " + renderSegLine(bNodeSegs(child, theme, density), theme, Math.max(8, width - 3)));
      }
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 变体 C: 分段展开 (摘要 + recentTools 最近 3 条 + last output)
// ---------------------------------------------------------------------------
function cCard(details: ProtoDetails, theme: ThemeLike, width: number, density: Density, expanded: boolean): string[] {
  const lines: string[] = [];
  if (details.mode === "single") {
    const node = details.nodes[0];
    lines.push(renderSegLine(statusRowSegs(node, theme, density), theme, width));
    lines.push(...cDetailLines(node, theme, width, "   ", expanded));
  } else {
    const root = details.nodes[0];
    const b = details.batch;
    const now = Date.now();
    const st = statusOf(root);
    const segs: Seg[] = [
      { plain: `◐ parallel`, color: "accent" },
      { plain: `${b?.done ?? 0}/${b?.total ?? 0} done`, color: "text" },
      { plain: [st.label, elapsedStr(root, now)].filter(Boolean).join(" "), color: st.color },
    ];
    if (details.usage) {
      const u = details.usage;
      let tokens = `total ↑${fmtT(u.input)} ↓${fmtT(u.output)}`;
      if (u.cacheWrite > 0) tokens += ` W${fmtT(u.cacheWrite)}`;
      segs.push({ plain: tokens, color: "text" });
      if (density === "cozy") segs.push({ plain: `$${u.cost.toFixed(4)}`, color: "muted" });
    }
    lines.push(renderSegLine(segs, theme, width));
    for (const child of details.nodes.slice(1)) {
      if (child.status === "pending") {
        lines.push(pendingLine(child, theme, "   ", width));
        continue;
      }
      lines.push("   " + renderSegLine(bNodeSegs(child, theme, density), theme, Math.max(8, width - 3)));
      const sub = cDetailLines(child, theme, width, "     ", false);
      for (const l of sub) lines.push(l);
    }
  }
  return lines;
}

function cDetailLines(node: ProtoRunNode, theme: ThemeLike, width: number, indent: string, expanded: boolean): string[] {
  const lines: string[] = [];
  const rt = node.progress?.recentTools ?? [];
  const limit = expanded ? Math.min(rt.length, 10) : Math.min(rt.length, 3);
  const start = Math.max(0, rt.length - limit);
  for (let i = start; i < rt.length; i++) {
    const t = rt[i];
    lines.push(indent + theme.fg("muted", "→ ") + theme.fg("toolOutput", truncate(`${t.tool} ${t.argsPreview}`, Math.max(8, width - dispLen(indent) - 2))));
  }
  const out = node.progress?.recentOutput ?? [];
  if (out.length > 0) {
    lines.push(indent + theme.fg("muted", "last: ") + theme.fg("toolOutput", `"${truncate(out[out.length - 1], Math.max(8, width - dispLen(indent) - 8))}"`));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 渲染入口
// ---------------------------------------------------------------------------
interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

class RunCardComponent implements Component {
  private build: (width: number) => string[];
  constructor(build: (width: number) => string[]) {
    this.build = build;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const w = width > 0 ? width : (process.stdout.columns || 80);
    return this.build(w);
  }
}

function renderCard(details: ProtoDetails, theme: ThemeLike, width: number, expanded: boolean): string[] {
  const v = currentVariant;
  const d = currentDensity;
  if (v === "b") return bCard(details, theme, width, d);
  if (v === "c") return cCard(details, theme, width, d, expanded);
  return details.mode === "parallel" ? aParallelCard(details, theme, width, d) : aSingleCard(details, theme, width, d);
}

function callCard(args: { mode: string; scenario?: string }, theme: ThemeLike, width: number): string[] {
  const mode = args.mode === "parallel" ? "parallel" : "single";
  const scenario = args.scenario || "success";
  const header = theme.fg("toolTitle", theme.bold("subagent_proto ")) + theme.fg("muted", `[proto] mode=${mode} scenario=${scenario}`);
  const state =
    mode === "single"
      ? theme.fg("accent", "⠿ explorer · active · running")
      : theme.fg("accent", "◐ parallel · batch · running");
  return [truncate(header, width), truncate(state, width)];
}

// ---------------------------------------------------------------------------
// 工具参数与执行
// ---------------------------------------------------------------------------
const PARAMS = Type.Object({
  mode: Type.Union([Type.Literal("single"), Type.Literal("parallel")], { description: "回放模式" }),
  scenario: Type.Optional(Type.String({ description: "场景: success/failed/timeout/storm/parallel-pending" })),
});

async function runReplaySteps(
  mode: "single" | "parallel",
  scenario: string,
  source: "command" | "tool",
  startedAtMs: number,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<ProtoDetails> | undefined,
): Promise<ProtoDetails> {
  const replay = createReplay(mode, scenario);
  const base = Date.now();
  let current = replay.buildDetails(0, startedAtMs);
  for (let i = 0; i < replay.steps.length; i++) {
    const step = replay.steps[i];
    const wait = base + step.atMs - Date.now();
    if (wait > 0) await sleep(wait);
    if (signal?.aborted) {
      logEvent({ event: "replay.aborted", source, mode, scenario, stepIndex: i, ts: Date.now() });
      break;
    }
    current = replay.buildDetails(i, startedAtMs);
    logEvent({
      event: "replay.step",
      source,
      mode,
      scenario,
      stepIndex: i,
      kind: step.kind,
      atMs: step.atMs,
      ts: Date.now(),
      text: step.text,
      statuses: current.nodes.map((n) => n.status),
    });
    if (source === "tool" && onUpdate) {
      onUpdate({ content: [{ type: "text", text: step.text }], details: current });
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------
export default function subagentPanelProto(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_proto",    label: "subagent_proto (fake replay)",
    description: "subagent-panel 原型假工具: 按真实触发点分布回放 single/parallel 子代理运行, 走 onUpdate 管线. 参数 mode=single|parallel, 可选 scenario=success|failed|timeout|storm|parallel-pending.",
    promptSnippet: "subagent_proto 假工具: 回放子代理运行时序, 用于 UI 原型验证",
    parameters: PARAMS,
    async execute(toolCallId: string, params, signal, onUpdate) {
      const mode: "single" | "parallel" = params.mode;
      const scenario = params.scenario || "success";
      const startedAtMs = Date.now();
      const details = await runReplaySteps(mode, scenario, "tool", startedAtMs, signal, onUpdate);
      const summary =
        details.mode === "single"
          ? `[proto] ${details.nodes[0].agent}:${details.nodes[0].status}`
          : `[proto] parallel ${details.batch?.done ?? 0}/${details.batch?.total ?? 0} done`;
      return {
        content: [{ type: "text", text: `subagent_proto 回放完成: ${summary}` }],
        details,
      };
    },
    renderCall(args, theme) {
      return new RunCardComponent((w) => callCard(args, theme, w));
    },
    renderResult(result, options, theme) {
      const details = result.details as ProtoDetails | undefined;
      if (!details || !Array.isArray(details.nodes) || details.nodes.length === 0) {
        return new Text(theme.fg("muted", "(no run data)"), 0, 0);
      }
      return new RunCardComponent((w) => renderCard(details, theme, w, options.expanded));
    },
  });

  // 命令路径确定性渲染帧 (M04 证据用): /subagent-proto render [variant] [mode] [scenario] [step]
  pi.registerMessageRenderer("subagent-proto-card", (message, { expanded, outputPad }, theme) => {
    const details = message.details as ProtoDetails | undefined;
    if (!details || !Array.isArray(details.nodes) || details.nodes.length === 0) return undefined;
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    if (typeof message.content === "string" && message.content.startsWith("[proto render]")) {
      box.addChild(new Text(theme.fg("dim", message.content), 0, 0));
    }
    box.addChild(new RunCardComponent((w) => renderCard(details, theme, w, expanded)));
    return box;
  });

  pi.registerCommand("subagent-proto", {
    description: "subagent-panel proto: single|parallel|storm|parallel-pending 回放; variant a|b|c; density compact|cozy; status",
    getArgumentCompletions: (prefix: string) => {
      const opts = [
        "single", "single failed", "single timeout", "parallel", "storm", "parallel-pending",
        "variant a", "variant b", "variant c",
        "density compact", "density cozy", "status",
      ];
      return opts.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const cmd = parts[0];
      const rest = parts.slice(1).join(" ");

      if (cmd === "render") {
        // render [variant a|b|c] [mode single|parallel] [scenario] [step]
        const tokens = parts.slice(1);
        let variant = currentVariant;
        let mode: "single" | "parallel" = "single";
        let scenario = "success";
        let step: number | undefined;
        let ti = 0;
        if (tokens[ti] === "a" || tokens[ti] === "b" || tokens[ti] === "c") {
          variant = tokens[ti] as VariantId;
          ti++;
        }
        if (tokens[ti] === "single" || tokens[ti] === "parallel") {
          mode = tokens[ti] as "single" | "parallel";
          ti++;
        }
        if (tokens[ti] !== undefined && !/^\d+$/.test(tokens[ti])) {
          scenario = tokens[ti];
          ti++;
        }
        if (tokens[ti] !== undefined && /^\d+$/.test(tokens[ti])) step = parseInt(tokens[ti], 10);
        currentVariant = variant;
        const replay = createReplay(mode, scenario);
        const idx = step === undefined ? replay.steps.length - 1 : Math.min(step, replay.steps.length - 1);
        const details = replay.buildDetails(idx, Date.now());
        const tag = `[proto render] ${variant} ${mode}/${scenario} step=${idx}`;
        pi.sendMessage({
          customType: "subagent-proto-card",
          content: tag,
          display: true,
          details,
        });
        ctx.ui.notify(`render ok v${variant} ${mode}/${scenario} step=${idx}`, "info");
        return;
      }

      if (cmd === "variant") {
        const id = (rest || "a").normalize("NFKC").trim().toLowerCase().replace(/[^a-z]/g, "") as VariantId;
        if (id !== "a" && id !== "b" && id !== "c") {
          ctx.ui.notify("variant 需为 a|b|c", "warning");
          return;
        }
        currentVariant = id;
        ctx.ui.notify(`Run Card variant → ${id} (${VARIANT_NAMES[id]}) · density=${currentDensity}`, "info");
        return;
      }
      if (cmd === "density") {
        const d = (rest || "cozy").normalize("NFKC").trim().toLowerCase().replace(/[^a-z]/g, "") as Density;
        if (d !== "compact" && d !== "cozy") {
          ctx.ui.notify("density 需为 compact|cozy", "warning");
          return;
        }
        currentDensity = d;
        ctx.ui.notify(`Run Card density → ${d} · variant=${currentVariant}`, "info");
        return;
      }
      if (cmd === "status") {
        ctx.ui.notify(`variant=${currentVariant} (${VARIANT_NAMES[currentVariant]}) density=${currentDensity} marker=${MARKER}`, "info");
        return;
      }

      // 回放命令
      let mode: "single" | "parallel";
      let scenario: string;
      if (cmd === "parallel" || cmd === "parallel-pending") {
        mode = "parallel";
        scenario = cmd === "parallel-pending" ? "parallel-pending" : rest || "success";
      } else if (cmd === "storm") {
        mode = "single";
        scenario = "storm";
      } else if (cmd === "single") {
        mode = "single";
        scenario = rest || "success";
      } else {
        ctx.ui.notify("用法: /subagent-proto single|parallel|storm|parallel-pending | variant a|b|c | density compact|cozy", "warning");
        return;
      }

      const startedAtMs = Date.now();
      const details = await runReplaySteps(mode, scenario, "command", startedAtMs, undefined, undefined);
      const done = details.mode === "single" ? details.nodes[0].status : `${details.batch?.done ?? 0}/${details.batch?.total ?? 0} done`;
      ctx.ui.notify(`replay done: ${mode}/${scenario} ${details.nodes.length} nodes · ${done}`, "info");
    },
  });
}
