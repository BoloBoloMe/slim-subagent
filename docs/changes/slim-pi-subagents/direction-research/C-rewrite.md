# 方向 C 评估报告: 重写最小核心 (rewrite from scratch)

- 调查日期: 2026-08-08
- 方向: 不删旧代码, 从零写一个新的最小 pi 扩展, 只实现保留功能, 按需从 pi-subagents 搬运
- 代码库 (只读): /var/mnt/DATA/Workspace/subagent/pi-subagents-main (66,465 行 TS, v0.44.0)
- API 依据: @earendil-works/pi-coding-agent docs/extensions.md (2962 行), docs/json.md, examples/extensions/subagent/ (1141 行)
- 保留功能集假设 (用户未点名): 单次委派 (agent+task) / chain 顺序链 / parallel 并行 / 模型选择 / 结果回收

---

## 1. pi 扩展 API 最小面

### 1.1 注册自定义工具需要什么 (依据官方 docs)

| 能力 | API | 证据 |
|---|---|---|
| 扩展入口 | `export default function (pi: ExtensionAPI)`, jiti 加载 TS 免编译, 同步/异步工厂 | extensions.md "Writing an Extension" |
| 放置与热重载 | `~/.pi/agent/extensions/*/index.ts` 或 `.pi/extensions/`, `/reload` 热重载; 或 `pi -e ./path.ts` | extensions.md "Extension Locations" |
| 注册工具 | `pi.registerTool({name, label, description, parameters (typebox), execute(id, params, signal, onUpdate, ctx), renderCall?, renderResult?})` | extensions.md "Custom Tools" + Quick Start 示例 |
| 工具返回 | `AgentToolResult<Details>` = `{content, details, isError?, usage?}` | extensions.md Quick Start; @earendil-works/pi-agent-core |
| 工具参数 schema | typebox `Type.Object`, 随 `parameters` 注入模型 | extensions.md "Custom Tools" |
| 生命周期 | 后台资源 (进程/定时器) 不得在 factory 启动, 必须挂 session_start / session_shutdown | extensions.md "Long-lived resources and shutdown" |
| 自定义渲染 | `renderCall(args, theme)` / `renderResult(result, options, theme, context)`, 基于 @earendil-works/pi-tui (Text/Container/Markdown) | extensions.md "Custom UI" |
| 可选增强 | `pi.on()` 事件订阅, `pi.events` 扩展间总线, `pi.registerCommand`, `pi.registerMessageRenderer` | extensions.md "ExtensionAPI Methods" |

最小依赖: `@earendil-works/pi-coding-agent` (类型+辅助), `typebox` (schema), `@earendil-works/pi-tui` (渲染), node builtins (child_process/fs/os/path)。全部为 peerDependencies (pi-subagents package.json 已声明)。

### 1.2 子代理扩展还需要哪些 pi 能力

官方示例 `examples/extensions/subagent/index.ts` (1015 行) 证明的最小集:

1. **spawn 子会话 = 独立 `pi` 进程** (非 API 调用, 而是 CLI 进程):
   - `spawn("pi", ["--mode", "json", "-p", "--no-session", "--model", m, "--tools", t, "--append-system-prompt", file, "Task: ..."])`
   - 证据: 示例 index.ts `runSingleAgent()` (行 ~246-360), `getPiInvocation()`; flags 有效性: docs/json.md:4 (`pi --mode json`), docs/rpc.md:17 (`--no-session`), extensions.md 提及 `--append-system-prompt`; pi-subagents pi-args.ts:522 同样 push `--no-session`, execution.ts:312 `baseArgs: ["--mode", "json", "-p"]`
2. **事件流 = 子进程 stdout JSONL** (docs/json.md): `session` 头 + `agent_start/turn_start/message_start/message_update/message_end/turn_end/agent_end` + `tool_execution_start/end` + `tool_result_end` (示例自行定义)。父进程逐行 JSON.parse, 从 `message_end` 累积 assistant 消息/usage/model/stopReason
3. **取消**: execute 的 `signal: AbortSignal` (pi 传入), 监听后 `proc.kill("SIGTERM")`, 5s 后 SIGKILL (示例); 也可用 `ctx.signal` 做嵌套工作取消 (extensions.md "ctx.signal")
4. **事件钩子 (可选)**: `pi.on("tool_result")` 等; 可信核心不需要, 但保留扩展间协作时用 `pi.events`
5. **CLI flags 全集** (pi-subagents pi-args.ts buildPiArgs, 行 418-560 为 args 组装): `--session/--session-dir/--no-session`, `--model`, `--tools/--no-tools`, `--extension`, `--no-context-files`, `--no-skills`, `--system-prompt/--append-system-prompt`, `@file` (超长 task)。核心集只用其中 5 个。

结论: 写新扩展注册自定义工具的最小面 = 一个 `registerTool` + node spawn; 官方示例 1141 行 (index.ts 1015 + agents.ts 126) 是"最小可行子代理扩展"的现成证明。

---

## 2. 最小核心范围

### 2.1 subagent-executor.ts (5483 行) 拆解

按功能区段 (证据: 行号 + grep):

| 区段 | 行范围 | 性质 |
|---|---|---|
| import | 1-160 | 36 个 import, 牵连 acceptance/clarify/watchdog/missions/steering/background | 
| 校验/规范化/上下文策略 | 160-2000 | canonicalizeExecutionParams (1700), validateExecutionInput (1754), context policy (1906-1942), fork (1942), timeout (1982), toolBudget (2001-2017), 大量为附加功能服务 |
| nested/resume/steer/intercom 辅助 | 396-1600 | 为 async/steer/intercom 服务, 核心集不需要 |
| 管理 action 分发 | 4400-5110 (~710 行) | 25+ 管理动作: mission.create/update/close (4471-4485), watchdog (4498), refine (4508), grant-spawn-budget (4531), children.list (4603), doctor (4611), status (4647), approve/reject-checkpoint (4698), resume (4752), steer (4755), append-step (4830), stop (4850), interrupt (4896) 等 |
| workflowScript 处理 | 4166-4400 (~230 行) | 可编程编排 + mission 绑定 |
| 核心执行分发 | 3690-3966 (single ~280), 3000-3690 (chain/parallel 调度 ~700), 5110-5428 (~320) | 真正的核心执行入口 |
| 导出工厂 | 4107-5483 | createSubagentExecutor, 组装上述全部 |

估算: 核心执行逻辑 (single/parallel/chain 调度 + 参数规范化核心) 约占 25-35%; 其余为 workflow/mission/watchdog/steering/管理 action/clarify/intercom 挂钩。

### 2.2 execution.ts (1868 行) 拆解

- runSync wrapper (1742-1868, 126 行): detach 收据协议 (后台分离), 核心集不需要
- runSyncCompletion (1341-1742, ~400 行): model candidates/fallback 解析, acceptance prompt 注入, skills/memory/refinement 注入, 重试循环
- runSingleAttempt (275-1341, ~1066 行): **核心 = spawn + JSONL 解析 + 进度更新 + 终止协议**, 关键行:
  - spawn (行 ~492-515): `getPiSpawnCommand` + `stdio: ["ignore","pipe","pipe"]`
  - processLine (831-970): JSON.parse; `message_end` → 累积 messages/usage/turns/model/stopReason (914-957); `tool_result_end` → 累积 (958+); `tool_execution_start/end` → 进度 (878-913)
  - 终止协议 (531-604): terminal assistant stop (`stopReason === "stop"` 且无 toolCall) → 1s grace drain → SIGTERM → 3s SIGKILL; `agent_settled` 兜底
  - 取消: signal/abort listener → kill
  - 附加 (非核心): watchdog 状态机 (844-875), control/needs_attention (705-830), turnBudget/toolBudget 定时器 (531-575), timeout 三阶段 kill, detach (intercom), acceptance 台账, structured output

估算: 核心 (spawn + 解析 + 终止 + 取消) ≈ 500-600 行; 附加挂钩 ≈ 40-50%。

### 2.3 结果如何传回父会话

- 子进程 stdout JSONL 逐行解析 (execution.ts:831 processLine), 累积到 `result.messages` (SingleResult), 最终输出 = 最后一条 assistant 文本 (`getFinalOutput`, 官方示例)
- usage (input/output/cacheRead/cacheWrite/cost/turns) 从 `message_end.usage` 累加
- 流式: 每个事件后 `fireUpdate()` → `onUpdate` → TUI (官方示例 emitUpdate 同粒度)
- 错误: stderr 捕获 + `stopReason === "error"|"aborted"` + `errorMessage` → isError 结果
- 核心集最小方案 = 官方示例同款: 结果全在进程内拼装返回, 无落盘

### 2.4 会话/产物目录管理最小需要

- 核心集最小: 无持久目录。子进程 `--no-session` (不写会话文件), 临时目录仅存 prompt 文件 (官方示例 `writePromptToTempFile` mkdtemp, 用完 unlink)
- pi-subagents 的 DIRS (shared/types.ts:1908: results/async/chain/artifacts) + `getSubagentSessionRoot` (extension/index.ts, 按父会话文件派生子会话目录) 只服务于 async 结果回收/status/transcript/分享, 核心集不需要
- 若保留"子会话可回看", 最小 = 一个 `--session-dir` 指向临时目录 (pi-args.ts:524-526 已实现), 无需要额外代码

### 2.5 结论: 可信核心需要哪些组件

| 组件 | 需要 | 来源 |
|---|---|---|
| agents 定义加载 (frontmatter md) | 是 (~126-200 行) | 官方示例 agents.ts 或 pi-subagents frontmatter.ts 简化 |
| tool 注册 + schema + description | 是 (~100 行) | 官方示例 |
| 子进程 spawn + 参数组装 | 是 (~150 行) | pi-args.ts args 核心裁剪 |
| JSONL 事件解析 + 结果回收 | 是 (~200 行) | execution.ts processLine 核心裁剪 |
| single/parallel/chain 调度 | 是 (~150 行) | 官方示例 execute() |
| 模型选择 (agent.model + fallback) | 是 (~60 行) | agent 字段 + --model flag; fallback 循环可加 |
| 取消 (signal → kill) | 是 (~20 行) | 官方示例 |
| 超时 (timeoutMs) | 建议加 (~30 行) | pi-subagents resolveForegroundTimeout 简化 |
| acceptance/clarify/watchdog/notice/async/workflow/mission/schedule/intercom/rpc/slash/fleet | 否 | 整体省略 |

合计: **~800-1100 行** (含 TUI 渲染), 即官方示例 1141 行量级 + fallback/thinking/tools 增量。

---

## 3. 可搬运清单与成本

### 3.1 可整块搬运

| 内容 | 位置 | 规模 | 说明 |
|---|---|---|---|
| 内置 agents (scout/worker/reviewer/oracle/researcher/delegate) | agents/*.md | 6 文件纯数据 | 原样复制 |
| 提示词模板 | prompts/*.md | 5 文件纯数据 | 如保留 `/parallel-review` 等工作流则复制 |
| skill | skills/pi-subagents | 纯数据 | 如保留 |
| frontmatter 解析 | src/agents/frontmatter.ts | 65 行纯函数 | 无依赖, 可整搬; 或直接用 pi 的 `parseFrontmatter` (官方示例 agents.ts:7) |
| spawn args 组装核心 | src/runs/shared/pi-args.ts 行 418-560 (args 部分) | ~140 行可裁剪 | 核心 = --mode json -p, --no-session, --model, --tools, --append-system-prompt, Task:; 裁掉 env/权限/watchdog 管线 (600-798) |
| JSONL 事件解析核心 | src/runs/foreground/execution.ts 行 831-970 (processLine) | ~140 行可裁剪 | 裁掉 watchdog/control/toolBudget 分支 |
| 终止协议参照 | execution.ts 行 531-604 | 参考 | 官方示例只有 abort-kill, 无 terminal-stop drain; 建议移植 |
| 官方示例整体 | examples/extensions/subagent/index.ts + agents.ts | 1141 行 | 直接作为新扩展基线 |
| 配置读取 | src/extension/config.ts | 76 行 | 小, 可搬 (若保留 config.json) |

### 3.2 必须重写 / 整体省略

必须重写: 无 (核心集全部有现成参考)。省略 (不搬): acceptance (1365), chain-clarify (1354), watchdog (runtime 868 + settings 568 + lsp 537 + child-status), missions (store 507 + lifecycle + actions), scheduled-runs (753), background runner (4718), async 家族 (async-execution 1574, async-job-tracker 511, run-status 504, subagent-wait 661, wait-tool), workflows (502), tui/fleet (879+577+564), intercom (715), rpc (653), slash (994), policy, profiles (661), agents/agent-management (1256) 与 agent-refinements (624) 等管理面。

### 3.3 工作量粗估 vs 方向 A

| 步骤 | 方向 C 成本 |
|---|---|
| 以官方示例为基线裁剪 | 0.5-1 天 |
| 增量: model/fallbackModels/thinking/tools allowlist/timeoutMs | 0.5-1 天 |
| 搬运内置 agents/prompts/skills | 0.5 天 |
| 测试: e2e 冒烟 (真实 pi spawn single/chain/parallel) + 单测 (frontmatter/event parse) | 0.5-1 天 |
| **合计** | **1-2 天, 交付 ≤1500 行** |

方向 A (硬删) 对比: 66K 行里外科手术式删除。关键困难:
- 耦合中心 shared/types.ts (2069 行) 的 SubagentState 同时服务 async/foreground/mission/fleet/control; 删任一功能都触碰 state 与事件订阅 (extension/index.ts session_start/session_shutdown 双清单一对一)
- SubagentParams schema (375 行, 30+ 参数) 与 action 分发 (25+ 动作) 已深度嵌套, 硬删 schema 字段需同步删校验/分发/描述
- 结果: 方向 A 需要先建依赖图 (成本 ≥1-2 天仅分析), 删除回归风险高, 且保留集 schema/描述仍大 (token 收益有限)
- 结论: 对"一次性裁剪"场景, 方向 C 成本 ≤ 方向 A 且风险更低

---

## 4. 风险

### 4.1 行为不一致 (隐性知识在 35K 行 runs/)

| 边界 case | pi-subagents 现状 | 官方示例现状 | 重写需注意 |
|---|---|---|---|
| 取消 | signal → kill + interruptController 双通道 + detach 协议 | signal → SIGTERM → 5s SIGKILL | 基础可覆盖; 缺 detach (后台化) |
| 超时 | 前台默认 30m, 三阶段终止 (drain → SIGTERM → SIGKILL), execution.ts:531-604 | 无 timeoutMs | **需自行补**, ~30 行 |
| 流式 | message_end 粒度 onUpdate + progress 字段 (toolCount/tokens/recentTools) | message_end 粒度 onUpdate | 一致 |
| 终止协议 | terminal stop 后 1s grace → SIGTERM → 3s SIGKILL; agent_settled 兜底 | 等 close 事件 | 示例可能等子进程自然退出 (pi 自身会在 stop 后退出), 风险低但需 e2e 验证 |
| 错误路径 | stopReason aborted/error/errorMessage, stderr, 非 JSON stdout 容忍 (execution.ts:835-843), 退出码语义 (-2 detached/1 失败) | exitCode 0/1 + stderr + errorMessage | 基础一致; 非 JSON 行容忍需保留 |
| 模型 | fallbackModels 重试链 + thinking 后缀 + modelScope | 仅 agent.model → --model | fallback 需要自写 (~40 行) |
| 子进程寻址 | getPiSpawnCommand (pi-spawn.ts, 163 行) 处理 bun/打包场景 | getPiInvocation 同思路 | 两者可参考, 测试环境需验证 |

### 4.2 重写漏功能风险

- 若保留集日后扩展 (async 后台 / acceptance 验收 / clarify), 需要反向移植 + 重新推导隐性行为; 本报告即为搬运地图
- 缓解: 交付时列出"已知行为差异清单" (timeout/drain/fallback 为最可能的差异点)

### 4.3 测试策略

- 官方示例 0 测试; pi-subagents 有 65K 行测试 (test/integration/single-execution.test.ts 5093 行等), 但全部针对旧行为, 不可直接复用
- 建议: (a) e2e 冒烟: 真实 spawn pi 子进程跑 single/chain/parallel + 模型选择, 断言退出码/最终输出/usage; (b) 纯函数单测: frontmatter 解析, JSONL 解析, task 模板 {previous} 替换; (c) 可选 golden 对拍: 同一 task 新旧扩展各跑一次对比输出
- 无测试基建成本 (pi 官方示例即可作为冒烟脚本模板)

### 4.4 版本风险

- 钉死版本不追上游 = 旧扩展冻结, 但新扩展依赖的 `@earendil-works/pi-coding-agent` (peer) 会随 pi 升级; 需在交付时记录已验证的 pi 版本, 并声明 API 兼容面 (registerTool/execute/signal/JSON 事件流)

---

## 5. 收益评估 (对照验收三件套)

### 5.1 只暴露保留能力, 高频工作流可用

- 新扩展仅一个 `subagent` 工具, 3 种模式 (single/parallel/chain); 官方示例即证明可跑通
- 用户高频工作流 (README 常见工作流表): 单次委派 ✓, chain (implement then review) ✓, parallel reviewers ✓, 模型选择 (agent.model) ✓, 结果回收 ✓
- **对保留集变化的敏感度: 低-中**。核心集内 (可信核心) 官方示例覆盖 100%, 收缩保留集 (去掉 chain/parallel) 只需删分支; 扩张保留集 (async/acceptance) 则每项需 +500-1500 行简化实现与隐性行为推导, 但依然 ≪ 66K, 因为只实现保留子集

### 5.2 token 开销可量化下降 (实测数据)

| 注入项 | 现状 (pi-subagents) | 新核心 (官方示例口径) |
|---|---|---|
| tool description | FULL 4049 chars ≈ 1012 tokens; COMPACT 2271 chars ≈ 567 tokens (tool-description.ts 实测) | 306 chars ≈ 76 tokens |
| parameters schema | SubagentParams 375 行, 30+ 参数, 含 workflowScript/action/acceptance/toolBudget/mission 等深度描述 (schemas.ts) | 8 参数 (agent/task/tasks/chain/agentScope/confirmProjectAgents/cwd) ≈ 100-200 tokens |
| 合计 | **~1500+ tokens/次注入** | **~200-300 tokens/次注入** |
| 下降 | | **~5-10x, 可用字符串长度直接度量** |

说明: FULL 描述 1012 tokens 不含 schema; schema 参数描述按保守 300-500 tokens 计, 实际注入总账 ≥1500 tokens。新核心两项合计 ~200-300 tokens (估算, 交付时可精确测量)。

### 5.3 代码易于维护且精简

- 交付 ~800-1500 行 vs 当前 66,465 行 (≥44x 缩小)
- 无 legacy 耦合: 新代码只依赖官方 pi API + node builtins, 无 shared/types.ts 枢纽
- 单文件起步 (官方示例即单 index.ts), 结构即功能清单

### 5.4 主要风险 (收益侧的代价)

- 行为回归: timeout/drain/fallback 等隐性行为需重写, e2e 验证不足会漏
- 保留集扩展时无缓冲: 旧代码 66K 虽重但功能完整, 新核心每加一个功能都要"重新发明"
- 双轨并存期: 新旧扩展同时安装会冲突 (同名 tool `subagent`); 需一次性切换

---

## 6. 结论建议

**方向 C 成立, 且是三个方向中成本最低、确定性最高的一个**:

1. **关键事实**: 官方 pi 自带 `examples/extensions/subagent/` (index.ts 1015 行 + agents.ts 126 行) 是可信核心 100% 的现成参考实现 — "从零写"实质是"以官方示例为基线做增量", 而非真正从零
2. **范围**: 最小核心 ≈ 800-1100 行; 在官方示例上加 agent.model/fallbackModels/thinking/tools allowlist/timeoutMs/终止 drain 协议 (~300-500 行增量); 整块搬运 agents/*.md 与 prompts/*.md
3. **成本**: 1-2 天, 显著低于方向 A (66K 行外科手术 + 依赖图分析 + 高回归风险)
4. **token 收益**: 可量化 ~5-10x 下降 (描述 1012→76 tokens, schema 30+ 参数→8 参数)
5. **敏感度**: 对"保留集 = 可信核心"低敏感; 若保留集确定含 async 后台运行或 acceptance, 需在动手前重新确认 — 这两项会把规模推高到 3000-5000 行且各自需要重新推导隐性行为
6. **建议动作**: (a) 先与用户钉死保留集边界 (尤其 async/acceptance 是否保留); (b) 以官方示例为骨架新建独立目录 (如 `slim-subagent/`), 不触碰 pi-subagents-main; (c) 交付时附带行为差异清单 (timeout/drain/fallback) 与已验证 pi 版本号