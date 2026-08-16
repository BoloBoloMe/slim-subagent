# ISSUE-03 parallel per-child 进度透传 (F1)

## 父级
- `../EXECUTION.md`

## 执行(Execution)
- [ ] 已实现

## 要构建什么
runParallelTasks 为每个 child 挂 onUpdate, per-child RunNode 快照 (activeTool/recentTools/recentOutput/usage) 汇入聚合 details; `progress: []` 硬编码消除. done/total 保序与 pending 预建行行为不变 (PRD §10-2). 可观测: parallel 运行中聚合 details 含每 child 实时进度. 适合 AFK: M07 D013 已拍板, 改造点明确.

## 覆盖依据
- Product: `../../pi_agent_subagent_panel_prd.md`, §3 progress 契约 + §2-4 (现状描述) 的改造

## 相关决策
- `../../milestone-07/DECISIONS.md`: D013 (F1 升级拍板)
- `../../milestone-08/DECISIONS.md`: D001 (M17=本 issue 为"只插桩"的例外), D005

## 允许范围
`slim-subagent/index.ts` runParallelTasks 及其直接辅助; `test/parallel*.test.ts` 扩展.

## 禁止范围
不动渲染/投影; 不改并行调度语义 (硬上限 8/硬并发 4/不 fail-fast).

## 代码定位提示
- runParallelTasks: index.ts:265-285 (聚合 onUpdate, completedFlags 计数); `progress: []` 硬编码 index.ts:281
- child spawn/onUpdate 参考 single.ts:862-974 的 emitUpdate 触发点分布
- 对照原型: `docs/changes/subagent-panel/milestone-04/prototype/replay.ts` parallel-pending 场景

## TDD 切片
- TS-001: 接缝 = parallel 聚合 details. TC-001: 2 child 运行中 → 聚合 details 含每 child 的 recentTools/usage 增量. 先写失败测试: `parallel aggregates per-child progress`. 最小绿色: per-child onUpdate 汇入.
- TS-002: 接缝 = 保序. TC-002: child 乱序完成 → done/total 递增不回头; pending → active 转换不丢行. 先写失败测试: `done/total monotonic with pending prebuilt rows`.

## 验证入口
`node --test` 全绿; pty 冒烟: parallel 4 child 运行中聚合 details 可见 per-child recentTools (一轮).

## 风险提示
per-child 流式频率远高于聚合约 4 次/批 — 透传不过滤, 节流交给消费侧 (TUI 16ms 节流连绘, M01 实测).

## 停止条件
需要改并行调度语义或 tasks schema 时停止.

## 适合 AFK 的原因
D013 已拍板, 改造点/不变量明确.

## 验收标准
- [ ] 聚合 details 含 per-child 实时 progress
- [ ] done/total 保序, pending 行为不变
- [ ] node --test 全绿不回归

## 被阻塞于
- ISSUE-02
