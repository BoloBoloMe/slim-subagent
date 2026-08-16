# 交接: subagent-panel 实现走廊执行 (AFK 编码)

- 日期: 2026-08-15
- 用途: 供执行 `docs/changes/subagent-panel/execution/` 中 ISSUE-01 起编码任务的会话了解前情
- 仓库: /var/mnt/DATA/Workspace/subagent (主仓库, git 管理); 施工目标 `slim-subagent/` (pi 扩展, 无独立 .git)

## 现状

路线图探路阶段全部完成 (M01-M08 关闭, M15 关闭记因), PRD v2.0 确认版定稿, 执行 spec 已生成并两轮校验修复. 施工未开始, slim-subagent 源码与基线 `492d9f3` 仅有文档外漂移 (M02 账本行号按 HEAD `7f7640e` 标注). 下一个动作 = 领取 ISSUE-01.

## 其他文档没有的信息

**用户协作偏好 (影响执行节奏)**:
- 所有产品/技术决策已固化在账本, 执行期禁止重开; 遇决策缺口走停止条件回主会话, 不自作主张
- 中文回复/文档 (非译项除外), 半角标点, `uv run python` (禁止裸 python/pip)
- 用户反感验证剧场: 原型轮两个 worker 均超时在深度 pty 验证, 功能早已完成. 纪律 (M08 D005): 单测 + 一轮 pty 冒烟全绿即交付, 禁止反复截帧/多轮重试/深度 harness
- 中文输入法会输入全角字符, 命令解析需 NFKC 归一化 (原型已踩坑并修复)

**pty 验证方法学 (M07 F005, 血泪教训)**:
- pty 驱动必须持续 drain, 否则缓冲满挂起 pi 事件循环, 扩展 setTimeout 全部失灵
- overlay 关闭类断言用状态探针 (如 status 命令输出) 不用屏幕帧 — 重绘时序导致缓冲旧帧误报
- LLM 触发路径偶发 abort, 重试即可; 冒烟启动命令: `pi --no-session --provider opencode-go --model opencode-go/deepseek-v4-flash --thinking off -ns -np -nc`
- pi `/reload` 秒级热载 (实测 902ms), 开发迭代用

**环境悬案 (不影响施工, 知道即可)**:
- `~/.pi/agent/extensions/subagent-panel-proto/` (原型扩展) 曾两次神秘消失, 特征 = 删除后父目录 mtime 被还原 (同步/备份类工具嫌疑), 未抓到现行; 已挂 watchdog 监控 `~/.pi/agent/watch/extensions-watch.log`
- 原型源码已归档仓库 `docs/changes/subagent-panel/milestone-0{4,5,6}/prototype/`, 再丢从仓库恢复
- 施工目标是 slim-subagent 本体, 与原型扩展无关; 原型只作渲染/交互参照 (ISSUE-05/06 可直接搬运逻辑, 禁止搬运原型债)

**关键非显然技术事实**:
- renderResult/renderCall 有第 4 参 `context.invalidate()` 可驱动重绘 (spinner 动效依赖, pi 包 tool-execution.js:93-98, types.d.ts:321)
- overlay 打开必须 fire-and-forget, 命令内 await ctx.ui.custom 冻结主循环 (M01 实测)
- parallel 聚合 onUpdate 在 index.ts:265-285, `progress: []` 硬编码在 index.ts:281 (ISSUE-03 改造点)
- 行号引用以 HEAD `7f7640e` 为准, spec 修复轮已校正主要定位 (ISSUE-02 的 assembleSingleResult = single.ts:1187, 返回体 1267-1290)

## 必读推荐

1. `docs/changes/subagent-panel/execution/EXECUTION.md` — 总入口: 允许/禁止范围, 完成定义, 停止条件. 开工前必读.
2. 所领取的 `docs/changes/subagent-panel/execution/issues/ISSUE-NN-*.md` — 任务书: TDD 切片/代码定位/验收标准.
3. `docs/changes/subagent-panel/pi_agent_subagent_panel_prd.md` — PRD v2.0 确认版, 契约 (§3)/渲染 (§4)/Viewer (§5)/日志 (§6)/Diagnose (§7) 权威. 遇到与 issue 冲突以 PRD + 账本为准并停止上报.
4. `docs/changes/subagent-panel/milestone-0{2,7,8}/DECISIONS.md` — 三本账本 (契约/定稿/施工), 含执行索引.
5. `docs/changes/subagent-panel/milestone-0{4,5,6}/prototype/` — ISSUE-05/06 的像素级参照 (变体 C 卡 + spinner + viewer 全结构).
6. `docs/changes/subagent-panel/milestone-06/evidence/smoke.py` — pty 冒烟模式参照 (含状态探针写法).
7. `docs/language/UBIQUITOUS_LANGUAGE.md` — 领域术语 (批次/RunNode/Timeline/DisplayStatus).

## 路线图

1. M01 overlay 共存排雷 → 2. M02 契约修订 (PRD v1.3) → 3. M03 原型骨架 → 4. M04-M06 原型三轮 (Run Card 变体 C / widget 否决 / Viewer v2 批次时间线) → 5. M07 PRD v2.0 定稿 → 6. M08 施工闸门 → 7. 执行 spec (9 issues) — **当前位置**
8. 剩: ISSUE-01→02→03→04 串行 → 05/06/07 并行 → 08 主会话接线 → 09 用户验收. 工作量评估: 编码主体未动, 但所有决策/契约/参照原型已备, 无已知阻塞性未知; 风险集中在并行合流 (ISSUE-08) 与真实 TUI 行为差异.
