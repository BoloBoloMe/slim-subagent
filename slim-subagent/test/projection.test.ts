// ISSUE-04 投影层 TDD (PRD §3 契约): projectSlimDetailsToRunNodes / isAttention.
// TS-001: active single live 快照 → 单节点 (kind/status/model/modelSource/usage).
// TS-002: parallel 6 child (2 未 scheduled) → pending/active/done 状态机 + root 进度.
// TS-003: 冲突优先级 — final details.model 胜 callParams.model; details 缺省时退化 call-params.
// 接缝 = 纯函数 (details + 调用侧快照 → RunNode), 不触发 spawn/执行管线.
// (原 TS-004 archived 投影已随 projectArchivedRunNode 删除迁往 test/run-record.test.ts — 归档读取归 run-record 接缝.)

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { projectSlimDetailsToRunNodes, isAttention } from "../projection.ts";
import type { DisplayStatus, RunNode } from "../projection.ts";
import { currentLogFile } from "../log.ts";

// ---- 测试数据构造 ----

// live/stream 快照形态: {mode, results[], progress[]} (single 与 parallel 同形, 依 mode 分叉).
function liveDetails(mode: "single" | "parallel", results: unknown[], progress: unknown[]) {
  return { mode, results, progress };
}

const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function childPlaceholder(index: number): unknown {
  return {
    index,
    agent: `agent-${index}`,
    task: `task ${index}`,
    isError: false,
    text: "(running...)",
    details: { usage: emptyUsage, runId: "run-batch", sessionDir: "", exitCode: -1 },
  };
}

function childProgress(index: number, scheduled: boolean): unknown {
  return {
    childIndex: index,
    agent: `agent-${index}`,
    recentTools: index === 0 ? [{ tool: "bash", args: "ls", endMs: 1000 }] : [],
    recentOutput: index === 0 ? ["out-1"] : [],
    usage: emptyUsage,
    isError: false,
    scheduled,
  };
}

// ---- TS-001: active single (live 快照) ----

test("TS-001 projects active single node from live details", () => {
  const nodes = projectSlimDetailsToRunNodes({
    toolCallId: "tc-001",
    details: liveDetails(
      "single",
      [
        {
          index: 0,
          agent: "worker",
          task: "fix the build",
          exitCode: 0,
          usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.002, turns: 3 },
          model: "fake-model-1",
          messages: [],
          stderr: "",
        },
      ],
      [{ recentTools: [{ tool: "bash", args: "echo hi", endMs: 42 }], recentOutput: ["hello"] }],
    ),
    callParams: { agent: "worker", task: "fix the build" },
  });
  assert.equal(nodes.length, 1);
  const n = nodes[0];
  assert.equal(n.kind, "single");
  assert.equal(n.status, "active"); // 无 endedAtMs → 运行中
  assert.equal(n.model, "fake-model-1");
  assert.equal(n.modelSource, "details");
  assert.deepEqual(n.usage, { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.002, turns: 3 });
  assert.equal(n.agent, "worker");
  assert.equal(n.taskPreview, "fix the build");
  assert.equal(n.progress?.recentTools?.[0]?.tool, "bash");
  assert.equal(n.progress?.recentOutput?.[0], "hello");
  // logCursor 关联当日 operational log (best-effort basename).
  assert.equal(n.logCursor?.file, path.basename(currentLogFile()));
});

// ---- TS-002: parallel 6 child 状态机 ----

test("TS-002 parallel pending/active/done state machine and root summary", () => {
  // 6 child: 2 未达 L30 (scheduled=false → pending), 其余 scheduled=true;
  // 其中 child 1 已完成 (现实结果 exitCode 0 → done).
  const results = [0, 1, 2, 3, 4, 5].map(childPlaceholder);
  results[1] = {
    index: 1,
    agent: "agent-1",
    task: "task 1",
    isError: false,
    text: "done output",
    details: {
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 },
      runId: "run-batch",
      sessionDir: "/tmp/run-batch/run-1",
      exitCode: 0,
      model: "child-model",
      stopReason: "stop",
      endedAtMs: 5000,
    },
  };
  const progress = [0, 1, 2, 3, 4, 5].map((i) => childProgress(i, i >= 4 ? false : true));
  const nodes = projectSlimDetailsToRunNodes({
    toolCallId: "tc-002",
    details: { mode: "parallel", runId: "run-batch", results, progress },
    callParams: {
      tasks: [
        { agent: "agent-0", task: "task 0" },
        { agent: "agent-1", task: "task 1" },
        { agent: "agent-2", task: "task 2" },
        { agent: "agent-3", task: "task 3" },
        { agent: "agent-4", task: "task 4" },
        { agent: "agent-5", task: "task 5" },
      ],
    },
  });
  assert.equal(nodes.length, 7); // root + 6 child
  const [root, ...children] = nodes;
  assert.equal(root.kind, "parallel-root");
  assert.equal(root.id, "run-batch");
  assert.equal(root.status, "active"); // 未全完成
  assert.deepEqual(root.progress, { done: 1, total: 6 });

  const pending = children.filter((c) => c.status === "pending");
  const active = children.filter((c) => c.status === "active");
  const done = children.filter((c) => c.status === "done");
  assert.equal(pending.length, 2); // child 4/5 未达 L30
  assert.equal(done.length, 1); // child 1 完成
  assert.equal(active.length, 3); // 其余 scheduled 且未完成
  for (const c of children) {
    assert.equal(c.parentId, "run-batch");
    assert.match(c.id, /^run-batch#[0-5]$/);
  }
  // pending child 无 usage/model 伪造 (D008: 未产生不填).
  for (const c of pending) {
    assert.equal(c.usage, undefined);
    assert.equal(c.model, "—");
  }
  const doneChild = done[0];
  assert.equal(doneChild.id, "run-batch#1");
  assert.equal(doneChild.modelSource, "details");
  assert.equal(doneChild.endedAtMs, 5000);
  assert.equal(doneChild.endedAtMsSource, "details");
});

// ---- TS-003: 冲突优先级 — details 胜 callParams ----

test("TS-003 final details model wins over call-params model", () => {
  const callParams = { agent: "worker", task: "t", model: "call-model" };
  const nodes = projectSlimDetailsToRunNodes({
    toolCallId: "tc-003a",
    details: {
      mode: "single",
      agent: "worker",
      taskPreview: "t",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
      runId: "run-003a",
      sessionDir: "/s/run-003a",
      exitCode: 0,
      model: "final-model",
      stopReason: "stop",
      startedAtMs: 1000,
      endedAtMs: 2000,
    },
    callParams,
  });
  assert.equal(nodes.length, 1);
  const n = nodes[0];
  assert.equal(n.model, "final-model");
  assert.equal(n.modelSource, "details");
  assert.equal(n.status, "done");
  assert.equal(n.endedAtMs, 2000);
  assert.equal(n.endedAtMsSource, "details");
});

test("TS-003 call-params model fallback when details lack model", () => {
  const callParams = { agent: "worker", task: "t", model: "call-model" };
  const nodes = projectSlimDetailsToRunNodes({
    toolCallId: "tc-003b",
    details: {
      mode: "single",
      agent: "worker",
      taskPreview: "t",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
      runId: "run-003b",
      sessionDir: "/s/run-003b",
      exitCode: 0,
      stopReason: "stop",
      startedAtMs: 1000,
      endedAtMs: 2000,
    },
    callParams,
  });
  assert.equal(nodes.length, 1);
  const n = nodes[0];
  assert.equal(n.model, "call-model");
  assert.equal(n.modelSource, "call-params");
});

// ---- isAttention 聚合 (PRD §4.1: attention = failed+timeout+budget+cancelled) ----

test("isAttention true for the four attention statuses", () => {
  for (const s of ["failed", "timeout", "budget", "cancelled"] as DisplayStatus[]) {
    assert.equal(isAttention(s), true, s);
  }
  for (const s of ["pending", "active", "done", "attention"] as DisplayStatus[]) {
    assert.equal(isAttention(s), false, s);
  }
});

// 类型层冒烟: RunNode 全字段可构造 (契约漂移防护).
test("RunNode shape smoke", () => {
  const node: RunNode = {
    id: "run-x",
    kind: "parallel-child",
    parentId: "run-batch",
    agent: "worker",
    taskPreview: "t",
    status: "pending",
    logCursor: { file: "subagent-20260101.log", lastEventId: "" },
  };
  assert.equal(node.status, "pending");
});