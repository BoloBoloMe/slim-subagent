// ISSUE-02 TS-001 切片测试: single 管线主路径 (寻址+spawn+行解析+close 结果构造+session 落盘).
// 接缝 (EXECUTION.md 测试策略接缝 1/2/3): fake ExtensionAPI 捕获 registerTool 后直调 execute(single);
// fake pi 经 PI_SUBAGENT_PI_BINARY env 注入 (寻址链第 1 级, 存在理由即测试); 临时 HOME 隔离文件系统.
// 覆盖: M2-D002(a) 正常载荷, M2-D006 (runId+sessionDir), M3 §六 (usage 6 字段/contextTokens/model 语义).

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
  contextTokens?: number;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
};

// 临时 HOME 隔离下以 fake pi 跑一次 single execute; env 注入与恢复.
// bundlePath 非空时注入 FAKE_PI_ECHO_BUNDLE (fake 回显 argv/cwd/prompt 快照, 供残留断言记录精确 temp 目录名).
async function runSingle(home: string, scenario: string, bundlePath?: string): Promise<ExecutedResult> {
  const prevBinary = process.env.PI_SUBAGENT_PI_BINARY;
  const prevScenario = process.env.FAKE_PI_SCENARIO;
  const prevExit = process.env.FAKE_PI_EXIT;
  const prevBundle = process.env.FAKE_PI_ECHO_BUNDLE;
  try {
    return await withHome(home, async () => {
      process.env.PI_SUBAGENT_PI_BINARY = FAKE_PI;
      process.env.FAKE_PI_SCENARIO = scenario;
      if (bundlePath !== undefined) process.env.FAKE_PI_ECHO_BUNDLE = bundlePath;
      const tool = captureTool();
      const ctx = { cwd: home } as ExtensionContext;
      return tool.execute("call-1", { agent: "Alpha", task: "做点事" }, undefined, undefined, ctx);
    });
  } finally {
    if (prevBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
    else process.env.PI_SUBAGENT_PI_BINARY = prevBinary;
    if (prevScenario === undefined) delete process.env.FAKE_PI_SCENARIO;
    else process.env.FAKE_PI_SCENARIO = prevScenario;
    if (prevExit === undefined) delete process.env.FAKE_PI_EXIT;
    else process.env.FAKE_PI_EXIT = prevExit;
    if (prevBundle === undefined) delete process.env.FAKE_PI_ECHO_BUNDLE;
    else process.env.FAKE_PI_ECHO_BUNDLE = prevBundle;
  }
}

test("TC-001 single run returns final text and usage details", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
    writeSettings(home, { subagent: { Alpha: { model: "fake-model" } } });
    // review 修复项 3: 经 fake-pi bundle 回显记录本次运行创建的精确 temp 目录名 (prompt 文件所在目录),
    // 断言该目录已清理 — 不做 /tmp 全量对比 (本机他进程/并行测试文件可能并发建删同前缀目录, 全量对比偶发假失败).
    const bundlePath = path.join(home, "echo-bundle.json");

    const result = await runSingle(home, "assistant-stop", bundlePath);
    const details = result.details as SingleDetails;

    assert.equal(result.isError, undefined, "正常完成不应标记错误");
    assert.equal(resultText(result), "Hello from fake assistant");

    // M2-D002(a): usage 六字段.
    assert.deepEqual(details.usage, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.5, turns: 1 });

    // M2-D006 + EXECUTION.md 调和 3: runId 格式 + sessionDir 绝对路径回传.
    assert.match(details.runId, /^run-\d{8}-\d{6}-[0-9a-f]{6}$/);
    assert.equal(details.sessionDir, path.join(home, ".pi", "agent", "slim-subagent", "sessions", details.runId));

    // 调和 1: session.jsonl 落盘 (fake pi 模拟 pi 写盘, 含 assistant 文本) + run.json 字段齐.
    const sessionFile = path.join(details.sessionDir, "run-0", "session.jsonl");
    assert.ok(fs.existsSync(sessionFile), "session.jsonl 应落盘");
    const sessionText = fs.readFileSync(sessionFile, "utf-8");
    assert.ok(sessionText.includes("Hello from fake assistant"), "session.jsonl 应含 assistant 消息");

    const runJson = JSON.parse(fs.readFileSync(path.join(details.sessionDir, "run.json"), "utf-8"));
    assert.equal(runJson.runId, details.runId);
    assert.equal(runJson.agent, "Alpha");
    assert.equal(runJson.model, "fake-model");
    assert.equal(runJson.cwd, home);
    assert.equal(typeof runJson.startedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(runJson.startedAt)), "startedAt 应为可解析时间");
    assert.equal(runJson.sessionFile, "run-0/session.jsonl");

    // temp prompt 文件 close 后清理: 精确断言本次运行创建的 temp 目录已删除 (bundle.prompt.path 即该目录内 prompt 文件).
    const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf-8")) as { prompt?: { path: string } };
    assert.ok(bundle.prompt, "fake 应回显 prompt 文件路径");
    const tmpDir = path.dirname(bundle.prompt.path);
    assert.ok(tmpDir.includes("pi-subagent-"), `temp 目录应位于 os.tmpdir 下: ${tmpDir}`);
    assert.ok(!fs.existsSync(tmpDir), `本次运行创建的 temp 目录不应残留: ${tmpDir}`);
  } finally {
    cleanup(home);
  }
});

test("TC-002 usage accumulates, contextTokens takes latest, model takes first", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");

    const result = await runSingle(home, "two-assistant");
    const details = result.details as SingleDetails;

    assert.equal(result.isError, undefined);
    assert.equal(resultText(result), "second reply", "content 应为最后一条 assistant 文本");

    // M3-02 考察点 2: 两条 assistant message_end 累加.
    assert.deepEqual(details.usage, { input: 30, output: 12, cacheRead: 5, cacheWrite: 3, cost: 0.375, turns: 2 });
    // contextTokens 取最新一条 totalTokens (非累加), model 取首个 assistant 消息.
    assert.equal(details.contextTokens, 32);
    assert.equal(details.model, "first-model");
    assert.equal(details.stopReason, "stop");
  } finally {
    cleanup(home);
  }
});

test("TC-003 stopReason error with exit 0 marks isError", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");

    const result = await runSingle(home, "error-stop");
    const details = result.details as SingleDetails;

    // M3-01 考察点 6: isError = exitCode!==0 || stopReason==="error" || stopReason==="aborted".
    assert.equal(result.isError, true);
    assert.ok(resultText(result).includes("model error: boom"), "错误文本应优先 errorMessage");
    assert.equal(details.errorMessage, "model error: boom");
    assert.equal(details.stopReason, "error");
  } finally {
    cleanup(home);
  }
});
