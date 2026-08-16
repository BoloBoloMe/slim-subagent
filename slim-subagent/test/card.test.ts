// ISSUE-05 Run Card TDD (PRD §4.0/§4.1 + M07 D001-D005/D008): card.ts 纯函数层接缝.
// TS-001: 窄行省略顺序 cost→CH→cap→timeout→recent→taskPreview→usage (D003), status/model/ctx/elapsed 死保.
// TS-002: parallel 聚合行 + pending 预建行 (无 model/ctx/elapsed/usage, D008) + child 双行树形.
// TS-003: computeCh — cacheRead 无数据不显; cacheRead>0 → cacheRead/(cacheRead+input) (D004).
// 纯函数层不依赖 pi-tui; spinner/重绘属组件层 (90ms invalidate), 人工冒烟验证.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRunNodeLines, renderParallelLines, computeCh, formatStatusIcon } from "../card.ts";
import type { RunNode } from "../projection.ts";

// ---- fixture: active single (cozy 全字段) ----

function activeSingle(): RunNode {
  return {
    id: "run-1",
    kind: "single",
    agent: "explorer",
    taskPreview: "收集测试用例并报告发现",
    status: "active",
    startedAtMs: Date.now() - 37_000,
    usage: { input: 12100, output: 3400, cacheRead: 88000, cacheWrite: 800, cost: 0.0412, turns: 5 },
    model: "openai/x",
    modelSource: "call-params",
    timeoutMsExplicit: 300_000,
    usageBudgetExplicit: 50_000,
    contextPercent: 18,
    progress: {
      recentTools: [{ tool: "read", argsPreview: "src/index.ts", endMs: 1 }],
      recentOutput: ["找到 3 个候选入口…"],
    },
  };
}

// 在宽度区间内找某标记首次出现的最低宽度 (阈值 = 窄于此即消失): 升序扫描保证单调.
function presenceWidth(marker: string, widths: number[]): number {
  for (const w of widths) {
    const lines = renderRunNodeLines(activeSingle(), w, { density: "cozy" });
    if (lines[0].includes(marker)) return w;
  }
  return Infinity;
}

// ---- TS-001: §4.0 窄行省略顺序 ----

test("TS-001 narrow width drops optional fields in cost→CH→cap→timeout→recent→task→usage order", () => {
  const widths: number[] = [];
  for (let w = 16; w <= 240; w += 1) widths.push(w);
  const wCost = presenceWidth("$0.0412", widths);
  const wCh = presenceWidth("CH 88%", widths);
  const wCap = presenceWidth("cap 50k", widths);
  const wTimeout = presenceWidth("timeout 300s", widths);
  const wRecent = presenceWidth("recent:", widths);
  const wTask = presenceWidth("task 收集", widths);
  const wUsage = presenceWidth("↑12.1k", widths);
  assert.ok(Number.isFinite(wCost) && wCost > 0, "cost 应在足够宽时出现");
  assert.ok(
    wCost > wCh && wCh > wCap && wCap > wTimeout && wTimeout > wRecent && wRecent > wTask && wTask > wUsage,
    `省略顺序应 cost→CH→cap→timeout→recent→task→usage (阈值递减), 实测 [${wCost},${wCh},${wCap},${wTimeout},${wRecent},${wTask},${wUsage}]`,
  );
});

test("TS-001 status/model/ctx/elapsed survive after all optional fields dropped", () => {
  // usage 刚出现的最低宽度附近, 四必显字段应完整存在 (未被截断).
  const widths: number[] = [];
  for (let w = 16; w <= 240; w += 1) widths.push(w);
  const wUsage = presenceWidth("↑12.1k", widths);
  const line = renderRunNodeLines(activeSingle(), wUsage, { density: "cozy" })[0];
  assert.ok(line.includes("⠿ explorer"), "status icon + agent 必在");
  assert.ok(line.includes("active 00:37"), "status 文案 + elapsed 必在");
  assert.ok(line.includes("model openai/x"), "model 必在");
  assert.ok(line.includes("ctx 18%"), "ctx 必在 (有数据不省略)");
  assert.ok(!line.includes("…"), "四必显字段不得被截断");
  // 超窄宽度下 (全部可选已丢), icon+agent 仍居首 (截断只作用于行尾).
  const narrow = renderRunNodeLines(activeSingle(), 21, { density: "cozy" })[0];
  assert.ok(narrow.includes("⠿ explorer"), "超窄宽度 icon+agent 仍保留");
});

test("TS-001 single card 分段展开: recentTools ≤3 逐行 + output 预览 + 卡尾提示", () => {
  const lines = renderRunNodeLines(activeSingle(), 200, { density: "cozy" });
  assert.ok(lines.some((l) => l.includes("→ read src/index.ts")), "recentTools 逐条行");
  assert.ok(lines.some((l) => l.includes('last: "找到 3 个候选入口…"')), "output 预览行");
  assert.ok(lines[lines.length - 1].includes("alt+v 会话 · /agent-diagnose 诊断"), "卡尾固定提示文案");
});

test("TS-001 compact density 预省 cost/CH/cap/timeout, 保留状态/usage", () => {
  const node = activeSingle();
  const line = renderRunNodeLines(node, 200, { density: "compact" })[0];
  assert.ok(!line.includes("$0.0412"), "compact 无 cost");
  assert.ok(!line.includes("CH"), "compact 无 CH");
  assert.ok(!line.includes("cap 50k"), "compact 无 cap");
  assert.ok(!line.includes("timeout 300s"), "compact 无 timeout");
  assert.ok(line.includes("↑12.1k"), "compact 仍显示 usage tokens");
  assert.ok(line.includes("ctx 18%"), "compact 仍显 ctx");
});

// ---- TS-002: parallel 聚合 + pending 预建行 + child 双行树形 ----

function parallelFixture() {
  const now = Date.now();
  const root: RunNode = {
    id: "run-batch",
    kind: "parallel-root",
    agent: "parallel",
    taskPreview: "",
    status: "active",
    startedAtMs: now - 72_000,
    progress: { done: 2, total: 4 },
  };
  const children: RunNode[] = [
    {
      id: "run-batch#0",
      kind: "parallel-child",
      parentId: "run-batch",
      agent: "worker",
      taskPreview: "pnpm lint",
      status: "done",
      startedAtMs: now - 75_000,
      endedAtMs: now - 38_000,
      usage: { input: 8100, output: 2000, cacheRead: 0, cacheWrite: 500, cost: 0.01, turns: 1 },
      model: "a/fast",
      contextPercent: 12,
      progress: { recentTools: [{ tool: "bash", argsPreview: "pnpm lint", endMs: 1 }] },
    },
    {
      id: "run-batch#1",
      kind: "parallel-child",
      parentId: "run-batch",
      agent: "reviewer",
      taskPreview: "审查改动",
      status: "failed",
      isError: true,
      startedAtMs: now - 102_000,
      endedAtMs: now - 51_000,
      stopReason: "error",
      usage: { input: 20000, output: 5000, cacheRead: 0, cacheWrite: 0, cost: 0.03, turns: 2 },
      model: "b/pro",
      contextPercent: 31,
      usageBudgetExplicit: 80_000,
    },
    {
      id: "run-batch#2",
      kind: "parallel-child",
      parentId: "run-batch",
      agent: "worker",
      taskPreview: "读 src 结构",
      status: "active",
      model: "a/fast",
      contextPercent: null,
      timeoutMsExplicit: 300_000,
      progress: { recentTools: [{ tool: "read", argsPreview: "src/", endMs: 1 }] },
    },
    {
      id: "run-batch#3",
      kind: "parallel-child",
      parentId: "run-batch",
      agent: "explorer",
      taskPreview: "收集测试用例",
      status: "pending",
    },
  ];
  return { root, children };
}

test("TS-002 aggregate row + pending prebuilt row + child double-line tree", () => {
  const { root, children } = parallelFixture();
  const lines = renderParallelLines(root, children, 200, { density: "cozy" });
  // 聚合行: ◐ parallel + done/total + status/elapsed + total tokens + cost (CH 无 cacheRead 不显).
  assert.ok(lines[0].includes("◐ parallel"), "聚合行 ◐ parallel");
  assert.ok(lines[0].includes("2/4 done"), "聚合行 2/4 done");
  assert.ok(lines[0].includes("active 01:12"), "聚合行 status + elapsed");
  assert.ok(lines[0].includes("total ↑28.1k"), "聚合行合计 tokens (从 child usage 汇总)");
  assert.ok(lines[0].includes("$0.0400"), "聚合行合计 cost");
  assert.ok(!lines[0].includes("CH"), "根无 cacheRead → 聚合行不显 CH (不伪造)");
  // pending 预建行: 只 agent + taskPreview + pending 等待并发槽, 无 model/ctx/elapsed/usage.
  const pendingLine = lines.find((l) => l.includes("pending 等待并发槽"));
  assert.ok(pendingLine, "存在 pending 行");
  assert.ok(pendingLine!.includes("◌ explorer"), "pending 行含 ◌ + agent");
  assert.ok(pendingLine!.includes("task 收集测试用例"), "pending 行含 taskPreview");
  for (const banned of ["model", "ctx", "↑", "$", ":"]) {
    assert.ok(!pendingLine!.includes(banned), `pending 行不得含 ${banned}`);
  }
  // active child 双行树形: 状态行 + recentTools 明细行.
  const activeLine = lines.find((l) => l.includes("⠿ worker"));
  assert.ok(activeLine, "active child 状态行");
  assert.ok(activeLine!.includes("active") && activeLine!.includes("model a/fast"), "active child 无 elapsed model 有 ctx —");
  assert.ok(activeLine!.includes("ctx —") && activeLine!.includes("timeout 300s"), "ctx 未知显 —, 显式 timeout 展示");
  const idx = lines.indexOf(activeLine!);
  assert.ok(lines[idx + 1].includes("→ read src/"), "active child 第二行 = recentTools 明细");
  // done/failed child 状态行.
  assert.ok(lines.some((l) => l.includes("✓ worker") && l.includes("done 00:37")), "done child 行");
  assert.ok(lines.some((l) => l.includes("✗ reviewer") && l.includes("stop error") && l.includes("cap 80k")), "failed child 行 stop + cap");
  assert.ok(lines[lines.length - 1].includes("alt+v 会话 · /agent-diagnose 诊断"), "parallel 卡尾提示文案");
});

// ---- TS-003: computeCh ----

test("TS-003 computeCh hides without cacheRead, computes cacheRead/(cacheRead+input)", () => {
  assert.equal(computeCh(undefined), undefined, "无 usage 不显");
  assert.equal(computeCh({ input: 12000, output: 3400, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }), undefined, "cacheRead=0 不显");
  assert.equal(computeCh({ input: 12000, output: 3400, cacheRead: 88000, cacheWrite: 800, cost: 0.0412, turns: 1 }), 0.88, "cacheRead/(cacheRead+input)");
  assert.equal(computeCh({ input: 0, output: 0, cacheRead: 100, cacheWrite: 0, cost: 0, turns: 1 }), 1, "input=0 且 cacheRead>0 → 100%");
});

// ---- formatStatusIcon ----

test("formatStatusIcon maps statuses and active spinner frame", () => {
  assert.equal(formatStatusIcon("done"), "✓");
  for (const s of ["failed", "timeout", "budget", "cancelled", "attention"]) {
    assert.equal(formatStatusIcon(s), "✗", `attention 聚合 → ${s} 为 ✗`);
  }
  assert.equal(formatStatusIcon("pending"), "◌");
  assert.equal(formatStatusIcon("active"), "⠿", "无帧时 active = ⠿ 占位");
  assert.equal(formatStatusIcon("active", "⠋"), "⠋", "有帧时 active = spinner 帧");
});

// ---- 回归: 超宽行不得超出终端宽度 (pi-tui 对超宽行直接 uncaughtException) ----

function dispLen(s: string): number {
  let n = 0;
  for (const ch of Array.from(s)) {
    const cp = ch.codePointAt(0)!;
    n += cp > 0x2e7f ? 2 : 1;
  }
  return n;
}

test("all rendered lines fit within width (long task / narrow terminal)", () => {
  const longTask = "执行一个小任务并自证: 1) 用 write 工具创建临时文件 /tmp/pi-subagent-probe-alpha.txt, 内容为一段随机文本".repeat(3);
  const single: RunNode = {
    id: "run-1",
    kind: "single",
    agent: "worker",
    taskPreview: longTask,
    status: "active",
    usage: { input: 12100, output: 3400, cacheRead: 88000, cacheWrite: 800, cost: 0.0412, turns: 5 },
    model: "opencode-go/deepseek-v4-flash",
    contextPercent: 18,
    progress: { recentTools: [{ tool: "read", argsPreview: longTask, endMs: 1 }], recentOutput: [longTask] },
  };
  const pending: RunNode = {
    id: "b#0",
    kind: "parallel-child",
    agent: "worker",
    taskPreview: longTask,
    status: "pending",
  };
  const root: RunNode = { id: "b", kind: "parallel-root", agent: "parallel", taskPreview: "", status: "active", progress: { done: 0, total: 2 } };
  for (const w of [40, 80, 137, 200]) {
    const singleLines = renderRunNodeLines(single, w, { density: "cozy" });
    for (const l of singleLines) assert.ok(dispLen(l) <= w, `single width=${w} 行超宽: ${dispLen(l)}>${w} :: ${l}`);
    const parLines = renderParallelLines(root, [pending], w, { density: "cozy" });
    for (const l of parLines) assert.ok(dispLen(l) <= w, `parallel width=${w} 行超宽: ${dispLen(l)}>${w} :: ${l}`);
  }
});