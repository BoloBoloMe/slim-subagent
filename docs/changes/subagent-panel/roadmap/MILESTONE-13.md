# 状态: 待处理
# 类型: task
# 阻塞于: MILESTONE-11

## 问题

D — Session Viewer 实现 (PRD §12 第 5 步). AFK 编码任务, 调用 `tdd-as-orchestra` skill:

- tolerant JSONL reader (无法识别的行进 raw, 不丢弃); session.jsonl 格式见 pi 包 docs/session-format.md;
- overlay 多 tab: Conversation/Tools/Events-Raw/Logs/Diagnostics (形态与键盘流按 M06+M07 定稿; 若迷雾 F2 触发, 按备选形态施工);
- Logs tab 关联 runId/nodeId, error/fatal 置顶;
- active/archived 分区, 同 runId 冲突 active 优先; GC/缺文件 empty state 不崩溃;
- parallel root 批次总览 + child 切换; child 完成前明示完整 transcript 不可用.

完成标准: PRD §10 Session Viewer 验收 5–7 条通过, 单测通过.
