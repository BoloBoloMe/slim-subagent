# 状态: 待处理
# 类型: task
# 阻塞于: MILESTONE-11

## 问题

D — Session Viewer 实现 (PRD §12 第 5 步). AFK 编码任务, 调用 `tdd-as-orchestra` skill:

- tolerant JSONL reader (无法识别的行进 raw, 不丢弃); session.jsonl 格式见 pi 包 docs/session-format.md;
- overlay 全屏: 首 tab Timeline 批次时间线 + 子代理会话 tab (形态与键盘流按 M06+M07 定稿, 见 PRD §5 v2 与 M07 D007/D008);
- Diagnostics 并入子代理 tab 底部状态区一行 (ctx%/budget/hint/log event ids);
- GC/缺文件 empty state 不崩溃; child 完成前明确提示完整 transcript 不可用;
- viewer 内 `d` 键 = diagnose 当前 tab 子代理 (带 runId 上下文), 由本里程碑在 viewer.ts 内实现, 调 M14 diagnose.ts 暴露的入口 (并行期先留接口桩, 主会话接线时接通).
- parallel root 批次总览 + child 切换; child 完成前明示完整 transcript 不可用.

完成标准: PRD §10 Session Viewer 验收 5–7 条通过, 单测通过.
