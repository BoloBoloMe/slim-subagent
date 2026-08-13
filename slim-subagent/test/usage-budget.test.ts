// ISSUE-04 TS-001 切片测试: usageBudget 运行中终止 (选项 B) — 触顶终止序列 + 诊断载荷.
// 接缝 (EXECUTION.md 测试策略接缝 2/3): fake pi (budget 场景, FAKE_PI_USAGE/MESSAGES/HANG 控制) +
// PI_SUBAGENT_PI_BINARY env 注入; 临时 HOME 隔离; 信号时序经 FAKE_PI_SIGNAL_FILE 记录.
// 覆盖: M1-D006 (token 上限运行中终止), M2-D003 (口径 input+output+cacheWrite, cacheRead 不计),
// M2-D002(b) 中止载荷 (stopReason usage_budget + 诊断载荷), M3-02 考察点 5 选项 B 挂点 (usage 累加后立即比对).

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
  SKIP_POSIX_SIGNALS,
  type ExecutedResult,
} from "./helpers.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

type SingleDetails = {
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
  runId: string;
  sessionDir: string;
  exitCode: number;
  processSignal?: string;
  contextTokens?: number;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  contextPercent?: number | null;
  contextWindow?: number;
  partialOutput?: string;
  hint?: string;
  usageBudget?: number;
  budgetAuto?: boolean;
};

// 临时 HOME 隔离 + fake pi 跑一次 single execute; 支持注入 usageBudget / timeoutMs / budget 场景开关.
async function runSingleWithBudget(
  home: string,
  opts: {
    usageBudget?: unknown;
    timeoutMs?: number;
    scenario?: string;
    signalFile?: string;
    usage?: string; // FAKE_PI_USAGE JSON
    messages?: number; // FAKE_PI_MESSAGES
    hang?: boolean; // FAKE_PI_HANG
    intervalMs?: number; // FAKE_PI_INTERVAL_MS
  },
): Promise<{ result: ExecutedResult; details: SingleDetails }> {
  const prev: Record<string, string | undefined> = {};
  for (const k of [
    "PI_SUBAGENT_PI_BINARY",
    "FAKE_PI_SCENARIO",
    "FAKE_PI_SIGNAL_FILE",
    "FAKE_PI_USAGE",
    "FAKE_PI_MESSAGES",
    "FAKE_PI_HANG",
    "FAKE_PI_INTERVAL_MS",
  ]) {
    prev[k] = process.env[k];
  }
  try {
    const result = await withHome(home, async () => {
      process.env.PI_SUBAGENT_PI_BINARY = FAKE_PI;
      process.env.FAKE_PI_SCENARIO = opts.scenario ?? "assistant-stop";
      if (opts.signalFile !== undefined) process.env.FAKE_PI_SIGNAL_FILE = opts.signalFile;
      if (opts.usage !== undefined) process.env.FAKE_PI_USAGE = opts.usage;
      if (opts.messages !== undefined) process.env.FAKE_PI_MESSAGES = String(opts.messages);
      if (opts.hang !== undefined) process.env.FAKE_PI_HANG = opts.hang ? "1" : "0";
      if (opts.intervalMs !== undefined) process.env.FAKE_PI_INTERVAL_MS = String(opts.intervalMs);
      const tool = captureTool();
      const ctx = { cwd: home } as unknown as ExtensionContext;
      const params: Record<string, unknown> = { agent: "Alpha", task: "做点事" };
      if (opts.usageBudget !== undefined) params.usageBudget = opts.usageBudget;
      if (opts.timeoutMs !== undefined) params.timeoutMs = opts.timeoutMs;
      return tool.execute("call-1", params, undefined, undefined, ctx);
    });
    return { result, details: result.details as SingleDetails };
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ---- TS-001: 触顶终止 + 诊断载荷 (M1-D006, M2-D002(b)) ----

test("TC-001 usage budget aborts mid-flight at pinned threshold", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // budget 场景默认 usage {input:10, output:5, cacheRead:0, cacheWrite:0} → 每条 used=15;
    // budget=20: 第 1 条 (used 15) 未触顶, 第 2 条 (used 30) 触顶 → 终止序列 (先写失败测试: budget 分支未写).
    const { result, details } = await runSingleWithBudget(home, { usageBudget: 20, scenario: "budget" });

    // M2-D002(b): 触顶结果 isError=true, stopReason 强制 "usage_budget" (调和 11 中止标记优先), exitCode 1.
    assert.equal(result.isError, true);
    assert.equal(details.stopReason, "usage_budget");
    assert.equal(details.exitCode, 1);

    // error 文案含 used/budget 数值; finalOutput 拼装同 timeout (error + 部分输出).
    const text = resultText(result);
    assert.ok(text.includes("Usage budget exhausted: reported tokens 30 reached limit 20."), `got: ${text}`);
    assert.ok(
      typeof details.partialOutput === "string" && details.partialOutput.length > 0,
      `partialOutput 应为触顶前已累积文本, got: ${JSON.stringify(details.partialOutput)}`,
    );
    // M6 修复 1: 中止 content = 原文 + 信息块 (runId/sessionDir/usage/hint), 故全等改前缀 + 关键字段断言.
    assert.ok(
      text.startsWith(
        `Usage budget exhausted: reported tokens 30 reached limit 20.\n\nPartial output before abort:\n${details.partialOutput}`,
      ),
      `got: ${text}`,
    );
    assert.ok(text.includes(details.runId), `content 应含 runId, got: ${text}`);
    assert.ok(text.includes(details.sessionDir), `content 应含 sessionDir, got: ${text}`);
    assert.ok(text.includes("usage"), `content 应含 usage 摘要, got: ${text}`);
    assert.ok(text.includes("resume"), `content 应含 resume 指引 (hint), got: ${text}`);

    // 诊断载荷同 ISSUE-03: runId/sessionDir 保留 (可 resume 前提, M1-D004), usage 6 字段, model, hint.
    assert.match(details.runId, /^run-\d{8}-\d{6}-[0-9a-f]{6}$/);
    assert.equal(details.sessionDir, path.join(home, ".pi", "agent", "slim-subagent", "sessions", details.runId));
    assert.ok(fs.existsSync(details.sessionDir), "触顶后 session 目录应保留");
    assert.equal(details.usage.turns, 2);
    assert.equal(details.usage.input, 20, "input 应逐条累加 10");
    assert.equal(details.usage.output, 10, "output 应逐条累加 5");
    assert.equal(details.usage.cacheRead, 0);
    assert.equal(details.usage.cacheWrite, 0);
    assert.ok(Math.abs(details.usage.cost - 0.03) < 1e-9, `cost 应累加 0.01+0.02, got ${details.usage.cost}`);
    assert.equal(details.model, "fake-model-1");
    assert.ok(typeof details.hint === "string" && details.hint!.includes("resume"), "触顶中止应产出 hint");
  } finally {
    cleanup(home);
  }
});

test("TC-002 usage budget signal sequence: SIGINT@0 → SIGTERM@+~1s → SIGKILL@+~4s", { skip: SKIP_POSIX_SIGNALS }, async () => {
  // 真实信号时序断言 (宽松区间, 同 ISSUE-03 TC-002 手法): hang=1 → 触顶后 fake 不退
  // (接住 SIGINT/SIGTERM 继续跑), 由 budget 管线 SIGKILL 杀死; 心跳最后一条 ≈ SIGKILL 时刻.
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const signalFile = path.join(home, "signals.jsonl");
    const { result, details } = await runSingleWithBudget(home, {
      usageBudget: 20,
      scenario: "budget",
      hang: true,
      signalFile,
    });

    assert.equal(result.isError, true);
    assert.equal(details.stopReason, "usage_budget");
    const records = fs
      .readFileSync(signalFile, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { signal: string; ts: number });
    const ts = (sig: string) => records.find((r) => r.signal === sig)?.ts;
    const start = ts("start");
    const sigint = ts("SIGINT");
    const sigterm = ts("SIGTERM");

    // SIGINT@0: 相对 fake 启动 ≈ 第 2 条消息触顶时刻 (~200ms; 宽松 < 2.5s).
    assert.ok(sigint !== undefined, "触顶后应发 SIGINT");
    if (start !== undefined) {
      assert.ok(
        sigint! - start >= 0 && sigint! - start < 2500,
        `SIGINT 应在触顶时到达, got ${sigint! - start}ms`,
      );
    }

    if (sigterm !== undefined) {
      // SIGTERM@+~1s (宽松区间); hang 场景无 drain 干扰 (stopReason toolCall 非 terminal).
      assert.ok(
        sigterm - sigint! >= 450 && sigterm - sigint! <= 1600,
        `SIGTERM 应在 SIGINT 后 ~1s, got ${sigterm - sigint!}ms`,
      );
      // SIGKILL@+~4s (相对触顶点, 即 SIGTERM 后 ~3s): 最后一条 heartbeat ≈ SIGKILL (误差 ≤ 心跳间隔).
      if (details.processSignal === "SIGKILL") {
        const lastHeartbeat = Math.max(...records.filter((r) => r.signal === "heartbeat").map((r) => r.ts));
        assert.ok(
          lastHeartbeat - sigterm >= 2000 && lastHeartbeat - sigterm <= 4500,
          `SIGKILL 应在 SIGTERM 后 ~3s, got 最后心跳差 ${lastHeartbeat - sigterm}ms`,
        );
      }
    } else {
      // 子进程在 SIGTERM 前已退出 → 按实际到达阶段断言, 不伪造 SIGTERM/SIGKILL.
      assert.equal(details.exitCode, 1, "触顶结果 exitCode 应为 1");
    }
  } finally {
    cleanup(home);
  }
});

// ---- TS-002: 口径边界 (M2-D003) ----

test("TC-003 cacheRead excluded from budget meter", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // usage {input:5, output:5, cacheRead:1000, cacheWrite:0} → used=10/条, 2 条累计 20 << 50;
    // cacheRead 不计入 → 不触顶, 正常完成 (先写失败测试: 口径未写).
    const { result, details } = await runSingleWithBudget(home, {
      usageBudget: 50,
      scenario: "budget",
      usage: '{"input":5,"output":5,"cacheRead":1000,"cacheWrite":0}',
      messages: 2,
    });

    assert.equal(result.isError, undefined, "cacheRead 不计入 → 不应触顶");
    assert.equal(details.exitCode, 0);
    assert.notEqual(details.stopReason, "usage_budget");
    assert.equal(details.error, undefined, "正常完成无错误");
    assert.equal(details.hint, undefined, "正常完成不产出 hint");
    // cacheRead 仍完整报在 usage 统计里供诊断 (M2-D003).
    assert.equal(details.usage.cacheRead, 2000);
    assert.equal(details.usage.input, 10);
    assert.equal(details.usage.output, 10);
    assert.equal(details.usage.cacheWrite, 0);
    assert.equal(details.usage.turns, 2);
    assert.equal(resultText(result), "budget partial 2");
  } finally {
    cleanup(home);
  }
});

test("TC-004 cacheWrite counted with >= boundary", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // used = input+output+cacheWrite = 5+3+2 = 10.
    // budget 恰等于 used → 触顶 (>= 边界, cacheWrite 计入).
    const eq = await runSingleWithBudget(home, {
      usageBudget: 10,
      scenario: "budget",
      usage: '{"input":5,"output":3,"cacheRead":0,"cacheWrite":2}',
      messages: 1,
    });
    assert.equal(eq.result.isError, true);
    assert.equal(eq.details.stopReason, "usage_budget", "used == budget 应触顶 (>= 边界)");
    assert.ok(
      resultText(eq.result).includes("Usage budget exhausted: reported tokens 10 reached limit 10."),
      `got: ${resultText(eq.result)}`,
    );

    // budget 高于 used (11 > 10) → 不触顶 (严格 < 才放行, 非 >).
    const over = await runSingleWithBudget(home, {
      usageBudget: 11,
      scenario: "budget",
      usage: '{"input":5,"output":3,"cacheRead":0,"cacheWrite":2}',
      messages: 1,
    });
    assert.notEqual(over.details.stopReason, "usage_budget", "used < budget 不应触顶");
    assert.equal(over.result.isError, undefined);
    assert.equal(over.details.exitCode, 0);
  } finally {
    cleanup(home);
  }
});

test("TC-005 no usageBudget param → auto budget (0.7 × fallback window), no abort, content pure", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const { result, details } = await runSingleWithBudget(home, { scenario: "assistant-stop" });

    assert.equal(result.isError, undefined);
    assert.equal(details.stopReason, "stop");
    assert.equal(details.exitCode, 0);
    assert.equal(details.error, undefined, "正常载荷不得带 budget 错误痕迹");
    assert.equal(details.hint, undefined, "正常载荷不得带 hint");
    assert.equal(resultText(result), "Hello from fake assistant", "正常完成 content 保持纯净");
    // 强制预算 (M07): 未显式传 → 自动 0.7 × 兜底窗口 (ctx 无 modelRegistry → 128000) = 89600, 进 details 不进 content.
    assert.equal(details.usageBudget, 89600, "自动预算应为 0.7 × 兜底窗口");
    assert.equal(details.budgetAuto, true, "未显式传应标 auto");
  } finally {
    cleanup(home);
  }
});

test("TC-007 usageBudget zero/negative/NaN/Infinity/non-number fails validation", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // 纯 number 正数校验 (M2-D008/B 语义): 非法值显式报错, 不静默忽略不真跑.
    for (const bad of [0, -5, NaN, Infinity, "abc"]) {
      const { result } = await runSingleWithBudget(home, { usageBudget: bad, scenario: "assistant-stop" });
      assert.equal(result.isError, true, `usageBudget=${String(bad)} 应报校验错误`);
      assert.ok(
        resultText(result).includes("usageBudget must be a positive number"),
        `usageBudget=${String(bad)}: ${resultText(result)}`,
      );
    }
  } finally {
    cleanup(home);
  }
});

// ---- TS-003: 竞态 (M1-D005/D006 交互) ----

test("TC-006 first abort reason wins: timeout before budget → timeout", { skip: SKIP_POSIX_SIGNALS }, async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // 竞态: 默认 usage used=15/条; budget=25 (第 1 条 15 不触顶, 第 2 条 30 才触顶),
    // timeoutMs=100 先于第 2 条消息 (~300ms) 触发; fake hang 不退 → timeout 后第 2 条到达,
    // budget 守卫不得再触发 (先触发者胜, 不双发; 先写失败测试: 互斥守卫未写).
    const signalFile = path.join(home, "signals.jsonl");
    const { result, details } = await runSingleWithBudget(home, {
      usageBudget: 25,
      timeoutMs: 100,
      scenario: "budget",
      hang: true,
      intervalMs: 300,
      signalFile,
    });

    assert.equal(result.isError, true);
    assert.equal(details.stopReason, "timeout", "先触发者胜: timeout 先到 → stopReason=timeout");
    const text = resultText(result);
    assert.ok(text.includes("Subagent timed out after 100ms."), `timeout 文案应保留: ${text}`);
    assert.ok(!text.includes("Usage budget exhausted"), "budget 不得覆写 timeout 结果 (不双发)");
    // 不双发: 仅 timeout 管线发过一次 SIGINT (budget 守卫未触发第二次).
    const records = fs
      .readFileSync(signalFile, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { signal: string; ts: number });
    assert.equal(records.filter((r) => r.signal === "SIGINT").length, 1, "SIGINT 只应发一次");
  } finally {
    cleanup(home);
  }
});
