// ISSUE-03 TS-001~003 切片测试: timeout 定时器 + 三阶段信号 + 诊断载荷.
// 接缝 (EXECUTION.md 测试策略接缝 1/2/3): fake ExtensionAPI 捕获 registerTool 后直调 execute(single);
// fake pi 经 PI_SUBAGENT_PI_BINARY env 注入; 临时 HOME 隔离; fakeCtx 注入 getContextUsage.
// 覆盖: M1-D005 (timeout 15min + 诊断), M2-D002(b) 中止载荷, M3-05 诊断字段清单,
// 调和 11 (中止标记优先 stopReason), M3-01 考察点 6 close 收尾 (error && exitCode 0 → 1).

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

// ISSUE-03 超时场景 fake pi (slow/graceful-sigint-exit 由 FAKE_PI_SCENARIO 选择).
const SLOW_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

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
};

// 临时 HOME 隔离 + fake pi 跑一次 single execute; 支持注入 getContextUsage / 信号记录文件.
async function runSingleWithTimeout(
  home: string,
  opts: {
    timeoutMs?: number;
    getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
    scenario?: string;
    signalFile?: string;
  },
): Promise<{ result: ExecutedResult; details: SingleDetails }> {
  const prev: Record<string, string | undefined> = {};
  for (const k of ["PI_SUBAGENT_PI_BINARY", "FAKE_PI_SCENARIO", "FAKE_PI_SIGNAL_FILE"]) {
    prev[k] = process.env[k];
  }
  try {
    const result = await withHome(home, async () => {
      process.env.PI_SUBAGENT_PI_BINARY = SLOW_PI;
      process.env.FAKE_PI_SCENARIO = opts.scenario ?? "assistant-stop";
      if (opts.signalFile !== undefined) process.env.FAKE_PI_SIGNAL_FILE = opts.signalFile;
      const tool = captureTool();
      const ctx = {
        cwd: home,
        getContextUsage: opts.getContextUsage,
      } as unknown as ExtensionContext;
      const params: Record<string, unknown> = { agent: "Alpha", task: "做点事" };
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

// ---- TS-001: timeout 定时器 + 三阶段信号 + 诊断载荷 ----

test("TC-001 timeout aborts with diagnostic payload", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // ISSUE-03 TS-001: timeoutMs=800, slow fake 每 200ms 发一条 assistant 且不退出 → 超时路径稳定触发,
    // 超时前已累积部分输出 (模型级 stopReason "stop" 被中止标记覆盖为 "timeout").
    const { result, details } = await runSingleWithTimeout(home, { timeoutMs: 800, scenario: "slow" });

    // M2-D002(b): 超时结果 isError = true, stopReason 强制 "timeout" (调和 11 中止标记优先), exitCode 1.
    assert.equal(result.isError, true);
    assert.equal(details.stopReason, "timeout");
    assert.equal(details.exitCode, 1);

    // finalOutput 拼装: error + "\n\nPartial output before timeout:\n" + 部分输出.
    const text = resultText(result);
    assert.ok(text.includes("Subagent timed out after 800ms."), `expected timeout text, got: ${text}`);
    // M6 修复 1: 中止结果的 content 须拼入 details 关键字段 (pi 只把 content 喂给模型, details 仅供 TUI).
    assert.ok(text.includes(details.runId), `content 应含 runId, got: ${text}`);
    assert.ok(text.includes(details.sessionDir), `content 应含 sessionDir, got: ${text}`);
    assert.ok(text.includes("usage"), `content 应含 usage 摘要, got: ${text}`);
    assert.ok(text.includes("resume"), `content 应含 resume 指引 (hint), got: ${text}`);
    assert.ok(
      typeof details.partialOutput === "string" && details.partialOutput.length > 0,
      `partialOutput 应为超时前已累积文本, got: ${JSON.stringify(details.partialOutput)}`,
    );
    assert.ok(
      text.startsWith(
        `Subagent timed out after 800ms.\n\nPartial output before timeout:\n${details.partialOutput}`,
      ),
      `content 应以 error+partial 开头 (后接 M6 信息块), got: ${text}`,
    );

    // M2-D006: details 仍带 runId/sessionDir; session 目录保留 (可 resume 前提, M1-D004).
    assert.match(details.runId, /^run-\d{8}-\d{6}-[0-9a-f]{6}$/);
    assert.equal(details.sessionDir, path.join(home, ".pi", "agent", "slim-subagent", "sessions", details.runId));
    assert.ok(fs.existsSync(details.sessionDir), "超时后 session 目录应保留");

    // 修复项 3: usage 同正常 6 字段 (M2-D002(b)) — slow fake 每条 assistant 带 usage
    // {input:10, output:5, cacheRead:0, cacheWrite:0, cost:{total:0.01}}, 超时前收到的 N 条累加,
    // 断言值与 turns 成正比 (turns 数受调度抖动影响, 不钉死绝对值).
    const u = details.usage;
    assert.ok(u.turns >= 1, `超时前应至少收到一条 assistant, got turns=${u.turns}`);
    assert.equal(u.input, 10 * u.turns, "input 应逐条累加 10");
    assert.equal(u.output, 5 * u.turns, "output 应逐条累加 5");
    assert.equal(u.cacheRead, 0, "slow fake 不报 cacheRead");
    assert.equal(u.cacheWrite, 0, "slow fake 不报 cacheWrite");
    assert.ok(
      Math.abs(u.cost - 0.01 * u.turns) < 1e-9,
      `cost 应逐条累加 0.01, got cost=${u.cost}, turns=${u.turns}`,
    );
  } finally {
    cleanup(home);
  }
});

test("TC-002 timeout signal sequence: SIGINT@0 → SIGTERM@+~1s → SIGKILL@+~4s", async () => {
  // 真实信号时序断言 (宽松区间, node 调度抖动容忍): fake-pi 记录 SIGINT/SIGTERM 时间戳;
  // SIGKILL 不可捕获, 由 slow 场景 heartbeat 最后一条时间戳推断 (≈ SIGKILL 时刻, 误差 ≤ 200ms).
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const signalFile = path.join(home, "signals.jsonl");
    const { result, details } = await runSingleWithTimeout(home, {
      timeoutMs: 500,
      scenario: "slow",
      signalFile,
    });

    assert.equal(result.isError, true);
    const records = fs
      .readFileSync(signalFile, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { signal: string; ts: number });
    const ts = (sig: string) => records.find((r) => r.signal === sig)?.ts;
    const start = ts("start");
    const sigint = ts("SIGINT");
    const sigterm = ts("SIGTERM");

    // SIGINT@0: 相对 fake 启动 ≈ timeoutMs (宽松: 子进程启动 ~百 ms 级, 不晚于 2.5s).
    assert.ok(sigint !== undefined, "SIGINT 应被 fake 记录");
    if (start !== undefined) {
      assert.ok(
        sigint! - start >= 0 && sigint! - start < 2500,
        `SIGINT 应在启动后 ~500ms 到达, got ${sigint! - start}ms`,
      );
    }

    if (sigterm !== undefined) {
      // SIGTERM@+~1s (宽松区间). ISSUE-02 TS-004 收口: drain 管线 (terminal stop + 1s grace) 与 timeout 管线
      // 独立共存, 互不让路 (原码 execution.ts:1004-1027 vs 585-605 同款); slow 场景第一条 assistant 即 terminal stop,
      // drain 先 arm (~100ms + 1s ≈ 1.05s 发 SIGTERM), 可先于 timeout 的 SIGTERM (timeout 0.5s + 1s = 1.5s) 到达,
      // 故 SIGINT→SIGTERM 实测间隔 ≈ 0.5-0.75s (drain 路径) 或 1s (timeout 路径); 下界放宽到 0.45s 吸收共存时序.
      assert.ok(
        sigterm - sigint! >= 450 && sigterm - sigint! <= 1600,
        `SIGTERM 应在 SIGINT 后 ~1s, got ${sigterm - sigint!}ms`,
      );
      // SIGKILL@+~4s (相对 timeout 触发点 @0, 即 SIGTERM 后 ~3s): 子进程被 SIGKILL 杀死 (processSignal),
      // 最后一条 heartbeat ≈ SIGKILL 时刻 (误差 ≤ 200ms 心跳间隔). 宽松区间 [2s, 4.5s].
      if (details.processSignal === "SIGKILL") {
        const lastHeartbeat = Math.max(...records.filter((r) => r.signal === "heartbeat").map((r) => r.ts));
        assert.ok(
          lastHeartbeat - sigterm >= 2000 && lastHeartbeat - sigterm <= 4500,
          `SIGKILL 应在 SIGTERM 后 ~3s, got 最后心跳差 ${lastHeartbeat - sigterm}ms`,
        );
      }
    } else {
      // 子进程在 SIGTERM 前已退出 → 按实际到达阶段断言, 不伪造 SIGTERM/SIGKILL.
      assert.equal(details.exitCode, 1, "超时结果 exitCode 应为 1");
    }
  } finally {
    cleanup(home);
  }
});

test("TC-003 timeout session dir retained for resume", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const { result, details } = await runSingleWithTimeout(home, { timeoutMs: 10 });

    assert.equal(result.isError, true);
    // session 目录保留 (可 resume 前提).
    assert.ok(fs.existsSync(details.sessionDir), "超时后 session 目录应保留");
    // run.json 应存在.
    const runJsonPath = path.join(details.sessionDir, "run.json");
    assert.ok(fs.existsSync(runJsonPath), "超时后 run.json 应存在");
    const runJson = JSON.parse(fs.readFileSync(runJsonPath, "utf-8"));
    assert.equal(runJson.agent, "Alpha");
  } finally {
    cleanup(home);
  }
});

// ---- TS-002: diagnostics 数据源 ----

test("TC-004 diagnostics prefer ctx.getContextUsage", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const { details } = await runSingleWithTimeout(home, {
      timeoutMs: 10,
      getContextUsage: () => ({ tokens: 50000, contextWindow: 128000, percent: 39 }),
    });

    assert.equal(details.contextPercent, 39);
    assert.equal(details.contextWindow, 128000);
    // M3-05 规则 2: getContextUsage().tokens 可得时优先于 message totalTokens.
    assert.equal(details.contextTokens, 50000);
    assert.ok(typeof details.hint === "string", "有百分比时应产出 hint");
    assert.ok(details.hint!.includes("resume"), "低占用应建议 resume");
  } finally {
    cleanup(home);
  }
});

test("TC-005 diagnostics with ctx unavailable falls back to message fields", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // 不注入 getContextUsage → contextPercent 显式 null (M3-05 字段 1: 不可用则 null),
    // contextWindow 保持 undefined (M3-05 字段 3: JSON 流场景缺省); hint 走回退产出.
    const { result, details } = await runSingleWithTimeout(home, { timeoutMs: 10 });

    assert.equal(result.isError, true);
    assert.equal(details.contextPercent, null);
    assert.equal(details.contextWindow, undefined);
    assert.equal(details.stopReason, "timeout");
    // M3-05 回退路径: hint 仍须产出 — 中文一句话, 含 "resume 恢复 / 新起子代理" 指引.
    assert.ok(typeof details.hint === "string" && details.hint.length > 0, "ctx 不可得时 hint 应回退产出");
    assert.ok(details.hint!.includes("resume"), `hint 应含 resume 恢复指引: ${details.hint}`);
    assert.ok(
      details.hint!.includes("新起子代理") || details.hint!.includes("新起"),
      `hint 应含新起子代理指引: ${details.hint}`,
    );
    // contextTokens 可能来自 message (若 fake 在超时前已发事件) 或 undefined.
  } finally {
    cleanup(home);
  }
});

test("TC-005d hint only produced for aborted (timeout) results, not normal completion", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // 正常完成 (scenario assistant-stop, 不传 timeoutMs) + ctx 可用且 percent 非 null:
    // 诊断字段照常打包, 但 hint 不得产出 — 修复前正常完成结果也带 "建议 resume..." 误导已完成任务.
    const { result, details } = await runSingleWithTimeout(home, {
      getContextUsage: () => ({ tokens: 50000, contextWindow: 128000, percent: 39 }),
    });

    assert.equal(result.isError, undefined, "正常完成不应 isError");
    assert.equal(details.stopReason, "stop");
    assert.equal(details.contextPercent, 39, "正常完成诊断字段仍应打包");
    assert.equal(details.contextWindow, 128000);
    assert.equal(details.hint, undefined, "正常完成结果不得产出 hint (仅中止结果带 hint)");
    // M6 修复 1 反向: 正常完成的 content 保持纯净, 不拼 details 信息块.
    assert.ok(!resultText(result).includes("runId:"), `正常完成 content 不应含信息块, got: ${resultText(result)}`);
  } finally {
    cleanup(home);
  }
});

test("TC-005b diagnostics high occupancy hint suggests new agent", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const { details } = await runSingleWithTimeout(home, {
      timeoutMs: 10,
      getContextUsage: () => ({ tokens: 80000, contextWindow: 128000, percent: 62.5 }),
    });

    assert.equal(details.contextPercent, 62.5);
    assert.ok(typeof details.hint === "string");
    assert.ok(
      details.hint!.includes("新起") || details.hint!.toLowerCase().includes("new"),
      `high occupancy hint should suggest new agent, got: ${details.hint}`,
    );
  } finally {
    cleanup(home);
  }
});

// ---- 修复项 2 回归: 优雅 SIGINT 退出 (exit 0) 不得抹掉中止语义 ----

test("TC-005c graceful SIGINT exit still yields timeout stopReason and exitCode 1", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // 复现审查实证缺口: 子进程接住 SIGINT 后优雅 exit 0 (模拟 pi 收尾写盘) — 修复前
    // details.exitCode=0 / isError undefined / stopReason 残留模型级 "stop".
    const { result, details } = await runSingleWithTimeout(home, {
      timeoutMs: 800,
      scenario: "graceful-sigint-exit",
    });

    assert.equal(result.isError, true, "优雅退出不应抹掉中止错误标记");
    assert.equal(details.stopReason, "timeout", "中止标记优先于模型级 stopReason (调和 11)");
    assert.equal(details.exitCode, 1, "超时结果 exitCode 恒为 1 (M3-01 考察点 3/6)");
    const text = resultText(result);
    assert.ok(text.includes("Subagent timed out after 800ms."), `expected timeout text, got: ${text}`);
    assert.equal(details.partialOutput, "graceful partial text", "partialOutput 应为超时前已发出的 assistant 文本");
  } finally {
    cleanup(home);
  }
});

// ---- TS-003: 参数校验与默认值 ----

test("TC-006 timeoutMs zero/negative/NaN/non-integer fails validation", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // 修复项 1: 原始值透传, 校验层统一兜 0/负数/NaN/非整数
    // (修复前 0/-5/NaN 被 index.ts 的 >0 过滤成 undefined, 静默按默认 15min 跑).
    for (const bad of [0, -5, NaN, 1.5]) {
      const { result } = await runSingleWithTimeout(home, { timeoutMs: bad });
      assert.equal(result.isError, true, `timeoutMs=${bad} 应报校验错误`);
      assert.ok(
        resultText(result).includes("timeoutMs must be a positive integer"),
        `timeoutMs=${bad}: ${resultText(result)}`,
      );
    }
  } finally {
    cleanup(home);
  }
});

test("TC-007 no timeoutMs param runs with default 15min (short task not killed)", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // 不传 timeoutMs, fake 快速完成 → 应正常返回, 不被 default 15min 误杀.
    const { result, details } = await runSingleWithTimeout(home, {});

    assert.equal(result.isError, undefined, "短任务不应被默认超时误杀");
    assert.equal(resultText(result), "Hello from fake assistant");
    // 正常 usage.
    assert.equal(details.usage.turns, 1);
    assert.equal(details.stopReason, "stop");
  } finally {
    cleanup(home);
  }
});
