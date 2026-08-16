// SessionViewerComponent 键盘流 TDD (架构深化 候选伍): 原模块级 state 单例无重置出口, 组件层零自动化测试.
// 现状态经 createViewerState() 注入 — 覆盖: 构造默认选中最新批次, Tab/←→/数字键切 tab, Timeline ↑/↓ 选批次,
// Enter 确认, Esc 关闭, 多实例状态隔离. 假 TUI/Theme 注入, 不碰真实终端.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionViewerComponent, createViewerState } from "../viewer.ts";
import type { ViewerBatch, ViewerAgent, ViewerState } from "../viewer.ts";

const theme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  inverse: (t: string) => t,
};

function fakeTui() {
  const tui = {
    renders: 0,
    requestRender() {
      tui.renders++;
    },
    terminal: { rows: 24, columns: 80 },
  };
  return tui;
}

function mkAgent(id: string, agent: string): ViewerAgent {
  return { id, agent, taskPreview: "", model: "—", status: "done", source: "live" };
}

function mkBatch(id: string, createdAtMs: number, agents: ViewerAgent[], mode: "single" | "parallel" = "single"): ViewerBatch {
  return {
    id,
    mode,
    createdAtMs,
    task: "",
    agents,
    total: agents.length,
    done: agents.length,
    failed: 0,
    active: 0,
    source: "live",
  };
}

function mkViewer(batches: ViewerBatch[], state?: ViewerState) {
  const tui = fakeTui();
  let doneCount = 0;
  const comp = new SessionViewerComponent({
    tui: tui as never,
    theme,
    done: () => {
      doneCount++;
    },
    getLive: () => ({ batches }),
    ...(state ? { state } : {}),
  });
  return { comp, tui, doneCount: () => doneCount };
}

test("构造即选中最新批次 (时间线尾部); render 头行含批次 id", () => {
  const state = createViewerState();
  const batches = [
    mkBatch("run-old", 1000, [mkAgent("run-old", "worker")]),
    mkBatch("run-new", 2000, [mkAgent("run-new", "explorer")]),
  ];
  const { comp } = mkViewer(batches, state);
  assert.equal(state.confirmedBatchId, "run-new");
  assert.equal(state.convCursor, 1); // 光标在时间线尾部 (最新)
  assert.equal(state.tabIndex, 0); // 首 tab = Timeline
  const lines = comp.render(80);
  assert.ok(lines[0].includes("Subagent Session Viewer"));
  assert.ok(lines[0].includes("run-new"));
  assert.ok(lines.some((l) => l.includes("Timeline")));
  comp.dispose();
});

test("Tab/←→ 循环切 tab + 数字键直跳", () => {
  const state = createViewerState();
  const batches = [
    mkBatch("run-p", 1000, [mkAgent("run-p#0", "worker"), mkAgent("run-p#1", "explorer")], "parallel"),
  ];
  const { comp } = mkViewer(batches, state);
  // tabs: Timeline + 2 agents = 3
  comp.handleInput("\t"); // tab
  assert.equal(state.tabIndex, 1);
  comp.handleInput("\x1b[C"); // right
  assert.equal(state.tabIndex, 2);
  comp.handleInput("\t"); // 回绕
  assert.equal(state.tabIndex, 0);
  comp.handleInput("\x1b[D"); // left 回绕到尾
  assert.equal(state.tabIndex, 2);
  comp.handleInput("1"); // 数字直跳 timeline
  assert.equal(state.tabIndex, 0);
  comp.handleInput("3"); // 数字直跳第二个 agent
  assert.equal(state.tabIndex, 2);
  comp.dispose();
});

test("Timeline ↑/↓ 选批次, Enter 确认换批", () => {
  const state = createViewerState();
  const batches = [
    mkBatch("run-a", 1000, [mkAgent("run-a", "worker")]),
    mkBatch("run-b", 2000, [mkAgent("run-b", "explorer")]),
    mkBatch("run-c", 3000, [mkAgent("run-c", "reviewer")]),
  ];
  const { comp } = mkViewer(batches, state);
  assert.equal(state.confirmedBatchId, "run-c");
  comp.handleInput("\x1b[A"); // up: 光标前移
  assert.equal(state.convCursor, 1);
  comp.handleInput("\x1b[A");
  assert.equal(state.convCursor, 0);
  comp.handleInput("\x1b[A"); // 顶 clamp
  assert.equal(state.convCursor, 0);
  comp.handleInput("\r"); // enter 确认 run-a
  assert.equal(state.confirmedBatchId, "run-a");
  const lines = comp.render(80);
  assert.ok(lines[0].includes("run-a"));
  comp.handleInput("\x1b[B"); // down
  assert.equal(state.convCursor, 1);
  comp.dispose();
});

test("Esc 关闭 → done 回调", () => {
  const state = createViewerState();
  const batches = [mkBatch("run-x", 1000, [mkAgent("run-x", "worker")])];
  const { comp, doneCount } = mkViewer(batches, state);
  comp.handleInput("\x1b");
  assert.equal(doneCount(), 1);
  comp.dispose();
});

test("多实例状态隔离: 各自注入 createViewerState 互不影响", () => {
  const s1 = createViewerState();
  const s2 = createViewerState();
  const batches = [
    mkBatch("run-1", 1000, [mkAgent("run-1", "worker")]),
    mkBatch("run-2", 2000, [mkAgent("run-2", "explorer")]),
  ];
  const v1 = mkViewer(batches, s1);
  const v2 = mkViewer(batches, s2);
  v1.comp.handleInput("\x1b[A"); // v1 光标前移
  v1.comp.handleInput("\r"); // v1 确认 run-1
  assert.equal(s1.confirmedBatchId, "run-1");
  assert.equal(s2.confirmedBatchId, "run-2", "v2 状态不受 v1 操作影响");
  assert.equal(s2.convCursor, 1);
  v1.comp.dispose();
  v2.comp.dispose();
});
