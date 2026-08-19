// ISSUE-05 TS-001~003 切片测试: tasks[] 并行执行 (M2-D004/M2-D008, 官方示例 index.ts 同款语义).
// 接缝 (EXECUTION.md 测试策略 1/2/3): fake ExtensionAPI 捕获 registerTool 直调 execute(tasks);
// fake pi 经 PI_SUBAGENT_PI_BINARY 注入; 临时 HOME 隔离; 并发 child 行为按 argv 任务标记区分
// (env 共享, 只能经 argv 区分: __FAIL__ → error-stop exit 1, __SLOW__ → slow 不主动退出).
// 覆盖: M1-D001(2) 并发 4/最大 8, M2-D004 全部跑完汇总/独立 isError/保序, M2-D008 parallel 覆盖语义,
// M3-04 考察点 5 并发上限, EXECUTION.md 调和 12 (批次 run.json 布局).
// TS-001: TC-001 >8 报错, TC-002 保序聚合, TC-003 失败不阻塞汇总.
// TS-002: TC-004 并发上限 4 (fake 时间戳观察).
// TS-003: TC-005/005b 顶层默认+item 覆盖, TC-006 model 覆盖 argv, TC-007 per-child session 布局.

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
  writeSettings,
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
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  partialOutput?: string;
};

type ParallelChildResult = {
  index: number;
  agent: string;
  task: string;
  isError: boolean;
  text: string;
  details: SingleDetails;
};

type ParallelDetails = {
  mode: "parallel";
  runId: string;
  results: ParallelChildResult[];
};

// 临时 HOME 隔离 + fake pi 跑一次 parallel execute (各测试独立 env 注入, 恢复现场).
async function runParallel(
  home: string,
  params: Record<string, unknown>,
  opts: { scenario?: string; signalFile?: string; sleepMs?: number; slowExitMs?: number; echoDir?: string; onUpdate?: (u: unknown) => void } = {},
): Promise<{ result: ExecutedResult; details: ParallelDetails }> {
  const prev: Record<string, string | undefined> = {};
  for (const k of [
    "PI_SUBAGENT_PI_BINARY",
    "FAKE_PI_SCENARIO",
    "FAKE_PI_SIGNAL_FILE",
    "FAKE_PI_SLEEP_MS",
    "FAKE_PI_SLOW_EXIT_MS",
    "FAKE_PI_ECHO_ARGV_DIR",
  ]) {
    prev[k] = process.env[k];
  }
  try {
    const result = await withHome(home, async () => {
      process.env.PI_SUBAGENT_PI_BINARY = FAKE_PI;
      process.env.FAKE_PI_SCENARIO = opts.scenario ?? "assistant-stop";
      if (opts.signalFile !== undefined) process.env.FAKE_PI_SIGNAL_FILE = opts.signalFile;
      if (opts.sleepMs !== undefined) process.env.FAKE_PI_SLEEP_MS = String(opts.sleepMs);
      if (opts.slowExitMs !== undefined) process.env.FAKE_PI_SLOW_EXIT_MS = String(opts.slowExitMs);
      if (opts.echoDir !== undefined) process.env.FAKE_PI_ECHO_ARGV_DIR = opts.echoDir;
      const tool = captureTool();
      const ctx = { cwd: home } as unknown as ExtensionContext;
      return tool.execute("call-1", params, undefined, opts.onUpdate as never, ctx);
    });
    return { result, details: result.details as ParallelDetails };
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ---- TS-001: 上限 + 聚合 ----

test("TC-001 more than 8 parallel tasks errors with official text", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const { result } = await runParallel(home, {
      tasks: Array.from({ length: 9 }, (_, i) => ({ agent: "Alpha", task: `t${i}` })),
    });
    assert.equal(result.isError, true);
    assert.equal(resultText(result), "Too many parallel tasks (9). Max is 8.");
  } finally {
    cleanup(home);
  }
});

// D024 回归: 未知 agent (无 model) 在 ≥2 项批次里应按 per-child 报 Unknown agent,
// 而非被 runParallelTasks 的缺 model 校验误报为整批 "缺少生效 model" (校验层已前置拦截 known-agent 缺 model).
test("TC-001b unknown agent in batch reports per-child, not missing-model", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const { result, details } = await runParallel(home, {
      tasks: [
        { agent: "Ghost1", task: "t1" },
        { agent: "Ghost2", task: "t2" },
      ],
    });
    // 整批不被缺 model 拒绝 (两个未知 agent 均无 model, 但应走 per-child 未知 agent 失败路径).
    assert.equal(result.isError, undefined, "批次不应被整批拒绝");
    assert.equal(details.results.length, 2);
    assert.ok(details.results[0].text.includes("Unknown agent: \"Ghost1\""), details.results[0].text);
    assert.ok(details.results[1].text.includes("Unknown agent: \"Ghost2\""), details.results[1].text);
    assert.equal(details.results[0].isError, true);
    assert.equal(details.results[1].isError, true);
    assert.ok(!resultText(result).includes("缺少生效 model"), "不应误报缺 model");
  } finally {
    cleanup(home);
  }
});

test("TC-002 parallel runs all tasks and aggregates in order", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    writeAgent(home, "beta.md", "name: Beta\ndescription: 处理研究任务");
    writeAgent(home, "gamma.md", "name: Gamma\ndescription: 处理写作任务");
    const { result, details } = await runParallel(home, {
      tasks: [
        { agent: "Alpha", task: "t1" },
        { agent: "Beta", task: "t2" },
        { agent: "Gamma", task: "t3" },
      ],
    });
    assert.equal(result.isError, undefined, "全部成功不应标记错误");
    assert.ok(resultText(result).includes("Parallel: 3/3 succeeded"), resultText(result));
    // 结果按 index 保序 (M2-D004), 各自 content/isError 独立.
    assert.equal(details.results.length, 3);
    assert.deepEqual(details.results.map((r) => r.agent), ["Alpha", "Beta", "Gamma"]);
    assert.deepEqual(details.results.map((r) => r.isError), [false, false, false]);
    assert.deepEqual(details.results.map((r) => r.text), [
      "Hello from fake assistant",
      "Hello from fake assistant",
      "Hello from fake assistant",
    ]);
    // M2-D006: 每 child 结果带 runId/sessionDir, session 目录保留.
    for (const r of details.results) {
      assert.match(r.details.runId, /^run-\d{8}-\d{6}-[0-9a-f]{6}$/);
      assert.ok(fs.existsSync(r.details.sessionDir), `child ${r.index} session 目录应存在`);
    }
  } finally {
    cleanup(home);
  }
});

test("TC-003 one failing task does not block summary", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    writeAgent(home, "beta.md", "name: Beta\ndescription: 处理研究任务");
    writeAgent(home, "gamma.md", "name: Gamma\ndescription: 处理写作任务");
    const { result, details } = await runParallel(
      home,
      {
        tasks: [
          { agent: "Alpha", task: "t1" },
          { agent: "Beta", task: "t2 __FAIL__" },
          { agent: "Gamma", task: "t3" },
        ],
      },
      { scenario: "error-if-marked" },
    );
    // 全部跑完返回 (不 fail-fast), 失败任务独立 isError 透传.
    assert.equal(details.results.length, 3);
    assert.deepEqual(details.results.map((r) => r.agent), ["Alpha", "Beta", "Gamma"], "结果应保序");
    assert.equal(details.results[0].isError, false);
    assert.equal(details.results[1].isError, true);
    assert.equal(details.results[2].isError, false);
    assert.equal(details.results[1].details.errorMessage, "model error: boom");
    assert.ok(details.results[1].details.exitCode !== 0, "失败 child exitCode 非 0");
    // 汇总 content 含失败标记 (M2-D004).
    const text = resultText(result);
    assert.ok(text.includes("Parallel: 2/3 succeeded"), text);
    assert.ok(text.includes("### [Beta] failed"), text);
    assert.ok(text.includes("model error: boom"), text);
    // 失败 child 的 session 目录同样保留 (可审查).
    assert.ok(fs.existsSync(details.results[1].details.sessionDir));
  } finally {
    cleanup(home);
  }
});

// ---- TS-002: 并发上限 (M1-D001(2), M3-04 考察点 5) ----

test("TC-004 concurrency capped at 4", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const signalFile = path.join(home, "signals.jsonl");
    // 6 个各睡 300ms 的任务: fake 记录 start/end 时间戳, 滑动窗口统计最大同时在跑数.
    const { result, details } = await runParallel(
      home,
      { tasks: Array.from({ length: 6 }, (_, i) => ({ agent: "Alpha", task: `sleep-${i}` })) },
      { scenario: "parallel-sleep", sleepMs: 300, signalFile },
    );

    // 全部完成 (不丢任务).
    assert.equal(details.results.length, 6);
    assert.ok(resultText(result).includes("Parallel: 6/6 succeeded"), resultText(result));
    assert.deepEqual(details.results.map((r) => r.isError), [false, false, false, false, false, false]);

    // 从 start/end 记录推最大并发 (宽松区间: 上限 4, 且 >=2 证明确在并行, 非串行退化).
    const records = fs
      .readFileSync(signalFile, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { signal: string; ts: number });
    assert.equal(records.filter((r) => r.signal === "start").length, 6, "6 个 child 都应记录 start");
    assert.equal(records.filter((r) => r.signal === "end").length, 6, "6 个 child 都应记录 end");
    const events = records.map((r) => ({ delta: r.signal === "start" ? 1 : -1, ts: r.ts }));
    events.sort((a, b) => (a.ts === b.ts ? a.delta - b.delta : a.ts - b.ts)); // 同 ts 先 end 后 start (保守)
    let active = 0;
    let max = 0;
    for (const e of events) {
      active += e.delta;
      if (active > max) max = active;
    }
    assert.ok(max <= 4, `最大同时在跑数应 ≤4, got ${max}`);
    assert.ok(max >= 2, `应确在并行 (≥2), got ${max}`);
  } finally {
    cleanup(home);
  }
});

// ---- TS-003: 顶层默认 + item 覆盖 + per-child session 布局 (M2-D008, 调和 12) ----

test("TC-005 item timeoutMs overrides batch default; other children unaffected", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // 顶层 timeoutMs=60000 作批默认; item 级 timeoutMs=300 覆盖 → 长任务 child 触顶中止,
    // 其余 child 正常跑完 (某 child 中止不影响其他 child, 无取消传播).
    const { result, details } = await runParallel(
      home,
      {
        timeoutMs: 60000,
        tasks: [
          { agent: "Alpha", task: "长任务 __SLOW__", timeoutMs: 300 },
          { agent: "Alpha", task: "快任务 1" },
          { agent: "Alpha", task: "快任务 2" },
        ],
      },
      { scenario: "slow-if-marked", slowExitMs: 1500 },
    );

    assert.equal(details.results.length, 3);
    assert.equal(details.results[0].isError, true, "item timeoutMs=300 覆盖顶层默认 → 长任务应超时中止");
    assert.equal(details.results[0].details.stopReason, "timeout");
    assert.ok(details.results[0].details.partialOutput && details.results[0].details.partialOutput.length > 0, "中止 child 应有部分输出");
    assert.equal(details.results[1].isError, false, "其他 child 不受中止影响");
    assert.equal(details.results[2].isError, false, "其他 child 不受中止影响");
    assert.equal(details.results[1].text, "Hello from fake assistant");
    assert.ok(resultText(result).includes("Parallel: 2/3 succeeded"), resultText(result));
    assert.ok(resultText(result).includes("failed (timeout)"), resultText(result));
    // 中止 child 的 session 目录保留 (可 resume 审查前提).
    assert.ok(fs.existsSync(details.results[0].details.sessionDir));
  } finally {
    cleanup(home);
  }
});

test("TC-005b batch timeoutMs applies as default when item has none", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // 反向方向: 顶层 timeoutMs=300 作批默认 → 无 item 覆盖的长任务被批默认中止;
    // item timeoutMs=60000 覆盖的长任务不受批默认影响 (自退正常完成).
    const { result, details } = await runParallel(
      home,
      {
        timeoutMs: 300,
        tasks: [
          { agent: "Alpha", task: "长任务A __SLOW__" },
          { agent: "Alpha", task: "长任务B __SLOW__", timeoutMs: 60000 },
        ],
      },
      { scenario: "slow-if-marked", slowExitMs: 1500 },
    );

    assert.equal(details.results[0].isError, true, "顶层 timeoutMs 应作批默认应用到无 item 覆盖的 child");
    assert.equal(details.results[0].details.stopReason, "timeout");
    assert.equal(details.results[1].isError, false, "item timeoutMs=60000 覆盖应免受批默认 300 影响");
    assert.equal(details.results[1].details.stopReason, "stop");
    assert.ok(resultText(result).includes("Parallel: 1/2 succeeded"), resultText(result));
  } finally {
    cleanup(home);
  }
});

test("TC-006 item model overrides batch default model", async () => {
  const home = makeTempHome();
  try {
    // agent 不带 model (保证 --model 只来自顶层默认/item 覆盖, 无 frontmatter 干扰).
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    writeAgent(home, "beta.md", "name: Beta\ndescription: 处理研究任务");
    const echoDir = path.join(home, "argv-echo");
    const { details } = await runParallel(
      home,
      {
        model: "top-model",
        thinking: "top-thinking",
        tasks: [
          { agent: "Alpha", task: "task-0", model: "item-model-a", thinking: "item-thinking-a" },
          { agent: "Beta", task: "task-1" },
        ],
      },
      { scenario: "assistant-stop", echoDir },
    );

    assert.equal(details.results.length, 2);
    assert.equal(details.results[0].isError, false);
    assert.equal(details.results[1].isError, false);
    // 逐 child argv 断言: item model 覆盖 (child 0 用 item-model-a), 顶层 model 作默认 (child 1 用 top-model).
    const argvByTask = new Map<string, string[]>();
    for (const f of fs.readdirSync(echoDir)) {
      const argv = JSON.parse(fs.readFileSync(path.join(echoDir, f), "utf-8")) as string[];
      const last = argv[argv.length - 1] ?? "";
      if (last.includes("task-0")) argvByTask.set("task-0", argv);
      else if (last.includes("task-1")) argvByTask.set("task-1", argv);
    }
    const modelOf = (argv: string[] | undefined): string | undefined => {
      const idx = argv?.indexOf("--model") ?? -1;
      return idx !== -1 && argv ? argv[idx + 1] : undefined;
    };
    const thinkingOf = (argv: string[] | undefined): string | undefined => {
      const idx = argv?.indexOf("--thinking") ?? -1;
      return idx !== -1 && argv ? argv[idx + 1] : undefined;
    };
    assert.equal(modelOf(argvByTask.get("task-0")), "item-model-a", "item model 应覆盖顶层默认");
    assert.equal(modelOf(argvByTask.get("task-1")), "top-model", "无 item model 时应回退顶层默认");
    assert.equal(thinkingOf(argvByTask.get("task-0")), "item-thinking-a", "item thinking 应覆盖顶层默认");
    assert.equal(thinkingOf(argvByTask.get("task-1")), "top-thinking", "无 item thinking 时应回退顶层默认");
  } finally {
    cleanup(home);
  }
});

test("TC-007 each child gets isolated run-<idx> session dir under batch root", async () => {
  const home = makeTempHome();
  try {
    // agent 带 tools (frontmatter) + model/thinking (settings 默认): 断言批次 run.json tasks 快照含各 child agent/model/thinking/tools (调和 12).
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\ntools: bash, read\n");
    writeAgent(home, "beta.md", "name: Beta\ndescription: 处理研究任务\ntools: read\n");
    writeSettings(home, {
      subagent: {
        Alpha: { model: "fake-model", thinking: "high" },
        Beta: { model: "fake-model-2", thinking: "low" },
      },
    });
    const { result, details } = await runParallel(home, {
      tasks: [
        { agent: "Alpha", task: "t1" },
        { agent: "Beta", task: "t2" },
        { agent: "Alpha", task: "t3" },
      ],
    });

    assert.equal(result.isError, undefined);
    assert.equal(details.mode, "parallel");
    const batchRoot = path.join(home, ".pi", "agent", "slim-subagent", "sessions", details.runId);
    // 批次根 run.json: mode parallel + tasks 快照 (各 child agent/model/tools + task).
    const runJsonPath = path.join(batchRoot, "run.json");
    assert.ok(fs.existsSync(runJsonPath), "批次根 run.json 应存在");
    const runJson = JSON.parse(fs.readFileSync(runJsonPath, "utf-8")) as {
      runId: string;
      mode: string;
      cwd: string;
      startedAt: string;
      tasks: { agent: string; task: string; model?: string; thinking?: string; tools?: string[] }[];
    };
    assert.equal(runJson.runId, details.runId);
    assert.equal(runJson.mode, "parallel");
    assert.equal(runJson.cwd, home);
    assert.ok(typeof runJson.startedAt === "string" && runJson.startedAt.length > 0);
    assert.equal(runJson.tasks.length, 3);
    assert.deepEqual(runJson.tasks.map((t) => t.agent), ["Alpha", "Beta", "Alpha"]);
    assert.deepEqual(runJson.tasks.map((t) => t.model), ["fake-model", "fake-model-2", "fake-model"]);
    assert.deepEqual(runJson.tasks.map((t) => t.thinking), ["high", "low", "high"]);
    assert.deepEqual(runJson.tasks.map((t) => t.tools), [["bash", "read"], ["read"], ["bash", "read"]]);
    // per-child: 共享批次 runId + 独立 run-<idx>/session.jsonl, 不写 per-child run.json (调和 12).
    for (const r of details.results) {
      assert.equal(r.details.runId, details.runId, "child 应共享批次 runId");
      assert.equal(r.details.sessionDir, path.join(batchRoot, `run-${r.index}`));
      assert.ok(fs.existsSync(path.join(r.details.sessionDir, "session.jsonl")), `run-${r.index} session.jsonl 应存在`);
      assert.ok(!fs.existsSync(path.join(r.details.sessionDir, "run.json")), "per-child 不应写 run.json");
    }
  } finally {
    cleanup(home);
  }
});

// ---- ISSUE-07 deferred 项: (b) parallel onUpdate 聚合流 / (c) per-task 输出 50KB 截断 / (d) item task 校验 ----

type ParUpdatePayload = {
  content: { type: string; text: string }[];
  details: { mode: string; results: { text: string; details: { exitCode: number } }[]; progress: unknown[] };
};

// (d) item 级 task 空串/非 string 校验报错 (与 single 模式对齐: 非法 task 显式报错, 不静默变空串).
test("TC-008 parallel item with empty or non-string task is rejected", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const r1 = await runParallel(home, { tasks: [{ agent: "Alpha", task: "" }] });
    assert.equal(r1.result.isError, true);
    assert.ok(resultText(r1.result).includes("task"), resultText(r1.result));
    // 多项批次 (走 parallel 管线): 非 string task 报错应点名出错 item 下标.
    const r2 = await runParallel(home, { tasks: [{ agent: "Alpha", task: "ok" }, { agent: "Alpha", task: 123 }] });
    assert.equal(r2.result.isError, true);
    const text = resultText(r2.result);
    assert.ok(text.includes("task"), text);
    assert.ok(text.includes("[1]"), "报错应点名出错 item 下标");
  } finally {
    cleanup(home);
  }
});

// (b) parallel onUpdate 聚合流 (官方 emitParallelUpdate :596-608 最小版): 初始全 running → 逐 child 完成,
// 最终 "N/N done, 0 running", payload mode=parallel + results 槽位齐全 (最小版不做 per-child 流式镜像).
test("TC-009 parallel onUpdate aggregates streaming progress", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const updates: ParUpdatePayload[] = [];
    const { result } = await runParallel(
      home,
      { tasks: [{ agent: "Alpha", task: "t1" }, { agent: "Alpha", task: "t2" }] },
      { onUpdate: (u) => updates.push(u as ParUpdatePayload) },
    );
    assert.equal(result.isError, undefined);
    assert.ok(updates.length >= 3, "初始 + 每 child 完成 ≥ 3 次更新, got " + updates.length);
    assert.equal(updates[0]!.details.mode, "parallel");
    assert.ok(Array.isArray(updates[0]!.details.progress), "parallel onUpdate details 应含 progress 数组 (初始更新)");
    assert.equal(updates[0]!.content[0]!.text, "Parallel: 0/2 done, 2 running...");
    const last = updates[updates.length - 1]!;
    assert.equal(last.content[0]!.text, "Parallel: 2/2 done, 0 running...");
    assert.equal(last.details.results.length, 2);
    assert.ok(last.details.results.every((r) => r.settled === true), "最终更新所有 child 应已 settle (候选叁显式标记)");
    assert.deepEqual(last.details.results.map((r) => r.text), ["Hello from fake assistant", "Hello from fake assistant"]);
    assert.ok(Array.isArray(last.details.progress), "parallel onUpdate details 应含 progress 数组 (最终更新)");
  } finally {
    cleanup(home);
  }
});

// (c) PER_TASK_OUTPUT_CAP (50KB): parallel 汇总 per-task 输出截断 (字节安全).
test("TC-010 parallel summary truncates per-task output at PER_TASK_OUTPUT_CAP", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // big-output 场景: assistant 输出 60KB (> 50KB cap); 两项任务保持 parallel 管线 (单项归并 single).
    const { result } = await runParallel(home, { tasks: [{ agent: "Alpha", task: "big" }, { agent: "Alpha", task: "small" }] }, { scenario: "big-output" });
    const text = resultText(result);
    assert.ok(text.includes("Parallel: 2/2 succeeded"), text);
    assert.ok(text.includes("[Output truncated:"), "汇总应含截断标记");
    const block = text.slice(text.indexOf("### [Alpha]"));
    const markerIdx = block.indexOf("[Output truncated:");
    assert.ok(markerIdx > 0, "截断标记应在任务块内");
    const kept = block.slice(0, markerIdx);
    assert.ok(Buffer.byteLength(kept, "utf8") <= 50 * 1024 + 200, `截断后保留段应 ≤ cap 量级, got ${Buffer.byteLength(kept, "utf8")}`);
  } finally {
    cleanup(home);
  }
});

// (c) 单元面: truncateParallelOutput 字节上限 + 小输出原样.
test("TC-011 truncateParallelOutput caps by bytes and appends marker", async () => {
  const { truncateParallelOutput } = await import("../index.ts");
  const big = "y".repeat(60 * 1024);
  const t = truncateParallelOutput(big);
  assert.ok(t.includes("[Output truncated:"), "超限应带截断标记");
  assert.ok(Buffer.byteLength(t, "utf8") <= 50 * 1024 + 200, `截断后 ≤ cap 量级, got ${Buffer.byteLength(t, "utf8")}`);
  assert.ok(t.endsWith("Full output preserved in tool details.]"), "标记应声明完整输出保留在 details");
  assert.equal(truncateParallelOutput("small"), "small", "小输出原样返回");
});

// tasks 长度 1 → 归并 single 管线 (无聚合壳/无 50KB 截断/run.json 落盘可 resume, 等价 task 形态).
test("TC-012 tasks with single item is normalized to single pipeline", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const { result, details } = await runParallel(home, {
      tasks: [{ agent: "Alpha", task: "唯一任务" }],
    });
    assert.equal(result.isError, undefined, resultText(result));
    assert.ok(!resultText(result).includes("Parallel:"), `不应有聚合壳: ${resultText(result)}`);
    assert.notEqual((details as { mode?: string }).mode, "parallel", "details 不应是 parallel 信封");
    const singleDetails = details as unknown as SingleDetails;
    assert.ok(singleDetails.runId !== "", "应有 single runId");
    assert.ok(
      fs.existsSync(path.join(singleDetails.sessionDir, "run.json")),
      "应落盘 run.json (single 布局, 可 resume)",
    );
  } finally {
    cleanup(home);
  }
});
