# M04 报告: Inline Run Card 原型 (A/B/C 三变体 HITL 评审)

- 日期: 2026-08-15
- 里程碑: MILESTONE-04 (prototype, HITL)
- 载体: scratch 扩展 `~/.pi/agent/extensions/subagent-panel-proto/` (M03 骨架重建 + M04 渲染层); **源码已归档仓库 `milestone-04/prototype/`** (扩展目录曾两次神秘消失, 防再丢)

## 1. 设计问题与答案

**问题**: A 形态 Inline Run Card 应长什么样 — renderCall/renderResult 三态 (single active / single final / parallel 聚合), 密度与截断规则的手感.

| 决策点 | 结论 | 依据 |
|---|---|---|
| 变体选型 | **C 分段展开** (摘要行 + recentTools 逐条行 + output 预览行; parallel child 双行树形) | 用户 HITL 实测三变体后选定 |
| 默认密度 | **cozy** (cost/timeout/cap 常驻) | 用户选定 |
| 截断/省略顺序 | **维持 PRD §4.0** (cost→cap→timeout→recent→task→usage, 死保 status/model/ctx/elapsed) | 用户确认 |
| CH 缓存命中率 | **新增展示段**: `CH = cacheRead/(cacheRead+input)`, 无数据不显; 优先级排 tokens 后 cost 前; cozy 才显 | 用户提出, 纯展示派生 (契约已有 cacheRead), 待 M07 落 PRD |
| F1 迷雾 | **升级** — 用户不接受 parallel 只有聚合进度的"瞎感" → 转化 MILESTONE-17 | 用户拍板 |

## 2. 评审过程暴露的设计发现

- **A/B 在 parallel 形态结构雷同** (都是聚合行 + child 单行) — 选 C 后自然消解, parallel 定为 child 双行树形.
- **渲染瑕疵 (M12 实现注意)**: 运行中首帧 (`active · running` 占位) 与 final 帧在 transcript 并存, 理想是 final 替换/收敛; 原型未处理.
- **命令注入坑**: 全角字符 (中文输入法) 导致命令解析失败 — 已加 NFKC 归一化加固; M12 实现 registerCommand 参数解析时应继承.
- LLM 触发路径 (真实 onUpdate 管线) 与确定性渲染路径 (`/subagent-proto render`, registerMessageRenderer + sendMessage customType) 双路均验证可用; 后者适合无 LLM 的静态帧评估.

## 3. 产物与证据

- 原型源码归档: `milestone-04/prototype/` (index.ts / replay.ts / types.ts / README.md); 存活副本在 `~/.pi/agent/extensions/subagent-panel-proto/` 供 M05/M06 复用
- 体验清单: `milestone-04/EXPERIENCE.md`
- 证据: `milestone-04/evidence/` — smoke.py (3/3 PASS: 加载/7 步回放/变体切换), harness.py (worker 深度验证未竟, 部分截帧 frame-variant-*.txt), replay.log/test.log
- 扩展目录消失悬案: 已挂 watchdog 监控 `~/.pi/agent/watch/` (recover 自 worker session.jsonl 重放, 24/24 edit 精确命中, 冒烟复验通过)

## 4. 对下游的影响

- M07 (deliberate 定稿): 输入 = 本报告 5 项决策; CH 字段增补需落 PRD (§4.0 字段表 + 省略顺序).
- MILESTONE-17 (新, F1 转化): parallel per-child 进度透传, 阻塞于 M10, 阻塞 M11.
- M12 (Run Card 实现): 按变体 C 结构实现; 处理 final 帧替换; 命令解析 NFKC 加固.
