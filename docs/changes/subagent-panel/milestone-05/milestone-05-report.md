# M05 报告: Widget 面板 + Footer 摘要原型 (HITL 评审)

- 日期: 2026-08-15
- 里程碑: MILESTONE-05 (prototype, HITL)
- 载体: `~/.pi/agent/extensions/subagent-panel-proto/` (M04 基础上加 widget/footer); 源码归档 `milestone-05/prototype/`

## 1. 设计问题与答案

**问题**: B/C 形态 (setWidget 持久面板 + setFooter 摘要) 的手感与升级决策材料.

| 决策点 | 结论 | 备注 |
|---|---|---|
| widget 位置 | **belowEditor** | 用户实测 above/below 后选定 |
| widget 高度预算 | **5 行** (聚合行 + 前 4 child) | 1 行太瞎, 5 行内不压迫 composer |
| footer 摘要 | **要与内建 footer 共存**, 不接受替换 | setFooter factory 可拿 footerData, 自定义两行 footer (内建信息行 + 摘要行) 技术可行 → M07 候选方案 |

## 2. API 事实 (types.d.ts, worker 探明)

- `setWidget(key, string[]|factory, {placement})` L97-100; 默认 aboveEditor; 同 key 重调=更新, 换 placement=移动; **string[] 上限 MAX_WIDGET_LINES=10**; factory 重载只在设置时调一次, 不适合每步刷新 → 每步刷新用 string[] 版
- `setFooter(factory|undefined)` L107 — factory 收 `(tui, theme, footerData)`, 可实现共存式 footer; `undefined` 恢复内建; 每步刷新靠 factory 捕获 `tui.requestRender()`
- `setStatus(key, text)` L80 为另一候选通道
- session_start reason: startup|reload|new|resume|fork (L419) — reload 后重建

## 3. 产物与证据

- 原型源码归档: `milestone-05/prototype/` (index.ts/replay.ts/types.ts/README.md)
- 证据: `milestone-05/evidence/` — smoke.py 一轮 6/6 PASS (加载/widget 命令/widget-height/footer/7 步回放/status)
- 备份: `/tmp/proto-backup-m05`

## 4. 对下游的影响 (M07 材料)

- B/C 升级候选形态: widget belowEditor 5 行 + 共存式两行 footer; 成本 = 每步 setWidget 刷新 + footer factory 维护.
- 遗留限制: string[] 版 setWidget 无宽度感知 (process.stdout.columns 兜底截断); footer 空闲态显示占位行而非 PRD §4.2 的隐藏语义 (实现时修正).
- 与其他扩展 widget 堆叠共存: 用户未报异常 (无 plan-mode 类扩展同开).
