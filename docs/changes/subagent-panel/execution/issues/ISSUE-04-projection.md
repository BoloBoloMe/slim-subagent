# ISSUE-04 投影层

## 父级
- `../EXECUTION.md`

## 执行(Execution)
- [ ] 已实现

## 要构建什么
`projection.ts`: `projectSlimDetailsToRunNodes` — details + 调用侧展示快照 → RunNode (PRD §3 契约); 状态映射 (pending 仅 parallel child 由 tasks 全集 − scheduled 集合推导; attention 聚合; resume resumed 徽章); modelSource 标注 (details/run.json/call-params/message/unknown); logCursor 关联 operational logs; finished/archived 从 run.json + session.jsonl 投影. 可观测: 单测覆盖全状态机; 供 card/viewer 消费. 适合 AFK: 契约已定稿.

## 覆盖依据
- Product: `../../pi_agent_subagent_panel_prd.md`, §3 (RunNode 契约 + 投影来源优先级 + 状态映射规则)

## 相关决策
- `../../milestone-02/DECISIONS.md`: D001-D010 (契约)
- `../../milestone-08/DECISIONS.md`: D001 (projection.ts), D003 (投影/状态映射单测先行)

## 允许范围
新增 `slim-subagent/projection.ts`, `test/projection*.test.ts`.

## 禁止范围
不改 index.ts/single.ts 执行逻辑; 不实现渲染 (ISSUE-05) 与 viewer (ISSUE-06).

## 代码定位提示
- 契约: PRD §3 全文; 原型参考 `docs/changes/subagent-panel/milestone-04/prototype/types.ts` (RunNode 类型) 与 `replay.ts` 快照生成
- 调用侧快照捕获点: index.ts 工具 execute 入参 (model/timeoutMs/usageBudget/tasks[i])
- 节点键规则 (M02 D004/R5): 投影取键 = toolCallId + 顶层 mode + runId/index, 防节点键漂移
- run.json 形状: `~/.pi/agent/slim-subagent/sessions/<runId>/run.json` (M02 resume 口径)

## TDD 切片
- TS-001: 接缝 = projectSlimDetailsToRunNodes. TC-001: active single details → RunNode (status/model/ctx/usage, modelSource=details). 先写失败测试: `projects active single node`.
- TS-002: 接缝 = 状态映射. TC-002: 6 tasks 并发 4 → 2 个 pending (全集 − scheduled), L30 后转 active; attention = 四态聚合. 先写失败测试: `pending derived from tasks minus scheduled`.
- TS-003: 接缝 = 冲突优先级. TC-003: 调用侧 model 与 final details.model 冲突 → details 胜; 早期 call-params 起步, final 纠正. 先写失败测试: `final details win over call-params`.
- TS-004: 接缝 = archived 投影. TC-004: run.json + 缺字段 → endedAtMsSource=mtime-approx 标注, 不伪造. 先写失败测试: `archived projection marks mtime-approx`.

## 验证入口
`node --test test/projection*.test.ts` 全绿 + 不回归.

## 风险提示
ctx 子口径的窗口推导 (resolveModelWindow 优先 details.model, 退化调用侧) 是 M02 修订核心, 未知一律 `—` 不伪造.

## 停止条件
契约字段语义不清时停止回主会话 (不自行解释 PRD §3).

## 适合 AFK 的原因
契约/映射规则/优先级全部定稿, 纯逻辑实现.

## 验收标准
- [ ] RunNode 全字段投影, 状态机全覆盖
- [ ] pending/attention/resumed/modelSource/logCursor 正确
- [ ] 冲突优先级 details > run.json > call-params > message
- [ ] node --test 全绿

## 被阻塞于
- ISSUE-03
