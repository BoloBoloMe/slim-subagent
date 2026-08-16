# 交接: subagent 可观测性控制面 — 验收收尾

- 日期: 2026-08-16
- 用途: 供接手「验收收尾 + 交付」的新会话了解前情
- 仓库: /var/mnt/DATA/Workspace/subagent (主仓库, git 管理); 施工目标 `slim-subagent/` (pi 扩展, 无独立 .git)

## 现状

全部编码里程碑已完成并提交: M09→M14 全部关闭 + ISSUE-08 接线完成. 全量测试 `cd slim-subagent && node --test test/*.test.ts` = **138 过 0 红**, git 干净.

当前处于 **ISSUE-09 用户验收**阶段 (M16 进行中). 用户边验收边报 bug, 上一会话随报随修. 已验收通过: AC 1 (single 卡), AC 2 (parallel/pending), AC 5 (Timeline), AC 6 (子代理 tab + 工具调用链), AC 8/9 (日志). 剩余 AC 3/4/10/11-14 的逐条步骤+预期已写入 `milestone-16/acceptance-guide.md`.

## 其他文档没有的信息

**验收期修复清单 (根因→修复, 均已提交, 回归不破坏)**:
- 超宽行致 pi 崩溃: card.ts pending/状态行/明细行截断预算未扣完整前缀, 加整行兑底截断 + 组件 render 兜底.
- renderCall 预执行帧: pi 会把 renderCall 与 renderResult 叠加渲染, 静态 `model — · ctx —` 帧误导; 用户拍板 renderCall 返回空组件, 卡只由 renderResult 驱动.
- viewer 批次要 reload 才出现: live onUpdate 帧没带 runId, 投影节点 id 空, 建批被丢弃; single/resume/parallel 均注入 runId.
- viewer 子会话无工具调用: parallel child 的 session.jsonl 路径算错 (`run-<idx>/run-0/` 应为 `run-<idx>/`); 按 kind 区分路径.
- viewer 无 spinner + 不实时刷新: 加 90ms 周期 `requestRender` + `readSessionTranscriptLines` 按 size/mtime 缓存 + 状态行/tab 栏 spinner 帧.
- viewer 状态不更新 (要 reload): 投影层终态字段只读顶层 details, live 帧终态在 `results[0]`; 回退到 results[0].
- `cap 5k` 不显示: 投影层 usageBudgetExplicit 只从 callParams 取 (接线没传), 改为从 details 推导 (`budgetAuto===false` → `usageBudget`).
- ctx% 运行中不显示: live 帧没带 contextPercent; single wrap 现算 `contextTokens / resolveModelWindow(子模型)` 注入.
- ctx% 全精度: 卡/viewer 统一圆整 1 位小数.
- timeout.fired 补 timeoutMsExplicit 字段 (diagnose 显式/自动可区分).
- 3 个既有红 (agents.test.ts 模型断言) 已修: 根因提交 a4f7506 有意改 frontmatter 为 `opencode-go/deepseek-v4-flash` 但没同步测试, 方向=改测试对齐 frontmatter.

**关键事实**:
- 扩展经 `~/.pi/agent/settings.json` 的 `packages` 加载 (所以用户会话里已有 `subagent` 工具), 非 `~/.pi/agent/extensions/`.
- 冒烟启动命令 (已对齐模型名): `pi --no-session --provider opencode-go --model opencode-go/deepseek-v4-flash --thinking off -ns -np -nc`; 开发迭代用 `/reload` 秒级热载.
- 内置 agent frontmatter 模型 = `opencode-go/deepseek-v4-flash` (worker/explorer/reviewer), thinking = high/high/max.
- 日志根 `~/.pi/subagent_log/` (= `path.dirname(getAgentDir())/subagent_log`), sessions 根 `~/.pi/agent/slim-subagent/sessions/`.

**剩余验收项精确状态** (对照 `milestone-16/acceptance-guide.md` 逐条):
- AC 3 必填字段: 上一轮已修 cap/ctx, 待用户复测.
- AC 4 final 纠正: 未验.
- AC 10 GC: 可跳过 (单测已覆盖).
- AC 11-14 Diagnose: 未验 (命令/工具均可用, 需造 timeout 失败 run 看 findings).

## 必读推荐

1. `docs/changes/subagent-panel/execution/EXECUTION.md` — 总范围/完成定义/停止条件. 必读.
2. `docs/changes/subagent-panel/milestone-16/acceptance-guide.md` — **本会话刚写的剩余验收项逐条步骤+预期**, 新会话直接据此推进.
3. `docs/changes/subagent-panel/pi_agent_subagent_panel_prd.md` — PRD v2.0 确认版, §3/§4/§5/§6/§7/§10 权威.
4. `docs/changes/subagent-panel/milestone-0{2,7,8}/DECISIONS.md` — 契约/定稿/施工三本账本.
5. `docs/changes/subagent-panel/roadmap/ROADMAP.md` + `MILESTONE-*.md` — 路线图与关闭记录.
6. `docs/changes/subagent-panel/milestone-0{9,10,14}/UNAUTHORIZED_DECISIONS.md` — AFK 自主决策记录.
7. `docs/language/UBIQUITOUS_LANGUAGE.md` — 领域术语.
8. `slim-subagent/` 源码 (index.ts 入口, single.ts 单次管线, resume.ts, projection.ts, card.ts, viewer.ts, diagnose.ts, log.ts) + `test/`.

## 路线图

1. 起点: 探路/契约/原型/定稿全部完成, PRD v2.0 确认版 + 执行 spec (9 ISSUE) 就绪.
2. M09 (ISSUE-01 日志骨架) → M10 (ISSUE-02 日志全量+details 补丁+ctx 子口径) → M17 (ISSUE-03 per-child 透传) → M11 (ISSUE-04 投影层) → M12/M13/M14 并行 (ISSUE-05/06/07: Run Card/Viewer/Diagnose).
3. ISSUE-08 主会话接线 (/agent-sessions + alt+v + /agent-diagnose + schema diagnose + store 回补 + d 键接通).
4. 验收期 (当前): 用户逐项验收, 随报随修 (上述 11 处修复).
5. **剩余**: ① 用户按 `acceptance-guide.md` 验完 AC 3/4/10/11-14 → ② 关 M16 → ③ 写最终交付说明 (改动清单/提交列表/已知限制), 抵达路线图终点.

距离目的地: 只剩「用户验收剩余项 + M16 关闭 + 交付说明」, 无已知阻塞性编码工作.
