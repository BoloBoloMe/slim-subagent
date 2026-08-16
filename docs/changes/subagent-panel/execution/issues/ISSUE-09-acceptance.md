# ISSUE-09 验收交付 (HITL 特例)

## 父级
- `../EXECUTION.md`

## 执行(Execution)
- [ ] 已实现

## 要构建什么
对照 PRD §10 十四条逐项核对 (Panel 1-4 / Viewer 5-7 / Logging 8-10 / Diagnose 11-14); 真机 e2e: single/parallel/resume/失败路径 (timeout/budget/spawn 失败/unknown agent)/diagnose 各 target 形态; 用户现场功能验收; 提交交付. HITL 原因: 验收必须用户在场 (路线图目的地第三点).

## 覆盖依据
- Product: `../../pi_agent_subagent_panel_prd.md`, §10 全量

## 相关决策
- 无 (验收执行, 不产生新决策; 验收发现的问题回主会话走路线图流程)

## 允许范围
只读验证 + 验收记录文档; 发现的缺陷开新 issue, 不在本片内修.

## 禁止范围
禁止验收不过仍交付; 禁止临时改 PRD 迁就实现.

## 代码定位提示
- 验收清单: PRD §10; e2e 场景: 本文件"要构建什么"
- pty harness 模式: `docs/changes/subagent-panel/milestone-06/evidence/smoke.py`

## TDD 切片
- 人工验证特例, 无 TDD 切片.

## 验证入口
用户逐条确认 §10 十四条 + e2e 场景通过.

## 风险提示
并行三合流后的集成缺陷集中暴露期 — 预留返修轮次.

## 停止条件
验收不通过项转新 issue, 本片保持打开.

## 适合 AFK 的原因
不适合 — HITL, 用户在场验收.

## 验收标准
- [ ] §10 十四条逐项通过
- [ ] e2e 场景全过
- [ ] 用户确认交付

## 被阻塞于
- ISSUE-08
