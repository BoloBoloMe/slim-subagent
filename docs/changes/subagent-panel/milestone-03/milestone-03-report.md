# M03: subagent-panel 原型骨架 (scratch 扩展 + 假数据回放器)

- 日期: 2026-08-15
- 里程碑: M03 (为 M04 工具卡 / M05 面板 / M06 Session Viewer 铺路)
- 目标达成: 骨架可跑, 回放时序对照真实分布, 热载实测通过, 文档落盘. 无真实面板 UI (范围外).
- 实测: pty 驱动真实 pi TUI, 25/25 断言通过 (复现方法见 evidence/harness.py, 沿用 M01 §1.1/§1.3 pty 方法)

---

## 1. 扩展文件清单与路径

载体: `~/.pi/agent/extensions/subagent-panel-proto/` (pi 自动发现全局扩展目录, loader.js:534-538 规则 2: 子目录 index.ts)

| 文件 | 作用 |
|---|---|
| `index.ts` | 入口: 注册假工具 `subagent_proto` + 命令 `/subagent-proto` + 极简 renderResult 卡 + 顶层热载标记 |
| `replay.ts` | 回放驱动: single/parallel 步骤序列 + 每步完整 RunNode 快照生成 + JSONL 日志 (默认 `/tmp/subagent-panel-proto/replay.log`, `PI_SUBAGENT_PROTO_LOG` 可覆盖) |
| `types.ts` | PRD §3 数据契约 (RunNode/SlimUsage/DisplayStatus), M04+ 可直接 import 复用 |
| `README.md` | 扩展内用法说明 |

未改 slim-subagent 仓库, 未改 pi 包 (范围外).

## 2. 用法

### 2.1 命令触发 (确定性, 不经过 LLM; 热载验证/手动检查用)

```
/subagent-proto single            # 7 步回放, 成功结局
/subagent-proto single failed     # 失败结局
/subagent-proto single timeout    # 超时结局
/subagent-proto parallel          # 5 步回放, 4 child, 其中 reviewer 失败
```

每步追加一条 JSONL 到 replay.log (`event:"replay.step"`), 结束 `ctx.ui.notify` 摘要.

### 2.2 工具触发 (真实 onUpdate 管线)

agent 调用 `subagent_proto` (参数 `{mode:"single"|"parallel"}`, single 可选 `scenario`).
执行期间按真实触发点分布定时调 `onUpdate`, 每条 update 的 `details` 为完整
`ProtoDetails` (含 `nodes: RunNode[]` 全量快照, 面板 store 语义: 同 key 覆盖);
最终 result 的 `details` 为末帧快照. 证据帧: `evidence/tool-card-frame.txt`
(真实 TUI 中 `[proto] mode=single scenario=success nodes=1 | explorer:done`).

### 2.3 切换 single/parallel

工具参数或命令第一参数选 `single`/`parallel`. 两种模式共用一套回放驱动 (`createReplay`),
snapshot 生成互不干扰; 并行批 root + 4 child, 未完成 child 只显示 active, 失败 child
(reviewer) 不破坏 done/total 保序 (PRD §10-2).

## 3. 回放时序与真实分布的对照

### 3.1 single (7 步, 总 ~3.8s) — 对照 `slim-subagent/single.ts:811-904`

| 回放 step | atMs | 触发点 | 真实位置 (single.ts) |
|---|---|---|---|
| 0 | 0 | initial (spawn 后立即 1 次) | :862 `emitUpdate()` (初始 "(running...)") |
| 1 | 700 | message_end (assistant, usage 累加, turns=1) | :902-968 (emitUpdate 于 :968) |
| 2 | 1400 | tool_execution_start | :883-886 |
| 3 | 1900 | tool_execution_end (recentTools push) | :887-894 |
| 4 | 2500 | tool_result_end (防御分支) | :970-974 |
| 5 | 3100 | message_end (turns=2, recentOutput push) | :961-968 |
| 6 | 3800 | close 最终 (agent_settled → drain → settle) | :975+ (agent_settled→startFinalDrain) |

实测实际间隔 (A 阶段命令回放): `[699, 700, 500, 600, 599, 702]` ms, 与计划
`[700, 700, 500, 600, 600, 700]` 一致 (tol 450ms), 总时长 3800ms.
真实工具路径 (C 阶段): `[700, 699, 501, 600, 600, 699]`, 总 3799ms.

### 3.2 parallel (5 步, 总 ~4s) — 对照 `slim-subagent/index.ts:265-285`

| 回放 step | atMs | 触发点 | 真实位置 (index.ts) |
|---|---|---|---|
| 0 | 0 | 初始 1 次 (全部 running) | :283 `emitParallelUpdate()` (全部 exitCode -1 占位) |
| 1 | 1500 | child#0 worker 完成 → 聚合 1 次 | :265-285 (completedFlags 计数, done/total) |
| 2 | 2300 | child#1 reviewer 失败 → 聚合 1 次 | 同上 |
| 3 | 3200 | child#2 explorer 完成 → 聚合 1 次 | 同上 |
| 4 | 4000 | child#3 linter 完成 → 聚合 1 次 + root done | 同上 |

实测实际间隔: `[1498, 800, 900, 800]`, 与计划 `[1500, 800, 900, 800]` 一致, 总 3998ms.
不做 per-child 流式镜像 (与 index.ts:265-285 最小版一致, 超出范围不承诺).

### 3.3 假数据形状 (PRD §3 契约)

- 严格 RunNode 契约; `ProtoRunNode.activeTool` 为原型扩展字段 (M04 工具卡用, 可忽略).
- 展示规则预演: model/ctx 早期来自 call-params 或 `—`, final 后纠正 (modelSource 标记);
  `timeoutMsExplicit`/`usageBudgetExplicit` 仅显式设置才填 (single timeout 有 timeout 90s,
  parallel 的 explorer 有 timeout 300s、reviewer 有 cap 80k); 自动 70% budget 只进
  `diagnostics` (PRD §4.0/§2-9).

## 4. 热载验证证据 (pty 驱动真实 pi TUI)

操作序列 (evidence/harness.py, 25/25 PASS):
1. 启动: `pi --no-session --provider opencode-go --model opencode-go/deepseek-v4-flash --thinking off -ns -np -nc` (不开 -ne/-e, 走全局扩展发现), 断言 `ext.loaded` marker=proto-v1 (1 条).
2. Phase A/B: `/subagent-proto single` 与 `/subagent-proto parallel` 命令回放, 7 步/5 步时序全对.
3. Phase C: 真实 agent 调用 `subagent_proto` (mode=single), 7 步 onUpdate 走真实管线到达, 间隔对; 帧内可见 renderResult 卡.
4. Phase D 热载: 改 `replay.ts` 的 `MARKER` `proto-v1`→`proto-v2` → 发送 `/reload` → 轮询 replay.log 出现 `{"event":"ext.loaded","marker":"proto-v2"}`.
   - 实测耗时: **902ms** (首轮 602ms), 均 <1s, 秒级热载达标.
   - 机制 (源码): `/reload` → `handleReloadCommand` → `session.reload()` → `resourceLoader.reload()` 调 `clearExtensionCache()` (resource-loader.js:222), 扩展经 jiti `moduleCache:false` 重新 import (loader.js:325-332), 模块顶层副作用重跑 → 新 marker 落盘.
5. reload 后 `/subagent-proto single` 仍可用, 7 步全部带 `proto-v2` marker (新代码生效).

耗时量级: 命令执行到 `notify` 显示 <2s; `/reload` 生效 0.6-0.9s.

## 5. 已知坑与注意事项 (供 M04-M06)

- pty 驱动时若不持续 drain 终端输出, pi 事件循环会被 pty 缓冲阻塞, 扩展 setTimeout 全部挂起 (实测 Phase C 首轮 150s 后才补发 6 步); harness 轮询期间必须持续 drain (M01 同款注意点).
- 真实 agent 调用可能偶发 abort (LLM 非确定性, 本实验 1/3 次), 回放器已做 abort 兜底: 记 `replay.aborted` + 以当前快照 resolve, 不崩.
- 热载后旧 `pi`/ctx 失效 (runner.js:350 invalidate 提示), M04+ 若持有状态需在 `session_start(reason:"reload")` 重建.

## 6. 文档与证据路径

- 本报告: `docs/changes/subagent-panel/milestone-03/milestone-03-report.md`
- 证据: `docs/changes/subagent-panel/milestone-03/evidence/`
  - `replay.log` — 25/25 断言回合完整 JSONL (ext.loaded + 全部 replay.step)
  - `test.log` — 各阶段时间线 + 热载耗时 902ms + 汇总 25/25
  - `harness.py` — 可复现 pty 验证脚本
  - `tool-card-frame.txt` — 真实 TUI 中 renderResult 卡帧 (`explorer:done`)
