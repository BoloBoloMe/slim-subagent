# ISSUE-07 Diagnose 实现

## 父级
- `../EXECUTION.md`

## 执行(Execution)
- [ ] 已实现

## 要构建什么
`diagnose.ts`: schema/action 扩展 `subagent { action:"diagnose", id?, since?, levelMin?, limit?, writeReport? }`; target 解析 (runId 前缀/随机尾段/`batchRunId#index`/today, 歧义报错列候选); 证据收集 (log 按 since/levelMin 过滤 + session 关联, 只读, 默认脱敏); 启发式 findings (PRD §7.2 类别清单: spawn failed/unknown agent/timeout/budget 区分显式与自动/protocol/empty output/stderr/signal/resume 冲突/parallel 分布/GC 异常) → Finding schema (§7.3); content 简洁中文结论, details 含 evidence refs; writeReport 落 `~/.pi/subagent_log/diagnose/...md` (7 日 GC). `/agent-diagnose` 命令接线留 ISSUE-08. 适合 AFK: §7 行为已定稿.

## 覆盖依据
- Product: `../../pi_agent_subagent_panel_prd.md`, §7.1-7.3, §10 验收 11-14

## 相关决策
- `../../milestone-07/DECISIONS.md`: D009 (/agent-diagnose 无参 = 最近 24h error/fatal)
- `../../milestone-08/DECISIONS.md`: D001 (diagnose.ts), D002 (只新增文件), D003 (target 解析单测)

## 允许范围
新增 `slim-subagent/diagnose.ts`, `test/diagnose*.test.ts`. **schema/action 注册不在本片** — 留公开入口函数, index.ts 注册归 ISSUE-08 (并行纪律, M08 D002).

## 禁止范围
不自动修复/不重启 run/不改代码 (PRD §7.2); 不动 viewer.ts/card.ts; 不用 list/resume 伪装诊断.

## 代码定位提示
- target 解析复用: resume.ts:44 findRunForResume (寻址逻辑)
- 日志读取: ISSUE-01 的 log.ts 公开 API; sessions 目录结构 PRD §2-7
- Finding schema: PRD §7.3

## TDD 切片
- TS-001: 接缝 = target 解析. TC-001: 前缀唯一命中/歧义列候选/随机尾段命中/batchRunId#index/today. 先写失败测试: `target resolution unique/ambiguous/suffix forms`.
- TS-002: 接缝 = 启发式分析. TC-002: 造 timeout 日志+session → finding 类别=timeout, 区分显式 cap 与自动 70%. 先写失败测试: `timeout finding distinguishes explicit cap from auto budget`.
- TS-003: 接缝 = 证据脱敏. TC-003: 含敏感 data 的日志行 → evidence 默认脱敏. 先写失败测试: `evidence redacted by default`.

## 验证入口
`node --test` 全绿; 冒烟: 对真实失败 run 跑 action:"diagnose", 输出中文结论 + findings details.

## 风险提示
诊断质量依赖 ISSUE-01/02 日志点完整性 — 发现证据缺口先回查日志挂载, 不补启发式猜测.

## 停止条件
需要修改 Finding schema 或新增修复类能力时停止.

## 适合 AFK 的原因
调用面/行为/findings 类别/schema 全部定稿.

## 验收标准
- [ ] PRD §10 验收 11-14
- [ ] target 解析四形态 + 歧义列候选
- [ ] findings 覆盖 §7.2 类别清单
- [ ] diagnose.ts 暴露供 index.ts 注册的公开入口 (无桩逻辑残留)
- [ ] node --test 全绿不回归

## 被阻塞于
- ISSUE-04
