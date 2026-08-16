// ISSUE-02 TS-001: assembleSingleResult 单点补丁 (M02 D001/D002) — final details 六字段 + ctx 子代理口径.
// 纯函数接缝 (不 spawn): 手造 SingleResult + opts, 断言 details 补丁字段与 contextPercent/contextWindow 子口径公式.
// 先红后绿: 补丁未打前 mode/agent/taskPreview/timeoutMsExplicit/startedAtMs/endedAtMs 均缺, 测试应失败.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSingleResult } from "../single.ts";
import type { SingleResult } from "../single.ts";

test("TS-001 final details carries six patch fields with ctx child-process metrics", () => {
  const result: SingleResult = {
    index: 0,
    agent: "fake-agent-1",
    task: "含 sk-abcdefghijklmnop secret=abc 的任务",
    exitCode: 0,
    processSignal: undefined,
    usage: { input: 11, output: 7, cacheRead: 2, cacheWrite: 3, cost: 0.5, turns: 2 },
    messages: [],
    model: "fake-model-1",
    stopReason: "stop",
    error: undefined,
    errorMessage: undefined,
    finalOutput: "done",
    partialOutput: undefined,
    contextTokens: 18,
    stderr: "",
    timedOut: true,
    budgetExceeded: false,
    timeoutMs: 800,
    endedAtMs: 123,
  };
  const single = assembleSingleResult(result, {
    runId: "run-20250101-000000-abc123",
    sessionDir: "/tmp/slim-subagent/sessions/run-20250101-000000-abc123",
    sessionFile: "/tmp/slim-subagent/sessions/run-20250101-000000-abc123/run-0/session.jsonl",
    agent: "Alpha",
    ctx: { modelRegistry: { find: () => ({ contextWindow: 2000 }) } },
    model: "fallback-model",
    task: "含 sk-abcdefghijklmnop secret=abc 的任务",
    timeoutMs: 800,
    startedAtMs: 100,
  });
  const details = single.details as {
    mode?: string;
    agent?: string;
    taskPreview?: string;
    timeoutMsExplicit?: number;
    startedAtMs?: number;
    endedAtMs?: number;
    contextPercent?: number | null;
    contextWindow?: number;
  };
  // D002: 六字段.
  assert.equal(details.mode, "single");
  assert.equal(details.agent, "Alpha");
  assert.equal(details.timeoutMsExplicit, 800);
  assert.equal(details.startedAtMs, 100);
  assert.equal(details.endedAtMs, 123);
  assert.ok(typeof details.taskPreview === "string" && details.taskPreview.length > 0, "taskPreview 应产出");
  assert.ok(!details.taskPreview!.includes("sk-abcdefghijklmnop"), `taskPreview 不得含 sk- 令牌原文, got: ${details.taskPreview}`);
  assert.ok(details.taskPreview!.length <= 120, `taskPreview ≤120, got length ${details.taskPreview!.length}`);
  // D001: ctx 子口径公式 (contextTokens / resolveModelWindow, 窗口优先级 result.model → opts.model).
  assert.equal(details.contextPercent, (18 / 2000) * 100);
  assert.equal(details.contextWindow, 2000);

  // 模型完全不可得 (result.model 与 opts.model 皆 undefined) → percent null / window undefined (UI 显示 ctx —, 不伪造).
  const noModel = assembleSingleResult({ ...result, model: undefined }, {
    runId: "run-20250101-000000-abc123",
    sessionDir: "/tmp/slim-subagent/sessions/run-20250101-000000-abc123",
    sessionFile: "/tmp/slim-subagent/sessions/run-20250101-000000-abc123/run-0/session.jsonl",
    agent: "Alpha",
    startedAtMs: 100,
  });
  const nd = noModel.details as { contextPercent?: number | null; contextWindow?: number };
  assert.equal(nd.contextPercent, null);
  assert.equal(nd.contextWindow, undefined);
});