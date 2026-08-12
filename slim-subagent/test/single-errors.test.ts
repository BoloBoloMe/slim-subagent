// ISSUE-02 TS-003 切片测试: 错误与退出码 (close 路径) + 寻址第 1 级生效.
// 接缝 (EXECUTION.md 测试策略接缝 1/2): fake ExtensionAPI 捕获 registerTool 后直调 execute(single);
// fake pi 经 PI_SUBAGENT_PI_BINARY env 注入 (TC-007 寻址第 1 级), 场景开关 FAKE_PI_SCENARIO/FAKE_PI_EXIT/FAKE_PI_STDERR.
// 覆盖: TC-007 env 覆盖生效, TC-008 非 JSON 行 exit 0 无害, TC-009 exit 1 + 非 JSON stdout → error=rawStdout 整段,
// TC-010 exit 1 仅 stderr → error=stderr 文本 (配错模型场景), TC-011 exit 0 无 assistant 文本 → exitCode 1 + 空输出错误.
// 不得测试 (M3-01 考察点 5): 尾部缓冲内部实现, 只测行为面.

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
  contextTokens?: number;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
};

// 临时 HOME 隔离 + fake pi 跑一次 single execute; env 注入与恢复.
async function runSingle(
  home: string,
  opts: { scenario: string; exit?: number; stderr?: string; echoArgv?: string },
): Promise<{ result: ExecutedResult; details: SingleDetails }> {
  const prev: Record<string, string | undefined> = {};
  for (const k of ["PI_SUBAGENT_PI_BINARY", "FAKE_PI_SCENARIO", "FAKE_PI_EXIT", "FAKE_PI_STDERR", "FAKE_PI_ECHO_ARGV"]) {
    prev[k] = process.env[k];
  }
  try {
    const result = await withHome(home, async () => {
      process.env.PI_SUBAGENT_PI_BINARY = FAKE_PI;
      process.env.FAKE_PI_SCENARIO = opts.scenario;
      if (opts.exit !== undefined) process.env.FAKE_PI_EXIT = String(opts.exit);
      if (opts.stderr !== undefined) process.env.FAKE_PI_STDERR = opts.stderr;
      if (opts.echoArgv !== undefined) process.env.FAKE_PI_ECHO_ARGV = opts.echoArgv;
      const tool = captureTool();
      const ctx = { cwd: home } as ExtensionContext;
      return tool.execute("call-1", { agent: "Alpha", task: "做点事" }, undefined, undefined, ctx);
    });
    return { result, details: result.details as SingleDetails };
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("TC-007 PI_SUBAGENT_PI_BINARY env override routes to fake pi (addressing level 1)", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const echoPath = path.join(home, "echo-argv.json");
    const { result } = await runSingle(home, { scenario: "assistant-stop", echoArgv: echoPath });

    // 仅 fake pi 会写 argv 回显文件 → 文件存在即证明 env 覆盖生效 (寻址链第 1 级优先于 (b)-(d) 与 PATH).
    // 文件内容 = argv 数组本身 (fake 的 process.argv.slice(2)).
    const echo = JSON.parse(fs.readFileSync(echoPath, "utf-8")) as string[];
    assert.equal(echo[0], "--mode", "fake 应以 env 覆盖路径直接执行, argv 不带脚本前缀");
    assert.equal(result.isError, undefined);
    assert.equal(resultText(result), "Hello from fake assistant");
  } finally {
    cleanup(home);
  }
});

test("TC-008 interleaved non-JSON lines with exit 0 are harmless", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const { result, details } = await runSingle(home, { scenario: "noisy-ok" });

    // M3-01 考察点 5: 非 JSON 行静默跳过, 不触发错误 (code 0).
    assert.equal(result.isError, undefined);
    assert.equal(resultText(result), "Hello from fake assistant");
    assert.deepEqual(details.usage, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.5, turns: 1 });
    assert.equal(details.exitCode, 0);
    assert.equal(details.error, undefined, "exit 0 时非 JSON 行不应产生错误");
  } finally {
    cleanup(home);
  }
});

test("TC-009 exit 1 with non-JSON stdout surfaces rawStdout block as error", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const { result, details } = await runSingle(home, { scenario: "non-json-fail", exit: 1 });

    // M3-01 考察点 5/6: code!==0 且 rawStdout 非空且无更具体错误 → closeError = rawStdout.trim() 整段.
    assert.equal(details.exitCode, 1);
    assert.equal(details.error, "Starting pipeline for task...\nError: something exploded\n  at fake line 12");
    assert.equal(result.isError, true);
  } finally {
    cleanup(home);
  }
});

test("TC-010 exit 1 with stderr only surfaces stderr text (wrong-model scenario)", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    // 配错模型场景 (M3 关键事实 6): pi 子进程 stderr 报 `Model "..." not found...` + exit 1.
    const stderrText = 'Model "totally-bogus" not found. Use --list-models to see available models.';
    const { result, details } = await runSingle(home, { scenario: "stderr-fail", exit: 1, stderr: stderrText });

    // M3-01 考察点 6: code!==0 且 stderr 非空且无更具体错误 → closeError = stderr.trim().
    assert.equal(details.exitCode, 1);
    assert.equal(details.error, stderrText);
    assert.ok(resultText(result).includes("not found"), "内容文本应含 stderr 诊断 (官方 getResultOutput 口径)");
    assert.equal(result.isError, true);
  } finally {
    cleanup(home);
  }
});

test("TC-011 exit 0 with no assistant text maps to exitCode 1 empty-output error", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const { result, details } = await runSingle(home, { scenario: "empty-ok" });

    // M3-01 考察点 6 / M3-02 考察点 4: 空输出判定 → exitCode 1 + 明确错误消息.
    assert.equal(details.exitCode, 1);
    assert.equal(details.error, "Subagent produced no output (possible model cold-start or empty response.)");
    assert.equal(result.isError, true);
  } finally {
    cleanup(home);
  }
});
