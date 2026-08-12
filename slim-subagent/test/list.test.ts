// ISSUE-01 TS-002 切片测试: action:"list" 的 agents 两源发现 + 最小名册格式化 (M1-D009, M2-D007).
// 接缝 (EXECUTION.md 测试策略接缝 1/3): fake ExtensionAPI 捕获 registerTool 后直调 execute(action:"list");
// 文件系统用临时 HOME 隔离 user agents 目录 (~/.pi/agent/agents/, M2-D007).
// 测试辅助 (makeTempHome/withHome/captureTool/writeAgent/cleanup) 已抽共享 test/helpers.ts.
// ISSUE-07 测试隔离改造: 内置 3 agents (explorer/worker/reviewer) 常驻名册后, 全量名册断言失效 —
// 改为按 user 源名过滤断言 (内置源隔离: 名册行形如 "- <name>: <desc>", 按 frontmatter name 排序).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeTempHome, withHome, captureTool, writeAgent, cleanup } from "./helpers.ts";
import { discoverAgents, formatAgentList } from "../agents.ts";

async function listText(home: string): Promise<string> {
  return withHome(home, async () => {
    const tool = captureTool();
    const result = await tool.execute("call-1", { action: "list" }, undefined, undefined, {} as ExtensionContext);
    const text = result.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    return text;
  });
}

// 内置源隔离: 从全量名册中过滤出 user 源写入的 agent 行 (内置 explorer/reviewer/worker 常驻, 不参与断言).
function userLines(text: string, names: string[]): string[] {
  return text.split("\n").filter((l) => names.some((n) => l.startsWith(`- ${n}:`)));
}

test("TC-003 list merges user agents sorted by name", async () => {
  const home = makeTempHome();
  try {
    // 文件写入顺序与名字排序相反, 断言只依赖 frontmatter name 排序 (M3-04 考察点 4);
    // 内置 agents 常驻名册 → 过滤 user 源行后断言相对序 (内置源隔离).
    writeAgent(home, "zeta.md", "name: Zeta\ndescription: 处理研究任务");
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    const text = await listText(home);
    assert.deepEqual(userLines(text, ["Alpha", "Zeta"]), ["- Alpha: 处理只读审查", "- Zeta: 处理研究任务"]);
  } finally {
    cleanup(home);
  }
});

test("TC-004 empty roster renders - (none)", async () => {
  const home = makeTempHome();
  try {
    // ISSUE-07: 内置 agents 常驻后 discoverAgents 不可能为空, "- (none)" 兜底分支改为直接单测格式化函数;
    // 全路径 (空 user 目录) 断言名册 = 内置 3 agents (M1-D008).
    assert.equal(formatAgentList([]), "- (none)");
    const text = await listText(home);
    const lines = text.split("\n");
    assert.equal(lines.length, 3, "空 user 目录时名册应恰为内置 3 agents");
    for (const name of ["explorer", "reviewer", "worker"]) {
      assert.ok(lines.some((l) => l.startsWith(`- ${name}: `)), `名册应含内置 agent ${name}`);
    }
  } finally {
    cleanup(home);
  }
});

test("TC-005 missing name or description is silently skipped", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "good.md", "name: Good\ndescription: 正常 agent");
    writeAgent(home, "no-name.md", "description: 缺 name");
    writeAgent(home, "no-desc.md", "name: NoDesc");
    const text = await listText(home);
    // 内置 agents 常驻 → 过滤 user 源行断言 (user 源只有 Good 存活).
    assert.deepEqual(userLines(text, ["Good"]), ["- Good: 正常 agent"]);
  } finally {
    cleanup(home);
  }
});

// EXECUTION.md 调和 16: 同名 agent 冲突 = user 覆盖内置 (对齐官方示例 agentMap 去重语义);
// list 去重后只列一条, 描述取 user 版 (不与内置 explorer 双行并列).
test("TC-007 same-name user agent overrides builtin in roster (调和 16)", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "explorer.md", "name: explorer\ndescription: user 版 explorer\ntools: bash");
    const text = await listText(home);
    const explorerLines = text.split("\n").filter((l) => l.startsWith("- explorer: "));
    assert.equal(explorerLines.length, 1, "同名 agent list 应只列一条, got: " + JSON.stringify(explorerLines));
    assert.equal(explorerLines[0], "- explorer: user 版 explorer", "描述应取 user 版");
    // 数据面: discoverAgents 同名去重后 explorer 恰一条且 source=user.
    const agents = await withHome(home, async () => discoverAgents().filter((a) => a.name === "explorer"));
    assert.equal(agents.length, 1, "discoverAgents 同名应去重为一条");
    assert.equal(agents[0].source, "user", "同名去重 user 应胜出");
    assert.deepEqual(agents[0].tools, ["bash"], "tools 取 user 版");
  } finally {
    cleanup(home);
  }
});

test("TC-006 tools as YAML block list does not crash and parses", async () => {
  const home = makeTempHome();
  try {
    writeAgent(
      home,
      "tools-agent.md",
      "name: ToolsAgent\ndescription: 带工具列表的 agent\ntools:\n  - read\n  - bash",
    );
    const text = await listText(home);
    // 内置 agents 常驻 → 过滤 user 源行断言 (user 源只有 ToolsAgent).
    assert.deepEqual(userLines(text, ["ToolsAgent"]), ["- ToolsAgent: 带工具列表的 agent"]);
    // 数组 tools 被规范化为 string[] (M3-04 考察点 3 Array.isArray 防御), 非 .split 崩溃路径.
    // ISSUE-07: 内置 agents 常驻 → discoverAgents 过滤 user 源后断言 (内置源隔离).
    const agents = await withHome(home, async () => discoverAgents().filter((a) => a.source === "user"));
    assert.equal(agents.length, 1);
    assert.deepEqual(agents[0].tools, ["read", "bash"]);
  } finally {
    cleanup(home);
  }
});
