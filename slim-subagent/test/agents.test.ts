// ISSUE-07 TS-001 切片测试: 内置 3 agents (M1-D008) — 名册可见 + spawn argv 工具面契约 + 渲染接线冒烟.
// 接缝 (EXECUTION.md 测试策略 1/2): fake ExtensionAPI 捕获 registerTool 直调 execute;
// fake pi 经 PI_SUBAGENT_PI_BINARY 注入 + FAKE_PI_ECHO_BUNDLE 回显 argv; 临时 HOME 隔离 user 源.
// 覆盖: M1-D008 (explorer/worker/reviewer), 内置 agent 默认 model (frontmatter 统一 opencode-go/deepseek-v4-flash),
// M1-D001(9) 渲染接线冒烟 (renderCall/renderResult 已注册且构造 pi-tui 组件不崩; 渲染效果属 TS-002 人工验证).
// 注: 渲染段 pi-tui 组件在测试环境仅模块加载/构造, 不调用 render (停止条件: 加载失败即停).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeTempHome, withHome, captureTool, writeAgent, cleanup, type ExecutedResult } from "./helpers.ts";
import { discoverAgents } from "../agents.ts";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

type Bundle = { argv: string[]; prompt?: { content: string; mode: number } };

async function runSingleWithBundle(
  home: string,
  params: Record<string, unknown>,
): Promise<{ result: ExecutedResult; bundle: Bundle }> {
  const prevBinary = process.env.PI_SUBAGENT_PI_BINARY;
  const prevScenario = process.env.FAKE_PI_SCENARIO;
  const prevBundle = process.env.FAKE_PI_ECHO_BUNDLE;
  const bundlePath = path.join(home, "echo-bundle.json");
  try {
    const result = await withHome(home, async () => {
      process.env.PI_SUBAGENT_PI_BINARY = FAKE_PI;
      process.env.FAKE_PI_SCENARIO = "assistant-stop";
      process.env.FAKE_PI_ECHO_BUNDLE = bundlePath;
      const tool = captureTool();
      const ctx = { cwd: home } as ExtensionContext;
      return tool.execute("call-1", params, undefined, undefined, ctx);
    });
    return { result, bundle: JSON.parse(fs.readFileSync(bundlePath, "utf-8")) as Bundle };
  } finally {
    if (prevBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
    else process.env.PI_SUBAGENT_PI_BINARY = prevBinary;
    if (prevScenario === undefined) delete process.env.FAKE_PI_SCENARIO;
    else process.env.FAKE_PI_SCENARIO = prevScenario;
    if (prevBundle === undefined) delete process.env.FAKE_PI_ECHO_BUNDLE;
    else process.env.FAKE_PI_ECHO_BUNDLE = prevBundle;
  }
}

test("TC-001 builtin agents discoverable with full tools and default model", async () => {
  const home = makeTempHome();
  try {
    // 名册 (空 user 目录 → 纯内置): 3 个内置 agent 均可见且描述非空 (M1-D008).
    const text = await withHome(home, async () => {
      const tool = captureTool();
      const r = await tool.execute("call-1", { action: "list" }, undefined, undefined, {} as ExtensionContext);
      return r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    });
    for (const name of ["explorer", "reviewer", "worker"]) {
      const line = text.split("\n").find((l) => l.startsWith(`- ${name}: `));
      assert.ok(line, `名册应含内置 agent ${name}`);
      assert.ok(line!.slice(`- ${name}: `.length).trim() !== "", `${name} 描述非空`);
    }
    // 数据面 (M1-D008): 均无 tools 字段 (全工具, spawn 不加 --tools); 均带默认 model (frontmatter 统一 opencode-go/deepseek-v4-flash);
    // 默认 thinking: explorer/worker=high, reviewer=max (deepseek 仅 off/high/max 可用, off 排除); body (system prompt) 非空.
    const builtin = discoverAgents().filter((a) => ["explorer", "reviewer", "worker"].includes(a.name));
    assert.equal(builtin.length, 3);
    for (const name of ["explorer", "reviewer", "worker"]) {
      assert.equal(builtin.find((a) => a.name === name)?.tools, undefined, `${name} 无 tools 字段 = 全工具`);
    }
    const thinkingOf = (name: string) => builtin.find((a) => a.name === name)?.thinking;
    assert.equal(thinkingOf("explorer"), "high", "explorer 默认 thinking=high");
    assert.equal(thinkingOf("worker"), "high", "worker 默认 thinking=high");
    assert.equal(thinkingOf("reviewer"), "max", "reviewer 默认 thinking=max");
    for (const a of builtin) {
      assert.equal(a.model, "opencode-go/deepseek-v4-flash", `内置 agent ${a.name} 默认 model 应为 opencode-go/deepseek-v4-flash`);
      assert.ok(a.systemPrompt.trim().length > 0, `${a.name} body (system prompt) 非空`);
    }
  } finally {
    cleanup(home);
  }
});

test("TC-002 explorer spawns without --tools and with default --model/--thinking", async () => {
  const home = makeTempHome();
  try {
    const { result, bundle } = await runSingleWithBundle(home, { agent: "explorer", task: "探查项目结构" });
    assert.equal(result.isError, undefined);
    const args = bundle.argv;
    assert.ok(!args.includes("--tools"), "explorer 无 tools 字段 → 省略 --tools (全工具)");
    assert.ok(args.includes("--model"), "内置 agent 带 frontmatter model → argv 含 --model");
    assert.equal(args[args.indexOf("--model") + 1], "opencode-go/deepseek-v4-flash", "默认 model = frontmatter 值");
    assert.ok(args.includes("--thinking"), "explorer 带 frontmatter thinking → argv 含 --thinking");
    assert.equal(args[args.indexOf("--thinking") + 1], "high", "explorer 默认 thinking = high");
    assert.ok(!args.includes("-e"), "临时 HOME 无 resolve-skill 扩展 → argv 无 -e (静默跳过)");
    assert.ok(bundle.prompt && bundle.prompt.content.trim().length > 0, "explorer system prompt 应注入");
  } finally {
    cleanup(home);
  }
});

// resolve-skill 例外: user 级扩展文件存在时 spawn argv 恒带 -e <路径> (--no-extensions 下显式 -e 仍生效),
// 使全部子代理 (含无 tools 字段的 worker) 可用 resolve_skill.
test("TC-002a resolve-skill extension is injected via -e when present in agent dir", async () => {
  const home = makeTempHome();
  try {
    const extDir = path.join(home, ".pi", "agent", "extensions");
    fs.mkdirSync(extDir, { recursive: true });
    const extPath = path.join(extDir, "resolve-skill.ts");
    fs.writeFileSync(extPath, "export default function () {}\n", "utf-8");
    for (const agent of ["explorer", "worker"]) {
      const { result, bundle } = await runSingleWithBundle(home, { agent, task: "任务" });
      assert.equal(result.isError, undefined);
      const args = bundle.argv;
      assert.ok(args.includes("-e"), `${agent} argv 应含 -e (resolve-skill 注入)`);
      assert.equal(args[args.indexOf("-e") + 1], extPath, `${agent} -e 应指向 user 级 resolve-skill.ts`);
      assert.ok(args.includes("--no-extensions"), `${agent} argv 仍含 --no-extensions (仅显式例外)`);
    }
  } finally {
    cleanup(home);
  }
});

test("TC-003 worker spawns with no --tools and default --model/--thinking", async () => {
  const home = makeTempHome();
  try {
    const { result, bundle } = await runSingleWithBundle(home, { agent: "worker", task: "写一个文件" });
    assert.equal(result.isError, undefined);
    const args = bundle.argv;
    assert.ok(!args.includes("--tools"), "worker 无 tools 字段 → argv 无 --tools (全工具语义)");
    assert.ok(args.includes("--model"), "worker frontmatter model → argv 含 --model");
    assert.equal(args[args.indexOf("--model") + 1], "opencode-go/deepseek-v4-flash");
    assert.ok(args.includes("--thinking"), "worker frontmatter thinking → argv 含 --thinking");
    assert.equal(args[args.indexOf("--thinking") + 1], "high", "worker 默认 thinking = high");
  } finally {
    cleanup(home);
  }
});

// EXECUTION.md 调和 16: 同名 agent 冲突 = user 覆盖内置 — spawn 解析到 user 版
// (tools/model/prompt 取 user 定义; 本测试 user explorer 加 tools, argv --tools 应取 user 值 — 内置版无 tools 字段).
test("TC-005 same-name user agent wins spawn resolution (调和 16)", async () => {
  const home = makeTempHome();
  try {
    writeAgent(home, "explorer.md", "name: explorer\ndescription: user 版 explorer\ntools: bash");
    const { result, bundle } = await runSingleWithBundle(home, { agent: "explorer", task: "探查项目结构" });
    assert.equal(result.isError, undefined);
    const args = bundle.argv;
    assert.ok(args.includes("--tools"), "spawn argv 应含 --tools");
    assert.equal(args[args.indexOf("--tools") + 1], "bash", "同名去重后 --tools 取 user 版值");
  } finally {
    cleanup(home);
  }
});

// M1-D001(9) 渲染接线冒烟 (可断言部分): renderCall/renderResult 已注册, 假 theme 构造组件不崩
// (Text/Container 构造不触终端; 不调用 render — 视觉效果属 TS-002 人工验证清单).
test("TC-004 render functions wired and construct components without crashing", async () => {
  const home = makeTempHome();
  try {
    await withHome(home, async () => {
      const tool = captureTool();
      assert.equal(typeof tool.renderCall, "function", "renderCall 应注册");
      assert.equal(typeof tool.renderResult, "function", "renderResult 应注册");
      const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
      const callComp = tool.renderCall!({ agent: "explorer", task: "探查" }, theme, {});
      assert.ok(callComp && typeof (callComp as { render?: unknown }).render === "function", "renderCall 应返回 pi-tui 组件");
      const resultComp = tool.renderResult!(
        {
          content: [{ type: "text", text: "done" }],
          details: { usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, runId: "r", sessionDir: "", exitCode: 0 },
        },
        { expanded: false, isPartial: false },
        theme,
        {},
      );
      assert.ok(resultComp && typeof (resultComp as { render?: unknown }).render === "function", "renderResult 应返回 pi-tui 组件");
      // parallel 折叠路径同样构造不崩.
      const parComp = tool.renderResult!(
        {
          content: [{ type: "text", text: "Parallel: 1/1 succeeded" }],
          details: {
            mode: "parallel",
            runId: "r",
            results: [
              {
                index: 0,
                agent: "explorer",
                task: "t",
                isError: false,
                text: "out",
                details: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, runId: "r", sessionDir: "", exitCode: 0 },
              },
            ],
          },
        },
        { expanded: false, isPartial: false },
        theme,
        {},
      );
      assert.ok(parComp && typeof (parComp as { render?: unknown }).render === "function", "parallel renderResult 应返回组件");
    });
  } finally {
    cleanup(home);
  }
});
