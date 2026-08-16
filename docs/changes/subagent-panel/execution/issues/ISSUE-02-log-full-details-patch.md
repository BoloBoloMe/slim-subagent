# ISSUE-02 日志全量挂载 + details 补丁

## 父级
- `../EXECUTION.md`

## 执行(Execution)
- [ ] 已实现

## 要构建什么
L11-L39 全量插桩 (single.ts: timeout/budget/protocol/abort/drain/signal/empty output; index.ts: parallel L28-L32; resume.ts: L33-L39); L06/L07 (run.json 写) 补 try/catch; assembleSingleResult 单点补丁: final details 补 `mode/agent/taskPreview/timeoutMsExplicit/startedAtMs/endedAtMs`, ctx 改子代理口径 (single/resume/parallel-child 三路径继承); run.json settle 补丁写. 可观测: 48 日志点审计行号表逐条销号; final result.details 携带六字段. 适合 AFK: 字段清单与挂载点行号表均已定.

## 覆盖依据
- Product: `../../pi_agent_subagent_panel_prd.md`, §6.3, §3 投影来源 1, §10 验收 8-10

## 相关决策
- `../../milestone-02/DECISIONS.md`: D001-D010 (契约修订, 本 issue 的实现权威)
- `../../milestone-08/DECISIONS.md`: D001, D005

## 允许范围
`slim-subagent/single.ts`, `index.ts`, `resume.ts` 插桩与 details 补丁; `test/` 新增.

## 禁止范围
不改渲染/投影/viewer; 不动 runParallelTasks 的 onUpdate 透传 (ISSUE-03).

## 代码定位提示
- 挂载点行号表: ROADMAP.md 笔记 (按 HEAD `7f7640e` 标注) + 契约审计结论
- assembleSingleResult: 定义 single.ts:1187, final details 返回体 1267-1290; runProcess startedAtMs: single.ts:694; settle endedAtMs: single.ts:1027
- ctx 子口径: PRD §2-9 + M02 账本对应条目

## TDD 切片
- TS-001: 接缝 = assembleSingleResult 输出. TC-001: 模拟 final → details 含六字段且 ctx 为子代理口径. 先写失败测试: `final details carries mode/agent/taskPreview/timeoutMsExplicit/startedAtMs/endedAtMs`. 最小绿色: 单点补丁.
- TS-002: 接缝 = timeout 路径. TC-002: timeout 触发 → L19 error + details.stopReason=timeout + run.json settle 写. 先写失败测试: `timeout emits L19 and settles run.json`.
- TS-003: 接缝 = budget 路径. TC-003: 80% 阈值 → L16 warn 每 run 至多 1 条 (显式/自动 budget 均计); 超限先 L14 后 L13. 先写失败测试: `budget 80% warns once, over-limit L14 before L13`.

## 验证入口
`node --test` 全绿; pty 冒烟: timeout/失败场景日志点出现 (一轮).

## 风险提示
single.ts 1371 行是最大文件, 插桩不得改变执行时序; drain/abort 路径已有防御分支, 插桩只观测不干预.

## 停止条件
挂载点行号与审计表漂移无法对应时停止上报, 不自行重审计.

## 适合 AFK 的原因
挂载点/字段清单/日志 schema 全部已定 (M02 + 审计), 纯施工.

## 验收标准
- [ ] 48 日志点全挂载, 行号表销号
- [ ] final details 六字段 + ctx 子口径
- [ ] run.json settle 补丁写
- [ ] L06/L07/L43 try/catch
- [ ] node --test 全绿不回归

## 被阻塞于
- ISSUE-01
