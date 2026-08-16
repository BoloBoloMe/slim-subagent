# subagent LLM 自由诊断 产品规格 (v0.2)

- 状态: **已施工 (首版)**, 待用户验收
- 日期: 2026-08-16 (v0.1 草稿 → v0.2 用户拍板方向变更后重写)
- 起源: subagent-panel 验收 (AC 11) 中用户提出 — 启发式 Diagnose 只认预设失败模式, 期望「诊断失败日志, 找出优化点」的开放式归因.
- 前置产品: subagent 可观测性控制面 (PRD v2.0 `../subagent-panel/pi_agent_subagent_panel_prd.md`, 交付说明 `../subagent-panel/milestone-16/delivery.md`)
- **v0.2 关键决策 (用户, 2026-08-16)**: 不做「启发式 + LLM 双模式互补」, **直接替换**原 Diagnose; 只有一个无参命令 `/agent-diagnose`; 不起子代理, 不建证据包管线 — 命令注入提示词, **由当前会话 LLM 自己读落盘日志分析并在会话中汇报**.

## 1. 一句话

`/agent-diagnose` = 零逻辑命令: 向当前会话注入一段自含提示词, 当前会话 LLM 读取落盘的 subagent 结构化日志与子代理会话, 找出可能存在的 bug 与可优化点, 在会话中向用户汇报.

## 2. 为什么是这个形态 (v0.1 候选对比的裁决)

v0.1 提了三条实现路径: A 起 diagnoser 子代理 / B 扩展 API 直调模型 / C 主会话内联. 用户选定 C 的极简变体, 理由 (相对 A/B):

- **零新基础设施**: 无证据包组装/体积控制/输出解析/预算管线; 主会话 LLM 自带文件读取工具与判断力.
- **诊断质量上限最高**: 自由探索 (可读日志/会话/源码), 不受预组装证据包窗口限制.
- **结果天然在会话中**: 用户可追问, 追问上下文共享, 无需报告落盘-回放机制.
- 代价 (已接受): 诊断消耗主会话上下文; 无结构化 findings 输出; 无 writeReport 落盘.

被拆除的 v1 启发式 Diagnose (原 PRD v2.0 §7, 已交付): `diagnose.ts` (935 行) + schema `action:"diagnose"` 四参 + DiagnoseOverlay + viewer d 键. 拆除提交 `bff20c4`. 原 §7 自此作废, 以本 PRD 为准.

## 3. 调用面

- 唯一入口: `/agent-diagnose` (无参; 带参忽略).
- 实现: `pi.sendUserMessage(DIAGNOSE_PROMPT, { deliverAs: "followUp" })` — 总是触发一轮对话; 流式中则排队到当前轮结束后.
- 无工具 action, 无快捷键, 无 Viewer 内入口, 无 overlay.

## 4. 提示词契约 (产品核心)

注入的提示词 (index.ts `DIAGNOSE_PROMPT` 常量) 必须自含:

1. **数据源位置与口径** (只读):
   - 结构化日志 `~/.pi/subagent_log/subagent-YYYYMMDD.log` (JSONL; 字段 ts/level/event/eventId/runId/batchRunId/childIndex/agent/model/status/error/data; level trace..fatal)
   - 子代理会话 `~/.pi/agent/slim-subagent/sessions/<runId>/run.json + run-0/session.jsonl`; parallel child `<batchRunId>/run-<idx>/session.jsonl`
2. **分析要求**: 优先 warn/error/fatal 与失败 run; 也看成功 run 的效率/质量优化点.
3. **证据纪律**: 每条结论附出处 (日志文件#eventId 或会话路径); 证据不足明说缺口, 不编造.
4. **隐私纪律**: 日志已脱敏; 会话正文可能含敏感内容, 汇报不复述原文.
5. **输出结构**: 发现的 bug (按严重度) → 优化建议 → 证据缺口 (若有).

## 5. 隐私与安全

- 诊断数据不出本机到新通道: 读取发生在当前会话, 模型提供商与用户的正常会话一致, 无新增出域面 (对比 v0.1 的 diagnoser 子代理方案, 少一层授权问题).
- 脱敏纪律靠提示词约束 (汇报不复述敏感原文), 非技术强制 — 已接受 (当前会话模型本来就能读这些文件).

## 6. 验收标准

1. `/reload` 后敲 `/agent-diagnose`: 当前会话出现注入的诊断请求消息, LLM 开始一轮分析.
2. LLM 实际读取日志/会话文件 (工具调用可见), 汇报含 bug 列表 + 优化建议, 结论带证据出处.
3. 流式中敲命令: 消息排队, 当前轮结束后触发 (followUp 语义).
4. 回归: schema 回到 10 参数 (无 diagnose action 四参); Session Viewer 无 d 键; 全量测试绿.

## 7. 明确不做

- 启发式规则引擎 (已拆除, 不回退)
- diagnoser 子代理 / 证据包管线 / 结构化 findings / writeReport 落盘 (v0.1 候选, 用户否决)
- target 寻址 (runId 前缀/batch#idx/today) — 定位具体 run 由用户在会话里直接说, 或 LLM 从日志自行发现
- 自动修复 / 自动重启 / 自动改代码

## 8. 已知限制

- 诊断质量取决于当前会话模型能力与上下文余量; 大日志量下模型可能抽样阅读而非全量.
- 无确定性: 同一日志集两次诊断结论可能不同.
- 历史启发式报告 (`~/.pi/subagent_log/diagnose/*.md`) 不再产生; 存量文件仍受 7 日 GC 清理 (log.ts 保留该路径的 GC 逻辑).
