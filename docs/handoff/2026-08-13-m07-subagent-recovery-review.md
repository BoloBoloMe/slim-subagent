---
date: 2026-08-13
---

# 交接: M07 中止恢复协议审阅

本会话刚完成 M07 中止恢复协议的实现与真实 e2e 验证. 下一个会话将**先读 `M07-RECOVERY-PROTOCOL.md` (背景/目的/方案/行为契约全文), 再审核 `slim-subagent/` 代码**是否与契约一致. 本交接文档只写审核所需的增量信息.

## 一句话现状

4 个文件已改 (single.ts / index.ts / resume.ts / test/timeout.test.ts), 核心行为全部经真实 pi 子进程 e2e 验证; 遗留 4 项见文末.

## 审核重点 (与契约对齐检查)

1. **预算公式**: `round(0.7 × modelRegistry.find(provider, modelId).contextWindow)`, 显式传参尊重. 查 `single.ts` 的 `resolveModelWindow` / `resolveEffectiveUsageBudget` / `DEFAULT_BUDGET_RATIO`.
2. **长版指令**: `buildRecoveryDirective` 三分支 (sessionSaved=false → 重发; true → [1]继续/[2]终止交接/[3]放弃), [2]b 文件名 = `docs/handoff/YYYY-MM-DD-<agent>-<runId>.md` (防重名覆盖, 用户点名要求).
3. **阈值**: 默认 30 且 env `PI_SUBAGENT_RESUME_HINT_PERCENT` 可覆盖; hint 分支与指令判断规则行同读 `resumeHintPercent()`.
4. **details 新字段**: `sessionSaved` (仅中止), `usageBudget`/`budgetAuto` (正常也带); 正常完成 content 保持纯净.
5. **强制预算接入点**: index.ts single 分支 + parallel 每 child (resolved 映射处), resume.ts (收尾同强制) — 三处都调 `resolveEffectiveUsageBudget`.
6. **一致性风险点**: 长版指令文案里的阈值数字与判断规则行是否与 `resumeHintPercent()` 返回值同步 (改 env 后数字变, 文案应跟随 — 因拼进模板的是常量函数返回值, 天然同步; 复核无硬编码 30/50 残留, 尤其 git grep 找 `> 50` / `percent > 3` 等).

## 审核时可利用的验证手段

- 函数级快速验证 (无需真实模型): 在 `slim-subagent/` 下跑 `node dbg.mjs` 式脚本 import `resolveEffectiveUsageBudget`, 构造伪 registry 断言窗口命中/兜底/env 覆盖. 可自行写临时脚本.
- 真实 e2e (需 2-4 分钟/次): `pi -ne -e ./slim-subagent/index.ts --no-session --mode json -p '<让父会话调用 subagent 的提示词>'`, 从输出事件流的 agent_end.messages[role="toolResult"] 取 content/details 验证.
- 静态核对: `git diff` 即本轮全部改动 (无其他文件).

## 必读推荐

1. `docs/changes/slim-pi-subagents/milestone-07/M07-RECOVERY-PROTOCOL.md` — 背景/目的/方案/行为契约/证据/决策记录 (审核对照标准, 必读).
2. `docs/changes/slim-pi-subagents/milestone-05/e2e-new-summary.md` — 旧载荷行为基线 (M6 修复 1 的 content 拼装, text 模式 details 不可见等, 理解为何中止载荷必须长版指令).
3. `docs/changes/slim-pi-subagents/milestone-03/03-resume-session.md` + `milestone-04/issues/ISSUE-06-resume-session-lifecycle.md` — resume 寻址/锁/GC/恢复点语义 (未动, 审核 resume.ts 改动时参照).
4. `slim-subagent/single.ts` 常量区 (resumeHintPercent 起 ~30 行) — 全部可配置项与解析函数的单一真相源.
5. pi 扩展 API 文档 (docs/extensions.md §ctx.modelRegistry) + dist/core/model-registry.d.ts — 窗口查询通道事实依据.

## 路线图

- 起点: 用户提出"使用该工具的 AI 无法先验知道恢复决策过程".
- 已走: 读 M1-M6 文档 → 确认载荷缺口 (hint 在不可见通道, M5 观察 #1 实证) → 方案三通道 (description 不扩写/长版指令/details 结构化) → 阈值 50→30 修正+可配置 → 强制预算 (modelRegistry.find 窗口 × 0.7, 踩坑 getProvider 无 models) → 三步终止交接协议 → 真实 e2e 3 轮全过 → 记账 (本文档 + M07).
- 剩余: 新会话审核代码 (本交接的目的); 之后可补完整三步链路 e2e、Windows 单测隔离修复、决策记录归档.

## 遗留 / 风险

1. 本机 Windows 单测全红 (既有缺陷: helpers.ts withHome 靠 process.env.HOME, 对 os.homedir() 无效) — 与本次改动无关, 但审核时无法用单测红绿判断本次改动, 用 2/3 手段替代.
2. 子代理 deepseek 模型认证 key 已失效 (401) — 复跑需换 key 有效模型 (如 ai-work-qwen/qwen3.8-max).
3. 完整三步链路 (中止→resume 收尾→handoff→新代理) 未实跑, 目前由载荷文本 + 代码逻辑支撑.
4. 敏感信息: 本交接不含任何 key/token; e2e 日志出现过的认证错误属环境状态, 勿回写凭据.