// ISSUE-02 遗留防御项收口: 16MB 单行上限 + failProtocol + turn_end/agent_end 聚合投影.
// 接缝 (EXECUTION.md 测试策略接缝 1/2): 同 drain.test.ts — captureTool 直调 execute(single),
// fake pi 经 PI_SUBAGENT_PI_BINARY env 注入; FAKE_PI_SIGNAL_FILE 记录信号时序.
// 行上限经模块级可注入常量 MAX_PENDING_LINE_BYTES 注入小值 1024 (ISSUE-02 风险提示: 不真造 16MB 行,
// 用较小临时常量注入, 不伪造绿); 粒度事件行 ~300B < 1024, 巨型行 ~4KB > 1024.
// 覆盖: M3-01 考察点 5 (failProtocol: 报错形态 formatProtocolOutputLimit + SIGTERM → 3s SIGKILL;
// turn_end/agent_end 巨型聚合行投影不误杀), EXECUTION.md 调和 9 (投影保留).

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
// 注入行上限 (env 缝 SLIM_SUBAGENT_PENDING_LINE_BYTES): 须大于粒度事件行 (~300B) 且远小于巨型行 (~4KB);
// 1024 留足裕度. 不真造 16MB 行 (ISSUE-02 风险提示).
const TEST_LINE_LIMIT = 1024;

type SingleDetails = {
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
  runId: string;
  sessionDir: string;
  exitCode: number;
  error?: string;
  processSignal?: string;
};

type SignalRecord = { signal: string; ts: number };

function readSignals(signalFile: string): SignalRecord[] {
  return fs
    .readFileSync(signalFile, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as SignalRecord);
}

// 行上限 env 注入 + fake pi 跑一次 single execute; signalFile 注入 FAKE_PI_SIGNAL_FILE (信号时序记录).
// env 在 execute 前设置 (single.ts 惰性读取), finally 清理防污染同文件后续测试.
async function runSingleWithLimit(
  home: string,
  opts: { scenario: string; signalFile?: string },
): Promise<{ result: ExecutedResult; details: SingleDetails }> {
  const prev: Record<string, string | undefined> = {};
  for (const k of ["PI_SUBAGENT_PI_BINARY", "FAKE_PI_SCENARIO", "FAKE_PI_SIGNAL_FILE", "SLIM_SUBAGENT_PENDING_LINE_BYTES"]) {
    prev[k] = process.env[k];
  }
  process.env.SLIM_SUBAGENT_PENDING_LINE_BYTES = String(TEST_LINE_LIMIT);
  try {
    return await withHome(home, async () => {
      process.env.PI_SUBAGENT_PI_BINARY = FAKE_PI;
      process.env.FAKE_PI_SCENARIO = opts.scenario;
      if (opts.signalFile !== undefined) process.env.FAKE_PI_SIGNAL_FILE = opts.signalFile;
      const tool = captureTool();
      const ctx = { cwd: home } as ExtensionContext;
      const result = await tool.execute("call-1", { agent: "Alpha", task: "做点事" }, undefined, undefined, ctx);
      return { result, details: result.details as SingleDetails };
    });
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ---- 超限非聚合行 → failProtocol (M3-01 考察点 5: 终止子进程 + 报错形态) ----

test("TC-LIMIT-001 oversized non-aggregate line: failProtocol error + SIGTERM + exitCode 1", { timeout: 8000 }, async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const signalFile = path.join(home, "signals.jsonl");
    const { result, details } = await runSingleWithLimit(home, { scenario: "huge-line", signalFile });

    // 报错形态 = formatProtocolOutputLimit 原文 (code/stream/limitBytes/observedBytes, M3-01 考察点 5).
    assert.match(
      details.error ?? "",
      /^protocol_output_limit: child stdout line exceeded 1024 bytes \(observed at least \d+ bytes without a newline\)\.$/,
    );
    assert.equal(details.exitCode, 1, `failProtocol 后 exitCode 应为 1, got ${details.exitCode}`);
    assert.equal(result.isError, true);
    // 终止子进程: failProtocol 应立即发 SIGTERM (fake 接住后优雅 exit 1, 故 processSignal 为空,
    // 以信号文件记录断言 SIGTERM 确实送出; fake-pi 顶层 + 场景双 listener 同刻各记一条, 取首条).
    const records = readSignals(signalFile);
    const start = records.find((r) => r.signal === "start")?.ts;
    const sigterm = records.find((r) => r.signal === "SIGTERM")?.ts;
    assert.ok(start !== undefined, "fake 应记录 start");
    assert.ok(sigterm !== undefined, "fake 应记录 SIGTERM (failProtocol 触发)");
    assert.ok(
      sigterm! - start >= 0 && sigterm! - start <= 1500,
      `failProtocol 的 SIGTERM 应在超限后立即到达, got ${sigterm! - start}ms`,
    );
  } finally {
    cleanup(home);
  }
});

test("TC-LIMIT-004 oversized turn_end garbage: invalid projection → failProtocol", { timeout: 8000 }, async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const signalFile = path.join(home, "signals.jsonl");
    const { result, details } = await runSingleWithLimit(home, { scenario: "huge-garbage", signalFile });

    // 前缀命中 turn_end 但内容非法 (对象不闭合) → 投影校验失败 → 仍走 failProtocol (旧码同款: 只投影合法冗余记录).
    assert.match(details.error ?? "", /^protocol_output_limit: child stdout line exceeded 1024 bytes /);
    assert.equal(details.exitCode, 1, `非法投影行应 failProtocol, exitCode 应为 1, got ${details.exitCode}`);
    assert.equal(result.isError, true);
    // 终止子进程: 非法投影同样立即 SIGTERM (fake 优雅 exit 1, 以信号文件断言).
    const records = readSignals(signalFile);
    assert.ok(records.some((r) => r.signal === "SIGTERM"), "非法投影应触发 failProtocol 发 SIGTERM");
  } finally {
    cleanup(home);
  }
});

// ---- 巨型聚合行投影 (turn_end/agent_end, 防大输出撑爆单行误杀, EXECUTION.md 调和 9) ----

test("TC-LIMIT-002 oversized turn_end line: projected to lifecycle event, no fail", { timeout: 8000 }, async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const signalFile = path.join(home, "signals.jsonl");
    const { result, details } = await runSingleWithLimit(home, { scenario: "huge-turn-end", signalFile });

    // 投影成功: 聚合行替换为 {"type":"turn_end"} 合成事件, 不触发 failProtocol, 运行正常完成.
    assert.equal(details.exitCode, 0, `投影成功不应 fail, exitCode 应为 0, got ${details.exitCode}`);
    assert.equal(details.error, undefined, "投影成功不得报错");
    assert.equal(result.isError, undefined, "投影成功不应标记错误");
    assert.equal(resultText(result), "Hello from fake assistant");
    const records = readSignals(signalFile);
    assert.equal(
      records.some((r) => r.signal === "SIGTERM"),
      false,
      "投影成功不得发 SIGTERM (failProtocol 未触发)",
    );
  } finally {
    cleanup(home);
  }
});

test("TC-LIMIT-003 oversized agent_end line: projected preserving willRetry, no fail", { timeout: 8000 }, async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const signalFile = path.join(home, "signals.jsonl");
    const { result, details } = await runSingleWithLimit(home, { scenario: "huge-agent-end", signalFile });

    // 投影保留 type 字段 + willRetry (旧码 PI_AGGREGATE_EVENT_PROJECTOR: agent_end 须捕获 willRetry 布尔才投影).
    assert.equal(details.exitCode, 0, `agent_end 投影成功不应 fail, exitCode 应为 0, got ${details.exitCode}`);
    assert.equal(details.error, undefined, "agent_end 投影成功不得报错");
    assert.equal(result.isError, undefined);
    assert.equal(resultText(result), "Hello from fake assistant");
    const records = readSignals(signalFile);
    assert.equal(records.some((r) => r.signal === "SIGTERM"), false, "agent_end 投影成功不得发 SIGTERM");
  } finally {
    cleanup(home);
  }
});

// ---- failProtocol 终止序列: SIGTERM 后不退 → +3s SIGKILL (与 drain 同常量 HARD_KILL_MS) ----

test("TC-LIMIT-005 failProtocol SIGTERM ignored: +3s SIGKILL", { timeout: 8000 }, async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const signalFile = path.join(home, "signals.jsonl");
    const { result, details } = await runSingleWithLimit(home, { scenario: "huge-line-ignore", signalFile });

    // SIGTERM 后 fake 仍不退 (接住继续跑) → HARD_KILL_MS=3000 后 SIGKILL (考察点 5 终止序列).
    const records = readSignals(signalFile);
    const sigterm = records.find((r) => r.signal === "SIGTERM")?.ts;
    assert.ok(sigterm !== undefined, "failProtocol 应已发 SIGTERM");
    // SIGKILL 不可捕获, 由 heartbeat 最后一条时间戳推断 (误差 ≤ 200ms, 同 drain TC-013 手法); 相对 SIGTERM ~+3s (宽松 2-4.5s).
    const heartbeats = records.filter((r) => r.signal === "heartbeat").map((r) => r.ts);
    assert.ok(heartbeats.length > 0, "fake 应发 heartbeat 供 SIGKILL 时刻推断");
    const lastHeartbeat = Math.max(...heartbeats);
    assert.ok(
      lastHeartbeat - sigterm >= 2000 && lastHeartbeat - sigterm <= 4500,
      `SIGKILL 应在 SIGTERM 后 ~3s, got 心跳差 ${lastHeartbeat - sigterm}ms`,
    );

    assert.equal(details.processSignal, "SIGKILL", "SIGTERM 被忽略 → SIGKILL 收尾");
    assert.equal(details.exitCode, 1, `failProtocol SIGKILL 后 exitCode 应为 1, got ${details.exitCode}`);
    assert.match(details.error ?? "", /^protocol_output_limit: child stdout line exceeded 1024 bytes /);
    assert.equal(result.isError, true);
  } finally {
    cleanup(home);
  }
});
