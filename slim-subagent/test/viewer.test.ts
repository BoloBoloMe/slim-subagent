// ISSUE-06 Session Viewer TDD (M13): 纯函数接缝 = tolerant reader / 批次时间线 / 磁盘回补 / 内存 store.
// TS-001: parseSessionJsonl — 混合合法 JSON/损坏 JSON/未知类型行 → 合法行 ok, 损坏行进 raw 不丢弃 (M08-D003 ⑥).
// TS-002: buildTimeline — 多 run 记录乱序 → 上早下晚排序, single 也算批次, 状态摘要正确 (PRD §5/D007).
// TS-003: backfillRecentBatches — 20+ run 目录只回补最近 20 批; 缺 run.json/坏文件跳过不崩 (D011).
// TS-004: ViewerStore — 同 id upsert 覆盖, getBatches 上早下晚, remove (D011 内存 store 语义).
// TS-005: batchFromLiveNodes — onUpdate RunNode[] → ViewerBatch (single/parallel 喂入路径, 反向不反推).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseSessionJsonl,
  sessionEntryOf,
  buildTimeline,
  batchStatusSummary,
  backfillRecentBatches,
  createViewerStore,
  batchFromLiveNodes,
} from "../viewer.ts";
import type { ViewerBatch, ViewerAgent } from "../viewer.ts";
import type { RunNode, DisplayStatus, SlimUsage } from "../projection.ts";

// ---- 测试数据构造 ----

const emptyUsage: SlimUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function mkAgent(id: string, agent: string, status: DisplayStatus): ViewerAgent {
  return { id, agent, taskPreview: "", model: "—", status, source: "live" };
}

function mkBatch(partial: {
  id: string;
  mode: "single" | "parallel" | "resume";
  createdAtMs: number;
  agents: ViewerAgent[];
}): ViewerBatch {
  const total = partial.agents.length;
  const done = partial.agents.filter((a) => a.status === "done").length;
  const failed = partial.agents.filter((a) => ["failed", "timeout", "budget", "cancelled"].includes(a.status)).length;
  const active = partial.agents.filter((a) => ["active", "pending"].includes(a.status)).length;
  return {
    id: partial.id,
    mode: partial.mode,
    createdAtMs: partial.createdAtMs,
    task: "",
    agents: partial.agents,
    total,
    done,
    failed,
    active,
    source: "live",
  };
}

// ---- TS-001: tolerant reader ----

test("tolerant reader keeps unrecognized lines as raw", () => {
  // 合法 JSON 行 → ok:true, evt 完整保留
  const valid = '{"type":"message","id":"a1","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"hi"}}';
  const r1 = parseSessionJsonl(valid);
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.deepEqual(r1.evt, JSON.parse(valid));
  }

  // 损坏 JSON 行 → ok:false, raw 原样保留 (不丢弃)
  const corrupt = '{"type":"message","id":"b2","message":{"role":"assistant"';
  const r2 = parseSessionJsonl(corrupt);
  assert.equal(r2.ok, false);
  if (!r2.ok) {
    assert.equal(r2.raw, corrupt);
  }

  // 非 JSON 杂讯行 → ok:false, raw 保留
  const noise = "<class 'arm.Prompt'> taking too long to respond";
  const r3 = parseSessionJsonl(noise);
  assert.equal(r3.ok, false);
  if (!r3.ok) {
    assert.equal(r3.raw, noise);
  }

  // 未知类型行 (合法 JSON) → 解析层照常 ok, 归一化层不丢弃 → kind:"other"
  const unknown = '{"type":"custom","id":"c3","parentId":"a1","timestamp":"2026-01-01T00:00:01.000Z","customType":"my-ext","data":{"n":1}}';
  const r4 = parseSessionJsonl(unknown);
  assert.equal(r4.ok, true);
  if (r4.ok) {
    const e = sessionEntryOf(r4.evt);
    assert.equal(e.kind, "other");
  }
});

test("sessionEntryOf extracts message transcript entries", () => {
  const user = sessionEntryOf(JSON.parse('{"type":"message","id":"u","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}'));
  assert.equal(user.kind, "message");
  if (user.kind === "message") {
    assert.equal(user.role, "user");
    assert.equal(user.text, "hello");
  }
  const asst = sessionEntryOf(JSON.parse('{"type":"message","id":"a","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"},{"type":"toolCall","id":"t1","name":"bash","arguments":{"cmd":"ls"}}],"model":"m","stopReason":"toolUse"}}'));
  assert.equal(asst.kind, "message");
  if (asst.kind === "message") {
    assert.equal(asst.role, "assistant");
    assert.equal(asst.type, "assistant");
    assert.equal(asst.text, "ok");
    assert.deepEqual(asst.toolCalls, [{ name: "bash", argsPreview: '{"cmd":"ls"}' }]);
  }
  const tool = sessionEntryOf(JSON.parse('{"type":"message","id":"t","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"t1","toolName":"bash","content":[{"type":"text","text":"out.txt"}],"isError":false}}'));
  assert.equal(tool.kind, "message");
  if (tool.kind === "message") {
    assert.equal(tool.role, "toolResult");
    assert.equal(tool.type, "toolResult");
    assert.equal(tool.isError, false);
    assert.equal(tool.text, "out.txt");
  }
});

// ---- TS-002: timeline 构建 ----

test("timeline orders batches oldest first", () => {
  const b1 = mkBatch({ id: "run-c", mode: "parallel", createdAtMs: 3000, agents: [mkAgent("run-c#0", "w", "done"), mkAgent("run-c#1", "x", "failed")] });
  const b2 = mkBatch({ id: "run-a", mode: "single", createdAtMs: 1000, agents: [mkAgent("run-a", "e", "done")] });
  const b3 = mkBatch({ id: "run-b", mode: "resume", createdAtMs: 2000, agents: [mkAgent("run-b", "r", "timeout")] });
  const sorted = buildTimeline([b1, b3, b2]);
  assert.deepEqual(sorted.map((b) => b.id), ["run-a", "run-b", "run-c"]);
  // 排序不改原数组
  assert.deepEqual(buildTimeline([b1, b2]).map((b) => b.id), ["run-a", "run-c"]);
});

test("single counts as a batch in timeline", () => {
  const single = mkBatch({ id: "run-solo", mode: "single", createdAtMs: 500, agents: [mkAgent("run-solo", "e", "done")] });
  const tl = buildTimeline([single]);
  assert.equal(tl.length, 1);
  assert.equal(tl[0].mode, "single");
  assert.equal(tl[0].agents.length, 1);
});

test("batch status summary is correct", () => {
  // parallel: done/total + failed + active
  assert.equal(batchStatusSummary(mkBatch({ id: "p", mode: "parallel", createdAtMs: 0, agents: [
    mkAgent("p#0", "a", "done"), mkAgent("p#1", "b", "done"),
    mkAgent("p#2", "c", "failed"), mkAgent("p#3", "d", "active"),
  ] })), "2/4 done · 1 failed · 1 active");
  // single: 单一状态标签
  assert.equal(batchStatusSummary(mkBatch({ id: "s", mode: "single", createdAtMs: 0, agents: [mkAgent("s", "e", "done")] })), "done");
  assert.equal(batchStatusSummary(mkBatch({ id: "t", mode: "single", createdAtMs: 0, agents: [mkAgent("t", "e", "timeout")] })), "timeout");
  // resumed 用单独标签 (resume 也算批次)
  assert.equal(batchStatusSummary(mkBatch({ id: "r", mode: "resume", createdAtMs: 0, agents: [mkAgent("r", "e", "failed")] })), "failed");
});

// ---- TS-003: 磁盘回补 ----

test("backfill caps at 20 batches, survives missing files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-backfill-"));
  const totalRuns = 25;
  for (let i = 0; i < totalRuns; i++) {
    const pad = String(i).padStart(2, "0");
    const dir = path.join(root, `run-20260812-${pad}0000-${pad}0001`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({
        runId: dir.slice(root.length + 1),
        agent: `agent-${pad}`,
        startedAt: new Date(Date.UTC(2026, 7, 12, 0, i, 0)).toISOString(),
        sessionFile: "run-0/session.jsonl",
      }),
    );
  }
  // 坏 run.json 目录 (解析失败) 与缺 run.json 目录 (GC 缺文件) → 跳过不崩
  const badDir = path.join(root, "run-20260812-bad-0001");
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, "run.json"), "{broken json");
  const emptyDir = path.join(root, "run-20260812-zzzz-0000");
  fs.mkdirSync(emptyDir, { recursive: true });

  const batches = backfillRecentBatches(root, 20);
  assert.equal(batches.length, 20); // 只回补最近 20 批
  const times = batches.map((b) => b.createdAtMs);
  assert.deepEqual(times, [...times].sort((a, b) => a - b)); // 上早下晚
  // 最近 20 批 = index 5..24 (0..24 共 25, 跳过最早 5 个)
  assert.equal(batches[0].id, "run-20260812-050000-050001");
  assert.equal(batches[batches.length - 1].id, "run-20260812-240000-240001");
  // 单批字段: 单 agent 批次, agent 名正确
  assert.equal(batches[0].mode, "single");
  assert.equal(batches[0].agents[0].agent, "agent-05");
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- TS-004: 内存 store ----

test("viewer store upserts, orders ascending, removes", () => {
  const store = createViewerStore();
  const latest = mkBatch({ id: "run-l", mode: "parallel", createdAtMs: 3000, agents: [mkAgent("run-l#0", "a", "done"), mkAgent("run-l#1", "b", "active")] });
  const earlier = mkBatch({ id: "run-e", mode: "single", createdAtMs: 1000, agents: [mkAgent("run-e", "e", "active")] });
  store.upsert(latest);
  store.upsert(earlier);
  assert.deepEqual(store.getBatches().map((b) => b.id), ["run-e", "run-l"]);
  // 同 id upsert 覆盖 (live 更新语义: 状态推进)
  const updated = { ...earlier, agents: [mkAgent("run-e", "e", "done")], done: 1, failed: 0, active: 0 };
  store.upsert(updated);
  const got = store.get("run-e");
  assert.equal(got?.agents[0].status, "done");
  store.remove("run-e");
  assert.equal(store.get("run-e"), undefined);
  assert.deepEqual(store.getBatches().map((b) => b.id), ["run-l"]);
});

// ---- TS-005: RunNode 快照 → 批次 (onUpdate 喂入路径) ----

function runNode(partial: Partial<RunNode> & { id: string; agent: string; status: DisplayStatus }): RunNode {
  return {
    kind: "single",
    taskPreview: "",
    model: "—",
    modelSource: "unknown",
    ...partial,
  } as RunNode;
}

test("batchFromLiveNodes maps single node to one batch", () => {
  const b = batchFromLiveNodes([
    runNode({ id: "run-1", agent: "explorer", status: "done", runId: "run-1", startedAtMs: 1000, sessionDir: "/tmp/x", usage: emptyUsage }),
  ]);
  assert.ok(b);
  assert.equal(b!.mode, "single");
  assert.equal(b!.id, "run-1");
  assert.equal(b!.agents.length, 1);
  assert.equal(b!.agents[0].sessionFile, path.join("/tmp/x", "run-0", "session.jsonl"));
});

test("batchFromLiveNodes maps parallel root+children to one batch", () => {
  const b = batchFromLiveNodes([
    runNode({ id: "run-p", kind: "parallel-root", agent: "parallel", status: "done", runId: "run-p", startedAtMs: 1000 }),
    runNode({ id: "run-p#0", kind: "parallel-child", parentId: "run-p", agent: "a", status: "done", runId: "run-p" }),
    runNode({ id: "run-p#1", kind: "parallel-child", parentId: "run-p", agent: "b", status: "failed", runId: "run-p", isError: true }),
    runNode({ id: "run-p#2", kind: "parallel-child", parentId: "run-p", agent: "c", status: "active", runId: "run-p" }),
  ]);
  assert.ok(b);
  assert.equal(b!.mode, "parallel");
  assert.equal(b!.agents.length, 3);
  assert.equal(b!.total, 3);
  assert.equal(b!.done, 1);
  assert.equal(b!.failed, 1);
  assert.equal(b!.active, 1);
  assert.equal(b!.agents[1].id, "run-p#1");
});

test("batchFromLiveNodes skips runId-less placeholder frames", () => {
  const b = batchFromLiveNodes([runNode({ id: "—", agent: "explorer", status: "active" })]);
  assert.equal(b, undefined);
});