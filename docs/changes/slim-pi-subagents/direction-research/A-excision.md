# 方向 A 侦察报告: 原地硬删 (pi-subagents 精简 fork)

- 侦察对象: /var/mnt/DATA/Workspace/subagent/pi-subagents-main (只读, v0.44.0)
- 代码规模: src 173 个 .ts, 66,465 行; test 75,328 行 (unit 40,472 + integration 24,347 + e2e 224 + fixtures/support 余量)
- 方法: 全部结论基于 grep/read 到的代码路径与行号, 未修改任何文件
- 保留集假设 (用户未点名, 本报告按其评估敏感度): 单次委派 / chain 顺序链 / parallel / 模型选择 / 结果回收

---

## 1. 功能-代码映射

### 1.1 可信核心 (保留集)

| 功能 | 代码位置 | 行数 | 说明 |
|---|---|---|---|
| 单次委派 (agent+task) | `src/runs/foreground/subagent-executor.ts` (总 5483, dispatch 4107-5483, runSinglePath 3550-3920), `src/runs/foreground/execution.ts` (总 1868, runSync 1742-1868), `src/runs/background/subagent-runner.ts` (总 4718, 子进程 runner), `src/runs/background/async-execution.ts` (1574, async 编排) | ~13,600 | 引擎主体, 不可删 |
| 子进程基础设施 | `src/runs/shared/pi-args.ts` (798), `subagent-prompt-runtime.ts` (588, 子提示词重写/工具注入), `child-protocol.ts` (401), `nested-events.ts` (1076), `single-output.ts` (235), `structured-output.ts` (182), `session-lease.ts` (299), `process-terminal.ts` (280), `top-level-async.ts` (14) | ~3,900 | 核心附属, 不可删 |
| chain 顺序链 (公开面) | `src/workflows/scripted-workflow.ts` (502, worker 线程 VM 引擎, runs.run/all/status/ref), executor workflow 分支 (4165-4410), `src/runs/foreground/chain-execution.ts` (1527, 旧 durable chain 执行), `src/runs/foreground/chain-clarify.ts` (1354, clarify TUI), `src/agents/chain-serializer.ts` (280), `src/runs/background/chain-append.ts` (328), `chain-root-attachment.ts` (199) | ~4,200+ | 两层语义, 见 2.4 决策点 |
| parallel | executor runParallelPath 3132-3550, runForegroundParallelTasks 2978-3132, parallel worktree 2835-2953; runner 并行组 1892-1941; `src/runs/shared/parallel-utils.ts` (256), `dynamic-fanout.ts` (297), `parallel-handoff.ts` (238), `workflow-graph.ts` (231), `shared/settings.ts` 并行解析 | ~2,500 | 核心 |
| 模型选择 | `src/runs/shared/model-fallback.ts` (336, fallbackModels/resolveModelCandidate), `src/shared/model-info.ts` (81), `model-scope.ts` (128), agents frontmatter model 字段, `src/profiles/profiles.ts` (661, provider 目录, 仅被 slash 引用) | ~1,200 | 核心 + profiles 为叶子 |
| 结果回收 | `result-watcher.ts` (414), `async-job-tracker.ts` (511), `notify.ts` (332), `completion-batcher.ts` (168), `completion-dedupe.ts` (54), `async-status.ts` (539), `run-status.ts` (504), `retained-children.ts` (68), `auto-drain.ts` (67), `run-id-resolver.ts` (167), `stale-run-reconciler.ts` (396), `src/tui/render.ts` (2029, 结果渲染), `subagent-wait.ts` (661)+`wait-subscriptions.ts` (253)+`wait-tool.ts` (34)+`wait-completions.ts` (112)+`wait-config.ts` (36) | ~5,900 | 核心 |

### 1.2 非保留功能 (候选切除)

| 功能 | 专属位置 | 行数 | 嵌入面 |
|---|---|---|---|
| watchdog 对抗二审 | `src/watchdog/` 16 文件: runtime.ts (868), settings.ts (568), lsp-diagnostics.ts (537), register-main.ts (440), review.ts (302), change-signature.ts (220), child-status.ts (205), types.ts (198), register-child.ts, permission-arbiter.ts, model-selection.ts, scope.ts, tool-actions.ts, turn-delta.ts, emission-guard.ts, warning-format.ts, render.ts | 4,395 | 深嵌子进程运行时 |
| missions 存档 | `src/missions/` 7 文件: store.ts (507), actions.ts (410), lifecycle.ts (346), workflow-state.ts (250), goal-driver.ts, types.ts | 1,832 | 深嵌 executor workflow 分支 |
| intercom / contact_supervisor | `src/intercom/`: native-supervisor-channel.ts (715, 子侧 contact_supervisor+intercom 工具), result-intercom.ts (421), intercom-bridge.ts (187) | 1,323 | 深嵌子进程 + 结果路径 |
| FleetView / tui | `src/tui/`: render.ts (2029), fleet.ts (879), fleet-status.ts (564), fleet-transcript.ts (577), render-helpers.ts (80); `src/runs/background/fleet-view.ts` (540) | 4,129 | render.ts 是核心渲染, 其余为面板 |
| slash 命令 | `src/slash/` 10 文件: slash-commands.ts (994, 约 15 个命令), subagents-admin.ts (432), delegation-adapters.ts (434), prompt-template-bridge.ts (383), prompt-workflows.ts (300), slash-live-state.ts (296), slash-bridge.ts (192), selector.ts, delegation-json.ts, delegation-request.ts | 3,452 | 仅 extension/index.ts 接线 |
| saved workflows (durable chain) | agents.ts ChainConfig (L197, 发现逻辑 1649-1664, .chain.md/.chain.json), chain-serializer.ts (280), chain-execution.ts (1527), chain-clarify.ts (1354), chain-append.ts (328), chain-root-attachment.ts (199) | ~4,200 | 仅 executor action 分支 (append-step/approve/reject-checkpoint) |
| acceptance 验收门 | `src/runs/shared/acceptance.ts` (1365) | 1,365 | 深嵌 5+ 引擎文件, 37 个文件引用 |
| inspectors (herdr) | `src/inspectors/herdr/` 4 文件 (654) + `src/integrations/herdr-status.ts` (330) + 根 inspector-runner.mjs (11) | 995 | executor action 分支 + extension 接线 |
| profiles | `src/profiles/profiles.ts` | 661 | 纯叶子, 仅 slash-commands 引用 |
| 定时调度 | `src/runs/background/scheduled-runs.ts` | 753 | extension/index + executor.executeScheduled + result-watcher.observeCompletion |
| worktree 隔离 | `src/runs/shared/worktree.ts` (759) + parallel-handoff.ts (238) + config worktreeSetupHook | 997 | 深嵌 executor/runner/async-execution/chain-execution |
| clarify TUI | `src/runs/foreground/chain-clarify.ts` | 1,354 | 仅 chain-execution 引用; 公开面已拒绝 clarify (public-execution.ts:32-33) |
| steering 干预 | `src/runs/background/steering.ts` (239) + async-steering-action.ts (256) + steering-notices.ts (35) + prompt-runtime registerSteeringInbox (L331) | ~530 | 深嵌 runner/prompt-runtime |
| control-channel | `src/runs/background/control-channel.ts` (stop/interrupt/steer 投递) | 692 | 核心附属 (运行管理), 建议保留 |
| RPC 桥 | `src/extension/rpc.ts` | 653 | 仅 extension/index 接线 |
| preflight / 启动契约 | `src/api/preflight.ts` (403) + shared/launch-contract.ts (124) + capability-ceiling.ts (209) + spawn-budget.ts (128) + mcp-direct-tool-allowlist.ts (406) | 1,270 | 深嵌 executor/spawn-budget/external-runs |
| doctor 诊断 | `src/extension/doctor.ts` (230) + doctor 相关 action | 230 | executor action |
| 跨扩展 API | `src/api/background-work.ts` (197), external-runs.ts (129), delegation.ts (119), 以及 package.json exports 的 control-channel/pi-args/shared-types/intercom-bridge 桩 (3-19 行) | ~450 | 独立导出面 |
| agent 附加 | agent-refinements.ts (624), agent-memory.ts (254), proactive-skills.ts (194), agent-management.ts (1256, 部分核心), skills.ts (761, 核心相关) | ~2,300 | refinements/memory/proactive 为叶子 |
| 其他 | `src/policy/authority.ts` (46), `src/runs/background/steering` 组, `completion-batcher` 可裁剪 | ~500 | 叶子 |

### 1.3 共享层占用

- `src/shared/types.ts` (2069 行): 核心类型 (SingleResult 861, Details 975, Usage/budgets, ExtensionConfig 1783, DIRS/常量 497-624) 约 1,300 行; 功能专属类型约 700 行可删: Acceptance* (639-803, ~165 行), Steering* (402-465), ControlEvent/Config (156-228), ParallelHandoff (234-301), WorkflowGraph (40-98), AsyncStatus (1280-1404, 124 行), NestedRunSummary (1109-1206), IntercomEventBus/事件常量 (247-262), IntercomBridgeConfig (341-360), ScheduledRunsConfig (371-377), ProactiveSkillSubagentsConfig (361-367), ProcessTerminal (340-390), SpawnBudget (932-950).
- `src/shared/settings.ts` (501): 链目录/模板解析, 核心保留但需裁剪 chain 专属段.
- `src/shared/`: utils.ts (613, 核心聚合), artifacts.ts (285, 结果文件, 核心), fork-context.ts (213, context 模式, 核心), child-transcript.ts (264, 核心), formatters.ts (133), jsonl-writer.ts (81), model-info.ts (81), 原子写/重试/会话工具 (约 300) 均保留.

---

## 2. 耦合分析

### 2.1 深嵌引擎 (切除会伤筋动骨)

1. **acceptance (1,365 + 嵌入)**: 被 37 个文件引用; execution.ts 52 处, subagent-runner.ts 55 处, chain-execution 35 处, async-execution 22 处, executor 35 处, 外加 scheduled-runs/task-intent/parallel-utils/chain-outputs/agent-contract. 删 = 改 5 个引擎文件 + schema (AcceptanceOverride, schemas.ts) + tool-description + task-intent.ts (181) + agent-contract.ts. 风险: 高.
2. **missions (1,832 + 嵌入)**: executor workflow 分支每个 workflow 自动建 mission (4165-4410, missionBinding/prepareMissionLaunch/attachMissionToLaunchResult), run-status.ts 读 mission 绑定, extension/index.ts agent_end 续接 + asyncComplete 同步, scripted-workflow 的 `state.get/set` 全局依赖 mission store. 删 = 必须同步砍 executor workflow 分支的 mission 脚手架 + workflow state 全局 + 3 处 extension 接线. 风险: 高.
3. **watchdog (4,395 + 嵌入)**: 子进程运行时是共同宿主 — subagent-prompt-runtime.ts registerChildWatchdog (每个子代理都跑), execution.ts resolveWatchdogConfig (L95), subagent-runner.ts 29 处, pi-args.ts CHILD_WATCHDOG_CONFIG_ENV, executor tool-actions. 删 = 动子进程最脆弱处. 风险: 高.
4. **intercom/supervisor (1,323 + 嵌入)**: executor 72 处 (single/parallel 结果路径 emitForegroundResultIntercom 1631-1692), prompt-runtime 子侧注册 contact_supervisor+intercom 工具 (290-358), result-watcher deliverIntercomResults, extension/index createNativeSupervisorChannel. 风险: 中高.
5. **worktree (997 + 嵌入)**: executor 并行/链 worktree 建立 2835-2953, runner captureParallelWorktreeDiffs 1906, async-execution 26 处, chain-execution 31 处, workflow 级 worktree:true 默认转发. 删 = 并行路径主干上动刀. 风险: 中.

### 2.2 边缘可整块切除 (低风险)

- profiles (661): 唯一消费方是 slash-commands (825-971), 无引擎引用.
- inspectors/herdr (995): 消费方是 executor action 分支 (L98-99) + extension/index herdrStatusBridge + fleet.ts; 切 3 处.
- scheduled-runs (753): 消费方是 extension/index (scheduledRunManager) + executor.executeScheduled (5483 尾部) + result-watcher observeCompletion; 接线独立.
- FleetView 面板 (fleet.ts/status/transcript 2,020 + fleet-view.ts 540 + async widget): extension/index fleetStatus 接线 + async-job-tracker widget; render.ts (2029) 是核心结果渲染器, 需保留并裁剪 feature 分支, 不能整删.
- slash 管理面 (admin/selector/profiles/prompt-bridge 约 2,400): 仅 extension/index 注册行 + slash-bridge 事件.
- RPC (653), doctor (230), external-runs (129), background-work (197), proactive-skills (194), agent-memory (254), agent-refinements (624): 均为独立接线.
- 旧 durable chain 子系统 (chain-execution 1527 + chain-clarify 1354 + chain-append 328 + chain-root-attachment 199 = 3,408): 只被 executor 的 append-step/approve-checkpoint/reject-checkpoint action 与 chainName 管理引用; 公开执行面 (public-execution.ts:38-40) 已拒绝顶层 chain 参数, 纯内部兼容路径.

### 2.3 types.ts 占用小结

2069 行中约 1,300 行核心 + 约 700 行功能专属 (1.3 节清单). 功能类型被多模块交叉引用, 删除顺序错误会连锁编译错; 建议按叶子功能先删, 类型字段随功能同步删.

### 2.4 保留集敏感度 (删除难度差异大的点)

| 决策点 | 两种解释 | 对删除量的影响 |
|---|---|---|
| "chain 顺序链" | (a) workflowScript 顺序 await (当前公开面唯一入口, public-execution.ts 已强制) vs (b) durable chainName 链 (.chain.md, append-step/checkpoint) | (b) 则 chain-execution/clarify/append/root-attachment 3,400 行全留; (a) 则全删. 差异最大的一刀 |
| acceptance 验收门 | 是否算"结果回收"的一部分 | 删则省 1,365+task-intent 181+嵌入修改; 留则 schema/描述/引擎全保留 |
| contact_supervisor | 不在假设核心, 但可能是用户高频工作流 | 删则省 715+result-intercom 421+prompt-runtime 子侧注入 (每子会话省 2 个工具定义) |
| worktree 隔离 | 并行写冲突缓解 vs 纯附加 | 删则省 997+并行路径简化; 但删后并行写同目录的风险转移给用户 |
| watchdog | 信任工程核心卖点 vs 附加 | 删则省 4,395 但子进程运行时要动 4 个文件 |

---

## 3. 删除顺序与风险

### Phase 0: fork 钉死 (0.5 人日)
- 复制仓库, 删 .git 上游或打 tag v0.44.0-slim, 锁 package.json 依赖版本, 删除未用 peerDependency 可选声明按需评估.
- 基线: `npm run typecheck` + `npm run test:unit` 全绿.
- 风险: 低. 证据: package.json scripts.

### Phase 1: 叶子整块切 (0.5-1 人日, 每块 0.5-2 小时)
- 顺序: profiles → inspectors/herdr+integrations → scheduled-runs → RPC → doctor → external-runs → background-work → policy/authority → proactive-skills → agent-memory → agent-refinements.
- 风险: 低; 每块只碰 extension/index.ts 若干接线行 + executor 一个 action 分支. 每步跑 typecheck.
- 测试: 直接删对应 test: profiles.test (365), herdr-inspector*.test (313), herdr-status-bridge.test (494), scheduled-runs.test (528)+scheduled-store-root.test, rpc.test (647), doctor.test, external-runs.test, background-work.test, proactive-skills.test (194), agent-memory.test, agent-refinements.test.

### Phase 2: 展示层 (0.5-1 人日)
- 删 FleetView 面板 (fleet.ts/status/transcript + fleet-view.ts + async widget + config fleetView/fleetViewPlacement), 删 slash 管理面 (admin/selector/profiles/prompt-bridge/subagents-* 命令, 保留 /run 与 slash-bridge 若需要), 删 steering notices 渲染.
- render.ts 裁剪: 保留结果渲染主干, 删 fleet/steering/control 分支.
- 风险: 中; extension/index.ts 是集线器 (805 行), 一半接线在此, 删错影响 session 生命周期 (resetSessionState/session_shutdown 引用 fleetStatus/slashBridge/promptTemplateBridge).
- 测试: fleet.test (912)+fleet-status.test (709)+fleet-transcript.test, render-widget.test (787), slash-commands.test (780), slash-live-state.test, selector.test, prompt-template-bridge.test, prompt-workflows.test, steering-notices.test, control-notices.test.

### Phase 3: 信任/协作层 (2-3 人日, 最难)
- 顺序: intercom/supervisor → watchdog → missions → acceptance.
- 每块必须同步改: 引擎文件 (execution/subagent-runner/prompt-runtime/pi-args/executor) + schema + tool-description + types.ts + extension/index.
- 风险: 高. 这是子进程运行时 (subagent-runner 4718 + prompt-runtime 588 + execution 1868) 的改动, 回归面最大. mitigation: test:unit 有大量 mock-pi 单测, 每步删功能后跑对应测试组 + 全量 unit.
- 测试: watchdog-*.test (约 2,954), mission-*.test (约 1,406), intercom-bridge.test+result-intercom.test+native-supervisor-channel.test (约 2,240), acceptance.test (1,183)+acceptance-file-report.test (439).

### Phase 4: 决策依赖 (0.5-1 人日)
- 按 2.4 决策: 若 chain=workflowScript, 删 chain-execution/clarify/append/root-attachment (3,408) 并精简 agents.ts chain 发现 (1649-1664) 与 settings.ts; 若删 worktree, 精简 executor 并行/链路径与 runner; 若删 clarify 相关 action.
- 风险: 中; chain-execution 与 executor 的 append-step/checkpoint action 强绑定.
- 测试: chain-execution.test (1,835)+chain-clarify.test (466)+chain-append.test+chain-root-attachment.test+chain-serializer.test (约 2,901 中大半), worktree.test (613), parallel-execution.test 中 worktree 用例.

### Phase 5: 细节清扫 (1-1.5 人日)
- schemas.ts 67 顶层属性裁到约 25 (删 mission/schedule/watchdog/inspector/steer/acceptance 相关字段), tool-description.ts 重写 (FULL 4049 字符), types.ts 删约 700 行功能类型, 清理残留注释/分支/死 import, 修全部受 schema 影响的测试 (schemas.test 547, tool-description.test, single-execution 5093, async-execution 4830, chain-execution, parallel-execution 656).
- 收尾: typecheck + test:unit + test:integration 全绿, 更新 README/docs/agents 内置 (agents/ 6 个 md 保留).

---

## 4. 成本估算

### 4.1 剩余代码量 (src 66,465 行)

| 情形 | 剩余 | 占比 |
|---|---|---|
| 激进 (删全部非保留集, chain=workflowScript, 删 acceptance/worktree/contact_supervisor) | 约 26-29K | 39-44% |
| 中值 (保留 acceptance+worktree+contact_supervisor+durable chain) | 约 33-36K | 50-54% |
| 保守 (仅删叶子+展示层, 信任层全留) | 约 38-41K | 57-62% |

估算依据 (各项切除量见 1.2): 叶子 6,600 + 展示层 5,500 + 信任层 (watchdog 4,395+missions 1,832+intercom 1,323+acceptance 1,546) + 决策层 (chain legacy 3,408, worktree 997) + 引擎内裁剪 (executor 约 1,800, runner 约 700, render 约 1,000, types 约 700, schema/描述约 300, 杂项 600).

### 4.2 测试处理

- test 75,328 行; 直接删: 约 22-30K (watchdog 2,954 + missions 1,406 + fleet 2,028 + intercom 2,240 + acceptance 1,622 + schedule 595 + profiles 365 + inspectors 313 + clarify 466 + worktree 613 + steering 683 + chain 系约 2,000 + herdr 494 + rpc 647 + 各类叶子).
- 保留但需改: single-execution (5,093) / async-execution (4,830) / chain-execution (1,835) / parallel-execution (656) 中混合引用了 acceptance/mission/worktree/supervisor, 预计 15-25% 用例要改.
- 风险: 只删测试不删功能 → 假绿; 只删功能不删测试 → 编译失败. 需 feature→test 对照清单 (本报告已给).

### 4.3 工作量粗估

- 一个熟悉该库的工程师: 4-8 人日 (Phase 0-2 约 2 日, Phase 3 约 2-3 日, Phase 4-5 约 2 日, 含 typecheck/测试循环).
- 主要成本在 Phase 3 (子进程运行时) 与 Phase 5 (schema/描述/测试修整), 而非机械删除.

---

## 5. 收益评估 (对照验收三件套)

### (1) 只暴露保留能力 + 高频工作流可用
- 收益: 保留集内功能零重写, 原样可用 (同一代码库物理裁剪, 不涉及行为重实现); 模型只看到裁剪后的 schema/描述/action 列表 (SUBAGENT_ACTIONS 常量, types.ts:522, 现 50 个 action 可裁到约 15 个).
- 风险: chain 语义二义性 (2.4) 是最大不确定性, 切错 = 高频工作流不可用; 修引用瀑布可能误伤保留路径 (靠每步 typecheck + 对应测试组兜底).

### (2) token 开销可量化下降
- 现状 (实测): subagent 工具描述 FULL 4,049 字符 ≈ 1,012 tokens (COMPACT 2,271 ≈ 568); SubagentParams schema 67 顶层属性, 源码 ≈ 9,901 字符 ≈ 2,475 tokens (序列化后略增); 合计每次注入 ≈ 3.5-4K tokens. 附加 subagent_wait 描述 1,561 字符 ≈ 390 tokens.
- 精简后: schema 25 属性 ≈ 1K tokens + 描述 ≈ 400 → 合计约 1.4-1.6K, 下降约 60%; 子代理侧再少 contact_supervisor/intercom/watchdog_warn 等 2-4 个工具定义, 每子会话省约 600-1,200 tokens.
- 结论: 该指标方向 A 可精确测量 (字符/4 估算 + 序列化实测), 达标无悬念.

### (3) 可维护
- 收益: 代码量减半, 概念面收窄到"委派 + 编排 + 模型 + 回收", 新维护者上手成本显著下降.
- 风险: 硬删留下"修剪痕迹" — 保留代码里残留的 feature 分支 (executor workflow 分支的 mission 脚手架注释等) 与 types.ts 未清字段, 必须 Phase 5 清扫, 否则维护负担只是转移; 钉死不追上游后, pi 核心 API 演进需自行跟进.

---

## 6. 结论建议

- 方向 A 可行, 且是保证"保留集原样可用 + token 精确可测"的最直接路径; 剩余代码 39-54%, 工作量 4-8 人日, 主要风险集中在子进程运行时 (watchdog/acceptance/intercom 的共同宿主) 与 chain 语义决策.
- 开工前必须先由用户点名三个决策: (a) chain 顺序链 = workflowScript 顺序 await 还是 durable chainName 链; (b) contact_supervisor 是否保留 (不在假设核心但可能是高频); (c) acceptance/worktree 是否保留. 这三个决策合计影响约 10K 行删除量, 是方向 A 敏感度最高的开关.
- 若用户目标纯粹是"最小编码面 + 最少 token", 推荐激进档 (26-29K), 但建议保留 control-channel (692, 运行管理不可少) 与 subagent_wait (结果回收闭环).
- 对照方向 C (重写): 本侦察发现官方 pi 自带 examples/extensions/subagent/index.ts (1015 行) 已覆盖可信核心 — 若最终保留集小于当前公开面, 方向 C 的"以官方示例为基线"可能是更省的路径; 但若用户坚持"现有高频工作流全部可用"且保留集含 acceptance/durable chain 等官方示例没有的能力, 方向 A 更稳. 建议以用户对上述三决策的回答作为 A/C 分岔的判据.