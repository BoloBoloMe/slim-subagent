// 共享测试辅助 — ISSUE-01 三测试文件重复 (makeTempHome/withHome/captureTool/writeAgent/resultText/cleanup),
// ISSUE-02 TS-001 顺手抽取共享, 不改变既有语义.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import extensionFactory from "../index.ts";

export type ExecutedResult = AgentToolResult<unknown> & { isError?: boolean };

export type RegisteredTool = {
  execute: (
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<ExecutedResult>;
  // ISSUE-07: 渲染接线冒烟 (TC-004) — renderCall/renderResult 已注册且返回 pi-tui 组件.
  renderCall?: (...args: unknown[]) => unknown;
  renderResult?: (...args: unknown[]) => unknown;
};

export function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slim-subagent-test-"));
}

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

// ISSUE-06: fake pi env 注入 + 恢复 (resume/锁/GC 测试共用; 临时 HOME 隔离 + bundle/argv 回显开关).
// 与既有 per-file 辅助同构 (single.test.ts runSingle), 抽共享避免三个新测试文件重复 env 搬运.
export async function withFakePi<T>(
  home: string,
  scenario: string,
  opts: { bundlePath?: string; echoArgvDir?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const prevBinary = process.env.PI_SUBAGENT_PI_BINARY;
  const prevScenario = process.env.FAKE_PI_SCENARIO;
  const prevBundle = process.env.FAKE_PI_ECHO_BUNDLE;
  const prevArgvDir = process.env.FAKE_PI_ECHO_ARGV_DIR;
  try {
    return await withHome(home, async () => {
      process.env.PI_SUBAGENT_PI_BINARY = FAKE_PI;
      process.env.FAKE_PI_SCENARIO = scenario;
      if (opts.bundlePath !== undefined) process.env.FAKE_PI_ECHO_BUNDLE = opts.bundlePath;
      if (opts.echoArgvDir !== undefined) process.env.FAKE_PI_ECHO_ARGV_DIR = opts.echoArgvDir;
      return await fn();
    });
  } finally {
    if (prevBinary === undefined) delete process.env.PI_SUBAGENT_PI_BINARY;
    else process.env.PI_SUBAGENT_PI_BINARY = prevBinary;
    if (prevScenario === undefined) delete process.env.FAKE_PI_SCENARIO;
    else process.env.FAKE_PI_SCENARIO = prevScenario;
    if (prevBundle === undefined) delete process.env.FAKE_PI_ECHO_BUNDLE;
    else process.env.FAKE_PI_ECHO_BUNDLE = prevBundle;
    if (prevArgvDir === undefined) delete process.env.FAKE_PI_ECHO_ARGV_DIR;
    else process.env.FAKE_PI_ECHO_ARGV_DIR = prevArgvDir;
  }
}

export function writeAgent(home: string, fileName: string, yaml: string, body = "system prompt body"): void {
  const dir = path.join(home, CONFIG_DIR_NAME, "agent", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), `---\n${yaml}\n---\n${body}\n`);
}

// getAgentDir() 每次调用读 env (PI_CODING_AGENT_DIR 优先, 否则 os.homedir() = $HOME), 无缓存.
// 临时 HOME 隔离 + 清掉可能的外部 PI_CODING_AGENT_DIR 覆盖.
export async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prevHome = process.env.HOME;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
}

export function captureTool(): RegisteredTool {
  let captured: RegisteredTool | undefined;
  const fakeApi = {
    registerTool(tool: RegisteredTool) {
      captured = tool;
    },
  } as unknown as ExtensionAPI;
  extensionFactory(fakeApi);
  if (!captured) throw new Error("registerTool 未被调用");
  return captured;
}

export function resultText(result: ExecutedResult): string {
  return result.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
}

export function cleanup(home: string): void {
  fs.rmSync(home, { recursive: true, force: true });
}
