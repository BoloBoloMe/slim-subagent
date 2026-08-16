// spawn-plan 接口级 TDD (架构深化 候选肆): argv 构建契约 + 生效 model/thinking 单一解析.
// argv 端到端契约 (fake pi 回显) 由 single-spawn-args.test.ts 覆盖; 此处直打接口钉住新接缝.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildSpawnArgs, effectiveModelOf, effectiveThinkingOf, TASK_ARG_LIMIT } from "../spawn-plan.ts";
import { makeTempHome, withHome } from "./helpers.ts";

test("effective model/thinking: 调用侧覆盖胜 frontmatter, 缺省回退, 双缺 undefined", () => {
  assert.equal(effectiveModelOf("p/m", { model: "fm" }), "p/m");
  assert.equal(effectiveModelOf(undefined, { model: "fm" }), "fm");
  assert.equal(effectiveModelOf(undefined, undefined), undefined);
  assert.equal(effectiveModelOf(undefined, {}), undefined);
  assert.equal(effectiveThinkingOf("max", { thinking: "low" }), "max");
  assert.equal(effectiveThinkingOf(undefined, { thinking: "low" }), "low");
  assert.equal(effectiveThinkingOf(undefined, undefined), undefined);
});

test("buildSpawnArgs: 基座 + 条件段全量 (resolve-skill 缺失时无 -e)", async () => {
  await withHome(makeTempHome(), async () => {
    const args = buildSpawnArgs({
      task: "do it",
      sessionFile: "/s/run-0/session.jsonl",
      model: "p/m",
      thinking: "high",
      tools: ["read", "bash"],
      promptFile: "/tmp/prompt-w.md",
      tmpDir: "/tmp",
      taskFileBase: "task-worker",
    });
    assert.deepEqual(args, [
      "--mode", "json", "-p", "--session", "/s/run-0/session.jsonl",
      "--model", "p/m", "--thinking", "high", "--tools", "read,bash",
      "--no-skills", "--no-extensions",
      "--append-system-prompt", "/tmp/prompt-w.md",
      "Task: do it",
    ]);
  });
});

test("buildSpawnArgs: 最小形态 (无 model/thinking/tools/prompt)", async () => {
  await withHome(makeTempHome(), async () => {
    const args = buildSpawnArgs({
      task: "t", sessionFile: "/s/session.jsonl", promptFile: null, tmpDir: "/tmp", taskFileBase: "task-x",
    });
    assert.deepEqual(args, ["--mode", "json", "-p", "--session", "/s/session.jsonl", "--no-skills", "--no-extensions", "Task: t"]);
  });
});

test("buildSpawnArgs: 超长 task 转 @file (内容落盘, 文件名用 taskFileBase)", async () => {
  await withHome(makeTempHome(), async () => {
    const tmp = fs.mkdtempSync(path.join("/tmp", "spawn-plan-"));
    const big = "x".repeat(TASK_ARG_LIMIT + 1);
    const args = buildSpawnArgs({
      task: big, sessionFile: "/s/session.jsonl", promptFile: null, tmpDir: tmp, taskFileBase: "task-resume",
    });
    const last = args[args.length - 1];
    assert.ok(last.startsWith("@"), "末参为 @file");
    assert.ok(last.includes("task-resume.txt"));
    assert.equal(fs.readFileSync(last.slice(1), "utf-8"), big);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
