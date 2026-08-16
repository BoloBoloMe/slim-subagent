# Subagent 可观测性控制面 Execution Spec

## 权威输入
- Product/Technical Spec (合一): `docs/changes/subagent-panel/pi_agent_subagent_panel_prd.md` (v2.0 确认版)
- Decisions: `docs/changes/subagent-panel/milestone-02/DECISIONS.md` (契约 D001-D010), `docs/changes/subagent-panel/milestone-07/DECISIONS.md` (定稿 D001-D013/F001-F005), `docs/changes/subagent-panel/milestone-08/DECISIONS.md` (施工 D001-D005/F001-F002)
- 领域语言: `docs/language/UBIQUITOUS_LANGUAGE.md`

## 全局允许范围
- `slim-subagent/`: 新增 `log.ts`, `projection.ts`, `card.ts`, `viewer.ts`, `diagnose.ts`; 修改 `index.ts` (插桩/渲染接线/schema, M17 透传改造), `single.ts`, `resume.ts` (仅插桩与 details 补丁); `test/` 新增测试
- `docs/changes/subagent-panel/**` 文档产物

## 全局禁止范围
- 禁止 patch/fork pi 本体 (pi 包只读)
- 禁止引入 widget 面板 / footer 摘要 / 手动 copy·resume 入口 (M07 D006/D010, PRD §11)
- 禁止为 `docs/changes/subagent-panel/milestone-*/prototype/` 写测试 (M07 D012)
- 禁止 queued/starting/blocked/waiting_input 一等状态 (PRD §3)

## 完成定义
- `cd slim-subagent && node --test test/**` 全绿 (既有 3588 行测试不回归 + 新增)
- 每 issue 的 pty 冒烟一轮全绿 (pty 持续 drain, M07 F005)
- ISSUE-09 用户验收通过

## 测试策略
- 纯函数 TDD 先行 (M08 D003): 投影映射 / 状态映射 / 日志脱敏+taskHash / diagnose target 解析 / 卡截断省略 / tolerant JSONL reader
- TUI 行为 (spinner/overlay/键盘流/onUpdate 管线): pty 冒烟, 每 issue 一轮全绿即过, 禁深度验证剧场 (M08 D005)
- AC 对应: PRD §10 十四条 → ISSUE-09 人工验收

## 任务图
- ISSUE-01: `issues/ISSUE-01-log-skeleton.md`; 覆盖: 日志骨架 (PRD §6.1/§6.2 最小闭环); 依赖: 无
- ISSUE-02: `issues/ISSUE-02-log-full-details-patch.md`; 覆盖: 48 日志点 + final details 契约; 依赖: ISSUE-01
- ISSUE-03: `issues/ISSUE-03-parallel-child-progress.md`; 覆盖: per-child 透传 (M07 D013); 依赖: ISSUE-02
- ISSUE-04: `issues/ISSUE-04-projection.md`; 覆盖: RunNode 投影 (PRD §3); 依赖: ISSUE-03
- ISSUE-05: `issues/ISSUE-05-run-card.md`; 覆盖: PRD §4/§10.1-4; 依赖: ISSUE-04
- ISSUE-06: `issues/ISSUE-06-session-viewer.md`; 覆盖: PRD §5/§10.5-7; 依赖: ISSUE-04
- ISSUE-07: `issues/ISSUE-07-diagnose.md`; 覆盖: PRD §7/§10.11-14; 依赖: ISSUE-04
- ISSUE-08: `issues/ISSUE-08-wiring.md`; 覆盖: 命令面 (M07 D009); 依赖: ISSUE-05, ISSUE-06, ISSUE-07 (integration 特例, 主会话执行)
- ISSUE-09: `issues/ISSUE-09-acceptance.md`; 覆盖: PRD §10 全量; 依赖: ISSUE-08 (HITL 特例)

## 覆盖矩阵
- PRD §6 日志 -> ISSUE-01/02 -> node --test + 日志文件观测
- PRD §3 契约/final details -> ISSUE-02/04 -> 投影单测
- M07 D013 per-child -> ISSUE-03 -> 聚合 details 单测 + 冒烟
- PRD §4 Run Card (AC 1-4) -> ISSUE-05 -> 截断单测 + pty 冒烟
- PRD §5 Viewer (AC 5-7) -> ISSUE-06 -> reader 单测 + pty 冒烟
- PRD §7 Diagnose (AC 11-14) -> ISSUE-07 -> target 解析单测 + 冒烟
- M07 D009 命令面 -> ISSUE-08 -> 冒烟
- PRD §10 全量 -> ISSUE-09 -> 人工验收

## 全局风险和停止条件
- 需要改变 PRD/账本决策时停止, 回主会话盘问
- 需要触碰 pi 本体或扩大允许范围时停止
- pty 冒烟环境与真实 TUI 行为差异无法自证时停止并上报
- worker 委派统一约束: 单测 + 一轮冒烟全绿即交付, 禁深度验证剧场 (M08 D005)
