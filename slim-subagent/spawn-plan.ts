// spawn-plan.ts — 启动计划构建 (架构深化 候选肆: 合并 buildPiArgs/buildResumeArgs ~80% 同构双份).
// 一个深模块拥有: 子进程 argv 构建 (single 与 resume 两个真实调用方证明接缝为真) +
// 生效 model/thinking 解析 (原三副本: single.ts runSingleAgent / index.ts resolved 与 writeParallelRunJson).
// 进程内纯计算 + 一处文件写入 (>TASK_ARG_LIMIT 任务转 @file); resolve-skill 扩展路径解析同归此处.

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// M3-04 考察点 2: task 内联转 @file 的字符上限.
export const TASK_ARG_LIMIT = 8000;

// resolve-skill 扩展路径: user 级 ~/.pi/agent/extensions/resolve-skill.ts (与父会话同源单一真相, 不 vendoring).
// 显式 -e 例外: --no-extensions 下显式 -e 仍生效, 使全部子代理可用 resolve_skill; 文件缺失静默跳过.
export function resolveSkillExtensionPath(): string | undefined {
  const p = path.join(getAgentDir(), "extensions", "resolve-skill.ts");
  return fs.existsSync(p) ? p : undefined;
}

/** 生效 model: 调用侧覆盖 ?? agent frontmatter (单一实现, 替代 single/index/resume 四副本). */
export function effectiveModelOf(override: string | undefined, agent: { model?: string } | undefined): string | undefined {
  return override ?? agent?.model;
}

/** 生效 thinking: 调用侧覆盖 ?? agent frontmatter (与 model 同规). */
export function effectiveThinkingOf(override: string | undefined, agent: { thinking?: string } | undefined): string | undefined {
  return override ?? agent?.thinking;
}

/**
 * 子进程 argv 构建 (M3-04 考察点 2 保留段 + EXECUTION.md 调和 8/14):
 * base ["--mode","json","-p","--session <file>"], --model/--thinking 有才加, --tools csv 有才加,
 * 恒 --no-skills + --no-extensions + 显式 -e resolve-skill 例外, --append-system-prompt <0600 文件>,
 * Task: <task> (>TASK_ARG_LIMIT 转 @file, 文件名由调用方定: single 带 agent 名, resume 固定 task-resume).
 */
export function buildSpawnArgs(opts: {
  task: string;
  sessionFile: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  promptFile: string | null;
  tmpDir: string;
  taskFileBase: string; // @file 文件名 (不含扩展名): "task-<safeAgentName>" | "task-resume"
}): string[] {
  const args: string[] = ["--mode", "json", "-p", "--session", opts.sessionFile];
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
  args.push("--no-skills", "--no-extensions");
  const resolveSkillExt = resolveSkillExtensionPath();
  if (resolveSkillExt) args.push("-e", resolveSkillExt);
  if (opts.promptFile) args.push("--append-system-prompt", opts.promptFile);
  if (opts.task.length > TASK_ARG_LIMIT) {
    const taskFile = path.join(opts.tmpDir, `${opts.taskFileBase}.txt`);
    fs.writeFileSync(taskFile, opts.task, "utf-8");
    args.push("@" + taskFile);
  } else {
    args.push("Task: " + opts.task);
  }
  return args;
}
