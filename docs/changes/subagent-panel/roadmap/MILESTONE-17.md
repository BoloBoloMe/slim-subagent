# 状态: 待处理
# 类型: task
# 阻塞于: MILESTONE-10

## 问题

F1 转化 — parallel per-child 实时进度透传 (M04 用户拍板升级: 不接受"只有 2/4 done, 看不到每个 child 在干嘛").

现状: slim-subagent `index.ts:265-285` runParallelTasks 不透传 per-child onUpdate (`progress: []` 硬编码), 只有 child 完成时的聚合计数.

改造内容 (AFK 编码任务, 调用 `tdd-as-orchestra` skill):
- runParallelTasks 为每个 child 挂 onUpdate, 把 per-child RunNode 快照 (activeTool/recentTools/recentOutput/usage) 汇入聚合 details;
- RunNode.progress per-child 实时数据契约确认 (PRD §3 已留位, 升级后从非 MUST 变 MUST, 落 PRD 修订);
- 保持 done/total 保序 (PRD §10-2) 与 pending 预建行行为不变.

下游影响: M11 投影层须消费 per-child progress; M12 Run Card (变体 C 树形) 渲染之.

完成标准: 改造完成, 测试通过, per-child 实时进度在聚合 details 可见.
