# 状态: 待处理
# 类型: task
# 阻塞于: MILESTONE-09

## 问题

日志全量挂载 + details 补齐 (PRD §12 第 2 步). AFK 编码任务, 调用 `tdd-as-orchestra` skill:

- L11–L39 插桩: timeout/budget/protocol/abort/drain/signal/empty output (single.ts), parallel (index.ts), resume (resume.ts); 挂载点行号见契约审计 (ROADMAP 笔记);
- L06/L07 (run.json 写) 与 L43 (GC) 补 try/catch — 当前异常直接冒泡/静默吞;
- assembleSingleResult details 单点补丁 (single.ts:1297-1316), 字段清单以 PRD §12 第 3 步/M02 账本为准: `mode`/`agent`/`taskPreview`/`timeoutMsExplicit`/`startedAtMs`/`endedAtMs`, ctx 改子代理口径 (single/resume/parallel-child 三路径继承);

完成标准: 48 日志点全部挂载, 审计行号表逐条销号, details 补丁字段齐 (六字段 + ctx 子口径), 单测通过.
