# 状态: 已关闭
# 类型: research
# 阻塞于: MILESTONE-01

## 问题

从 pi-subagents-main 提取必须移植到新扩展的隐性行为与可搬运代码, 产出移植规格 (M4 施工图纸).

必查隐性行为 (C-rewrite.md §4 已定位行号):
- timeout 三阶段终止 (drain → SIGTERM → SIGKILL), execution.ts:531-604
- fallbackModels 重试链与 thinking 后缀, model-fallback.ts
- 非 JSON stdout 容忍, execution.ts:835-843
- pi 可执行寻址 (bun/打包场景), pi-spawn.ts
- 结果回收: JSONL 事件流解析核心, execution.ts:831-970

可搬运清单 (C-rewrite.md §3.1): agents/*.md, prompts/*.md, frontmatter 解析, pi-args 核心段, config.ts.

考察范围随 M1 保留集调整: 点名拉回的功能 (如 async) 各自需要补隐性行为提取.

产物: 移植规格已落盘 docs/changes/slim-pi-subagents/milestone-03/ — 总纲 [PORTING-SPEC.md](../milestone-03/PORTING-SPEC.md) + 分片 01-process-lifecycle / 02-result-recovery / 03-resume-session / 04-spawn-args-frontmatter / 05-context-window.

关闭摘要 (2026-08-10): 考察范围已按 M1 保留集校准 (fallback/agents/prompts/config 降级为删除确认, 新增 resume/session 与上下文窗口数据源). 关键落定: D012a 成立 (pi 会话增量写盘, SIGKILL 丢 in-flight); F006 消解 (ctx.getContextUsage() 直接拿百分比); 发现 D006 usage budget 语义缺口 (旧码=调度门, 无运行中终止), 待决策清单见 PORTING-SPEC §四; M5 对拍清单见 §五.
