// termination 接口级 TDD (架构深化 候选壹): 4 套定时器单一所有者.
// 覆盖: armTimeout 触发与 dispose 取消, startAbortSequence 立即 SIGINT (+1s SIGTERM), protocolKill 立即 SIGTERM
// 与 exit 守卫, startFinalDrain grace 后 SIGTERM + forced 标记 + onDrainForced, watchCancel 已中止信号立即杀.
// 慢路径 (+4s SIGKILL/drain 强杀) 由 e2e (timeout/drain/line-limit) 断言, 此处只打快速面; 日志走 withHome 隔离.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerminationSupervisor } from "../termination.ts";
import { makeTempHome, withHome } from "./helpers.ts";

function fakeProc() {
  const sent: NodeJS.Signals[] = [];
  return {
    sent,
    killed: false,
    kill(sig: NodeJS.Signals): boolean {
      sent.push(sig);
      return true;
    },
  };
}

function mkSup(proc: ReturnType<typeof fakeProc>, over: Partial<Parameters<typeof createTerminationSupervisor>[0]> = {}) {
  const calls = { timeout: 0, drainForced: 0 };
  const sup = createTerminationSupervisor({
    proc,
    isSettled: () => false,
    isChildExited: () => false,
    onTimeout: () => { calls.timeout++; },
    onDrainForced: () => { calls.drainForced++; },
    logCtx: { mode: "single", agent: "t" },
    ...over,
  });
  return { sup, calls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("armTimeout fires onTimeout; dispose cancels pending", async () => {
  await withHome(makeTempHome(), async () => {
    const proc = fakeProc();
    const { sup, calls } = mkSup(proc);
    sup.armTimeout(20);
    await sleep(60);
    assert.equal(calls.timeout, 1);

    const proc2 = fakeProc();
    const { sup: sup2, calls: calls2 } = mkSup(proc2);
    sup2.armTimeout(20);
    sup2.dispose();
    await sleep(60);
    assert.equal(calls2.timeout, 0);
  });
});

test("startAbortSequence: SIGINT 立即, SIGTERM +1s", async () => {
  await withHome(makeTempHome(), async () => {
    const proc = fakeProc();
    const { sup } = mkSup(proc);
    sup.startAbortSequence();
    assert.deepEqual(proc.sent, ["SIGINT"]);
    await sleep(1150);
    assert.deepEqual(proc.sent, ["SIGINT", "SIGTERM"]);
    sup.dispose(); // 清 +4s SIGKILL (慢路径 e2e 覆盖)
  });
});

test("protocolKill: SIGTERM 立即; 已 exit 不发", async () => {
  await withHome(makeTempHome(), async () => {
    const proc = fakeProc();
    const { sup } = mkSup(proc);
    sup.protocolKill();
    assert.deepEqual(proc.sent, ["SIGTERM"]);
    sup.notifyChildExited(); // 清 3s 强杀定时器

    const proc2 = fakeProc();
    const { sup: sup2 } = mkSup(proc2, { isChildExited: () => true });
    sup2.protocolKill();
    assert.deepEqual(proc2.sent, []);
  });
});

test("startFinalDrain: grace 后 SIGTERM + forced 标记 + onDrainForced; 守卫不重入", async () => {
  await withHome(makeTempHome(), async () => {
    const proc = fakeProc();
    const { sup, calls } = mkSup(proc);
    sup.startFinalDrain();
    sup.startFinalDrain(); // 重入守卫: 不重复启动
    assert.deepEqual(proc.sent, []); // grace 期内不发信号
    await sleep(1150);
    assert.deepEqual(proc.sent, ["SIGTERM"]);
    assert.equal(sup.forcedTerminationSignal, true);
    assert.equal(calls.drainForced, 1);
    sup.dispose(); // 清 +3s SIGKILL

    const proc2 = fakeProc();
    const { sup: sup2 } = mkSup(proc2, { isChildExited: () => true });
    sup2.startFinalDrain(); // 已 exit → 不启动
    await sleep(1150);
    assert.deepEqual(proc2.sent, []);
    assert.equal(sup2.forcedTerminationSignal, false);
  });
});

test("watchCancel: 已中止信号立即 SIGTERM; dispose 移除监听", async () => {
  await withHome(makeTempHome(), async () => {
    const proc = fakeProc();
    proc.kill = (sig) => { proc.sent.push(sig); proc.killed = true; return true; }; // 杀即死, 3s 兜底空转
    const { sup } = mkSup(proc);
    const ctrl = new AbortController();
    ctrl.abort();
    sup.watchCancel(ctrl.signal);
    assert.deepEqual(proc.sent, ["SIGTERM"]);

    const proc2 = fakeProc();
    const { sup: sup2 } = mkSup(proc2);
    const ctrl2 = new AbortController();
    sup2.watchCancel(ctrl2.signal);
    sup2.dispose(); // 移除监听 → 后续 abort 不再杀
    ctrl2.abort();
    await sleep(30);
    assert.deepEqual(proc2.sent, []);
  });
});
