// ISSUE-02 TS-004 切片测试: 终止时序 / drain.
// 接缝 (EXECUTION.md 测试策略接缝 1/2): fake ExtensionAPI 捕获 registerTool 后直调 execute(single);
// fake pi 经 PI_SUBAGENT_PI_BINARY env 注入; FAKE_PI_SIGNAL_FILE 记录信号时间戳 (ISSUE-03 基建复用);
// SIGKILL 不可捕获 → drain-stop 场景 heartbeat 最后一条时间戳推断 (同 timeout TC-002 手法).
// 覆盖: M3-01 考察点 2 (三阶段 drain: terminal stop/agent_settled → 1s grace → SIGTERM → 3s SIGKILL,
// forcedDrainAfterFinalSuccess → exitCode 归 0), 考察点 4 (abort → SIGTERM → "terminated by signal SIGTERM." + exitCode 1).
// 时序断言宽松区间 (0.8-2s / 2-4.5s) 防 CI 抖动 (ISSUE-02 风险提示); 每测试 8s 上限.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  makeTempHome,
  withHome,
  captureTool,
  writeAgent,
  resultText,
  cleanup,
  type ExecutedResult,
} from "./helpers.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

type SingleDetails = {
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
  runId: string;
  sessionDir: string;
  exitCode: number;
  error?: string;
  processSignal?: string;
  stopReason?: string;
};

type SignalRecord = { signal: string; ts: number };

function readSignals(signalFile: string): SignalRecord[] {
  return fs
    .readFileSync(signalFile, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as SignalRecord);
}

// 临时 HOME 隔离 + fake pi 跑一次 single execute; signalFile 注入 FAKE_PI_SIGNAL_FILE (信号时序记录);
// abortAfterMs 非空时注入 AbortController, 到点 abort (取消路径 TC-015).
async function runSingleDrain(
  home: string,
  opts: { scenario: string; signalFile?: string; abortAfterMs?: number },
): Promise<{ result: ExecutedResult; details: SingleDetails }> {
  const prev: Record<string, string | undefined> = {};
  for (const k of ["PI_SUBAGENT_PI_BINARY", "FAKE_PI_SCENARIO", "FAKE_PI_SIGNAL_FILE"]) {
    prev[k] = process.env[k];
  }
  try {
    return await withHome(home, async () => {
      process.env.PI_SUBAGENT_PI_BINARY = FAKE_PI;
      process.env.FAKE_PI_SCENARIO = opts.scenario;
      if (opts.signalFile !== undefined) process.env.FAKE_PI_SIGNAL_FILE = opts.signalFile;
      const tool = captureTool();
      const ctx = { cwd: home } as ExtensionContext;
      const controller = new AbortController();
      let signal: AbortSignal | undefined;
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      if (opts.abortAfterMs !== undefined) {
        signal = controller.signal;
        abortTimer = setTimeout(() => controller.abort(), opts.abortAfterMs);
      }
      try {
        const result = await tool.execute("call-1", { agent: "Alpha", task: "做点事" }, signal, undefined, ctx);
        return { result, details: result.details as SingleDetails };
      } finally {
        if (abortTimer) clearTimeout(abortTimer);
      }
    });
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ---- TS-004 TC-012/TC-013: terminal stop 后 fake 不退出 → drain (1s SIGTERM → 3s SIGKILL), exitCode 归 0 ----

test("TC-012 terminal stop then no exit: ~1s SIGTERM, drain exitCode 0", { timeout: 8000 }, async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const signalFile = path.join(home, "signals.jsonl");
    const { result, details } = await runSingleDrain(home, { scenario: "drain-stop", signalFile });

    // M3-01 考察点 2: terminal stop 干净收到后强制收尾 → forcedDrainAfterFinalSuccess → exitCode 归 0, 无错误.
    assert.equal(details.exitCode, 0, `drain 后 exitCode 应归 0, got ${details.exitCode}`);
    assert.equal(details.error, undefined, "terminal stop 干净完成后强制收尾不得报错");
    assert.equal(details.processSignal, "SIGKILL", "fake 不退出 → 最终 SIGKILL 收尾");
    assert.equal(result.isError, undefined, "drain 成功收尾不应标记错误");
    assert.equal(resultText(result), "drain final text");
    assert.equal(details.stopReason, "stop");

    // 时序: terminal stop 后 ~1s grace → SIGTERM (宽松 0.8-2s 防 CI 抖动, ISSUE-02 风险提示).
    const records = readSignals(signalFile);
    const start = records.find((r) => r.signal === "start")?.ts;
    const sigterm = records.find((r) => r.signal === "SIGTERM")?.ts;
    assert.ok(start !== undefined, "fake 应记录 start");
    assert.ok(sigterm !== undefined, "fake 应记录 SIGTERM (drain 触发)");
    assert.ok(
      sigterm! - start >= 800 && sigterm! - start <= 2000,
      `SIGTERM 应在 terminal stop 后 ~1s 到达, got ${sigterm! - start}ms`,
    );
  } finally {
    cleanup(home);
  }
});

test("TC-013 SIGTERM ignored: +3s SIGKILL", { timeout: 8000 }, async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const signalFile = path.join(home, "signals.jsonl");
    const { result, details } = await runSingleDrain(home, { scenario: "drain-stop", signalFile });

    // SIGTERM 后 fake 仍不退 (接住继续跑) → HARD_KILL_MS=3000 后 SIGKILL 收尾 (考察点 2 时序).
    const records = readSignals(signalFile);
    const sigterm = records.find((r) => r.signal === "SIGTERM")?.ts;
    assert.ok(sigterm !== undefined, "SIGTERM 应已到达");
    // SIGKILL 不可捕获, 由 heartbeat 最后一条时间戳推断 (误差 ≤ 200ms 心跳间隔, 同 timeout TC-002 手法);
    // 相对 SIGTERM ~+3s (宽松 2-4.5s).
    const heartbeats = records.filter((r) => r.signal === "heartbeat").map((r) => r.ts);
    assert.ok(heartbeats.length > 0, "drain-stop fake 应发 heartbeat 供 SIGKILL 时刻推断");
    const lastHeartbeat = Math.max(...heartbeats);
    assert.ok(
      lastHeartbeat - sigterm >= 2000 && lastHeartbeat - sigterm <= 4500,
      `SIGKILL 应在 SIGTERM 后 ~3s, got 心跳差 ${lastHeartbeat - sigterm}ms`,
    );

    // SIGKILL 收尾后仍走 forcedDrainAfterFinalSuccess (考察点 2/6): exitCode 归 0, 无错误.
    assert.equal(details.processSignal, "SIGKILL");
    assert.equal(details.exitCode, 0, `drain SIGKILL 后 exitCode 应归 0, got ${details.exitCode}`);
    assert.equal(details.error, undefined);
    assert.equal(result.isError, undefined);
  } finally {
    cleanup(home);
  }
});

// ---- TS-004 TC-014: agent_settled 兜底 (无 terminal stop) 同样触发 drain ----

test("TC-014 agent_settled without terminal stop triggers same drain", { timeout: 8000 }, async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const signalFile = path.join(home, "signals.jsonl");
    const { result, details } = await runSingleDrain(home, { scenario: "settled", signalFile });

    // fake 只发非 terminal assistant (stopReason "toolCall") + agent_settled → drain 由 agent_settled 兜底触发.
    assert.equal(details.stopReason, "toolCall", "无 terminal stop (stopReason 应为 toolCall)");
    assert.equal(details.exitCode, 0, `agent_settled drain 后 exitCode 应归 0, got ${details.exitCode}`);
    assert.equal(details.error, undefined);
    assert.equal(details.processSignal, "SIGKILL");
    assert.equal(result.isError, undefined);
    assert.equal(resultText(result), "settled partial text");

    // 时序同 TC-012: ~1s SIGTERM (宽松 0.8-2s).
    const records = readSignals(signalFile);
    const start = records.find((r) => r.signal === "start")?.ts;
    const sigterm = records.find((r) => r.signal === "SIGTERM")?.ts;
    assert.ok(sigterm !== undefined, "agent_settled 应触发 drain 发 SIGTERM");
    assert.ok(start !== undefined);
    assert.ok(
      sigterm! - start >= 800 && sigterm! - start <= 2000,
      `agent_settled drain 的 SIGTERM 应在 ~1s, got ${sigterm! - start}ms`,
    );
  } finally {
    cleanup(home);
  }
});

// ---- TS-004 TC-015: abort 取消 (SIGTERM → error → exitCode 1) ----

test("TC-015 abort: SIGTERM, terminated-by-signal error, exitCode 1", { timeout: 8000 }, async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // abort-raw: fake 不接 SIGTERM (OS 默认杀死) → close signal=SIGTERM → processSignal 错误路径.
    const { result, details } = await runSingleDrain(home, { scenario: "abort-raw", abortAfterMs: 400 });

    // M3-01 考察点 4: 取消走通用错误路径 — error = "Subagent process terminated by signal SIGTERM.", exitCode 1, isError true.
    assert.equal(details.processSignal, "SIGTERM", "abort 应先发 SIGTERM, 子进程不接住 → 死于 SIGTERM");
    assert.equal(details.error, "Subagent process terminated by signal SIGTERM.");
    assert.equal(details.exitCode, 1, `取消后 exitCode 应为 1, got ${details.exitCode}`);
    assert.equal(result.isError, true);
    // 取消不清 stopReason: fake 已发的非 terminal 消息 stopReason 保留 (调和 11 仅中止标记覆写).
    assert.equal(details.stopReason, "toolCall");
  } finally {
    cleanup(home);
  }
});
