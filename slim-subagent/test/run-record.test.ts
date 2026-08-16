// run-record 接缝 TDD (架构深化 候选贰): 归档运行读取单一接口.
// 覆盖: archivedStatusOf 唯一实现 (含原 projection/viewer 双份漂移点 "active"),
// readArchivedRun endedAtMs 三级来源 (run.json → mtime-approx → 缺省), 坏/缺 run.json 容错,
// parallel child 回补脱敏收口 (原始 task 不上观测面), 目录布局约定 (run-0 / run-<idx>).
// 文件系统 = 本地可替代: 真临时目录, 无 mock.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  archivedStatusOf,
  readArchivedRun,
  archivedSessionFileOf,
  liveSessionFileOf,
  childSessionDirOf,
  SINGLE_SESSION_REL,
} from "../run-record.ts";

function mkRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "run-record-"));
}

function writeRunJson(dir: string, json: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(json, null, 2) + "\n");
}

// ---- archivedStatusOf: 唯一实现 (替代 projection/viewer 双份; "active" 漂移点统一判 active) ----

test("archivedStatusOf maps finalStatus, active stays active", () => {
  assert.equal(archivedStatusOf("timeout"), "timeout");
  assert.equal(archivedStatusOf("usage_budget"), "budget");
  assert.equal(archivedStatusOf("cancelled"), "cancelled");
  assert.equal(archivedStatusOf("error"), "failed");
  assert.equal(archivedStatusOf("failed"), "failed");
  assert.equal(archivedStatusOf("aborted"), "failed");
  assert.equal(archivedStatusOf("active"), "active"); // 漂移点: 原 projection 版误判 done
  assert.equal(archivedStatusOf("done"), "done");
  assert.equal(archivedStatusOf(undefined), "done"); // 无补丁无失败证据 → done
  assert.equal(archivedStatusOf("stop"), "done");
  assert.equal(archivedStatusOf("whatever"), "done");
});

// ---- 目录布局约定 ----

test("layout: single run-0, parallel child run-<idx>", () => {
  assert.equal(SINGLE_SESSION_REL, "run-0/session.jsonl");
  assert.equal(childSessionDirOf("/b", 2), path.join("/b", "run-2"));
  assert.equal(liveSessionFileOf("single", "/s"), path.join("/s", "run-0", "session.jsonl"));
  assert.equal(liveSessionFileOf("resume", "/s"), path.join("/s", "run-0", "session.jsonl"));
  assert.equal(liveSessionFileOf("parallel-child", "/s/run-1"), path.join("/s/run-1", "session.jsonl"));
});

test("archivedSessionFileOf three-tier candidates", () => {
  const dir = mkRunDir();
  // 皆缺 → run-0 缺省路径
  assert.equal(archivedSessionFileOf(dir, undefined), path.join(dir, "run-0", "session.jsonl"));
  // 同目录 session.jsonl 存在 → 第三级
  fs.writeFileSync(path.join(dir, "session.jsonl"), "x\n");
  assert.equal(archivedSessionFileOf(dir, undefined), path.join(dir, "session.jsonl"));
  // run-0 存在 → 第二级优先于第三级
  fs.mkdirSync(path.join(dir, "run-0"), { recursive: true });
  fs.writeFileSync(path.join(dir, "run-0", "session.jsonl"), "x\n");
  assert.equal(archivedSessionFileOf(dir, undefined), path.join(dir, "run-0", "session.jsonl"));
  // sessionFile 字段存在 → 第一级优先
  fs.mkdirSync(path.join(dir, "custom"), { recursive: true });
  fs.writeFileSync(path.join(dir, "custom", "s.jsonl"), "x\n");
  assert.equal(archivedSessionFileOf(dir, "custom/s.jsonl"), path.join(dir, "custom", "s.jsonl"));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- readArchivedRun: single/resume ----

test("readArchivedRun single with settle patch: endedAtMsSource=run.json", () => {
  const dir = mkRunDir();
  fs.mkdirSync(path.join(dir, "run-0"), { recursive: true });
  writeRunJson(dir, {
    runId: "run-a",
    agent: "worker",
    model: "m1",
    cwd: "/tmp",
    startedAt: "2026-01-01T00:00:00.000Z",
    sessionFile: "run-0/session.jsonl",
    endedAtMs: 999,
    finalStatus: "done",
    usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  });
  fs.writeFileSync(path.join(dir, "run-0", "session.jsonl"), "x\n");
  const rec = readArchivedRun(dir)!;
  assert.ok(rec);
  assert.equal(rec.runId, "run-a");
  assert.equal(rec.mode, "single");
  assert.equal(rec.agent, "worker");
  assert.equal(rec.status, "done");
  assert.equal(rec.endedAtMs, 999);
  assert.equal(rec.endedAtMsSource, "run.json");
  assert.equal(rec.model, "m1");
  assert.deepEqual(rec.usage, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });
  assert.equal(rec.startedAtMs, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(rec.sessionFile, path.join(dir, "run-0", "session.jsonl"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readArchivedRun without settle patch: mtime-approx", () => {
  const dir = mkRunDir();
  fs.mkdirSync(path.join(dir, "run-0"), { recursive: true });
  writeRunJson(dir, {
    runId: "run-b",
    agent: "explorer",
    cwd: "/tmp",
    startedAt: "2026-01-02T00:00:00.000Z",
    sessionFile: "run-0/session.jsonl",
  });
  const sess = path.join(dir, "run-0", "session.jsonl");
  fs.writeFileSync(sess, "line1\nline2\n");
  const mtime = 5_555_555_555;
  fs.utimesSync(sess, new Date(mtime), new Date(mtime));
  const rec = readArchivedRun(dir)!;
  assert.equal(rec.endedAtMsSource, "mtime-approx");
  assert.ok(typeof rec.endedAtMs === "number" && Math.abs(rec.endedAtMs - mtime) < 1);
  assert.equal(rec.status, "done"); // 无 finalStatus → done
  assert.equal(rec.model, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readArchivedRun mode=resume preserved; missing/broken run.json → undefined", () => {
  const dir = mkRunDir();
  writeRunJson(dir, { runId: "run-r", mode: "resume", agent: "worker", startedAt: "bad-date" });
  const rec = readArchivedRun(dir)!;
  assert.equal(rec.mode, "resume");
  assert.equal(rec.startedAtMs, undefined); // 坏 startedAt 不填
  assert.ok(rec.createdAtMs >= 0); // 回退 runDir mtime

  const missing = path.join(dir, "sub");
  fs.mkdirSync(missing);
  assert.equal(readArchivedRun(missing), undefined);

  const broken = path.join(dir, "broken");
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, "run.json"), "{broken json");
  assert.equal(readArchivedRun(broken), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- readArchivedRun: parallel (脱敏收口 + run-<idx> 布局 + 状态传播) ----

test("readArchivedRun parallel: child taskPreview redacted, layout run-<idx>", () => {
  const dir = mkRunDir();
  const secretTask = 'deploy with api_key=sk-abcdefgh12345678 please\nand keep it quiet';
  writeRunJson(dir, {
    runId: "run-p",
    mode: "parallel",
    cwd: "/tmp",
    startedAt: "2026-01-03T00:00:00.000Z",
    tasks: [
      { agent: "worker", task: secretTask, model: "m-a" },
      { agent: "explorer", task: "plain task" },
    ],
  });
  // child 0 有 session.jsonl (mtime → endedAtMs), child 1 缺文件
  const child0 = path.join(dir, "run-0");
  fs.mkdirSync(child0, { recursive: true });
  fs.writeFileSync(path.join(child0, "session.jsonl"), "x\n");

  const rec = readArchivedRun(dir)!;
  assert.equal(rec.mode, "parallel");
  assert.equal(rec.status, "done"); // 批次 run.json 无 settle 补丁 → undefined → done
  assert.equal(rec.taskCount, 2);
  assert.equal(rec.children.length, 2);

  const c0 = rec.children[0];
  assert.equal(c0.agent, "worker");
  assert.equal(c0.model, "m-a");
  assert.equal(c0.sessionDir, path.join(dir, "run-0"));
  assert.equal(c0.sessionFile, path.join(dir, "run-0", "session.jsonl"));
  assert.ok(typeof c0.endedAtMs === "number");
  // 脱敏收口: 密钥遮蔽 + 单行化 + 原始 task 不原样出现
  assert.ok(!c0.taskPreview.includes("sk-abcdefgh12345678"), "secret must be redacted");
  assert.ok(!c0.taskPreview.includes("\n"), "preview must be single-line");
  assert.ok(c0.taskPreview.includes("[REDACTED]"));

  const c1 = rec.children[1];
  assert.equal(c1.taskPreview, "plain task");
  assert.equal(c1.model, undefined);
  assert.equal(c1.endedAtMs, undefined); // 缺文件 → 不填
  fs.rmSync(dir, { recursive: true, force: true });
});
