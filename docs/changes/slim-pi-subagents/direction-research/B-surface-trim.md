# 方向 B 侦察报告: 只裁暴露面 (不删引擎)

- 代码库: /var/mnt/DATA/Workspace/subagent/pi-subagents-main (只读, v0.44.0, 总源码 66,465 LOC, 测试 171 文件 65,043 LOC)
- 方法: 逐文件追踪注册调用 + 实测序列化 schema 字符数 (typebox@1.1.38 实跑 JSON.stringify)
- 保留集假设: 可信核心 = 单次委派 / chain / parallel / 模型选择 / 结果回收

## 1. 注册边界

入口唯一: index.ts (src/extension/index.ts, 805 LOC) export default, package.json `pi.extensions: ["./index.ts"]`.

父会话模型可见面 (全部经 `pi.registerTool`):
- `subagent` 工具: index.ts:581 `pi.registerTool(tool)`, 描述由 buildSubagentToolDescription 生成 (tool-description.ts:164), 参数 = SubagentParams (schemas.ts:284)
- `subagent_wait` 工具: index.ts:583 registerWaitTool → wait-tool.ts:33 `pi.registerTool(tool)`, 参数 SubagentWaitParams
- `subagent_supervisor` + `intercom` 两工具: supervisorChannel.start() (index.ts:759) → native-supervisor-channel.ts:635-637 registerParentTools 无条件注册 (无配置开关), 父侧模型可见

父会话非模型面注册 (TUI/事件):
- 5 个 registerMessageRenderer (index.ts:448-507): SLASH_RESULT_TYPE, SLASH_TEXT_RESULT_TYPE, subagent-notify, steering, control — 纯渲染, 模型不可见
- registerSlashCommands (index.ts:606 → slash-commands.ts:651-962): 14 命令 + 1 快捷键 (ctrl-alt-f) + prompt-workflows.ts:267 的 prompt-workflow 命令 + watchdog/register-main.ts:403 的 subagents-watchdog = 共 17 命令
- 事件桥: slashBridge (513), promptTemplateBridge (520), rpcBridge (531, 事件式 RPC, 不注册工具), herdrStatusBridge (631), watchdog (375), notify (376), missions 钩子 (agent_end, ~595), fleetStatus, scheduledRunManager

子会话 (每次 spawn 的 child pi 进程) 模型可见面 (subagent-prompt-runtime.ts, 588 LOC):
- `subagent_wait`: :496 无条件 registerWaitTool
- `contact_supervisor`: :497-512 无条件注册 (intercomBridge 配置不影响注册本身)
- `intercom` fallback: 仅当 child 工具白名单含 intercom 时
- `structured_output`: 仅 structured contract 场景 (529-536)
- fanout child 另注册精简版 `subagent` (fanout-child.ts:188, desc 305 chars)

结论: 裁暴露面 = 改上述注册调用点, 不碰 runs/ 引擎 (runs/foreground 10,685 LOC + runs/background ~14K LOC), 但 index.ts 本身就是巨型 wiring (engine 装配), 删注册需连带删 wiring.

## 2. token 账本 (模型可见面 = 工具名+description+schema JSON)

实测 (chars = 序列化字符数, ~tokens = chars/4):

父会话静态面 (每请求, 未计缓存):
| 工具 | description | schema JSON | 小计 | ~tok |
|---|---|---|---|---|
| subagent (full 模式) | 4049 (tool-description.ts:53) | 16988 (SubagentParams, 63 props) | 21037 | 5259 |
| subagent_wait | 1907 (wait-tool.ts:16) | 921 (4 props) | 2828 | 707 |
| subagent_supervisor (父) | 104 | 245 | 349 | 87 |
| intercom (父) | 100 | 245 | 345 | 86 |
| 合计 | 6160 | 18399 | 24559 | ~6140 |

compact 模式 (已有配置): subagent desc 2271 (tool-description.ts:96), 省 1778 chars ≈ 445 tok, 合计 ~5695 tok.

子会话面 (每次 spawn 固定开销):
| 项 | chars | ~tok | 出处 |
|---|---|---|---|
| subagent_wait (无条件) | 2828 | 707 | subagent-prompt-runtime.ts:496 |
| contact_supervisor | 363 | 91 | 同文件 :497 |
| intercom bridge 指令注入 child system prompt (默认 always) | 1627 | 407 | intercom-bridge.ts:24-38 |
| intercom (仅白名单含时) | 345 | 86 | - |
| 合计 | ~5163 | ~1291 | 每 child |

裁到可信核心后估算:
- subagent desc → ~1300 chars (删 missions/schedules/watchdog/refine/profiles/fleet/inspector/doctor/grant/append-step/approve-checkpoint 段落, 保留 execute + list/get/status + models + interrupt/stop/resume/steer)
- SubagentParams 63 props → ~20 props (workflowScript, agent, task, async, model, context, cwd, timeoutMs, output, skill, reads, toolBudget, turnBudget, acceptance, usageBudget, agentScope, mission:false, action:list/status, resume), schema JSON ≈ 5500-6000 chars
- subagent_wait desc → ~800 chars (保留, 异步结果回收需要), schema 921 不变
- 删父侧 subagent_supervisor/intercom (-694 chars)
- 合计 ≈ 8500-9000 chars ≈ 2130-2250 tok → 静态面 **-63%~-65%** (省 ~3900-4000 tok/请求)
- 若纯同步连 subagent_wait 也删: ≈ 6800 chars ≈ 1700 tok, **-72%**
- child 侧: 裁 intercomBridge off + 删 child 侧 subagent_wait/contact_supervisor → 每 spawn 省 ~1291 tok (保留 structured_output 契约)

附: 内置 agents (agents/*.md 共 17,367 chars) 不进父模型 (模型被指示先调 action:"list"), 是 child 侧单 agent 注入; skills (SKILL.md 4319 + references ~100KB) 与 prompts (5 模板) 按需加载, 非基线.

## 3. 现有配置机制 (纯配置路线能走多远)

config.json (~/.pi/agent/extensions/subagent/config.json, config.ts:76):
- `toolDescriptionMode: "compact"|"custom"` — 已有, 唯一能缩模型面的配置项 (省 445 tok; custom 可自写描述但 safety guidance 强制保留, tool-description.ts:151-162)
- `fleetView:false`, `asyncWidget:false` — 只关 TUI 面板, 0 tok 收益
- `waitTool.enabled:false` — 行为 no-op 但**工具仍注册**, 0 tok 收益 (docs/configuration.md:71 明说 "Keeps the subagent_wait tool registered")
- `missions.enabled:false`, `scheduledRuns.enabled:false` — 只关行为, 描述/schema 里的 action 文本仍在模型面前
- `intercomBridge.mode:"off"` — 省 child 侧 407 tok/指令注入, 但 contact_supervisor 注册不受影响
- `inlineToolDisplay`, `authorityPolicy`, `permissions`, `completionBatch` 等 — 行为项, 0 tok

settings.json (pi 侧) 的 `subagents` 键 (agents.ts:166, 858-866):
- `disableBuiltins: true` — 内置 agents 全部从发现结果消失 (不删文件)
- `agentOverrides.<name>.disabled: true` — 单 agent 禁用 (docs/agents.md:85)

结论: 纯配置能裁掉 TUI/通知/使命/调度等行为面, 但**两个大头必须动代码**: (a) subagent 的 63-prop schema 16988 chars 无任何配置裁剪手段; (b) subagent_wait/subagent_supervisor/intercom 的工具注册无开关. 纯配置路线静态面只能省 ~445 tok (~7%), 无法满足验收 2 的量化目标.

## 4. 维护面影响 (裁面不裁芯)

- 需改动文件 (注册面): extension/index.ts (805), extension/tool-description.ts (164), extension/schemas.ts (375), slash/slash-commands.ts (994), runs/shared/subagent-prompt-runtime.ts (588), intercom/native-supervisor-channel.ts (715), watchdog/register-main.ts (440, 可整段删), slash/prompt-workflows.ts (300), extension/rpc.ts (653, 可整段删), agents/ (6 文件), skills/, prompts/, package.json (pi.skills/pi.prompts 项)
- 引擎保留后成为不可达死代码 ≈ 25,000-30,000 LOC (missions/ 1832, watchdog runtime ~2000, profiles/ 661, tui/ 4129, inspectors/herdr, runs/background/scheduled-runs 等), 仍被 tsc + 171 个测试文件覆盖 — 类型检查全绿但功能无人走, 属"半死路径"
- 半死路径实例: index.ts:595 agent_end 的 missions 钩子、executor 内 scheduledRunManager.handleToolCall、notify 批次器 — 这些 wiring 嵌在 index.ts 与 executor 里, 纯删注册调用不够, 需连删 wiring 100-200 行才真正断开
- 测试影响: tool-description.test.ts, schemas.test.ts, native-supervisor-channel.test.ts, prompt-workflows.test.ts, subagent-prompt-runtime.test.ts, wait-subscriptions.test.ts 需同步改; 其余 ~160 个单元测试直接测引擎内部, 不受影响仍可过
- 建议分两档: B1 只裁描述/schema/注册 (diff 小, 死代码留下, 维护面 C 级); B2 加删死子树 (diff 大, 真精简, 维护面 A 级)

## 5. 收益上限与风险

收益上限 (对照验收三件套):
1. 保留能力全可用: 高. 核心路径引擎零改动, workflowScript 单发/chain/parallel/model/status+wait 全部原样; 风险点是 action 是自由字符串 (schemas.ts 无 enum 约束), 模型可能调用描述外动作 — 执行器对未知 action 返回错误即 fail-closed, 可接受
2. token 可量化下降: 静态工具面 -63%~-72% (≈3900-4400 tok/请求, prompt caching 下 cache read 同比例降), child 侧每 spawn -1291 tok
3. 维护: B1 不佳 (~3 万 LOC 死代码), B2 可接受
- 方向天花板: 这即是 B 方向的极限, 再深必须裁引擎 (方向 A/C)

主要风险:
1. 删 notify/control/steering renderer 后, 异步完成通知降级为纯文本消息 (display:true 仍可用) — 若用户要保留通知体验, 需留 subagent-notify renderer (index.ts:464)
2. 裁内置 agents (oracle/delegate/researcher) 会破坏引用它们的自定义 agent/chain 定义 (agent 不存在 → 启动报错), 需先 grep 用户侧 .pi/agents
3. 异步结果回收链: subagent_wait + notify + 轮询三选一, 若三样全裁, 后台结果只能靠用户手动 status — 核心里"结果回收"要求至少留一条链
4. 版本钉死 0.44.0 不追上游: 无上游冲突, 但失去安全修复 (permissions/watchdog 属安全面, 裁掉有暴露风险)
5. integration/e2e 测试若经注册面会挂, 需裁剪测试面

## 6. 结论建议

方向 B 可行且是三条方向里 diff 最小、风险最低的: 引擎零改动, 核心工作流 100% 保留, 静态工具面 token 降 ~65% (4K tok/请求) + child 侧 1.3K tok/spawn, 全部有实测数字背书.

但纯"只裁面"会在 66K LOC 里留下 3 万行死代码, 过不了验收 3. 建议 B 的落地形态 = B1(裁描述/schema/注册门控, 约 6-8 小时) + 顺手 B2(删 missions/profiles/tui-fleet/inspectors/schedules 死子树, +1-2 天, 依赖 import 图清理). 配置先行 (compact + fleetView/asyncWidget/missions/schedules/intercomBridge off + disableBuiltins) 作为零代码兜底, 但必须接受: 配置到不了 schema 和工具注册, 这两个大头只能靠代码.

工作量粗估: B1 编码 4-6h + 测试修整 2-3h; B2 额外 1-2 天; 合计 2-3 人日.
