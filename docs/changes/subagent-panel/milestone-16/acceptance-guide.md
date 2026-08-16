# Subagent 可观测性控制面 — 人工验收清单 (ISSUE-09 / M16)

本清单覆盖你还没亲手验证的验收项 (PRD §10). 每项写清「具体怎么做」和「预期看到什么」.

## 前置准备

1. 先 `/reload` (热载最新扩展, 秒级生效).
2. 用普通 pi 会话即可 (扩展已通过 settings.json packages 加载, 你的会话里已有 `subagent` 工具).
3. 验收过程中随时敲 `/agent-sessions` (或 alt+v) 看 Session Viewer, 敲 `/agent-diagnose` 看诊断.

---

## AC 3 — 每行必填字段 (timeout/cap 仅显式, 自动 70% 不上卡)

**要做什么** — 三种委派各跑一次, 观察 Run Card 状态行:

1. 不传超时/预算:
   在 pi 输入: `请用 subagent 工具委派 worker 做一个小任务: 列出当前目录内容.`
2. 显式传超时+预算:
   在 pi 输入: `请用 subagent 工具委派 worker 做一个小任务 (列出当前目录), 参数 timeoutMs=120000, usageBudget=5000.`
3. 只传超时不传预算:
   在 pi 输入: `请用 subagent 工具委派 worker 做一个小任务 (列出当前目录), 参数 timeoutMs=120000.`

**预期**:

- 第 1 次: 卡上 status 和 model **一定出现**; ctx 运行后期有数据显示 `ctx xx.x%`, 早期未知显示 `ctx —`; 因为没显式传 timeoutMs/usageBudget, 状态行**不应出现** `timeout` 和 `cap` 两段.
- 第 2 次: 状态行出现 `timeout 120s` 和 `cap 5k` 两段.
- 第 3 次: 状态行出现 `timeout 120s`, 但**不应出现** `cap` 段 (自动 70% 预算只进 diagnostics/日志, 不上 Panel 行).

---

## AC 4 — final 卡自洽 (调用侧 model 被 final 纠正)

**要做什么**:

在 pi 输入: `请用 subagent 工具委派 worker 做一个小任务 (列出当前目录), 参数 model="opencode-go/glm-5.3".`

**预期**:

- final 卡 (终态 ✓/✗ 那帧) 显示的 model 是**实际执行的模型** (glm-5.3, 或运行时 assistant 消息回报的实际模型 id), 与 final details 一致.
- 早期 active 帧 model 可以是 `model —` (未知不伪造), final 到达后纠正为真实值; 卡上 agent/taskPreview/timeout(仅显式) 均来自 final details, 不依赖调用侧快照.

---

## AC 10 — 7 日 GC (可跳过, 单测已覆盖)

**说明**: 该条 `runLogGc` 删旧文件 + 活跃 lease 跳过记 L42 + 异常记 L43 已被单测覆盖 (test/log.test.ts TS-003). 手动验证要造 7 天前的旧文件, 较麻烦, **可跳过**.

若要手动验证:

1. 在 `~/.pi/subagent_log/` 里造一个 8 天前的文件:
   `touch -d "8 days ago" ~/.pi/subagent_log/subagent-20260808.log`
2. 重启 pi (session_start 触发 GC).

**预期**: 那个 8 天前的日志文件被删除; 今天及 7 天内的保留.

---

## AC 11 — Diagnose 缺省 (最近 24h)

**要做什么**: 直接敲 `/agent-diagnose` (无参).

**预期**: 弹出诊断 overlay, 首行类似:

```
诊断目标: 最近 24h error/fatal 相关 run
时间窗: 24h, 最低级别: warn, 扫描日志 N 条
```

- 若最近 24h 内有 error/fatal 日志: 下面列出 `发现 K 项:` + 每条 `- [级别] 标题 (类别) / 原因 / 建议`.
- 若没有: 显示 `未发现异常证据 (insufficient_evidence) — 不编造问题...`.

---

## AC 12 — Diagnose target 解析 (前缀 / 歧义 / parallel child)

**要做什么**:

1. 先拿一个 runId: 敲 `/agent-diagnose` 看 findings 里的 `[run: xxx]`, 或看 `~/.pi/subagent_log/` 日志行里的 `runId` 字段.
2. 前缀命中: `/agent-diagnose <runId前4-6位>` (如 `run-2026`).
3. 歧义: `/agent-diagnose run` (短到命中多个 run).
4. parallel child: 用最近一个 parallel 批次 id, `/agent-diagnose <batchRunId>#0` (注意用 `#` 号, 不带空格).

**预期**:

- 第 2 步: 只诊断该 run, 显示对应 findings + 该 run 的会话关联 (底部提示可开 Session Viewer).
- 第 3 步: 报 `诊断目标解析失败: Ambiguous run id prefix 'run' matched: ...` 并列出候选.
- 第 4 步: 定位到该 batch 的第 0 个 child 的 logs + session (不是整批).

---

## AC 13 — Diagnose findings 结构 (timeout 为例)

**要做什么**:

1. 先造一个 timeout 失败: 在 pi 输入 `请用 subagent 工具委派 worker 做一个会跑很久的任务 (如逐字打印 1 到 100000), 参数 timeoutMs=3000.`
2. 等它 timeout 结束 (卡显示 ✗ timeout).
3. 敲 `/agent-diagnose <那个runId>` (从 timeout 卡 content 里的 runId 拿).

**预期**: finding 至少含:

- `category` = timeout
- `suspectedCause` (超时原因)
- `recommendedFix` (可执行建议, 如增大 timeoutMs 或拆分任务)
- `confidence` (low/medium/high)
- `needsCodeChange` (true/false)

content 为简洁中文结论; 显式 timeoutMs 能区分「显式触发」vs「自动缺省 15min」.

---

## AC 14 — Diagnose writeReport 落盘

**要做什么**:

在 pi 输入 (让模型用工具调用, 带上 writeReport):
`请用 subagent 工具调用 action="diagnose", writeReport=true, id 用最近失败 run 的 id.`

(或直接给模型看: `subagent { action:"diagnose", id:"<runId>", writeReport:true }`)

**预期**:

1. `~/.pi/subagent_log/diagnose/YYYYMMDD-HHMMSS-<target>.md` 生成.
2. 报告内容脱敏: **不含**完整 task / prompt / tool result / secret, 只有 hash/preview/路径/eventId.
3. 报告同样受 7 日 GC 管理 (超龄会被清).

---

## 验收通过后

全部通过后, 我会: 关闭 M16 → 写最终交付说明 (改动清单 / 提交列表 / 已知限制), 抵达路线图终点.
