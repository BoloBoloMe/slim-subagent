# 状态: 已关闭
# 类型: task
# 阻塞于: MILESTONE-11

## 问题

A — Inline Run Card 实现 (PRD §12 第 4 步). AFK 编码任务, 调用 `tdd-as-orchestra` skill:

- renderCall/renderResult 按 M07 定稿落地: partial live card + final 结果卡;
- §4.0 必填字段与省略规则 (status/model 必显, timeout/cap 仅显式设置出现, 自动 70% budget 不进 Panel 行);
- 错误行挂 Diagnose 入口 (registerCommand/registerShortcut 呈现, 按 M07 定稿);
- parallel 聚合卡: 初始 total + per-child 完成 done/total 递增; `pending` 预建行 (批次开始画全集, 未启动显示 pending).

完成标准: PRD §10 Panel 验收 1–4 条通过, 单测通过.
