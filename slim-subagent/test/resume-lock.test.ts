// ISSUE-06 TS-002 切片测试: 并发 resume 锁 (M3-03 考察点 3 最小锁, M2-D005 锁语义).
// 接缝: 真实子进程挂住 fake (slow 场景) + FAKE_PI_ECHO_ARGV_DIR 回显 child pid (收尾强杀防泄漏);
// 锁目录经 SLIM_SUBAGENT_LEASE_DIR env 隔离到临时目录 (默认 os.tmpdir()/slim-subagent-leases, 调和 15).
// 覆盖: 活冲突报错含 "already running" 不排队 (TC-005), stale 回收 (TC-006), 子进程退出后释放 (TC-007).
// 不得测试: /proc startticks 解析细节 (processIsAlive 即可).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { leaseDirFor } from "../session-lease.ts";
import {
  makeTempHome,
  withFakePi,
  captureTool,
  writeAgent,
  cleanup,
  resultText,
  type ExecutedResult,
} from "./helpers.ts";

type SingleDetails = { runId: string; sessionDir: string; resumed?: boolean };

async function runTool(
  home: string,
  params: Record<string, unknown>,
  opts: { scenario?: string; echoArgvDir?: string } = {},
): Promise<ExecutedResult> {
  return withFakePi(home, opts.scenario ?? "assistant-stop", { echoArgvDir: opts.echoArgvDir }, async () => {
    const tool = captureTool();
    const ctx = { cwd: home } as ExtensionContext;
    return tool.execute("call-1", params, undefined, undefined, ctx);
  });
}

async function waitFor(fn: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor 超时: ${what}`);
}

// 锁目录 env 隔离 (测试临时目录; 恢复原值).
async function withLeaseEnv<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.SLIM_SUBAGENT_LEASE_DIR;
  process.env.SLIM_SUBAGENT_LEASE_DIR = path.join(home, "leases");
  try {
    return await fn(); // 注意: 必须 await, 否则 finally 在 fn() 同步返回后立即执行, env 提前被删 (隔离失效)
  } finally {
    if (prev === undefined) delete process.env.SLIM_SUBAGENT_LEASE_DIR;
    else process.env.SLIM_SUBAGENT_LEASE_DIR = prev;
  }
}

test("TC-005 concurrent resume on same run rejected, different run unaffected", async () => {
  const home = makeTempHome();
  try {
    await withLeaseEnv(home, async () => {
      writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
      const single = await runTool(home, { agent: "Alpha", task: "任务A" });
      const details = single.details as SingleDetails;
      const idA = details.runId;
      const sessionDirA = details.sessionDir;
      const sessionFileA = path.join(sessionDirA, "run-0", "session.jsonl");

      // 第一个 resume: fake 挂住不退出 (slow 场景), argv 回显到 dir (拿 child pid 供收尾强杀).
      const argvDir = path.join(home, "argv-dir");
      const first = runTool(home, { action: "resume", id: idA, task: "继续A" }, { scenario: "slow", echoArgvDir: argvDir });
      await waitFor(
        () => {
          try {
            return fs.readdirSync(argvDir).length > 0;
          } catch {
            return false;
          }
        },
        5000,
        "第一个 resume 应完成 spawn (argv 回显出现)",
      );
      // acquire 在 spawn 前 → 此时锁已持有 (owner.json 存在).
      assert.ok(fs.existsSync(path.join(leaseDirFor(sessionFileA), "owner.json")), "resume 运行中应持有锁");

      // 第二个同 id resume → already running (M2-D005: 显式报错不排队).
      const second = await runTool(home, { action: "resume", id: idA, task: "继续B" });
      assert.equal(second.isError, true);
      assert.ok(resultText(second).includes("already running"), `锁冲突应含 already running: ${resultText(second)}`);
      assert.ok(resultText(second).includes(idA), "锁冲突报错应含 runId");

      // 不同 id 不受影响.
      const singleB = await runTool(home, { agent: "Alpha", task: "任务B" });
      const idB = (singleB.details as SingleDetails).runId;
      const other = await runTool(home, { action: "resume", id: idB, task: "继续C" });
      assert.equal(other.isError, undefined, "不同 id 不受锁影响");
      assert.equal((other.details as SingleDetails).resumed, true);

      // 收尾: 强杀挂住 child → 第一个 resume 收束 → finally 释放锁.
      // 注: 首个 withFakePi 挂起未 restore, FAKE_PI_ECHO_ARGV_DIR 泄漏到后续调用, argvDir 可能含
      // 多个 child 回显 (含已死的 single/other resume child) — 全部强杀, 已死 pid 抛 ESRCH 忽略.
      const pidFiles = fs.readdirSync(argvDir).filter((f) => f.startsWith("argv-"));
      assert.ok(pidFiles.length >= 1, "应至少找到 slow child argv 回显文件");
      for (const f of pidFiles) {
        const pid = Number(f.match(/^argv-(\d+)\.json$/)?.[1]);
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // 已退出则不杀
          }
        }
      }
      // slow child 已发 terminal stop → 强杀归 forcedDrainAfterFinalSuccess (exit 0, M3-01 语义),
      // 故不断言错误态, 只断言收束后锁释放.
      await first;
      assert.ok(!fs.existsSync(leaseDirFor(sessionFileA)), "子进程退出后锁应释放");
    });
  } finally {
    cleanup(home);
  }
});

test("TC-006 stale owner pid reclaimed, resume succeeds", async () => {
  const home = makeTempHome();
  try {
    await withLeaseEnv(home, async () => {
      writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
      const single = await runTool(home, { agent: "Alpha", task: "任务A" });
      const details = single.details as SingleDetails;
      const idA = details.runId;
      const sessionFile = path.join(details.sessionDir, "run-0", "session.jsonl");

      // 伪造 owner.json: pid=不存在进程 → stale, 应被墓碑回收后 resume 成功 (重试 ≤2).
      const leaseDir = leaseDirFor(sessionFile);
      fs.mkdirSync(leaseDir, { recursive: true });
      fs.writeFileSync(
        path.join(leaseDir, "owner.json"),
        JSON.stringify({ token: "fake-stale-token", runId: idA, pid: 99999999, hostname: os.hostname(), acquiredAtMs: Date.now() }),
      );

      const res = await runTool(home, { action: "resume", id: idA, task: "继续" });
      assert.equal(res.isError, undefined, "stale 锁应被回收后 resume 成功");
      assert.equal((res.details as SingleDetails).resumed, true);
      assert.ok(!fs.existsSync(leaseDir), "resume 结束后锁应释放");
    });
  } finally {
    cleanup(home);
  }
});

test("TC-007 lock released after child exits, same id resumable again", async () => {
  const home = makeTempHome();
  try {
    await withLeaseEnv(home, async () => {
      writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
      const single = await runTool(home, { agent: "Alpha", task: "任务A" });
      const details = single.details as SingleDetails;
      const idA = details.runId;
      const sessionFile = path.join(details.sessionDir, "run-0", "session.jsonl");

      const first = await runTool(home, { action: "resume", id: idA, task: "第一轮" });
      assert.equal(first.isError, undefined);
      assert.ok(!fs.existsSync(leaseDirFor(sessionFile)), "子进程退出后锁应释放");

      const second = await runTool(home, { action: "resume", id: idA, task: "第二轮" });
      assert.equal(second.isError, undefined, "锁释放后同 id 可再 resume");
      assert.equal((second.details as SingleDetails).resumed, true);
    });
  } finally {
    cleanup(home);
  }
});
