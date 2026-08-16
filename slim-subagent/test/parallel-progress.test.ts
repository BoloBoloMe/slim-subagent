// ISSUE-03 (F1, M07 D013) TDD 切片: parallel per-child 实时进度透传.
// 接缝: runParallelTasks 聚合 onUpdate 的 details.progress (改造前恒 [], 改造后每 child 一行实时快照).
// 测试范式对齐 parallel.test.ts: fake ExtensionAPI 捕获 registerTool 直调 execute(tasks),
// fake pi 经 PI_SUBAGENT_PI_BINARY + FAKE_PI_SCENARIO 注入 (两 child 都走同一 scenario).
// TS-001: 聚合 details 含每 child recentTools/usage 增量 (tool-progress 场景).
// TS-002: done/total 保序 + results/progress 预建行不丢 (error-if-marked: 一败一成).

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  makeTempHome,
  withHome,
  captureTool,
  writeAgent,
  cleanup,
} from "./helpers.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

// per-child 进度快照 (聚合 details.progress 元素形态, 断言面).
type ProgressEntry = {
  childIndex: number;
  agent: string;
  recentTools: { tool: string; args: string; endMs: number }[];
  recentOutput: string[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
  model?: string;
  isError: boolean;
};
type ParUpdatePayload = {
  content: { type: string; text: string }[];
  details: { mode: string; results: unknown[]; progress: ProgressEntry[] };
};

// 临时 HOME 隔离 + fake pi 跑一次 parallel execute, 收集 onUpdate (各测试独立 env 注入, 恢复现场).
async function runParallel(
  home: string,
  params: Record<string, unknown>,
  opts: { scenario?: string; onUpdate?: (u: unknown) => void } = {},
): Promise<{ isError: boolean | undefined }> {
  const prev: Record<string, string | undefined> = {};
  for (const k of ["PI_SUBAGENT_PI_BINARY", "FAKE_PI_SCENARIO"]) {
    prev[k] = process.env[k];
  }
  try {
    const updates = opts.onUpdate;
    const result = await withHome(home, async () => {
      process.env.PI_SUBAGENT_PI_BINARY = FAKE_PI;
      process.env.FAKE_PI_SCENARIO = opts.scenario ?? "assistant-stop";
      const tool = captureTool();
      const ctx = { cwd: home } as unknown as ExtensionContext;
      return tool.execute("call-1", params, undefined, updates as never, ctx);
    });
    return { isError: result.isError };
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ---- TS-001: 聚合 details 含 per-child 实时进度 (tool-progress 场景: read + grep + assistant). ----

test("TS-001 parallel aggregates per-child progress into onUpdate details", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const updates: ParUpdatePayload[] = [];
    const { isError } = await runParallel(
      home,
      { tasks: [{ agent: "Alpha", task: "t0" }, { agent: "Alpha", task: "t1" }] },
      { scenario: "tool-progress", onUpdate: (u) => updates.push(u as ParUpdatePayload) },
    );
    assert.equal(isError, undefined, "全部成功不应标记错误");
    assert.ok(updates.length >= 3, `初始 + per-child 透传 ≥ 3 次更新, got ${updates.length}`);

    // 存在某个聚合更新: progress 长度 2 (预建行不丢) 且每 child 的 recentTools 非空
    // (tool-progress 场景 read/grep 已落), usage.input > 0 (usage 已累加), childIndex/agent 正确.
    const ripe = updates.find(
      (u) =>
        Array.isArray(u.details.progress) &&
        u.details.progress.length === 2 &&
        u.details.progress.every(
          (p) =>
            p.recentTools.length > 0 &&
            ["read", "grep"].every((t) => p.recentTools.some((x) => x.tool === t)) &&
            p.usage.input > 0 &&
            p.isError === false,
        ),
    );
    assert.ok(ripe, "应存在每 child progress 非空 (recentTools 含 read/grep + usage.input>0) 的聚合更新");
    assert.deepEqual(
      ripe!.details.progress.map((p) => p.childIndex),
      [0, 1],
      "progress 按 childIndex 保序预建",
    );
    assert.deepEqual(
      ripe!.details.progress.map((p) => p.agent),
      ["Alpha", "Alpha"],
      "progress 带正确 agent 名",
    );
  } finally {
    cleanup(home);
  }
});

// ---- TS-002: done/total 保序 + results/progress 预建行不丢 (一败一成, 失败 child exitCode 非 0). ----

test("TS-002 done/total monotonic with prebuilt results/progress rows", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const updates: ParUpdatePayload[] = [];
    const { isError } = await runParallel(
      home,
      { tasks: [{ agent: "Alpha", task: "ok task" }, { agent: "Alpha", task: "bad __FAIL__" }] },
      { scenario: "error-if-marked", onUpdate: (u) => updates.push(u as ParUpdatePayload) },
    );
    assert.equal(isError, undefined, "单 child 失败不应整批报错 (不 fail-fast)");
    assert.ok(updates.length >= 3, `初始 + per-child 透传 ≥ 3 次更新, got ${updates.length}`);

    // 全序列: content 的 done 计数单调不减; results/progress 长度恒 2 (预建行不丢).
    const dones: number[] = [];
    for (const u of updates) {
      const m = /^Parallel: (\d+)\/(\d+) done/.exec(u.content[0]!.text);
      assert.ok(m, `content 应匹配 done/total 文本, got "${u.content[0]!.text}"`);
      assert.equal(Number(m![2]), 2, "total 恒 2");
      dones.push(Number(m![1]));
      assert.equal(u.details.results.length, 2, `results 预建行不丢, got ${u.details.results.length}`);
      assert.ok(Array.isArray(u.details.progress) && u.details.progress.length === 2, `progress 预建行不丢, got ${u.details.progress?.length}`);
    }
    for (let i = 1; i < dones.length; i++) {
      assert.ok(dones[i]! >= dones[i - 1]!, `done 应单调不减 (保序), ${dones[i - 1]} → ${dones[i]}`);
    }
    assert.equal(dones[dones.length - 1], 2, "最终收敛 2/2 done");
    // 失败 child 的 progress isError 也应透传 (与 results 独立 isError 一致).
    const last = updates[updates.length - 1]!;
    assert.equal(last.details.progress[1]!.isError, true, "失败 child 的 progress.isError 应为 true");
    assert.equal(last.details.progress[0]!.isError, false, "成功 child 的 progress.isError 应为 false");
  } finally {
    cleanup(home);
  }
});