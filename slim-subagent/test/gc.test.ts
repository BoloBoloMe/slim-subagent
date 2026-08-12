// ISSUE-06 TS-003 切片测试: 按龄 GC (M2-D005) — 扫 sessions/*/run.json, startedAt 超 7 天且无活跃锁删目录.
// 接缝: 直接调 runSessionGc hook 函数 (不测 pi session_start 内部触发机制); 临时 HOME 隔离文件系统;
// 锁目录经 SLIM_SUBAGENT_LEASE_DIR env 隔离 (活跃锁判定依赖真实 lease 目录).
// 覆盖: 超龄删/龄期内留/无 run.json 不碰 (TC-008), 超龄但有活跃锁跳过 (TC-009).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runSessionGc } from "../resume.ts";
import { acquireSessionLease, releaseSessionLease } from "../session-lease.ts";
import { makeTempHome, withHome, cleanup } from "./helpers.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

async function withLeaseEnv<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.SLIM_SUBAGENT_LEASE_DIR;
  process.env.SLIM_SUBAGENT_LEASE_DIR = path.join(home, "leases");
  try {
    return await fn(); // 必须 await, 否则 finally 提前执行 env 被删 (隔离失效)
  } finally {
    if (prev === undefined) delete process.env.SLIM_SUBAGENT_LEASE_DIR;
    else process.env.SLIM_SUBAGENT_LEASE_DIR = prev;
  }
}

test("TC-008 gc removes sessions older than 7 days, keeps recent", async () => {
  const home = makeTempHome();
  try {
    await withLeaseEnv(home, () =>
      withHome(home, async () => {
        const root = path.join(home, ".pi", "agent", "slim-subagent", "sessions");
        const oldRun = path.join(root, "run-20000101-000000-aaaaaa");
        const recentRun = path.join(root, "run-20000101-000000-bbbbbb");
        const noJsonRun = path.join(root, "run-20000101-000000-cccccc");
        fs.mkdirSync(path.join(oldRun, "run-0"), { recursive: true });
        fs.mkdirSync(path.join(recentRun, "run-0"), { recursive: true });
        fs.mkdirSync(noJsonRun, { recursive: true });
        const writeRunJson = (dir: string, startedAt: string): void => {
          fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ runId: path.basename(dir), agent: "Alpha", startedAt }));
        };
        writeRunJson(oldRun, new Date(Date.now() - 8 * DAY_MS).toISOString());
        writeRunJson(recentRun, new Date(Date.now() - 3 * DAY_MS).toISOString());

        runSessionGc();

        assert.ok(!fs.existsSync(oldRun), "8 天前 run 目录应被删");
        assert.ok(fs.existsSync(recentRun), "3 天前 run 目录应保留 (成功 run 也不删, 调和 2)");
        assert.ok(fs.existsSync(noJsonRun), "无 run.json 目录不碰");
      }),
    );
  } finally {
    cleanup(home);
  }
});

test("TC-009 gc skips over-age run with active lease, deletes after release", async () => {
  const home = makeTempHome();
  try {
    await withLeaseEnv(home, () =>
      withHome(home, async () => {
        const root = path.join(home, ".pi", "agent", "slim-subagent", "sessions");
        const runId = "run-20000101-000000-aaaaaa";
        const dir = path.join(root, runId);
        fs.mkdirSync(path.join(dir, "run-0"), { recursive: true });
        fs.writeFileSync(
          path.join(dir, "run.json"),
          JSON.stringify({ runId, agent: "Alpha", startedAt: new Date(Date.now() - 8 * DAY_MS).toISOString(), sessionFile: "run-0/session.jsonl" }),
        );
        const sessionFile = path.join(dir, "run-0", "session.jsonl");
        fs.writeFileSync(sessionFile, "x\n");

        // 活跃锁: owner pid = 当前进程 (活) → GC 豁免.
        const lease = acquireSessionLease(sessionFile, runId);
        try {
          runSessionGc();
          assert.ok(fs.existsSync(dir), "有活跃锁的超龄 run 不应被删");
        } finally {
          releaseSessionLease(sessionFile, lease);
        }

        // 锁释放后再 GC → 删除.
        runSessionGc();
        assert.ok(!fs.existsSync(dir), "锁释放后超龄 run 应被删");
      }),
    );
  } finally {
    cleanup(home);
  }
});
