# subagent-panel-proto (scratch 扩展)

subagent-panel 的 Inline Run Card 原型. M03 骨架 + M04 Run Card 三变体.
全局扩展目录 `~/.pi/agent/extensions/` 自动发现 (loader 规则 2: 子目录 index.ts).

## 文件

| 文件 | 作用 |
|---|---|
| `index.ts` | 入口: 注册假工具 `subagent_proto` + 命令 `/subagent-proto` + M04 Run Card 渲染 (renderCall/renderResult) + 顶层热载标记 |
| `replay.ts` | 回放驱动: single/parallel/storm/parallel-pending 步骤序列 + 每步完整 ProtoDetails 快照 + JSONL 日志 (默认 `/tmp/subagent-panel-proto/replay.log`, `PI_SUBAGENT_PROTO_LOG` 可覆盖) |
| `types.ts` | PRD §3 数据契约 (RunNode/SlimUsage/DisplayStatus) + `ProtoRunNode.activeTool` 扩展字段 |
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
/subagent-proto status              # 当前 variant/density
```

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

## 已知坑 (M03 延续)

- pty 驱动时须持续 drain, 否则 pi 事件循环被 pty 缓冲阻塞, 扩展 setTimeout 挂起.
- 热载后旧 ctx 失效; 本扩展状态为模块级 (variant/density), /reload 后重置为 a/cozy.
- 真实 agent 调用偶发 abort (LLM 非确定性), 回放器已做 abort 兜底.
