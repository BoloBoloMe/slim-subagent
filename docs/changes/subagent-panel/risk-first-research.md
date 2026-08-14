# Risk-first 方向探查报告 — subagent-panel PRD

基线: PRD v1.2 (`docs/changes/subagent-panel/pi_agent_subagent_panel_prd.md`), slim-subagent @ 492d9f3, pi 0.82.1 (package.json "version": "0.82.1").

## 结论先行

- 12 项技术风险, 真正"文档空白 × MUST 形态"叠加的只有 1 项: **R1 overlay 长期共存** (Session Viewer D). 其余 11 项已被文档/源码闭环, 或爆炸半径低.
- PRD §4.1 卡片按钮 / §4.2 footer 点击 / §5 "每行 Open session" 入口形态**已被 pi 文档证伪** (工具卡无输入通道, footer 无点击) — 不是待验证风险, 是确定的设计改道点.
- parallel per-child 流式缺口在源码层面坐实 (index.ts:292 runSingleAgent 不透传 onUpdate; index.ts:275 `progress: []` 硬编码), 但 PRD 自己已把它列为非 MUST (§8/§11), 不构成路线杀手.
- session.jsonl 格式**有完整文档** (docs/session-format.md, 436 行, 含 v1→v3 版本与 id/parentId 树) — 原假设"格式在哪定义未知"不成立, 风险降级为工作量.
- 判断: **推荐该方向, 但需修正为混合形态** (见末节).

## 风险清单 (按 不确定性 × 爆炸半径 排序)

### R1 — Overlay 浮层与 streaming/dialog 长期共存 [不确定性 高 × 半径 高] ← 唯一路线杀手候选
- 文档只覆盖 `ctx.ui.custom(..., {overlay:true, overlayOptions, onHandle})` + focus/unfocus 语义 (docs/tui.md:124-200); "focused overlay keeps input ownership across temporary non-overlay UI" (tui.md:175) 是唯一共存承诺.
- `nonCapturing` **不在任何文档** (grep docs = 0 hit), 仅见于 examples/extensions/overlay-qa-tests.ts:958/1057/1279, 走内部 API `tui.showOverlay(panel, {nonCapturing:true,...})` (overlay-qa-tests.ts:1057).
- agent streaming 重绘与 overlay 叠绘、内置 dialog (/model, select) 弹出/关闭后焦点回收 — 文档无任何陈述.
- pi-tui 无 ScrollView/Tab 组件 (grep docs/tui.md 无 Scroll 类; 仅 :643 editor 的 scrollInfo 回调) → Viewer 自绘滚动确定要做, 属工作量非不确定性.
- 爆炸半径: D 是 MUST, 且 R2 已证伪工具卡交互 → overlay 若不可用, Viewer 只剩 `ctx.ui.custom` 非 overlay 全屏替换 UI 一条路 (体验降级但可行).

### R6 — details/帧膨胀与性能 [中 × 中]
- live parallel 每帧 details 带全量 `allResults` 副本 (index.ts:275), `completed.text = resultTextOf(res)` 全文不截断 (index.ts:303 附近, `truncateParallelOutput` 只截 content 不截 details); 8 child × ≤50KB 文本 × 16ms 节流连绘.
- details 会持久化进 session 文件 (session-format.md ToolResultMessage.details; docs/extensions.md:1821 "store it in tool result details for proper branching support") → 刷新重建可行 (PRD §8 成立), 但 session 文件膨胀.
- §9 性能 MUST (≤200ms 初始渲染) 是否达标只能实测.

### R4 — session.jsonl 树形/版本/resume 追加形态 [低-中 × 中]
- 格式有文档: header `{"type":"session","version":3,...}` (session-format.md SessionHeader 节); v1 线性 / v2 id+parentId 树 / v3 hookMessage→custom; pi 加载时自动迁移, 但**磁盘 raw 文件可能是任意版本**.
- resume 复用同一文件追加 (PRD §5 "无 boundary marker"): 树结构下 resume 后产生分支, Viewer "当前分支"展示需 leaf 选择策略 — 文档未给 resume 追加的具体形态, 需实测样本.
- tolerant 解析必须处理: compaction/model_change/thinking_level_change/custom/bashExecution entry (session-format.md Entry Types 节).

### R2 — 工具卡/footer 无交互 vs PRD 入口设计 [低 × 中] (已证伪, 非不确定性)
- renderCall/renderResult context 字段 = args/state/lastComponent/invalidate/toolCallId/cwd/executionStarted/argsComplete/isPartial/expanded/showImages/isError (docs/extensions.md:2203-2205) — **无输入通道**; 唯一内置交互是 Ctrl+O expand (extensions.md:2258 keyHint 节).
- setFooter = `render(width)=>string[]`, 无输入无点击 (docs/tui.md:826-837 Pattern 6) → §4.2 "点击聚焦"不可实现.
- 改道出口存在且有文档: `pi.registerCommand` (extensions.md:1491) + `pi.registerShortcut` (extensions.md:174) → 入口改为命令/快捷键 + keyHint 文案, 卡片按钮降级为提示文本.

### R3 — parallel per-child 流式数据缺口 [低 × 中] (源码坐实)
- index.ts:292 runChild 调 runSingleAgent 参数无 onUpdate; index.ts:269 占位 details `usage: emptyUsage(), sessionDir: "", exitCode: -1`; index.ts:275 聚合帧 `progress: []` 硬编码.
- 后果: parallel 卡 active child 行只能有 status/model(调用侧)/timeout(调用侧), 无 ctx/usage/recent — 与 §4.1 mock (active child 行本就无 recent) 和验收 2 ("未完成 child 只显示 active") 一致, PRD 自体自洽; 升级为实时需改 runParallelTasks 透传 index-tagged onUpdate (纯本仓库改动, 不被 pi 阻塞).

### R10 — ctx% 数据源与 modelRegistry [中 × 低-中]
- `ctx.getContextUsage()` 有文档但返回**父会话**用量 (docs/extensions.md:1036), 不能直接当子代理 ctx%.
- 子代理 ctx% = contextTokens (message_end totalTokens, single.ts message_end 分支) ÷ contextWindow; 后者靠 `ctx.modelRegistry.find` (single.ts resolveModelWindow) — modelRegistry 在 dist 类型有 (dist/core/extensions/types.d.ts:220), 但 docs/extensions.md 全文 0 hit → 半官方 API, pi 版本漂移即静默退化为 `ctx —` (PRD 允许 —, 兜底安全).

### R7 — session_start GC × resume lease × log 引用 [中 × 低-中]
- GC 挂点 `pi.on("session_start")` 有文档 (extensions.md:66,392); index.ts:430 的防御性 cast 多余但无害.
- PRD §6.1 要求 logs GC "若文件仍被活跃 run/lease 引用则跳过": 现行 lease 以 sessionFile hash 建锁 (session-lease.ts leaseDirFor), **与日志文件无任何关联机制**; "当日 log 被活跃 run 引用"需扫描 log 行 runId 判定 — 与"删除该文件"循环依赖, 需新设计 (跨午夜 run 是边界 case).
- 长 pi 会话不重启 → session_start 不触发 → 7 日 GC 实际推迟 (sessions/logs 同).

### R5 — onUpdate 替换语义 vs §8 "增量投影同键覆盖"; final single 无 mode 字段 [低 × 低-中]
- 每帧都是全量快照 (single.ts:814-820 emitUpdate 带完整 results+progress 拷贝; index.ts:275 全量 allResults) → 替换语义下投影器**可从单帧重建**, "增量投影同键覆盖"措辞不冲突, 但实现不能依赖跨帧 diff 累积.
- 键漂移: live single details 有 `mode:"single"` (single.ts:107/817), final single details (assembleSingleResult 收口, single.ts:1266 起) **无 mode 字段** → §8 节点键 `toolCallId+mode+runId/index` 在 final 帧 mode=undefined, 同一 run 前后两键, 投影器需键规则补丁.

### R9 — Diagnose action/schema 兼容性 [低 × 低]
- 现 schema 恰 9 参数 + action union ["list","resume"] (index.ts:54-63 SubagentParams, 注释标 M2-D008 为既有契约); 扩 `"diagnose"` literal + 新增可选参数 (since/levelMin/limit/writeReport) 对模型侧是纯增量, 向后兼容; 内部"恰 9 参数"测试断言与 promptSnippet/description 需同步更新.

### R8 — 日志写入失败降级 [低 × 低]
- PRD §8 已定降级路径 (warn / 静默计数到 diagnose insufficient_evidence); 日志设施全新建, append 必须全 try/catch (ENOSPC/EACCES/HOME 只读), 崩溃路径 best-effort — 纯工程纪律, 单测注入 fs 失败即可排雷.

### R12 — setFooter 是覆盖式 API [低 × 低]
- `ctx.ui.setFooter(...)` 整体替换默认 footer (tui.md:826-837) → mini summary 会顶掉 git branch 等默认内容, 需用 footerData (getGitBranch/getExtensionStatuses) 重组默认元素, 否则形态 B 有体验回退.

### R11 — render 抛错回退 [已闭环, 零风险]
- pi 内置 fallback: renderer throws → renderCall 显示工具名, renderResult 显示 raw text (docs/extensions.md:2298-2302) → L44 的回退语义免费获得.

## Top 风险排雷方式

| 风险 | 方式 | 具体搭法 | 成本 |
|---|---|---|---|
| R1 | 微型实验 | 复制 overlay-qa-tests.ts 为独立扩展: 命令开 (a) capturing 自绘滚动 viewer overlay (b) nonCapturing 角标 overlay; 同会话跑长 subagent (流式 16ms 连绘), 期间弹 ctx.ui.select 与内置 /model dialog; 观察叠绘撕裂/焦点回收/Esc 返回链. 另测非 overlay 全屏 custom UI 作 fallback | ~0.5 天 |
| R6 | 微型实验 | 用既有注入缝 PI_SUBAGENT_PI_BINARY/FAKE_PI_SCENARIO (single.ts 寻址链 a 级) 造 8-child verbose 场景, 打点 onUpdate 频率 × `JSON.stringify(payload).length` 分布; 真 pi TUI 肉眼验连绘 | ~0.5 天 |
| R4 | 读文档+取样 | session-format.md 全篇; 真跑一次 single + 中止 + resume, 逐行比对落盘 session.jsonl (版本号/树分支/resume 追加形态/compaction entry) | ~0.5 天 |
| R2 | 已闭环 | 无需实验; 产物 = 入口改道清单 (registerCommand/registerShortcut + keyHint) | 0 |
| R10 | 微型探针 | 30 行扩展打印 `ctx.modelRegistry?.find(...)` 实况 + 读 dist types.d.ts:220 签名 | ~1 小时 |

## Milestone 草案 (阻塞关系序)

- M0 排雷冲刺: R1/R6/R4/R10 四个实验并行, 产 go/no-go + 实测数据 (阻塞一切设计).
- M1 入口与降级矩阵定稿 (依赖 M0-R1 结论; R2 清单并入) — 决定 D 形态与 A 卡文案.
- M2 日志骨架 + GC (PRD §12 步骤 1-2; 与 M0/M1 无依赖, 可并行启动) — E 前半.
- M3 投影器 projectSlimDetailsToRunNodes (依赖 M0-R6 帧预算结论; 含 R5 键补丁) — A 数据层.
- M4 Inline Run Card 增强 (依赖 M3) — A 完成.
- M5 Session Viewer (依赖 M1 + M0-R4 样本解析器) — D.
- M6 Diagnose (依赖 M2 日志 + M5 解析器复用) — E 后半.
- M7 Footer/Widget (依赖 M3; SHOULD/COULD, 可整段裁剪) — B/C.

## 成本/收益/缺点

- 工作量粗估: 排雷 1.5-2.5 天; 排雷顺利前提下全量实现 (A+D+E+B) 8-14 天 (Viewer 自绘多 tab + tolerant parser 4-6 天为最大头; 48 个日志点 2-3 天; Diagnose 启发式 1.5-2.5 天; 投影+卡片 1.5-2 天; footer/panel 1 天). 排雷占总量约 15%.
- 收益: 把唯一路线杀手 (R1, MUST 形态 D) 的 go/no-go 前置到写实现代码之前; 实验副产品 (session.jsonl 真实样本/帧预算数据/overlay 行为清单) 直接喂设计.
- 缺点: (1) 排雷完设计仍未开始, 里程碑形态碎片化 (M0/M2 并行, M1 依赖实验结论, PRD §12 顺序需整体重排); (2) 排雷产物多为一次性脚手架, 不可复用进实现; (3) "风险清零后设计自然成形"是假设 — R2/R3/R5/R11 已被文档/源码闭环, 纯串行 risk-first 会把这些确定结论无谓后置, 延迟 PRD 修订反馈环 (尤其 §4.1 按钮/§4.2 点击这类 PRD 文本本身要改).

## 明确判断

**推荐, 但修正为混合形态**: M0 排雷冲刺与 M2 日志骨架并行启动, 排雷结束后立即做一次 PRD 修订 checkpoint (入口改道/R5 键规则/R10 降级文案), 再进正式设计. 纯串行 risk-first 不推荐 — 12 项风险里 8 项已被文档/源码闭环, 全走实验是浪费.

## 后续行动者入口

先跑 R1 overlay 实验 (模板: `examples/extensions/overlay-qa-tests.ts`, 重点抄 PassiveDemoController/FocusDemoController 的 showOverlay 用法) — 它是唯一不确定性×半径双高项, 且其结论决定 M1 入口设计与 D 形态存亡; 其余风险读本报告证据行号即可, 不必重复查证.
