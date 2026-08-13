// ISSUE-02 TS-002 切片测试: spawn argv 契约 (M3-04 考察点 2 保留段 + EXECUTION.md 调和 8).
// 接缝: fake pi 经 PI_SUBAGENT_PI_BINARY 注入 (寻址链第 1 级), FAKE_PI_ECHO_BUNDLE 回显
// argv / 进程 cwd / --append-system-prompt 文件快照 (内容+权限) / @file task 快照.
// 覆盖: TC-004 argv 全契约, TC-005 task>8000 → @file, TC-006 cwd 透传.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  makeTempHome,
  withHome,
  captureTool,
  writeAgent,
  cleanup,
  type ExecutedResult,
} from "./helpers.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

// fake-pi FAKE_PI_ECHO_BUNDLE 回显结构 (TS-002).
type Bundle = {
  argv: string[];
  cwd: string;
  prompt?: { content: string; mode: number };
  taskFile?: { path: string; content: string };
};

// 临时 HOME 隔离 + fake pi + bundle 回显, 跑一次 single execute.
async function runSingleWithBundle(
  home: string,
  opts: { scenario?: string; params: Record<string, unknown> },
): Promise<{ result: ExecutedResult; bundle: Bundle }> {
  const prevBinary = process.env.PI_SUBAGENT_PI_BINARY;
  const prevScenario = process.env.FAKE_PI_SCENARIO;
  const prevBundle = process.env.FAKE_PI_ECHO_BUNDLE;
  const bundlePath = path.join(home, "echo-bundle.json");
  try {
    const result = await withHome(home, async () => {
      process.env.PI_SUBAGENT_PI_BINARY = FAKE_PI;
      process.env.FAKE_PI_SCENARIO = opts.scenario ?? "assistant-stop";
      process.env.FAKE_PI_ECHO_BUNDLE = bundlePath;
      const tool = captureTool();
      const ctx = { cwd: home } as ExtensionContext;
      return tool.execute("call-1", opts.params, undefined, undefined, ctx);
    });
    const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf-8")) as Bundle;
    return { result, bundle };
  } finally {
    if (prevBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
    else process.env.PI_SUBAGENT_PI_BINARY = prevBinary;
    if (prevScenario === undefined) delete process.env.FAKE_PI_SCENARIO;
    else process.env.FAKE_PI_SCENARIO = prevScenario;
    if (prevBundle === undefined) delete process.env.FAKE_PI_ECHO_BUNDLE;
    else process.env.FAKE_PI_ECHO_BUNDLE = prevBundle;
  }
}

test("TC-004 spawn argv follows pinned contract", async () => {
  const home = makeTempHome();
  try {
    // agent 带 model + tools (M3-04 考察点 2: 有才加 --model/--tools).
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\nmodel: fake-model\ntools: bash, read\n");
    const { result, bundle } = await runSingleWithBundle(home, {
      params: { agent: "Alpha", task: "做点事" },
    });
    assert.equal(result.isError, undefined, "正常完成不应标记错误");
    const args = bundle.argv;

    // base 段 (M3-04 考察点 2: 恒加 ["--mode","json","-p"]).
    assert.deepEqual(args.slice(0, 3), ["--mode", "json", "-p"]);

    // --session <已存在路径> (per-run 目录, fake pi 写盘后存在).
    const sessionIdx = args.indexOf("--session");
    assert.ok(sessionIdx !== -1, "argv 应含 --session");
    const sessionFile = args[sessionIdx + 1];
    assert.ok(sessionFile && fs.existsSync(sessionFile), "session 文件应已存在 (fake pi 写盘)");
    assert.ok(
      sessionFile.includes(path.join(".pi", "agent", "slim-subagent", "sessions")),
      "session 应落在 per-run 目录",
    );

    // agent 带 model/tools → --model/--tools 值.
    assert.ok(args.includes("--model"), "argv 应含 --model");
    assert.equal(args[args.indexOf("--model") + 1], "fake-model");
    assert.ok(args.includes("--tools"), "argv 应含 --tools");
    assert.equal(args[args.indexOf("--tools") + 1], "bash,read");

    // 恒 --no-skills + --no-extensions (EXECUTION.md 调和 8).
    assert.ok(args.includes("--no-skills"), "argv 应含 --no-skills");
    assert.ok(args.includes("--no-extensions"), "argv 应含 --no-extensions");

    // --append-system-prompt: 文件存在 + 内容 = agent body + 0600 (M3-04 考察点 2).
    const promptIdx = args.indexOf("--append-system-prompt");
    assert.ok(promptIdx !== -1, "argv 应含 --append-system-prompt");
    assert.ok(bundle.prompt, "fake 应回显 prompt 快照");
    assert.equal(bundle.prompt.content, "system prompt body", "prompt 文件内容 = agent body");
    // Windows 无 POSIX 权限位 (fs mode 参数被忽略), 仅 POSIX 断言 0600.
    if (process.platform !== "win32") assert.equal(bundle.prompt.mode, 0o600, "prompt 文件权限 0600");

    // 末参 `Task: <task>` (≤8000 内联).
    assert.equal(args[args.length - 1], "Task: 做点事");
  } finally {
    cleanup(home);
  }
});

test("TC-005 task over 8000 chars becomes @file last arg", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
    // 12000 字符 > TASK_ARG_LIMIT(8000) → @file.
    const longTask = "长任务".repeat(4000);
    const { result, bundle } = await runSingleWithBundle(home, {
      params: { agent: "Alpha", task: longTask },
    });
    assert.equal(result.isError, undefined);
    const last = bundle.argv[bundle.argv.length - 1];
    assert.ok(last.startsWith("@"), `末参应为 @file, 实际: "${last}"`);
    assert.ok(bundle.taskFile, "fake 应回显 task 文件快照");
    assert.equal(bundle.taskFile.content, longTask, "@file 内容 = 原 task");
    assert.ok(bundle.taskFile.path.startsWith(path.join(fs.realpathSync(os.tmpdir()), "pi-subagent-")), "@file 应在 temp 目录");
    assert.ok(bundle.taskFile.path.endsWith("task-Alpha.txt"), "@file 命名应含 agent 名");
  } finally {
    cleanup(home);
  }
});

test("TC-006 cwd param is passed to spawned process", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
    // 显式 cwd 子目录 (M2-D008 参数 7), spawn 前须已存在.
    const workdir = path.join(home, "workdir");
    fs.mkdirSync(workdir, { recursive: true });

    const { result, bundle } = await runSingleWithBundle(home, {
      params: { agent: "Alpha", task: "做点事", cwd: workdir },
    });
    assert.equal(result.isError, undefined);
    assert.equal(bundle.cwd, workdir, "fake pi 进程 cwd 应等于透传的 cwd");

    // run.json 同步记录 cwd (EXECUTION.md 调和 1 既有字段).
    const details = result.details as { sessionDir: string };
    const runJson = JSON.parse(fs.readFileSync(path.join(details.sessionDir, "run.json"), "utf-8"));
    assert.equal(runJson.cwd, workdir);
  } finally {
    cleanup(home);
  }
});
