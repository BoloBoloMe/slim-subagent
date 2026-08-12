import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extensionFactory from "../index.ts";

// 接缝 (EXECUTION.md 测试策略接缝 1): fake ExtensionAPI 捕获 registerTool 注册的 schema 与描述
// 预期值来自 M2 决策账本 (独立真相源), 非实现拷贝.

// M2-D008 钉死的 9 个参数名
const PINNED_PARAMS = ["agent", "task", "tasks", "model", "timeoutMs", "usageBudget", "cwd", "action", "id"];

// 工具描述钉版原文 (v5: 恢复 v3 的 "优先" 委派偏置, 行为规范全在 guidelines; 逐字含标点)
const PINNED_DESCRIPTION =
  '把可独立的任务优先委派给子代理, 保持主会话上下文精简; 调用后阻塞等待结果. ' +
  '单次: agent + task. 并行: tasks[]. action:"list" 发现 agents; "resume" + id 恢复中止的运行.';

function captureRegistration(): {
  name: string;
  description: string;
  parameters: { properties: Record<string, unknown> };
} {
  let captured:
    | { name: string; description: string; parameters: { properties: Record<string, unknown> } }
    | undefined;
  const fakeApi = {
    registerTool(tool: {
      name: string;
      description: string;
      parameters: { properties: Record<string, unknown> };
    }) {
      captured = tool;
    },
  } as unknown as ExtensionAPI;
  extensionFactory(fakeApi);
  if (!captured) throw new Error("registerTool 未被调用");
  return captured;
}

test("TC-001 schema exposes exactly 9 pinned params", () => {
  const { parameters } = captureRegistration();
  const names = Object.keys(parameters.properties);
  assert.equal(names.length, 9);
  assert.deepEqual(names.sort(), [...PINNED_PARAMS].sort());
});

test("TC-002 description matches pinned v4 text", () => {
  const { description } = captureRegistration();
  assert.equal(description, PINNED_DESCRIPTION);
});

test("TC-002prompt system-prompt 面存在且与描述零重复", () => {
  const reg = captureRegistration() as unknown as {
    promptSnippet?: string;
    promptGuidelines?: string[];
  };
  // M6 后增补: promptSnippet 进 Available tools, promptGuidelines 进 Guidelines (resolve-skill 同机制).
  assert.ok(reg.promptSnippet && reg.promptSnippet.length > 0, "promptSnippet 缺失");
  assert.equal(reg.promptGuidelines?.length, 3, "promptGuidelines 应恰 3 条");
  for (const g of reg.promptGuidelines ?? []) {
    assert.ok(g.length > 10, "guideline 不应为空壳");
  }
});
