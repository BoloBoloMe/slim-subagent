// ISSUE-01 TS-003 切片测试: execute 分发前校验层 (M2-D008 条件必填, M1-D009 error-driven 兜底).
// 接缝 (EXECUTION.md 测试策略接缝 1): fake ExtensionAPI 捕获 registerTool 后直调 execute,
// 断言 AgentToolResult 的 content/details/isError. 文件系统用临时 HOME 隔离 (同 TS-002).
// 测试辅助 (makeTempHome/withHome/captureTool/writeAgent/resultText/cleanup) 已抽共享 test/helpers.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeTempHome, withHome, captureTool, writeAgent, resultText, cleanup } from "./helpers.ts";
import { fileURLToPath } from "node:url";

// TC-012/013 在修复前会穿过校验层直达 spawn: 必须注入 fake pi, 否则红的形式是真子进程挂起 (默认 15min).
const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
async function withFakePi<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PI_SUBAGENT_PI_BINARY;
  process.env.PI_SUBAGENT_PI_BINARY = FAKE_PI;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
    else process.env.PI_SUBAGENT_PI_BINARY = prev;
  }
}

test("TC-007 unknown agent error lists all candidates", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "zeta.md", "name: Zeta\ndescription: 处理研究任务");
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    await withHome(home, async () => {
      const tool = captureTool();
      const result = await tool.execute(
        "call-1",
        { agent: "Ghost", task: "查资料" },
        undefined,
        undefined,
        {} as ExtensionContext,
      );
      assert.equal(result.isError, true);
      assert.ok(resultText(result).includes("Ghost"), "报错文本应点名未知 agent");
      assert.ok(resultText(result).includes("Alpha"), "报错文本应含全部候选名");
      assert.ok(resultText(result).includes("Zeta"), "报错文本应含全部候选名");
    });
  } finally {
    cleanup(home);
  }
});

test("TC-008 task and tasks together is rejected", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    await withHome(home, async () => {
      const tool = captureTool();
      const result = await tool.execute(
        "call-1",
        { agent: "Alpha", task: "单次任务", tasks: [{ agent: "Alpha", task: "并行任务" }] },
        undefined,
        undefined,
        {} as ExtensionContext,
      );
      assert.equal(result.isError, true);
      // 报错形态与 M2-D008 参数 2 描述 ("与 tasks 互斥") 一致.
      assert.ok(resultText(result).includes("互斥"), "报错文本应体现互斥约束");
    });
  } finally {
    cleanup(home);
  }
});

test("TC-009 default action without task or tasks is rejected", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    await withHome(home, async () => {
      const tool = captureTool();
      const result = await tool.execute(
        "call-1",
        { agent: "Alpha" },
        undefined,
        undefined,
        {} as ExtensionContext,
      );
      assert.equal(result.isError, true);
      const text = resultText(result);
      assert.ok(text.includes("task"), "报错文本应提及 task");
      assert.ok(text.includes("tasks"), "报错文本应提及 tasks");
    });
  } finally {
    cleanup(home);
  }
});

test("TC-010 action list without agent returns normally", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    await withHome(home, async () => {
      const tool = captureTool();
      const result = await tool.execute(
        "call-1",
        { action: "list" },
        undefined,
        undefined,
        {} as ExtensionContext,
      );
      assert.equal(result.isError, undefined, "list 不应标记为错误");
      // ISSUE-07: 内置 agents 常驻名册 → 断言 user 源 Alpha 行存在 (不再精确相等全量名册).
      assert.ok(resultText(result).includes("- Alpha: 处理只读审查"), "名册应含 user agent Alpha");
    });
  } finally {
    cleanup(home);
  }
});

// ---- review 修复项 1: `{task}` 无 agent → 明确校验报错 (M2-D008 执行模式 agent 条件必填), 列用法不泄露 undefined. ----

test("REV-1 task without agent is rejected with usage hint (no undefined leak)", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理只读审查");
    await withHome(home, async () => {
      const tool = captureTool();
      const result = await tool.execute(
        "call-1",
        { task: "查资料" },
        undefined,
        undefined,
        {} as ExtensionContext,
      );
      assert.equal(result.isError, true);
      const text = resultText(result);
      assert.ok(text.includes("agent"), "报错应点名缺 agent");
      assert.ok(text.includes("用法"), "报错应列用法");
      assert.ok(!text.includes("undefined"), "报错不应泄露内部 undefined");
    });
  } finally {
    cleanup(home);
  }
});

// 生效 model 缺失拒绝 (D024): 传参与 agent 默认都缺时禁止静默继承 pi 默认模型, 报错引导传参.
test("TC-012 single without model and without agent default is rejected", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理任务", "system prompt body", { noDefaultModel: true });
    await withHome(home, () => withFakePi(async () => {
      const tool = captureTool();
      const result = await tool.execute(
        "call-m1",
        { agent: "Alpha", task: "做事" },
        undefined,
        undefined,
        {} as ExtensionContext,
      );
      assert.equal(result.isError, true);
      assert.ok(resultText(result).includes("model"), "报错应点名 model");
      assert.ok(resultText(result).includes("Alpha"), "报错应点名 agent");
    }));
  } finally {
    cleanup(home);
  }
});

test("TC-013 parallel item without model and without agent default is rejected", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "alpha.md", "name: Alpha\ndescription: 处理任务", "system prompt body", { noDefaultModel: true });
    await withHome(home, () => withFakePi(async () => {
      const tool = captureTool();
      const result = await tool.execute(
        "call-m2",
        { tasks: [{ agent: "Alpha", task: "做事" }] },
        undefined,
        undefined,
        {} as ExtensionContext,
      );
      assert.equal(result.isError, true);
      assert.ok(resultText(result).includes("model"), "报错应点名 model");
    }));
  } finally {
    cleanup(home);
  }
});
