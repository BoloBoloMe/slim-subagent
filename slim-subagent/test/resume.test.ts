// ISSUE-06 TS-001 切片测试: resume 执行路径 (寻址/参数校验/session 校验/恢复 spawn/结果标记).
// 接缝: fake pi (PI_SUBAGENT_PI_BINARY) + FAKE_PI_ECHO_BUNDLE 回显 argv/prompt 快照; 临时 HOME 隔离.
// 覆盖: M1-D004, M2-D005, M3-03 考察点 1 移植规格 1-5, EXECUTION.md 调和 6/13/14.
// 不得测试: 锁 (TS-002), GC (TS-003), run.json 解析内部.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  makeTempHome,
  withFakePi,
  captureTool,
  writeAgent,
  cleanup,
  resultText,
  type ExecutedResult,
} from "./helpers.ts";

type SingleDetails = {
  runId: string;
  sessionDir: string;
  resumed?: boolean;
  usage: unknown;
  exitCode: number;
};

// 临时 HOME 隔离 + fake pi (env 注入与恢复由 withFakePi 承担), 直调 execute 一次.
async function runTool(home: string, params: Record<string, unknown>): Promise<ExecutedResult> {
  return withFakePi(home, "assistant-stop", {}, async () => {
    const tool = captureTool();
    const ctx = { cwd: home } as ExtensionContext;
    return tool.execute("call-1", params, undefined, undefined, ctx);
  });
}

test("TC-001 resume reopens persisted session with follow-up", async () => {
  const home = makeTempHome();
  try {
    // agent 带 model + tools (断言恢复 spawn 按 run.json 快照重建 --model/--tools, 调和 14).
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\nmodel: fake-model\ntools: bash, read\n");
    const single = await runTool(home, { agent: "Alpha", task: "最初任务" });
    assert.equal(single.isError, undefined);
    const details = single.details as SingleDetails;
    const runId = details.runId;
    const sessionDir = details.sessionDir;
    assert.ok(fs.existsSync(path.join(sessionDir, "run-0", "session.jsonl")), "single 应先落盘 session.jsonl");

    // resume: fake 回显 argv + prompt 快照 (bundle).
    const bundlePath = path.join(home, "resume-bundle.json");
    const resumed = await withFakePi(home, "assistant-stop", { bundlePath }, async () => {
      const tool = captureTool();
      const ctx = { cwd: home } as ExtensionContext;
      return tool.execute("call-1", { action: "resume", id: runId, task: "继续做" }, undefined, undefined, ctx);
    });

    assert.equal(resumed.isError, undefined, "resume 正常完成不应标记错误");
    assert.equal(resultText(resumed), "Hello from fake assistant");
    const rDetails = resumed.details as SingleDetails;
    assert.equal(rDetails.resumed, true, "结果应标记 resumed:true");
    assert.equal(rDetails.runId, runId, "runId 沿用原 run (调和 13)");
    assert.equal(rDetails.sessionDir, sessionDir, "sessionDir 沿用原 run");

    // 恢复 spawn 契约: --session <原路径> + 原 agent prompt 文件 + follow-up 原文 + 快照 --model/--tools.
    const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf-8")) as { argv: string[]; prompt?: { content: string } };
    const args = bundle.argv;
    const sessionIdx = args.indexOf("--session");
    assert.ok(sessionIdx !== -1, "argv 应含 --session");
    assert.equal(args[sessionIdx + 1], path.join(sessionDir, "run-0", "session.jsonl"), "--session 应为原 sessionFile");
    assert.equal(args[args.indexOf("--model") + 1], "fake-model", "--model 按 run.json 快照重建");
    assert.equal(args[args.indexOf("--tools") + 1], "bash,read", "--tools 按 run.json 快照重建");
    assert.ok(args.includes("--append-system-prompt"), "argv 应含 --append-system-prompt");
    assert.ok(bundle.prompt, "fake 应回显 prompt 快照");
    assert.equal(bundle.prompt.content, "system prompt body", "prompt 文件 = 原 agent body");
    assert.equal(args[args.length - 1], "Task: 继续做", "follow-up 原文追加 (接受中断 turn 重复, M3 §四 #5)");
    assert.ok(args.includes("--no-skills") && args.includes("--no-extensions"), "恒 --no-skills/--no-extensions (调和 8)");
  } finally {
    cleanup(home);
  }
});

test("TC-002 id prefix match, ambiguity, not found", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
    const runA = await runTool(home, { agent: "Alpha", task: "任务A" });
    const runB = await runTool(home, { agent: "Alpha", task: "任务B" });
    const idA = (runA.details as SingleDetails).runId;
    const idB = (runB.details as SingleDetails).runId;

    // 程序化求公共前缀与唯一前缀 (runId 含随机段, 避免硬编码前缀歧义偶发).
    let common = "";
    let i = 0;
    while (i < idA.length && i < idB.length && idA[i] === idB[i]) {
      common += idA[i];
      i++;
    }
    const uniqueA = i < idA.length ? common + idA[i] : idA;
    const both = common;

    // (a) 前缀匹配成功.
    const prefixHit = await runTool(home, { action: "resume", id: uniqueA, task: "继续A" });
    assert.equal(prefixHit.isError, undefined, "唯一前缀应命中");
    assert.equal((prefixHit.details as SingleDetails).runId, idA);

    // (b) 多命中歧义报错.
    const ambiguous = await runTool(home, { action: "resume", id: both, task: "继续B" });
    assert.equal(ambiguous.isError, true);
    const ambText = resultText(ambiguous);
    assert.ok(ambText.includes("Ambiguous"), `歧义报错应含 Ambiguous: ${ambText}`);
    assert.ok(ambText.includes(idA) && ambText.includes(idB), "歧义报错应列出全部命中");

    // (c) 无命中 "Run not found".
    const missing = await runTool(home, { action: "resume", id: "run-nope", task: "继续C" });
    assert.equal(missing.isError, true);
    assert.ok(resultText(missing).includes("Run not found"), resultText(missing));
  } finally {
    cleanup(home);
  }
});

// M6 修复 2 (用户裁决 b): id 匹配放宽 — 完整 runId 前缀 或 随机尾段前缀 均可命中.
test("TC-002c id tail-segment prefix match", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
    // 手工造三个 run 目录 (runId 尾段可控), 跳过真实 single 运行.
    const root = path.join(home, ".pi", "agent", "slim-subagent", "sessions");
    const mk = (runId: string) => {
      const dir = path.join(root, runId);
      fs.mkdirSync(path.join(dir, "run-0"), { recursive: true });
      fs.writeFileSync(path.join(dir, "run-0", "session.jsonl"), "{}\n");
      fs.writeFileSync(
        path.join(dir, "run.json"),
        JSON.stringify({ runId, agent: "Alpha", startedAt: new Date().toISOString(), sessionFile: "run-0/session.jsonl" }),
      );
    };
    mk("run-20260813-000000-abc123");
    mk("run-20260813-111111-def456");
    mk("run-20260813-222222-abc999");

    // (a) 唯一尾段前缀命中.
    const hit = await runTool(home, { action: "resume", id: "def4", task: "继续" });
    assert.equal(hit.isError, undefined, `尾段前缀应命中: ${resultText(hit)}`);
    assert.equal((hit.details as SingleDetails).runId, "run-20260813-111111-def456");

    // (b) 尾段歧义 (abc123 与 abc999 同尾段前缀 "abc").
    const amb = await runTool(home, { action: "resume", id: "abc", task: "继续" });
    assert.equal(amb.isError, true);
    const ambText = resultText(amb);
    assert.ok(ambText.includes("Ambiguous"), `尾段歧义应报 Ambiguous: ${ambText}`);
    assert.ok(ambText.includes("abc123") && ambText.includes("abc999"), "歧义报错应列出全部命中");
  } finally {
    cleanup(home);
  }
});

test("TC-002b parallel batch run id rejected", async () => {
  const home = makeTempHome();
  try {
    // 手工造 parallel 批次 run.json (调和 12: mode:"parallel" + tasks 快照) + per-child session 文件.
    const runId = "run-20000101-000000-aaaaaa";
    const dir = path.join(home, ".pi", "agent", "slim-subagent", "sessions", runId);
    fs.mkdirSync(path.join(dir, "run-0"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({ runId, mode: "parallel", startedAt: new Date().toISOString(), cwd: home, tasks: [] }),
    );
    fs.writeFileSync(path.join(dir, "run-0", "session.jsonl"), "x\n");

    const res = await runTool(home, { action: "resume", id: runId, task: "继续" });
    assert.equal(res.isError, true);
    assert.ok(resultText(res).includes("v1 仅支持 single resume"), resultText(res));
  } finally {
    cleanup(home);
  }
});

test("TC-003 resume param validation: missing id / missing task / model rejected", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
    // 缺 id.
    const noId = await runTool(home, { action: "resume", task: "继续" });
    assert.equal(noId.isError, true);
    assert.ok(resultText(noId).includes("id"), `缺 id 应报错: ${resultText(noId)}`);

    // 缺 task.
    const runA = await runTool(home, { agent: "Alpha", task: "任务A" });
    const idA = (runA.details as SingleDetails).runId;
    const noTask = await runTool(home, { action: "resume", id: idA });
    assert.equal(noTask.isError, true);
    assert.ok(resultText(noTask).includes("task"), `缺 task 应报错: ${resultText(noTask)}`);

    // 带 model → 同用报错 (调和 6).
    const withModel = await runTool(home, { action: "resume", id: idA, task: "继续", model: "other-model" });
    assert.equal(withModel.isError, true);
    assert.ok(resultText(withModel).includes("model"), `model 覆盖应报错: ${resultText(withModel)}`);
  } finally {
    cleanup(home);
  }
});

test("TC-004 session file validation uses legacy error texts", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
    const single = await runTool(home, { agent: "Alpha", task: "任务A" });
    const details = single.details as SingleDetails;
    const idA = details.runId;
    const sessionDir = details.sessionDir;

    // (a) session.jsonl 被人为删除 → 旧码 "session file does not exist" (subagent-executor.ts:674-675).
    fs.rmSync(path.join(sessionDir, "run-0", "session.jsonl"));
    const deleted = await runTool(home, { action: "resume", id: idA, task: "继续" });
    assert.equal(deleted.isError, true);
    assert.ok(resultText(deleted).includes("session file does not exist"), resultText(deleted));
    assert.ok(resultText(deleted).includes(idA), "报错应含 runId");

    // (b) run.json sessionFile 扩展名非 .jsonl → 旧码 "must be a .jsonl file" (subagent-executor.ts:672-673).
    fs.writeFileSync(path.join(sessionDir, "run-0", "session.jsonl"), "x\n");
    const runJsonPath = path.join(sessionDir, "run.json");
    const runJson = JSON.parse(fs.readFileSync(runJsonPath, "utf-8"));
    runJson.sessionFile = "run-0/foo.txt";
    fs.writeFileSync(runJsonPath, JSON.stringify(runJson));
    const wrongExt = await runTool(home, { action: "resume", id: idA, task: "继续" });
    assert.equal(wrongExt.isError, true);
    assert.ok(resultText(wrongExt).includes("must be a .jsonl file"), resultText(wrongExt));
  } finally {
    cleanup(home);
  }
});
