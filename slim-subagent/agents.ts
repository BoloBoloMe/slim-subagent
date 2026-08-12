// slim-subagent agents 发现模块 — ISSUE-01 TS-002 切片 (M2-D007 两源, M3-04 考察点 3/4).
// 两源: 内置 (扩展目录 agents/, 本 issue 阶段可为空目录) + user (getAgentDir()/agents = ~/.pi/agent/agents/).
// frontmatter 用 pi 包 parseFrontmatter (yaml 真解析); name/description 缺失静默跳过;
// tools 兼容逗号串与 YAML 块列表数组 (Array.isArray 防御, 官方示例 .split 会崩).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "builtin" | "user";
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
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      systemPrompt: body,
      source,
    });
  }
  return agents;
}

// M2-D007: 只扫内置 + user 两源, 无 project 源.
// EXECUTION.md 调和 16: 同名 agent 冲突 = user 覆盖内置 (对齐官方示例 agentMap 去重语义);
// list 只列一条, spawn find 解析到 user 版 (tools/model/prompt 取 user 定义).
export function discoverAgents(): AgentConfig[] {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const builtin = loadAgentsFromDir(path.join(extensionDir, "agents"), "builtin");
  const user = loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user");
  const byName = new Map<string, AgentConfig>();
  for (const a of [...builtin, ...user]) byName.set(a.name, a);
  return [...byName.values()];
}

// M1-D009 最小 list: 每行 `- <name>: <description>`, 按名排序, 空则 `- (none)` (M3-04 考察点 4).
export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "- (none)";
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map((a) => `- ${a.name}: ${a.description}`).join("\n");
}
