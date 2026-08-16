# subagent-panel-proto (scratch 扩展)

subagent-panel 的 Inline Run Card 原型. M03 骨架 + M04 Run Card 三变体 + M05 Widget/Footer 摘要 + M06b Session Viewer overlay (第二版).
全局扩展目录 `~/.pi/agent/extensions/` 自动发现 (loader 规则 2: 子目录 index.ts).

## 文件

| 文件 | 作用 |
|---|---|
| `index.ts` | 入口: 注册假工具 `subagent_proto` + 命令 `/subagent-proto` + M04 Run Card 渲染 (renderCall/renderResult) + M05 Widget/Footer 摘要 (setWidget/setFooter) + M06b Session Viewer (toggle 打开/关闭, 数据源 batches.ts 时间线) + 顶层热载标记 |
| `replay.ts` | 回放驱动: single/parallel/storm/parallel-pending 步骤序列 + 每步完整 ProtoDetails 快照 + JSONL 日志 (默认 `/tmp/subagent-panel-proto/replay.log`, `PI_SUBAGENT_PROTO_LOG` 可覆盖) |
| `batches.ts` | M06b 批次时间线假数据: 3 个批次 (1/4/3 个子代理), 每个子代理一段假会话 (user/assistant 消息 + 工具调用带输出) |
| `types.ts` | PRD §3 数据契约 (RunNode/SlimUsage/DisplayStatus) + `ProtoRunNode.activeTool` 扩展字段 + M06b 批次/会话契约 (ProtoBatch/ProtoAgentSession/ProtoSessionMessage/ProtoSessionToolCall/ProtoTimeline) |
| `viewer.ts` | M06b Session Viewer overlay 组件 (capturing 自绘面板, 动态 tab 栏 = 子代理, 批次时间线, pi 风格 transcript, 自维护滚动, followLive) |
| `README.md` | 本文件 |

## 命令

```
/subagent-proto single              # 7 步回放, success 结局 (timeout 300s · cap 50k 显式)
/subagent-proto single failed       # 失败结局 (reviewer, stop error)
/subagent-proto single timeout      # 超时结局 (timeout 90s)
/subagent-proto parallel            # 5 步回放, 4 child, reviewer 失败
/subagent-proto storm               # 40 步 @~50ms, 轮换 recentTools/recentOutput (连绘噪音考察)
/subagent-proto parallel-pending    # 6 child, 并发槽 4, 2 个先 pending 后转 active
/subagent-proto variant a|b|c       # 切换 Run Card 变体 (notify 确认)
/subagent-proto density compact|cozy  # 密度开关 (compact 预省略 cost/cap/timeout)
/subagent-proto widget above|below|off  # M05: Widget 面板开关/位置 (高度默认 3)
/subagent-proto widget-height 1|3|5  # M05: Widget 高度变体 (1=单行汇总, 3=聚合+2child, 5=聚合+4child)
/subagent-proto footer on|off       # M05: Footer 摘要开关 (on=自定义 PRD §4.2, off=内置 footer)
/subagent-proto view               # M06b: 打开/关闭 Session Viewer overlay (capturing, toggle 语义; Esc 或 alt+v 关闭)
/subagent-proto status              # 当前 variant/density/widget/footer/viewer 状态
```

快捷键: `alt+v` 打开/关闭 Session Viewer (toggle, 同 view 命令, 非阻塞).

命令路径确定性回放 (不经过 LLM), 每步追加 JSONL `event:"replay.step"`, 结束 notify 摘要.

## 工具 (真实 onUpdate 管线)

agent 调用 `subagent_proto` `{mode:"single"|"parallel", scenario?: "success"|"failed"|"timeout"|"storm"|"parallel-pending"}`.
执行期间按真实触发点分布定时调 onUpdate, 每条 update 的 details 为完整 `ProtoDetails`
(nodes 全量快照); final result.details 为末帧快照. abort 兜底: 记 `replay.aborted` 并
以当前快照 resolve.

## Run Card 三变体 (M04)

| 变体 | 结构 | 截断行为 |
|---|---|---|
| A PRD 双行卡 | 状态行 (icon+agent+status+elapsed+model+ctx+usage+timeout/cap 仅显式) + task+recent 单行 + 操作提示 | 自然换行, 不省略 |
| B 单行致密 | 每 node 一行, recent 压缩为尾段 `last: read src/` | 严格按 PRD §4.0 省略顺序逐字段丢: cost→cap→timeout→recent→taskPreview→usage tokens, 保留 status/model/ctx/elapsed |
| C 分段展开 | 摘要行 + recentTools 最近 3 条各一行 + last output 一行; parallel child 两行 (状态行+recent 行) | recentTools/last 硬截断 |

图标: ⠿(active) ◐(parallel root) ✓(done) ✗(failed) ◌(pending); active/failed/done 用主题语义色.
密度: cozy=全字段; compact=预省略 cost/cap/timeout (B compact 再省 recent).
宽度: `Component.render(width)` 传入可用宽度, 兜底 `process.stdout.columns`.

## Widget 面板 + Footer 摘要 (M05)

- Widget: `/subagent-proto widget above|below|off` 控制 `ctx.ui.setWidget(key, string[], {placement})`.
  内容为当前回放快照的树形摘要 (复用变体 C 风格: 聚合行 + child 状态行, pending 行 ◌).
  高度变体 `/subagent-proto widget-height 1|3|5`: 1=单行汇总 `Agents 2/4 · attention 1`;
  3=聚合行 + 前 2 child; 5=聚合行 + 前 4 child. 回放进行中每步用同 key 重复 setWidget 刷新
  (命令与工具两路均刷新); 无活跃 run 时显示静态演示快照 (parallel-pending step1).
- Footer: `/subagent-proto footer on|off` 控制 `ctx.ui.setFooter(factory)`, 内容按 PRD §4.2:
  `Agents 2/4 · attention 1 · 40.3k tok · $0.26 · errors 2` (从快照推导: done/total,
  failed+timeout+budget+cancelled 计 attention, input+output+cacheWrite 计 tok, isError 计 errors).
  回放每步刷新: factory 内捕获 tui → requestRender. off → `setFooter(undefined)` 恢复内置 footer.
- 热载: 状态为模块级, `/reload` 后重置 (widget=off, height=3, footer=off); `session_start`
  钩子用新 ctx 重放 applyPanel 重建, 规避热载后旧 ctx 失效 (沿用 M04 模式).

## 手动体验

1. 启动: `pi --no-session --provider opencode-go --model opencode-go/deepseek-v4-flash --thinking off -ns -np -nc` (COLS=110 ROWS=36).
2. `/subagent-proto variant a` → 让 agent 调用工具:
   `请调用 subagent_proto 工具, 参数 mode=single, 调用完就结束, 不要调用其他工具.`
   观察: 状态行 ↑/↓/W/$ 实时更新, final 后 ✓ done.
3. `/subagent-proto variant b` → 同上, 观察单行省略 (把终端缩窄到 ~80 列看 §4.0 丢字段).
4. `/subagent-proto variant c` → 让 agent 调用 `mode=parallel, scenario=parallel-pending`,
   观察: 6 child 树形, 后排 2 个先 ◌ pending 后转 ⠿ active.
5. `/subagent-proto storm` 后用 agent 调用 `mode=single, scenario=storm`: 观察 ~2s 内
   recentTools/recentOutput 轮换导致的 16ms 节流连绘滚动噪音.
6. `/subagent-proto density compact` 对比字段省略观感.
7. `/subagent-proto widget above` → `/subagent-proto single` 回放, 观察 widget 面板每步刷新;
   `/subagent-proto widget-height 1|3|5` 切换高度; `/subagent-proto widget below` 看 belowEditor 位置.
8. `/subagent-proto footer on` → `/subagent-proto parallel-pending` 回放, 观察 footer 摘要每步刷新
   (attention/errors 变化); `/subagent-proto footer off` 恢复内置 footer.
9. `/subagent-proto render c parallel parallel-pending 1` → widget 面板直接显示该步快照 (含 ◌ pending).

## Session Viewer overlay (M06b, 第二版)

- 打开/关闭: `/subagent-proto view` 或快捷键 `alt+v`, toggle 语义 (打开时再按 = 关闭; capturing 吞键盘时命令不可达,
  alt+v 由 overlay 内拦截, Esc 亦可). capturing overlay 全屏自绘 (M01 结论: fire-and-forget 打开, 不 await). 始终全屏,
  宽度切换已删除.
- 信息组织 (用户新设计):
  - tab 栏 = 子代理: 第一个 tab 固定 Conversation (批次时间线), 其余每个 tab 是所选 (确认) 批次的 1 个子代理 (agent 名),
    tab 内容 = 该子代理会话 transcript (pi 父会话历史区风格: user 消息 bg 块 + assistant 纯文本 + 工具调用 bg 块
    + bold toolTitle + toolOutput, 自绘近似).
  - Conversation tab: 父会话历史上发起过的所有子代理批次, 从早到晚 (上早下晚). 每行 = 时间 + 模式 (single/parallel)
    + agent 列表 + 状态摘要 (如 2/4 done · 1 failed). ↑/↓ 移动选择 (▸ 光标行反显), Enter 确认 (● 已确认批次)
    → 其余 tab 切换为该批次的子代理. 默认选中最新批次 (batch-3).
  - 假数据: batches.ts 3 个批次 (batch-1 single 1 agent / batch-2 parallel 4 agents 2done+1failed+1active /
    batch-3 parallel 3 agents 2done+1active), 每个子代理一段假会话 (2-3 条消息 + 1-3 个工具调用带输出).
- 键盘流 (用户拍板): `Tab`/`Shift+Tab`/`←`/`→` 循环切 tab, 数字键 `1`-`N` 直跳,
  `↑`/`↓` Conversation tab = 选批次 / 子代理 tab = 滚动会话, `PgUp`/`PgDn` 翻页, `Enter` 仅 Conversation tab 确认选中,
  `Esc` 关闭, `alt+v` 再按关闭. `r` 回放键与 `w` 宽度键已删除.
- followLive 保留在子代理 tab (会话进行中的语义): follow 开时自动滚到底, 用户上翻解除 (footer 显 "已暂停 follow"),
  滚回底部恢复. Conversation tab 不需要 follow.

## 手动体验 (M06b)

10. `/subagent-proto view` 打开: 观察 tab 栏 = Conversation + 默认批次 (batch-3) 子代理 (worker/reviewer/linter);
    Conversation tab 显示 3 个批次时间线行 (#1-#3, 从早到晚), 默认选中最新 (#3 ▸ 反显).
11. `↑` 移到 #2 (parallel 4 agents) → `Enter`: tab 栏切换为 worker/reviewer/explorer/linter 4 个子代理 tab.
12. 数字 `2` 跳到 worker tab: 观察 pi 风格 transcript (user 消息 bg 块 / assistant 纯文本 / 工具调用 bg 块带输出);
    `↑`/`↓` 滚动, `PgUp`/`PgDn` 翻页, footer follow 注记. 切到 linter (active) 观察 running 注记.
13. `Esc` 或 `alt+v` 关闭; 再 `/subagent-proto view` 重开 (tab/选中批次状态保留).

## 已知坑 (M03/M06 延续)

- pty 驱动时须持续 drain, 否则 pi 事件循环被 pty 缓冲阻塞, 扩展 setTimeout 挂起.
- 热载后旧 ctx 失效; 本扩展状态为模块级 (variant/density/widget/footer/viewer), /reload 后重置为 a/cozy/off/off/closed.
- capturing overlay 打开时键盘全归 overlay (M01 P5 实测): 命令/消息无法输入, 只能 overlay 内按键 (alt+v 关闭) + Esc 退出;
  `/subagent-proto view` 的 toggle 关闭路径实际仅在 viewer 未聚焦时可达 (如未来非捕获形态), capturing 下用 alt+v/Esc.
- overlayOptions 只在 show 时解析一次 (showExtensionCustom resolveOptions 单次), 动态改宽靠重开 overlay (状态模块级保留).
- 真实 agent 调用偶发 abort (LLM 非确定性), 回放器已做 abort 兜底.
