# Subagent 可观测性控制面

## 目的地

实际交付: ① PRD 草稿定稿为确认版需求 (含 B/C 形态升级与否的决策) → ② 按确认版 PRD 完成编码, 测试通过 → ③ 用户对照验收标准完成功能验收, 交付. 全程只改 slim-subagent 扩展, 不 patch pi 本体; 扩展层做不到的记入限制.

## 笔记

**领域与仓库**:
- 代码仓库: `/var/mnt/DATA/Workspace/subagent/slim-subagent` (独立 git 仓库, pi 扩展, 提供 `subagent` 阻塞式委派工具). 源码: `index.ts` (工具入口/渲染), `single.ts`, `agents.ts`, `resume.ts`, `session-lease.ts`; 测试 `node --test test/**`. 基线 commit `492d9f3`.
- PRD (草稿, M07 定稿): `docs/changes/subagent-panel/pi_agent_subagent_panel_prd.md` (v1.2-observability).
- pi 包: `/var/home/bolo/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/`; 权威 API 签名在 `dist/core/extensions/types.d.ts`, 示例在 `examples/extensions/`.

**已验证的 pi API 事实** (勿重复探查):
- renderCall/renderResult/onUpdate 可完全自定义; onUpdate 替换语义 (partialResult 整体覆盖), TUI 16ms 节流连绘; **工具卡内无交互**, 一切交互走 registerCommand/registerShortcut.
- `ctx.ui.setWidget(key, lines|factory, {placement:"aboveEditor"|"belowEditor"})` 持久面板存在; `setFooter/setStatus/setHeader` 存在; `registerCommand` 存在.
- Session Viewer 类视图须 overlay + 自绘滚动 (pi-tui 无 ScrollView/Tab 组件); Esc=done(null).
- `/reload` 秒级热载, jiti 免编译; 钩子齐全 (session_start, tool_call/tool_result 拦截等).

**契约审计结论** (4 处 PRD 缺口, M02 处理): contextPercent 语义错位 (现为父会话占用) / final details 缺 agent·task·timeoutMs / endedAtMs 无记录 / L16 无对应触发点 + L13/L14 需定界 / R5 final details 缺 mode 致节点键漂移. 48 日志点 44 个挂载点已存在, Diagnose 9 类证据链闭环.

**风险审计结论**: 完整报告 `docs/changes/subagent-panel/risk-first-research.md`. 唯一双高风险 R1 (overlay 共存) → M01; R2 证伪按钮隐喻 → 改道 registerCommand/registerShortcut; 其余 8/12 项已闭环.

**方向侦查结论**: 选定**混合路线** (R1 排雷 + 契约修订开路 → 原型驱动敲定交互 → 定稿 → 实现走廊 → 验收交付). 未选方向排除理由: 纯原型驱动会带着有毒契约进原型; 纯契约先行把 TUI 交互决策推给纸面 (体验死区); 纯风险倒序 8/12 风险已闭环, 串行排雷是浪费.

**固定偏好**: 中文回复/文档 (非译项除外), 半角标点, `uv run python`.

**遍历时应查阅的 skill**: prototype (HITL) → `prototype` skill; deliberate → `deliberate` skill, 产物根目录 `docs/changes/subagent-panel/milestone-NN/`; AFK 编码任务 → `tdd-as-orchestra` skill.

## 已关闭决策

<!-- 每个已关闭 Milestone 一行: 链接 + 一句话摘要 -->

## 前沿

- [MILESTONE-01](MILESTONE-01.md) — `research` — R1 overlay 共存排雷实验
- [MILESTONE-02](MILESTONE-02.md) — `deliberate` — 数据/日志契约修订 (5 处 PRD 缺口)
- [MILESTONE-03](MILESTONE-03.md) — `task` — 原型骨架: scratch 扩展 + 假数据回放器

## 未决迷雾

- **F1 · parallel per-child 实时进度**: 审计坐实 parallel 不透传 onUpdate (`progress: []` 硬编码, index.ts:275). 升级只需改本仓库 runParallelTasks, PRD 现列非 MUST. M04 原型轮摸到手感后回访 — 若升级, 裂出改造里程碑插入实现走廊 (影响 M10–M12); 也可能确认不做.
- **F2 · R1 负面时 D 的备选形态**: 若 M01 实测 overlay 共存有坑, D 改走哪条路 (widget 常驻 + 命令开 overlay? 放弃全屏?) 等 M01 结论, 同时影响 M06 与 M13.

## 范围外

- **patch / fork pi 本体** — 扩展 API 覆盖面足够, 缺口记限制. 排除原因: 目的地边界, 用户已确认.
- **PRD §11 全清单** — 无限子代理树可视化 / parallel resume / queued·waiting_input 一等状态 / skill 独立分类 / Diagnose 自动修复 / 日志做 metrics 后端 / 从磁盘反推运行中状态 / list 名册面板化. 排除原因: PRD 已明确不做, 与目的地无关.

## 阻塞关系

```
M01 ─┐
     ├─→ M06 ─┐
M03 ─┼─→ M04 ─┤
     └─→ M05 ─┤
M02 ──────────┴─→ M07 ─→ M08 ─→ M09 ─→ M10 ─→ M11 ─┬─→ M12 ─┐
                                                   ├─→ M13 ─┤
                                                   ├─→ M14 ─┼─→ M16 ─→ ◆ 实际交付
                                                   └─→ M15 ─┘
```

- M06 阻塞于 M01, M03; M07 阻塞于 M02, M04, M05, M06; M08 阻塞于 M07.
- M09–M11 串行; M12–M15 并行阻塞于 M11; M15 另需 M07 决策升级 (条件里程碑, 不升级则关闭记因).
- M16 阻塞于 M12, M13, M14, M15.
- F1 若转化, 插入 M10–M12 之间; F2 若转化, 影响 M06/M13.
