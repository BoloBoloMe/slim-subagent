# 状态: 待处理
# 类型: task
# 阻塞于: MILESTONE-11

## 问题

B/C 实现 (PRD §12 第 7 步). **条件里程碑**: 仅当 M07 决策升级 B/C 时施工; 若不升级, 直接关闭并在 ROADMAP 范围外记因.

施工时 (AFK 编码任务, 调用 `tdd-as-orchestra` skill):
- B: footer mini summary — 无 active 且无未确认 attention 时隐藏; errors 来自今日 error/fatal 日志计数; 聚焦/点击替代交互按 M07 定稿;
- C: widget persistent panel — aboveEditor/belowEditor 按 M07 定稿; column 配置显隐 timeout/cap/ctx/cost.

完成标准: 若升级 — footer/widget 落地, 对应验收条通过, 单测通过; 若不升级 — 关闭记因.
