// slim-subagent agents 发现模块 — ISSUE-01 TS-002 切片 (M2-D007 两源, M3-04 考察点 3/4).
// 两源: 内置 (扩展目录 agents/, 本 issue 阶段可为空目录) + user (getAgentDir()/agents = ~/.pi/agent/agents/).
// frontmatter 用 pi 包 parseFrontmatter (yaml 真解析); name/description 缺失静默跳过;
// tools 兼容逗号串与 YAML 块列表数组 (Array.isArray 防御, 官方示例 .split 会崩).
// model/thinking 不再走 frontmatter (设备差异配置): 来源 = 全局 settings.json subagent.<name> 块
// (~/.pi/agent/settings.json, 两台设备各自一份), frontmatter 遗留字段静默忽略.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
// ISSUE-01: 日志插桩 (仅加日志调用, 不改执行逻辑; 写失败静默吞, 见 log.ts).
import { logEvent } from "./log.ts";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  // 默认 model/thinking 来源 = settings.json subagent.<name> 块 (非 frontmatter);
  // thinking 取值同 pi --thinking (off/minimal/low/medium/high/xhigh/max); 缺省 = 不传, 走模型/pi 默认.
  model?: string;
  thinking?: string;
  systemPrompt: string;
  source: "builtin" | "user";
}

// settings.json subagent.<name> 条目 (每 agent 默认 model/thinking).
export interface SubagentModelOverride {
  model?: string;
  thinking?: string;
}

// M3-04 考察点 3: 逗号串 -> string[], YAML 块列表 (数组) -> string[], 其他 (缺失/非串) -> undefined.
function normalizeTools(raw: unknown): string[] | undefined {
  const items: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const tools = items
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: "builtin" | "user"): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    const { name, description } = frontmatter;
    // M3-04 考察点 3: name/description 缺失 (含空串/非串) 静默跳过, 不报错.
    if (typeof name !== "string" || name.trim() === "" || typeof description !== "string" || description.trim() === "") {
      continue;
    }

    agents.push({
      name,
      description,
      tools: normalizeTools(frontmatter.tools),
      // model/thinking 不再读 frontmatter (来源 = settings.json subagent 块, discoverAgents 合并).
      systemPrompt: body,
      source,
    });
  }
  return agents;
}

// 读全局 settings.json (<agentDir>/settings.json = ~/.pi/agent/settings.json) 的 subagent 字段:
// { "subagent": { "<agentName>": { "model": "...", "thinking": "..." } } }.
// 文件不存在/坏 JSON/无 subagent 字段 → undefined; 条目内非空 string 字段保留, 其余丢弃.
// 每次发现重读 (无缓存): 改 settings 即时生效, 文件小开销可忽略.
export function readSubagentOverrides(): Record<string, SubagentModelOverride> | undefined {
  const settingsPath = path.join(getAgentDir(), "settings.json");
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf-8");
  } catch {
    return undefined; // 文件不存在 (常见) → 无覆盖
  }
  let parsed: { subagent?: unknown };
  try {
    parsed = JSON.parse(raw) as { subagent?: unknown };
  } catch (e) {
    // L04 (warn): settings.json 坏 JSON → 忽略 subagent 覆盖 (不阻断 agents 发现).
    logEvent({ level: "warn", event: "agents.settings.invalid_json", errorMessage: (e as Error).message, data: { settingsPath } });
    return undefined;
  }
  if (typeof parsed.subagent !== "object" || parsed.subagent === null) return undefined;
  const result: Record<string, SubagentModelOverride> = {};
  for (const [name, entry] of Object.entries(parsed.subagent as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const model = (entry as { model?: unknown }).model;
    const thinking = (entry as { thinking?: unknown }).thinking;
    const clean: SubagentModelOverride = {
      ...(typeof model === "string" && model.trim() !== "" ? { model: model.trim() } : {}),
      ...(typeof thinking === "string" && thinking.trim() !== "" ? { thinking: thinking.trim() } : {}),
    };
    if (clean.model !== undefined || clean.thinking !== undefined) result[name] = clean;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// M2-D007: 只扫内置 + user 两源, 无 project 源.
// EXECUTION.md 调和 16: 同名 agent 冲突 = user 覆盖内置 (对齐官方示例 agentMap 去重语义);
// list 只列一条, spawn find 解析到 user 版 (tools/model/prompt 取 user 定义).
export function discoverAgents(): AgentConfig[] {
  try {
    const extensionDir = path.dirname(fileURLToPath(import.meta.url));
    const builtin = loadAgentsFromDir(path.join(extensionDir, "agents"), "builtin");
    const user = loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user");
    const byName = new Map<string, AgentConfig>();
    for (const a of [...builtin, ...user]) byName.set(a.name, a);
    // settings.json subagent.<name> 块合并 (user 覆盖内置之后, 按名对齐): 只补 model/thinking,
    // 不碰 description/tools/systemPrompt; 未配置的 agent 不动 (走模型/pi 默认).
    const overrides = readSubagentOverrides();
    if (overrides) {
      const applied: string[] = [];
      for (const a of byName.values()) {
        const o = overrides[a.name];
        if (o === undefined) continue;
        if (o.model !== undefined) a.model = o.model;
        if (o.thinking !== undefined) a.thinking = o.thinking;
        applied.push(a.name);
      }
      if (applied.length > 0) logEvent({ level: "debug", event: "agents.settings.applied", data: { agents: applied } });
    }
    return [...byName.values()];
  } catch (e) {
    // L04 (error): 发现失败 → 记日志后 rethrow (不改现有行为; 内部 loadAgentsFromDir 静默吞保持原样).
    logEvent({ level: "error", event: "agents.discover.failed", errorMessage: (e as Error).message });
    throw e;
  }
}

// M1-D009 最小 list: 每行 `- <name>: <description>`, 按名排序, 空则 `- (none)` (M3-04 考察点 4).
export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "- (none)";
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map((a) => `- ${a.name}: ${a.description}`).join("\n");
}
