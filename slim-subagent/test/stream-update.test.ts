// 本切片测试: onUpdate 流式接线 (M3-02 考察点 6 触发点: spawn 初始 / message_end 后 / tool_result_end 后 / close 最终;
// payload 形态 = 官方示例 base {content, details:{mode,results}} + progress 快照) + run.json tools 快照 (EXECUTION.md 调和 14).
// 接缝 (EXECUTION.md 测试策略接缝 1/2/3): fake ExtensionAPI 直调 execute 传入捕获回调;
// fake pi 经 PI_SUBAGENT_PI_BINARY env 注入; 临时 HOME 隔离文件系统.
// 注意: payload.results[0] 是 live 引用 (官方口径直接带, 不剥离/不拷贝) — 事后读 messages 会看到最终态,
// 故回调触发瞬间快照 msgCount/lastRole/text (emit 时点语义), 结构字段 (mode/progress) 事后断言无碍.

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
  cleanup,
  type ExecutedResult,
} from "./helpers.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

// onUpdate payload 最小面 (考察点 6: content + details{mode,results,progress}).
type UpdatePayload = {
  content: { type: string; text: string }[];
  details: {
    mode: string;
    results: { agent: string; exitCode: number }[];
    progress: { recentTools: unknown[]; recentOutput: string[] }[];
  };
};

// 捕获条目: payload + 触发瞬间快照 (live 引用防事后污染).
type CapturedUpdate = {
  payload: UpdatePayload;
  text: string;
  msgCount: number;
  lastRole?: string;
  exitCodeAtEmit?: number;
};

async function runWithUpdate(
  home: string,
  scenario: string,
  params: Record<string, unknown>,
): Promise<{ result: ExecutedResult; updates: CapturedUpdate[] }> {
  const updates: CapturedUpdate[] = [];
  const prevBinary = process.env.PI_SUBAGENT_PI_BINARY;
  const prevScenario = process.env.FAKE_PI_SCENARIO;
  try {
    const result = await withHome(home, async () => {
      process.env.PI_SUBAGENT_PI_BINARY = FAKE_PI;
      process.env.FAKE_PI_SCENARIO = scenario;
      const tool = captureTool();
      const ctx = { cwd: home } as ExtensionContext;
      return tool.execute("call-1", params, undefined, (u: UpdatePayload) => {
        const r = u.details.results[0];
        updates.push({
          payload: u,
          text: u.content[0]?.text ?? "",
          msgCount: (r as unknown as { messages: unknown[] }).messages.length,
          lastRole: (r as unknown as { messages: { role?: string }[] }).messages.at(-1)?.role,
          exitCodeAtEmit: r.exitCode,
        });
      }, ctx);
    });
    return { result, updates };
  } finally {
    if (prevBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
    else process.env.PI_SUBAGENT_PI_BINARY = prevBinary;
    if (prevScenario === undefined) delete process.env.FAKE_PI_SCENARIO;
    else process.env.FAKE_PI_SCENARIO = prevScenario;
  }
}

// 触发点断言: assistant-stop 场景事件序列 = user message_end → assistant(stop) message_end → exit 0.
// 期望 onUpdate 调用序列: [0] spawn 初始 "(running...)" / [1] user message_end 后 / [2] assistant message_end 后 / [3] close 最终.
test("TC-001 onUpdate fires at spawn/message_end/close with spec payload shape", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
    const { result, updates } = await runWithUpdate(home, "assistant-stop", {
      agent: "Alpha",
      task: "做点事",
    });
    assert.equal(result.isError, undefined);

    assert.equal(updates.length, 4, "spawn 初始 + 2×message_end + close 最终 = 4 次 onUpdate");

    // payload 形态 (考察点 6): content[{type:"text"}] + details{mode:"single", results:[...], progress:[快照]}.
    for (const u of updates) {
      assert.equal(u.payload.details.mode, "single");
      assert.equal(u.payload.content[0].type, "text");
      assert.equal(u.payload.details.results.length, 1, "results 恒为单元素数组");
      assert.equal(u.payload.details.results[0].agent, "Alpha");
      assert.equal(u.payload.details.progress.length, 1, "progress 恒为单元素快照");
      assert.ok(Array.isArray(u.payload.details.progress[0].recentTools), "progress 快照含 recentTools");
      assert.ok(Array.isArray(u.payload.details.progress[0].recentOutput), "progress 快照含 recentOutput");
    }

    // [0] spawn 初始: 无消息, 文本 "(running...)".
    assert.equal(updates[0].msgCount, 0, "spawn 初始时无消息");
    assert.equal(updates[0].text, "(running...)");

    // [1] user message_end 后: user 消息已入 messages, 但无 assistant 文本 → 仍 "(running...)".
    assert.equal(updates[1].msgCount, 1);
    assert.equal(updates[1].lastRole, "user");
    assert.equal(updates[1].text, "(running...)");

    // [2] assistant message_end 后: 文本 = getFinalOutput (官方示例口径).
    assert.equal(updates[2].msgCount, 2);
    assert.equal(updates[2].lastRole, "assistant");
    assert.equal(updates[2].text, "Hello from fake assistant");

    // [3] close 最终: 同 payload, text = finalOutput, results 含最终完整结果 (exitCode 已定格).
    assert.equal(updates[3].text, "Hello from fake assistant");
    assert.equal(updates[3].exitCodeAtEmit, 0);
  } finally {
    cleanup(home);
  }
});

// tool_result_end 触发点: fake 场景在 user 与 assistant 之间插入 tool_result_end (防御分支, 考察点 6 触发点之一).
test("TC-002 onUpdate also fires after tool_result_end", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
    const { result, updates } = await runWithUpdate(home, "tool-result-end", {
      agent: "Alpha",
      task: "做点事",
    });
    assert.equal(result.isError, undefined);

    // spawn 初始 + user message_end + tool_result_end + assistant message_end + close 最终 = 5 次.
    assert.equal(updates.length, 5, "spawn 初始 + user + tool_result_end + assistant + close = 5 次 onUpdate");

    // tool_result_end 后的那次更新: messages 已含 toolResult 消息 (触发点命中证明).
    assert.equal(updates[2].msgCount, 2);
    assert.equal(updates[2].lastRole, "toolResult");

    // 收尾两跳仍正常 (assistant message_end → close 最终).
    assert.equal(updates[3].text, "Hello after tool");
    assert.equal(updates[4].text, "Hello after tool");
    assert.equal(updates[4].exitCodeAtEmit, 0);
  } finally {
    cleanup(home);
  }
});

// run.json tools 快照 (EXECUTION.md 调和 14): agent 定义解析后的工具面落盘;
// 无 tools 字段 = 全工具 (重建时不加 --tools) — agent 无 tools 时省略字段.
test("TC-003 run.json records tools snapshot from agent definition", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\ntools: bash, read\n");
    const { result } = await runWithUpdate(home, "assistant-stop", { agent: "Alpha", task: "做点事" });
    const details = result.details as { sessionDir: string };
    const runJson = JSON.parse(fs.readFileSync(path.join(details.sessionDir, "run.json"), "utf-8"));
    assert.deepEqual(runJson.tools, ["bash", "read"], "tools 快照 = agent 定义解析后的工具面");
  } finally {
    cleanup(home);
  }
});

// 无 tools 的 agent: run.json 省略 tools 字段 (无 tools 字段 = 全工具语义, 重建时缺省不加 --tools).
test("TC-004 run.json omits tools field when agent has no tools", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
    const { result } = await runWithUpdate(home, "assistant-stop", { agent: "Alpha", task: "做点事" });
    const details = result.details as { sessionDir: string };
    const runJson = JSON.parse(fs.readFileSync(path.join(details.sessionDir, "run.json"), "utf-8"));
    assert.ok(!("tools" in runJson), "agent 无 tools 时 run.json 不含 tools 字段");
  } finally {
    cleanup(home);
  }
});

// ---- ISSUE-07 deferred (a): tool_execution_start/end 进度累积 (M3-02 考察点 1b/6) ----
// progress 快照填 recentTools (≤10)/recentOutput (≤50) 有界截断, onUpdate payload 的 progress 不再恒空.

test("TC-005 tool_execution events accumulate into progress recentTools/recentOutput", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
    // tool-progress 场景: read + grep 两对 tool 事件 + assistant 三行文本.
    const { result, updates } = await runWithUpdate(home, "tool-progress", { agent: "Alpha", task: "做点事" });
    assert.equal(result.isError, undefined);
    // 中途某次 update 的 progress 即已填值 (非恒空): tool_execution_end 后 recentTools 非空.
    const mid = updates.find((u) => (u.payload.details.progress[0].recentTools as unknown[]).length > 0);
    assert.ok(mid, "tool_execution_end 后的 onUpdate 应已带 recentTools");
    // 最终快照: recentTools = read+grep (带 args 预览与 endMs), recentOutput = assistant 文本行.
    const last = updates[updates.length - 1]!.payload.details.progress[0];
    assert.equal(last.recentTools.length, 2);
    assert.deepEqual((last.recentTools as { tool: string }[]).map((t) => t.tool), ["read", "grep"]);
    const firstTool = last.recentTools[0] as { tool: string; args: string; endMs: number };
    assert.ok(firstTool.args.includes("src/a.ts"), "args 应为工具参数预览");
    assert.equal(typeof firstTool.endMs, "number");
    assert.deepEqual(last.recentOutput, ["found it", "line two", "line three"], "recentOutput 应含 assistant 文本行");
  } finally {
    cleanup(home);
  }
});

test("TC-006 progress recentTools ≤10 and recentOutput ≤50 bounded", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查\n");
    // tool-progress-many: 12 对 tool 事件 + 6 条 12 行 assistant (recentTools 超 10, recentOutput 超 50).
    const { result, updates } = await runWithUpdate(home, "tool-progress-many", { agent: "Alpha", task: "做点事" });
    assert.equal(result.isError, undefined);
    for (const u of updates) {
      const p = u.payload.details.progress[0];
      assert.ok(p.recentTools.length <= 10, `recentTools 有界 ≤10, got ${p.recentTools.length}`);
      assert.ok(p.recentOutput.length <= 50, `recentOutput 有界 ≤50, got ${p.recentOutput.length}`);
    }
    const last = updates[updates.length - 1]!.payload.details.progress[0];
    assert.equal(last.recentTools.length, 10, "12 对工具事件 → 截断到 10");
    assert.equal(last.recentOutput.length, 50, "60 行输出 → 截断到 50");
  } finally {
    cleanup(home);
  }
});
