# 状态: 待处理
# 类型: task
# 阻塞于: MILESTONE-10

## 问题

投影层 (PRD §12 第 3 步). AFK 编码任务, 调用 `tdd-as-orchestra` skill:

- `projectSlimDetailsToRunNodes`: details + 调用侧展示快照 → RunNode (契约见 PRD §3, 以 M02 修订版为准);
- 状态映射 (无 queued/starting/blocked/waiting_input; attention = failed+timeout+budget+cancelled; resume 加 resumed 徽章);
- modelSource 标注 (details / run.json / call-params / message / unknown);
- logCursor 关联 operational logs;
- contextPercent 按 M02 定稿口径推导.

完成标准: 契约每个字段有出处, 单测覆盖状态映射全分支.
