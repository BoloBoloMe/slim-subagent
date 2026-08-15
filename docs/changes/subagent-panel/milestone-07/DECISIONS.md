# M07 定稿盘问 决策账本

产物根目录: `docs/changes/subagent-panel/milestone-07/`. 权威输入 = 本账本 + PRD v2.0 确认版 (`../pi_agent_subagent_panel_prd.md`). M02 账本 (D001-D010 契约决策) 在 `../milestone-02/DECISIONS.md`, 仍然有效, 本账本不重复.

## 决策

### D001 Run Card 结构 = 变体 C 分段展开
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: Inline Run Card 采用分段展开结构: 状态行 + recentTools 逐条行 (≤3, expanded ≤10) + output 预览行; parallel 为聚合行 + child 双行树形. 理由: M04 三变体 HITL 评审, 用户实测选定; recent 历史清晰度最优, 横向截断压力最小. A (PRD 双行) 与 B (单行致密) 废弃.
- 预计影响: slim-subagent renderResult/renderCall 重写 (M12)

### D002 密度默认 cozy
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: cozy = 全字段 (含 cost/CH/cap/timeout); compact 预省 cost/CH/cap/timeout. 默认 cozy. 理由: 用户需要 cost/timeout/cap 常驻.
- 预计影响: 渲染层密度开关 (M12)

### D003 窄行省略顺序维持 §4.0
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: cost → CH → cap → timeout → recent → taskPreview → usage tokens; 死保 status/model/ctx/elapsed. (CH 为本轮新增, 插入 cost 之后.)
- 预计影响: 渲染截断逻辑 (M12)

### D004 CH 缓存命中率展示段
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 状态行新增 `CH 87%` 段, 公式 `cacheRead / (cacheRead + input)`, 无 cacheRead 数据不显 (不伪造); 显示位置 tokens 后; 仅 cozy; 省略顺序紧随 cost. 纯展示派生, 契约不加字段.
- 预计影响: 渲染层 (M12)

### D005 active 图标 = 动画 spinner
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: active 行图标为 ⠋⠙⠹… 90ms 帧轮转动画, 终态静态 (✓/✗). 实现: renderResult 第 4 参 `context.invalidate()` 注册进组件定时器驱动重绘, 与数据更新解耦; settled 即停. 理由: 用户硬性需求 ("不接受静态 ⠿"); 原型已实测可行.
- 依赖事实: F001
- 预计影响: 渲染组件 (M12)

### D006 形态裁决: 保留 A, 砍 Widget 面板与 Footer 摘要
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 唯一常驻实时观测面 = Inline Run Card. Widget 面板 (§4.3) 与 Mini Footer Summary (§4.2) 出局进 §11. 理由: 用户实测"无卡 + widget 独挑"形态后否决 ("这个设计不对, 应该保留 Inline Run Card, 去掉 Widget 面板"); footer 摘要用户无诉求 (Q1 选 b). M15 收窄后整体关闭记因.
- 预计影响: PRD §1.4/§4.2/§4.3/§11/§12; ROADMAP M15

### D007 Session Viewer 信息组织 = Timeline + 子代理会话 tab
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: tab 栏 = 所选批次的子代理; 首 tab `Timeline` = 全部批次按创建时间上早下晚的时间线, ↑/↓ 选批次 Enter 确认换批, 默认最新批次; 子代理 tab 内容视觉对齐 pi 父会话 transcript. v1 内容分类 tab (Tools/Events-Raw/Logs/Diagnostics) 全砍: Tools 与 transcript 冗余; Events/Logs 归 Diagnose 领域; Diagnostics 并入子代理 tab 底部状态区一行 (ctx%/budget/hint/log event ids). 理由: 用户原话设计, v1 原型被否决后 v2 实测 "就是我想要的".
- 预计影响: PRD §5 重写; viewer 实现 (M13)

### D008 Viewer 键盘流与窗口行为
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: Tab/Shift+Tab 循环 + ←/→ 切 tab + 数字键直跳; ↑/↓ 选择/滚动; PgUp/PgDn 翻页; Enter 仅 Timeline 确认; Esc 关闭; toggle 语义 (view 命令/alt+v 再按即关). 始终全屏, 无宽度调整. 不做 overlay 内回放/演示. followLive 仅子代理 tab. 理由: 用户逐项拍板 (M06).
- 预计影响: viewer 实现 (M13)

### D009 命令面与快捷键
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: `/agent-sessions` (viewer 主入口) + `alt+v` (Windows 被粘贴占用, 退回命令); `/agent-diagnose [target] [since]` (无参 = 最近 24h error/fatal 相关 run); viewer 内 `d` = diagnose 当前 tab 子代理 (带 runId 上下文). 卡上提示文案 `alt+v 会话 · /agent-diagnose 诊断`.
- 依赖事实: F002
- 预计影响: registerCommand/registerShortcut (M13/M14); PRD §7.1

### D010 无手动 copy runId / resume 入口
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 删除 [Copy runId] [Copy resume cmd] 全部入口. 理由: 用户无 copy 场景 (Q3 反问成立); "resume 是父会话要做的事, 父会话自行决定是否 resume, resume 谁" (Q5).
- 预计影响: PRD §4.1/§5/§11; 卡渲染与 viewer

### D011 Viewer 数据源 = 内存 store + 磁盘回补 20 批
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 运行中数据走内存 (onUpdate 喂入); 启动时从磁盘 run 记录 (run.json + run-*/session.jsonl) 回补最近 20 批; 不从磁盘反推运行中状态. 理由: Q4 用户选定; 纯磁盘拼不全运行态 (M02 审计), 纯内存重启即空.
- 预计影响: store 设计 (M11/M13)

### D012 测试策略
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: ① 契约/投影/渲染纯函数 → `node --test` 单元测试先行 (red-green); ② TUI 集成行为 (onUpdate 管线/热载/overlay) → pty 冒烟脚本, 每里程碑 1 轮全绿即过, 不求断言覆盖率; ③ prototype/ 目录永不受测. 理由: Q6 用户同意; 与 M01-M06 已验证节奏一致.
- 预计影响: M09-M16 全部编码里程碑

### D013 F1 升级: parallel per-child 实时进度透传
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 改造 runParallelTasks 透传 per-child onUpdate 进聚合 details (MILESTONE-17). 理由: 用户 "无法接受只有 2/4 done, 看不到每个 child 在干嘛的瞎感" (M04).
- 预计影响: slim-subagent index.ts runParallelTasks (M17); 投影层 (M11); Run Card (M12)

## 事实

### F001 renderResult/renderCall 第 4 参 context.invalidate() 可驱动重绘
- 状态: 当前有效
- 来源: pi 包 dist/modes/interactive/components/tool-execution.js:89-107 (getRenderContext), 调用点 :235/:257; types.d.ts:376; 原型实测 (2026-08-15, pty 验证 spinner 多帧)
- 内容: ToolRenderContext.invalidate = 组件 invalidate + ui.requestRender; 90ms 定时器调它即可实现卡内动画; pi-tui Loader 同款机制 (loader.js:54-65). 终态不注册即停.

### F002 键位占用
- 状态: 当前有效
- 来源: pi 包 docs/keybindings.md
- 内容: alt+v Linux/macOS 空闲 (原型已验证可用), Windows = 粘贴图片; alt+b/f/d/y 被编辑器词操作占用; ctrl+c/d/z/g 等被 app 占用. 快捷键设计须避让.

### F003 setWidget/setFooter API 事实
- 状态: 当前有效
- 来源: types.d.ts L46-49/L80/L97-107; interactive-mode.js L1670+ (worker M05 探明)
- 内容: setWidget string[] 上限 MAX_WIDGET_LINES=10, 同 key 重调 = 更新, factory 仅在设置时调一次 (不适合每步刷新); setFooter factory 收 footerData 可实现共存式两行 footer. (形态已出局, 存档备查.)

### F004 overlay 硬约束 (M01)
- 状态: 当前有效
- 来源: docs/changes/subagent-panel/milestone-01/overlay-coexistence-research.md
- 内容: 打开必须 fire-and-forget (命令内 await ctx.ui.custom 冻结主循环); capturing 吞全部键盘; Esc=done(null); session 事件走 pi.on() typed handler.

### F005 pty 验证方法学
- 状态: 当前有效
- 来源: M01/M03-M06 evidence
- 内容: pty 驱动须持续 drain (缓冲满会挂起 pi 事件循环); overlay 关闭断言用状态探针 (status 命令) 而非屏幕帧 (重绘时序致误报); LLM 触发路径偶发 abort 可重试.
