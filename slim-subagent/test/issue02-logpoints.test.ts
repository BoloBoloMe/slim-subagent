// ISSUE-02 日志点验证 (L11-L39): 回归面窄化 — 只断言本批挂载点 (timeout/budget/protocol 投影序列).
// 范式: withFakePi + withHome 隔离, readAllLogLines 读 logRootDir 下全部 subagent-*.log (log.test.ts 同法).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempHome, withFakePi, writeAgent, captureTool, cleanup, type ExecutedResult } from "./helpers.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

function dateStampOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// 读 logRootDir() 下全部 subagent-*.log 行 (按行 JSON 解析, 坏行跳过) — 同 log.test.ts 范式.
function readAllLogLines(home: string): Record<string, unknown>[] {
  const dir = path.join(home, ".pi", "subagent_log");
  if (!fs.existsSync(dir)) return [];
  const lines: Record<string, unknown>[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".log")) continue;
    for (const line of fs.readFileSync(path.join(dir, f), "utf-8").trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // 坏行跳过 (容错)
      }
    }
  }
  return lines;
}

// 跑一次 single execute: fake pi + 临时 HOME; 日志级别强制 debug (L14 aggregate.projection 需 debug 落盘).
async function runSingle(
  home: string,
  opts: {
    scenario: string;
    timeoutMs?: number;
    usageBudget?: number;
    usage?: string; // FAKE_PI_USAGE JSON
    messages?: number; // FAKE_PI_MESSAGES
    pendingLineBytes?: number; // SLIM_SUBAGENT_PENDING_LINE_BYTES
  },
): Promise<ExecutedResult> {
  const keys = [
    "PI_SUBAGENT_PI_BINARY",
    "FAKE_PI_SCENARIO",
    "FAKE_PI_USAGE",
    "FAKE_PI_MESSAGES",
    "SLIM_SUBAGENT_PENDING_LINE_BYTES",
    "PI_SUBAGENT_LOG_LEVEL",
  ] as const;
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    return await withFakePi(home, opts.scenario, {}, async () => {
      if (opts.usage !== undefined) process.env.FAKE_PI_USAGE = opts.usage;
      if (opts.messages !== undefined) process.env.FAKE_PI_MESSAGES = String(opts.messages);
      if (opts.pendingLineBytes !== undefined) process.env.SLIM_SUBAGENT_PENDING_LINE_BYTES = String(opts.pendingLineBytes);
      process.env.PI_SUBAGENT_LOG_LEVEL = "debug";
      const tool = captureTool();
      const params: Record<string, unknown> = { agent: "Alpha", task: "做点事" };
      if (opts.timeoutMs !== undefined) params.timeoutMs = opts.timeoutMs;
      if (opts.usageBudget !== undefined) params.usageBudget = opts.usageBudget;
      return tool.execute("call-1", params, undefined, undefined, { cwd: home });
    });
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const SESSIONS = (home: string) => path.join(home, ".pi", "agent", "slim-subagent", "sessions");

function writeAlpha(home: string): void {
  writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
}

// ---- TS-002: timeout 路径 — L19 timeout.fired + L25 process.close.settled + run.json settle 补丁 ----

test("TS-002 timeout 路径挂点: timeout.fired / process.close.settled / run.json settle 补丁", async () => {
  const home = makeTempHome();
  try {
    writeAlpha(home);
    // graceful-sigint-exit: 发一条后等待, 接住 SIGINT 优雅 exit 0 → timeout 800ms 稳定触发.
    const res = await runSingle(home, { scenario: "graceful-sigint-exit", timeoutMs: 800 });

    assert.equal(res.isError, true, "timeout 应中止结果");
    const events = readAllLogLines(home);
    const of = (e: string) => events.filter((l) => l.event === e);

    // L19 (error): timeout.fired 至少 1 条.
    const fired = of("timeout.fired");
    assert.ok(fired.length >= 1, `应含 timeout.fired, got: ${JSON.stringify(events.map((l) => l.event))}`);

    // L25 (info): process.close.settled 至少 1 条, 且 stopReason 摘要 = timeout.
    const settled = of("process.close.settled");
    assert.ok(settled.length >= 1, "应含 process.close.settled");
    assert.equal((settled[0]!.data as Record<string, unknown>).stopReason, "timeout");

    // run.json 含 settle 补丁字段 (endedAtMs/finalStatus:"timeout"/usage) — 前批已挂, 此处回归断言.
    const runId = (res.details as { runId: string }).runId;
    const runJson = JSON.parse(
      fs.readFileSync(path.join(SESSIONS(home), runId, "run.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert.equal(typeof runJson.endedAtMs, "number");
    assert.equal(runJson.finalStatus, "timeout");
    assert.ok(runJson.usage && typeof (runJson.usage as { turns?: number }).turns === "number", "usage 摘要应存在");
  } finally {
    cleanup(home);
  }
});

// ---- TS-003: budget 路径 — L17 触顶 + L16 80% + L14→L13 协议序列 ----

test("TS-003 budget 触顶: usage_budget.abort (L17)", async () => {
  const home = makeTempHome();
  try {
    writeAlpha(home);
    // 每条 used = input+output+cacheWrite = 300 ≥ budget 200 → 第 1 条即触顶 (显式 budget, budgetAuto=false).
    const res = await runSingle(home, {
      scenario: "budget",
      usageBudget: 200,
      usage: '{"input":100,"output":100,"cacheWrite":100}',
    });
    assert.equal(res.isError, true, "触顶应中止结果");
    const events = readAllLogLines(home);
    const aborts = events.filter((l) => l.event === "usage_budget.abort");
    assert.ok(aborts.length >= 1, `应含 usage_budget.abort, got: ${JSON.stringify(events.map((l) => l.event))}`);
    assert.equal(aborts[0]!.level, "error");
    const d = aborts[0]!.data as Record<string, unknown>;
    assert.equal(d.used, 300);
    assert.equal(d.budget, 200);
    assert.equal(d.budgetAuto, false);
  } finally {
    cleanup(home);
  }
});

test("TS-003 budget 80% 提示: usage_budget.warn_80pct 恰 1 条 (L16)", async () => {
  const home = makeTempHome();
  try {
    writeAlpha(home);
    // FAKE_PI_MESSAGES=1 单条: used=80, budget=100 → 80 ∈ [0.8×100, 100), 不触顶.
    const res = await runSingle(home, {
      scenario: "budget",
      usageBudget: 100,
      usage: '{"input":60,"output":20,"cacheWrite":0}',
      messages: 1,
    });
    const events = readAllLogLines(home);
    const warns = events.filter((l) => l.event === "usage_budget.warn_80pct");
    assert.equal(warns.length, 1, `80% 提示应恰 1 条, got: ${JSON.stringify(events.map((l) => l.event))}`);
    assert.equal(warns[0]!.level, "warn");
    const d = warns[0]!.data as Record<string, unknown>;
    assert.equal(d.used, 80);
    assert.equal(d.budget, 100);
    assert.equal(d.budgetAuto, false);
    assert.equal(events.filter((l) => l.event === "usage_budget.abort").length, 0, "80% 用例不应触顶");
  } finally {
    cleanup(home);
  }
});

test("TS-003 协议序列: aggregate.projection(L14) 先于 protocol.output_limit(L13)", async () => {
  const home = makeTempHome();
  try {
    writeAlpha(home);
    // huge-string-unclosed: turn_end 前缀 + 未闭合字符串 — push 全成功但 finish 返回 undefined → 投影失败 → failProtocol.
    // (huge-line 是 huge_payload 前缀, acceptsAggregatePrefix 不收 → 直达 failProtocol, 只记 L13.)
    const res = await runSingle(home, { scenario: "huge-string-unclosed", pendingLineBytes: 500 });
    const events = readAllLogLines(home);
    const seq = events
      .filter((l) => l.event === "aggregate.projection" || l.event === "protocol.output_limit")
      .map((l) => l.event);
    const iProj = seq.indexOf("aggregate.projection");
    const iProt = seq.indexOf("protocol.output_limit");
    assert.ok(iProj !== -1 && iProt !== -1 && iProj < iProt, `应先 L14 后 L13, got: ${JSON.stringify(seq)}`);
    const proj = events.find((l) => l.event === "aggregate.projection")!;
    const pd = proj.data as Record<string, unknown>;
    assert.equal(pd.ok, false, "未闭合字符串投影应失败");
    assert.equal(typeof pd.projectedBytes, "number");
    const prot = events.find((l) => l.event === "protocol.output_limit")!;
    const ld = prot.data as Record<string, unknown>;
    assert.equal(ld.stream, "stdout");
    assert.equal(ld.limitBytes, 500);
  } finally {
    cleanup(home);
  }
});

test("TS-003 协议直达: huge-line 仅 protocol.output_limit (L13)", async () => {
  const home = makeTempHome();
  try {
    writeAlpha(home);
    const res = await runSingle(home, { scenario: "huge-line", pendingLineBytes: 500 });
    const events = readAllLogLines(home);
    assert.ok(events.filter((l) => l.event === "protocol.output_limit").length >= 1, "huge-line 应 failProtocol");
    assert.equal(events.filter((l) => l.event === "aggregate.projection").length, 0, "huge_payload 前缀不进投影");
  } finally {
    cleanup(home);
  }
});