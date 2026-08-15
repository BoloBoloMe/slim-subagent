# M06 报告: Session Viewer 原型 (两版迭代, 用户定稿)

- 日期: 2026-08-15
- 里程碑: MILESTONE-06 (prototype, HITL)
- 载体: `~/.pi/agent/extensions/subagent-panel-proto/` (viewer.ts 为 M06 主体); 源码归档 `milestone-06/prototype/`

## 1. 设计演进

**v1 (被否决)**: 固定内容 tab (Conversation/Tools/Events-Raw/Logs/Diagnostics). 用户: "不是我想要的".

**v2 (定稿, 用户原话设计)**:
- **tab 栏 = 所选批次的子代理** (一个工具调用批次 = 一组 tab), tab 内容 = 该子代理会话, 视觉对齐 pi 父会话 transcript ("极其相近甚至一样").
- **首 tab Conversation = 批次时间线**: 父会话历史全部批次, 按创建时间上早下晚; 行 = 时间 + 模式 + agent 列表 + 状态摘要 (2/4 done · 1 failed); ↑/↓ 选批次, Enter 确认 → 其余 tab 换成该批次子代理; 默认最新批次.

## 2. 用户拍板的交互决策

| 决策点 | 结论 |
|---|---|
| tab 切换 | Tab/Shift+Tab 循环 + ←/→ 保留 + 数字键直跳 |
| 滚动 | 自绘 scroll offset 手感尚可 (↑/↓ 步进, PgUp/PgDn 翻页) — 本站最大未知落地 |
| overlay 内回放 | **不做** (用户明确删除) |
| 宽度 | **始终全屏**, 不提供宽度调整 |
| 关闭 | Esc + **toggle** (view 命令/alt+v 再按即关) |
| followLive | 保留在子代理 tab (会话进行中语义), Conversation 不需要 |

## 3. 实现要点与 API 事实

- capturing overlay 全屏 (width:"100%", margin top/bottom 1), fire-and-forget 打开 (M01 硬约束); Esc/alt+v=done(null); toggle 靠模块级 viewerOpen + viewerDone 句柄
- 键盘: matchesKey(data,"escape"/"alt+v"/"tab"/...) + kitty release 过滤
- 滚动: 自维护 offset, render 宽度与 handleInput 共用 (组件记最近 render 宽度)
- 冒烟两次误报教训: overlay 关闭后主界面重绘行数少, 缓冲尾部仍含旧 overlay 帧 — 断言改用 `/subagent-proto status` 的 viewer=closed 探针 (顺带验证 capturing 已释放)

## 4. 产物与证据

- 原型源码归档: `milestone-06/prototype/` (含 viewer.ts)
- 证据: `milestone-06/evidence/` — smoke.py 13/13 PASS (tab 栏/批次时间线/Enter 换批/transcript 显示/Esc/toggle/重开), frames 记录

## 5. 对下游的影响 (M07/M13 输入)

- PRD §5 需按 v2 重写: tab 语义从"内容分类"改为"批次子代理", Conversation 改批次时间线; 原 Tools/Events-Raw/Logs/Diagnostics tab 的归属待 M07 盘 (并入子代理 tab? 砍?)
- 真实实现数据源: 批次历史不能只靠内存 — 需从 slim-subagent run 记录 (run.json + run-*/session.jsonl) 读历史批次; 子代理会话渲染 = 解析 session.jsonl 自绘 transcript
- 用户授权: 效果受 pi 能力限制时可取近似方案, 满足核心需求 (批次时间线 + 类 transcript 会话查看) 即可
