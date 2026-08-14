# 状态: 待处理
# 类型: task
# 阻塞于: MILESTONE-09

## 问题

日志全量挂载 + details 补齐 (PRD §12 第 2 步). AFK 编码任务, 调用 `tdd-as-orchestra` skill:

- L11–L39 插桩: timeout/budget/protocol/abort/drain/signal/empty output (single.ts), parallel (index.ts), resume (resume.ts); 挂载点行号见契约审计 (ROADMAP 笔记);
- L06/L07 (run.json 写) 与 L43 (GC) 补 try/catch — 当前异常直接冒泡/静默吞;
- assembleSingleResult details 补 `agent`/`task`/`timeoutMs` (single.ts:1297-1316);
- runProcess 补 startedAtMs, settle 处补 endedAtMs (single.ts:694/1021), run.json 同步 (依 M02 决策).

完成标准: 48 日志点全部挂载, 审计行号表逐条销号, 单测通过.
