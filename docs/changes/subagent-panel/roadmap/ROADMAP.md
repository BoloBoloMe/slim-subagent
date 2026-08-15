# Subagent 可观测性控制面

## 目的地

实际交付: ① PRD 草稿定稿为确认版需求 (含 B/C 形态升级与否的决策) → ② 按确认版 PRD 完成编码, 测试通过 → ③ 用户对照验收标准完成功能验收, 交付. 全程只改 slim-subagent 扩展, 不 patch pi 本体; 扩展层做不到的记入限制.

## 笔记

**领域与仓库**:
- 代码仓库: `/var/mnt/DATA/Workspace/subagent/slim-subagent` (主仓库子目录, 无独立 .git; pi 扩展, 提供 `subagent` 阻塞式委派工具). 源码: `index.ts` (工具入口/渲染), `single.ts`, `agents.ts`, `resume.ts`, `session-lease.ts`; 测试 `node --test test/**`. 基线 commit `492d9f3`; 基线后代码已漂移 (+27/-14 行), 行号引用以 M02 账本为准 (按 HEAD `7f7640e` 标注).
- PRD (已定稿, v1.3): `docs/changes/subagent-panel/pi_agent_subagent_panel_prd.md`. M02 决策账本: `docs/changes/subagent-panel/milestone-02/DECISIONS.md` (D001-D010, 实现权威输入).
- pi 包: `/var/home/bolo/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/`; 权威 API 签名在 `dist/core/extensions/types.d.ts`, 示例在 `examples/extensions/`.

**已验证的 pi API 事实** (勿重复探查):
- renderCall/renderResult/onUpdate 可完全自定义; onUpdate 替换语义 (partialResult 整体覆盖), TUI 16ms 节流连绘; **工具卡内无交互**, 一切交互走 registerCommand/registerShortcut.
- `ctx.ui.setWidget(key, lines|factory, {placement:"aboveEditor"|"belowEditor"})` 持久面板存在; `setFooter/setStatus/setHeader` 存在; `registerCommand` 存在.
- Session Viewer 类视图须 overlay + 自绘滚动 (pi-tui 无 ScrollView/Tab 组件); Esc=done(null).
- `/reload` 秒级热载, jiti 免编译; 钩子齐全 (session_start, tool_call/tool_result 拦截等).
- overlay 实测 (M01, 26/26 断言): nonCapturing 可承载 D 形态; **打开必须非阻塞** (fire-and-forget / registerShortcut handler, 命令内 `await ctx.ui.custom` 冻结主交互循环); 非捕获浮层收不到键盘, 关闭靠外部 `handle.hide()` 或自触发 `done()`; capturing 浮层吞全部键盘; session 事件只走 `pi.on()` typed handler, **不走 `pi.events` 总线**. 详见 `../milestone-01/overlay-coexistence-research.md`.

**契约审计结论** (4 处 PRD 缺口, M02 处理): contextPercent 语义错位 (现为父会话占用) / final details 缺 agent·task·timeoutMs / endedAtMs 无记录 / L16 无对应触发点 + L13/L14 需定界 / R5 final details 缺 mode 致节点键漂移. 48 日志点 44 个挂载点已存在, Diagnose 9 类证据链闭环.

**风险审计结论**: 完整报告 `docs/changes/subagent-panel/risk-first-research.md`. 唯一双高风险 R1 (overlay 共存) → M01; R2 证伪按钮隐喻 → 改道 registerCommand/registerShortcut; 其余 8/12 项已闭环.

**方向侦查结论**: 选定**混合路线** (R1 排雷 + 契约修订开路 → 原型驱动敲定交互 → 定稿 → 实现走廊 → 验收交付). 未选方向排除理由: 纯原型驱动会带着有毒契约进原型; 纯契约先行把 TUI 交互决策推给纸面 (体验死区); 纯风险倒序 8/12 风险已闭环, 串行排雷是浪费.

**M04 原型决策** (2026-08-15): Run Card 变体 C (分段展开) 胜出; 密度默认 cozy; §4.0 省略顺序不变; CH 缓存命中率段待 M07 落 PRD; M12 实现注意: final 帧替换运行帧 + 命令参数 NFKC 归一化. 详见 M04 报告.

**补充决策** (2026-08-14, 用户补充需求, 落 M02 第 6 条): DisplayStatus 加 `pending` — 仅 parallel child 可推导 (tasks[] 全集 − L30 scheduled 集合), 预建行, 进 worker 转 active; 失败原因展示限运行层 (可观测), 语义层"未达到目标"不做自动判断. 波及 M04/M11/M12.

**固定偏好**: 中文回复/文档 (非译项除外), 半角标点, `uv run python`.

**遍历时应查阅的 skill**: prototype (HITL) → `prototype` skill; deliberate → `deliberate` skill, 产物根目录 `docs/changes/subagent-panel/milestone-NN/`; AFK 编码任务 → `tdd-as-orchestra` skill.

## 已关闭决策

<!-- 每个已关闭 Milestone 一行: 链接 + 一句话摘要 -->

- [MILESTONE-01](MILESTONE-01.md) — R1 排雷通过: nonCapturing overlay 与 streaming/dialog/焦点共存 26/26 实测合格, D 形态可承载; 硬约束=打开须非阻塞 + 关闭靠外部句柄/自触发. 报告: [overlay-coexistence-research.md](../milestone-01/overlay-coexistence-research.md). 迷雾 F2 条件 (R1 负面) 未触发, 消散.
- [MILESTONE-02](MILESTONE-02.md) — 契约修订落 PRD v1.3: ctx 子代理口径 / final details 补字段 (assembleSingleResult 单点补丁) / taskPreview ≤120 规则 / 节点键顶层 mode / run.json settle 补丁写 / L16 80% 预警 + L13→L14 序列定界 / pending 契约 / resume startedAtMs 口径. 账本: [DECISIONS.md](../milestone-02/DECISIONS.md) (D001-D010); 审核 (k3) 无严重发现, 轻微项已全修.
- [MILESTONE-03](MILESTONE-03.md) — 原型骨架就绪: scratch 扩展 `~/.pi/agent/extensions/subagent-panel-proto/` + 假工具 `subagent_proto` (single 7 步/parallel 5 步回放, 时序对照 single.ts:811-904 与 index.ts:265-275), pty 实测 25/25 通过, `/reload` 热载 902ms 生效; `types.ts` 契约 M04+ 直接复用. 报告: [milestone-03-report.md](../milestone-03/milestone-03-report.md).
- [MILESTONE-04](MILESTONE-04.md) — Run Card 原型评审收口: **变体 C 分段展开** (recentTools 逐条行 + parallel child 双行树形) 选定; 默认密度 cozy; 截断维持 PRD §4.0; 新增 CH 缓存命中率展示段 (cacheRead 派生, tokens 后 cost 前, cozy 限定, 待 M07 落 PRD); **F1 升级** → MILESTONE-17. 报告: [milestone-04-report.md](../milestone-04/milestone-04-report.md); 原型源码归档 [../milestone-04/prototype/](../milestone-04/prototype/).

## 前沿

- [MILESTONE-05](MILESTONE-05.md) — `prototype` — B/C · Widget 面板 + Footer 摘要原型
- [MILESTONE-06](MILESTONE-06.md) — `prototype` — D · Session Viewer 原型 (overlay 多 tab)

## 未决迷雾

(空 — F1 已转化为 MILESTONE-17)

## 范围外

- **patch / fork pi 本体** — 扩展 API 覆盖面足够, 缺口记限制. 排除原因: 目的地边界, 用户已确认.
- **PRD §11 全清单 (修正版)** — 无限子代理树可视化 / parallel resume / waiting_input 等运行时无事件的一等状态 (queued 禁令收窄: parallel child 的 `pending` 已纳入范围, 见补充决策) / skill 独立分类 / Diagnose 自动修复 / 日志做 metrics 后端 / 从磁盘反推运行中状态 / list 名册面板化. 排除原因: PRD 已明确不做, 与目的地无关.
- **语义层"未达到目标"自动判断** — 运行时无信号可观测结果质量, 需引入 LLM 评审, 超出可观测性范围. 排除原因: 用户已确认边界, 属另一个产品.

## 阻塞关系

```
M04 ─┐
M05 ─┼─→ M07 ─→ M08 ─→ M09 ─→ M10 ─→ M17 ─→ M11 ─┬─→ M12 ─┐
M06 ─┘                                           ├─→ M13 ─┤
                                                 ├─→ M14 ─┼─→ M16 ─→ ◆ 实际交付
                                                 └─→ M15 ─┘
```

- M07 阻塞于 M04(已关闭), M05, M06 (M02 已关闭); M08 阻塞于 M07.
- M09–M10 串行; M17 (F1 转化) 阻塞于 M10, 阻塞 M11; M12–M15 并行阻塞于 M11; M15 另需 M07 决策升级 (条件里程碑, 不升级则关闭记因).
- M16 阻塞于 M12, M13, M14, M15.
