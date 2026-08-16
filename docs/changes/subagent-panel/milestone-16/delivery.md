# 交付说明: subagent 可观测性控制面

- 日期: 2026-08-16
- 范围: 基线 commit `492d9f3` → HEAD, 施工目标 `slim-subagent/` (pi 扩展)
- 权威需求: PRD v2.0 确认版 `../pi_agent_subagent_panel_prd.md`
- 验收: ISSUE-09 用户验收通过 (2026-08-16 用户声明验收完毕; AC 10 按验收清单跳过, 单测覆盖), M16 关闭, 路线图抵达终点

## 改动清单

**新增模块** (`slim-subagent/`):

| 文件 | 行数 | 职责 |
|---|---|---|
| `log.ts` | +253 | 结构化日志: append-only JSONL 按日文件, trace..fatal 级别 + PI_SUBAGENT_LOG_LEVEL, 脱敏 (redactSecret) + taskHash, 7 日 GC (runLogGc) |
| `projection.ts` | +391 | 投影层: details+调用侧快照 → RunNode; 状态映射 (pending 仅 parallel-child/attention 聚合/resumed 徽章), modelSource 优先级, endedAtMs 三级来源, archived 投影 (mtime 近似) |
| `card.ts` | +414 | Inline Run Card: 变体 C 分段展开, spinner 90ms invalidate, §4.0 窄行省略顺序, CH 段, 密度开关, 超宽行截断兜底 |
| `viewer.ts` | +1123 | Session Viewer: capturing 全屏 overlay, Timeline 批次时间线 + 子代理 tab (视觉对齐 pi transcript), followLive 实时读盘, 键盘流, tolerant JSONL reader, 20 批回补 |
| `diagnose.ts` | +935 | Diagnose: target 解析四形态 (前缀/尾段/batch#idx/today, 歧义列候选), 日志收集 (since/levelMin/limit), 聚类 + 启发式 findings 全类别, 证据默认脱敏, writeReport 落盘 |

**修改**:

- `index.ts` (+479/-): 48 日志点插桩, renderResult 换血 (projection → card), schema 加 `action:"diagnose"`, 命令面 `/agent-sessions` `/agent-diagnose` + alt+v, store 回补, renderCall 返回空组件 (卡只由 renderResult 驱动)
- `single.ts` (+372/-): 日志插桩, assembleSingleResult 六字段补丁 (mode/agent/taskPreview/timeoutMsExplicit/startedAtMs/endedAtMs), ctx 子代理口径 (contextTokens/resolveModelWindow), run.json settle 补丁写, live 帧 runId/contextPercent 注入
- `resume.ts` (+81/-): 日志插桩 + details 补丁
- `agents.ts` / `agents/*.md`: 内置 agent frontmatter 模型 `opencode-go/deepseek-v4-flash`, thinking high/high/max
- `test/`: 新增 7 个测试文件 (log/projection/card/viewer/diagnose/issue02-logpoints/parallel-progress), 既有测试对齐

**总量**: 28 文件, +5716/-304 行; 测试 138 过 0 红 (`node --test test/*.test.ts`).

## 提交列表 (基线后, 新→旧)

代码 (feat/fix):
- `b90adbc` fix: cap 展示 + viewer 状态 live 更新 + ctx% 运行中展示
- `5d0bad7` fix: ctx% 圆整 1 位小数 + timeout.fired 补 timeoutMsExplicit
- `896d2a1` fix: viewer live 刷新 (spinner 帧 + 会话实时读盘 + 周期重绘)
- `958e709` fix: viewer 建批 (live 帧注入 runId) + parallel child sessionFile 路径
- `f7edbc7` feat: 命令面接线 (ISSUE-08)
- `f1f53c6` fix: renderCall 预执行帧去掉
- `fda3c70` fix: card.ts 超宽行截断防 pi-tui uncaughtException
- `34ea8ae` fix: 测试对齐模型名 (a4f7506 遗留)
- `b095d8f` feat: Diagnose (ISSUE-07)
- `5505f9d` feat: Session Viewer (ISSUE-06)
- `a59f630` feat: Inline Run Card (ISSUE-05)
- `df7e9d8` feat: 投影层 (ISSUE-04)
- `399fcd1` feat: parallel per-child 进度透传 (ISSUE-03)
- `a7d98ca` feat: 日志全量挂载 + final details 补丁 + ctx 子口径 (ISSUE-02)
- `71850e0` feat: 日志骨架 (ISSUE-01)

文档 (doc): 各 MILESTONE 关闭记录, DECISIONS 账本 (M02/M07/M08), EXECUTION spec + ISSUE-01..09, acceptance-guide, 交接文档 — 见 `git log --oneline 492d9f3..HEAD`.

## 验收记录 (PRD §10)

- AC 1/2 (Panel 卡 single/parallel+pending): 通过
- AC 3 (必填字段, timeout/cap 仅显式): 通过 (验收期修复 cap 推导 + ctx 运行中显示后复测)
- AC 4 (final 卡自洽, model 纠正): 通过
- AC 5/6/7 (Viewer Timeline/tab/工具调用链): 通过
- AC 8/9 (日志): 通过
- AC 10 (7 日 GC): 跳过 (验收清单许可, test/log.test.ts TS-003 覆盖)
- AC 11-14 (Diagnose 缺省/target 解析/findings 结构/writeReport): 通过

验收期共修 11 处 (截断/runId 注入/viewer 刷新/cap/ctx 等, 见交接文档 `docs/handoff/2026-08-16-subagent-panel-acceptance.md`), 均已提交且回归不破坏.

## 已知限制

1. **Diagnose 为规则启发式**, 只识别 PRD §7.2 预设失败模式, recommendedFix 为模板; 不做开放式归因/优化点挖掘. 用户已立项「LLM 自由诊断」→ `docs/changes/subagent-llm-diagnose/` (PRD 草稿).
2. **无一等 queued/starting/blocked/waiting_input 状态** (PRD §3/§11); pending 仅 parallel child 可推导.
3. **renderCall 返回空组件**, 卡只由 renderResult 驱动 (用户拍板; pi 会叠加渲染 renderCall+renderResult, 静态预执行帧误导).
4. **archived run 缺 endedAtMs 时** 用 session.jsonl mtime 近似, Viewer/Diagnose 标注 `mtime-approx` (PRD §8).
5. **日志只证明父进程观测**; 子进程崩溃未写 session 时 Panel failed/unknown + Viewer empty state (PRD §8).
6. **扩展加载方式**: 经 `~/.pi/agent/settings.json` 的 `packages` 加载, 非 `extensions/` 目录; 开发迭代用 `/reload` 热载.
7. **语义层"未达到目标"不做自动判断** (需 LLM 评审, 属另一个产品; 与限制 1 的新 PRD 部分相关).
8. PRD §11 全清单 (无限树可视化/parallel resume/skill 一等分类/日志做 metrics 等) 维持不做.
