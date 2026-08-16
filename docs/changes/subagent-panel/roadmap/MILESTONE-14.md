# 状态: 已关闭
# 类型: task
# 阻塞于: MILESTONE-11

## 问题

E — Diagnose 命令实现 (PRD §12 第 6 步). AFK 编码任务, 调用 `tdd-as-orchestra` skill:

- 扩展 schema/action: `subagent { action:"diagnose", id?, since?, levelMin?, limit?, writeReport? }`; `/agent-diagnose` 映射同一能力 (M07 D009);
- target 解析: runId 前缀/随机尾段/`batchRunId#index`/today, 歧义报错列候选 (寻址可复用 resume.ts:44 findRunForResume);
- 证据收集: log 按 since/levelMin 过滤 + session 关联, 只读, 默认脱敏;
- 启发式 findings (PRD §7.2 类别清单) → Finding schema (§7.3); content 简洁中文结论, details 含 evidence refs;
- writeReport 写 `~/.pi/subagent_log/diagnose/...md`, 同 7 日 GC;
- 无证据返回 insufficient_evidence, **不编造问题**.

完成标准: PRD §10 Diagnose 验收 11–14 条通过, 单测通过.
