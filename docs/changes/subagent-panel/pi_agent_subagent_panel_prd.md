# pi agent — Subagent Observability 产品规格（唯一版）

版本：v2.0-确认版（2026-08-15 M07 定稿：形态裁决 A+D+E / Run Card 变体 C / spinner 动效 / CH 字段 / Session Viewer 批次时间线重定义 / footer 与 widget 面板出局 / 命令面 /agent-sessions + /agent-diagnose / 无手动 copy·resume 入口）  
前身：v1.3-observability（M02 契约修订：ctx 子代理口径 / final details 补字段 / taskPreview 规则 / endedAtMs 记录 / L16 阈值预警 + L13/L14 定界 / R5 节点键 / pending 状态 / resume startedAtMs 口径）  
基线仓库：`BoloBoloMe/slim-subagent`  
基线 commit：`492d9f35fa7319da50028dbc5bb9088ee8e4e6bb`（2026-08-13）  
中心主题：**提高子代理调度的可观测性**。所有功能都围绕一个目标：让每次委派“看得见状态、追得回现场、查得到错误、给得出修复建议”。  
效力：本文档取代此前所有草稿；后续会话只引用本文件。

---

## 1. North Star 与范围

### 1.1 一句话
把 slim-subagent 从“一个阻塞式委派工具”升级为“可观测的委派控制面”：Panel 给实时状态，Session Viewer 给单次现场，Logging 给可追踪证据，Diagnose 给错误聚类与修复建议。

### 1.2 观测对象
只有 slim-subagent 实际产生的运行：single、parallel batch root → `tasks[index]` children、single resume。树深度硬限制为 2；子进程以 `--no-skills --no-extensions` 启动，不递归 spawn，因此不做无限树。

### 1.3 四类观测信号
1. **Run status**：pending/active/done/failed/timeout/budget/cancelled 的显示状态。
2. **Run details**：`onUpdate/final details` 中的 usage、model、stopReason、diagnostics。
3. **Session transcript**：`run.json + session.jsonl` 的对话/工具/原始事件证据。
4. **Operational logs**：父进程在关键路径写出的结构化日志，尤其失败/崩溃/错误点。

### 1.4 形态分级
- **A Inline Live Run Card（MUST）**：增强 `subagent` 工具 render/onUpdate 消费；唯一常驻实时观测面 (M07 裁决, 结构见 §4.1)。
- **D Session Viewer（MUST）**：Run Card 的只读详情入口；批次时间线 + 子代理会话 tab (M07 重定义, 见 §5)。
- **E Structured Logs + Diagnose（MUST）**：日志落盘 `~/.pi/subagent_log/`，7 日 GC，提供用户可调用诊断命令。
- ~~B Mini Footer Summary / C Persistent Panel~~：M07 原型评审后出局，进 §11 不做清单。

---

## 2. 基线事实与硬约束

规格只承诺 slim-subagent 当前可证明的能力；缺口必须显式标记为“依赖/改造点”。

1. 唯一工具入口 `subagent`，阻塞式执行；缺省执行，`action:"list"` 列名册，`action:"resume"` 恢复 single。新增诊断能力需要扩展 action/schema，见第 7 节。
2. 执行模式：single=`agent+task`；parallel=`tasks[]` 硬上限 8、硬并发 4，全部跑完汇总、不 fail-fast；resume 仅支持 single，parallel 批次不支持恢复。
3. 层级只有两级：single run，或 parallel batch root → children。子进程不递归 spawn。
4. 流式更新：single `onUpdate` 在 spawn 初始、message_end、tool_result_end、close 最终触发；parallel 只有初始 1 次 + 每个 child 完成后各 1 次聚合，不转发 per-child 流式进度。
5. 可展示数据：`usage{input,output,cacheRead,cacheWrite,cost,turns}`、`runId/sessionDir`、`model/stopReason/errorMessage/exitCode/processSignal`、`contextTokens/contextPercent/contextWindow`、`partialOutput/hint`、`usageBudget/budgetAuto`、中止时 `sessionSaved`、resume final 的 `resumed:true`。调用侧参数可在 `renderCall`/execute 入参捕获用于展示；final details 不一定回带 `timeoutMs`。改造点 (v1.3)：final details 缺 `mode/agent/taskPreview/timeoutMsExplicit/startedAtMs/endedAtMs`，且 `contextPercent` 现为父会话口径（语义错位）— 目标契约见 §3/§8，补丁集中于 `assembleSingleResult` 单点。
6. 状态语义：`timeout` 与 `usage_budget` 是显式 stopReason；用户取消走通用 signal 错误路径，无独立 cancelled；无 queued/starting/blocked/waiting_input 一等状态。
7. 落盘：single=`~/.pi/agent/slim-subagent/sessions/<runId>/run.json + run-0/session.jsonl`；parallel root=`run.json(mode:"parallel")`，child=`run-<idx>/session.jsonl`。sessions 已按 7 天龄期在 `session_start` GC。
8. 现有 TUI：`renderCall/renderResult` 已支持调用摘要、结果折叠、Ctrl+O 展开、usage 统计。
9. 必填展示字段可得性：model 多数可得；timeoutMs 与 usageBudget 只有“显式设置”才在 Panel 展示，自动 70% 预算不进 Panel 行，只进 Diagnostics/logs；context window 占用百分比为子代理口径 (v1.3 修订)：`contextTokens / resolveModelWindow(子模型)` 推导，窗口来源优先运行时 `details.model`、退化调用侧 effective model，皆不可得显示 `—`，不伪造；父会话占用不进 details；resume hint 的阈值比较同用子口径。
10. 日志是父进程观测：能可靠记录 slim-subagent 扩展自身路径、spawn/close/stdout/stderr 事件；不能保证记录子进程内部未暴露的思考或工具细节，除非它们出现在 session/messages/stdout/stderr。

---

## 3. 观测数据契约

```ts
type SlimUsage = { input:number; output:number; cacheRead:number; cacheWrite:number; cost:number; turns:number };

type DisplayStatus =
  | "pending"                   // 仅 parallel child：批次开始预建行，未进 worker
  | "active" | "done" | "failed" | "timeout" | "budget" | "cancelled" | "attention";

type RunNode = {
  id: string;                    // single/resume: runId；parallel child: `${batchRunId}#${index}`
  kind: "single" | "parallel-root" | "parallel-child" | "resume";
  parentId?: string;
  agent: string;
  taskPreview: string;           // ≤120 字符，单行化（换行折叠为空格），过 secret redaction；不展示完整敏感 task
  status: DisplayStatus;
  isError?: boolean;
  startedAtMs?: number;
  endedAtMs?: number;
  endedAtMsSource?: "details" | "run.json" | "mtime-approx"; // 缺失时用 session.jsonl mtime 近似并标注
  usage?: SlimUsage;
  model?: string;                 // 优先 final details.model / run.json；active 早期可用调用侧 effective model；未知 `—`
  modelSource?: "details" | "run.json" | "call-params" | "message" | "unknown";
  timeoutMsExplicit?: number;     // 仅显式设置才填；Panel 不显示默认 15min
  usageBudgetExplicit?: number;   // 仅显式设置才填；自动 70% 不进 Panel 行
  contextPercent?: number | null; // 子代理口径：contextTokens/resolveModelWindow(子模型)；窗口优先运行时 details.model，退化调用侧 effective model；未知 `—`
  stopReason?: string;
  errorMessage?: string;          // 脱敏/截断
  runId?: string;
  sessionDir?: string;
  logCursor?: { file?: string; lastEventId?: string }; // 关联 operational logs
  progress?: {
    recentTools?: { tool:string; argsPreview:string; endMs:number }[];
    recentOutput?: string[];
    done?: number; total?: number;
  };
  diagnostics?: {
    contextTokens?: number; contextPercent?: number | null; contextWindow?: number;
    usageBudget?: number; budgetAuto?: boolean; partialOutput?: string; hint?: string; sessionSaved?: boolean;
  };
};
```

投影来源优先级：
1. active/final 当前工具调用：`onUpdate/final result.details`。v1.3 起 final details 携带 `mode/agent/taskPreview/timeoutMsExplicit/startedAtMs/endedAtMs`，`contextPercent` 为子代理口径 — `assembleSingleResult` 单点补丁，single/resume/parallel-child 三路径继承。
2. 调用侧展示快照：`renderCall`/execute 入参里的 `model/timeoutMs/usageBudget/tasks[i].*` 仅用于展示字段；冲突时 final details 胜。
3. finished/archived：single 读 `run.json + run-0/session.jsonl`；parallel root 读批次 `run.json`，child 读 `run-<idx>/session.jsonl`。
4. operational logs：`~/.pi/subagent_log/` 用于错误证据与诊断，不作为运行态唯一来源。
5. raw fallback：无法识别 JSONL/log 行进 raw，不丢弃。

状态映射规则（v1.3 修订）：MUST 不使用 queued/starting/blocked/waiting_input；`pending` 仅 parallel child — 批次开始按 tasks[] 全集预建行，未进 worker（未达 L30 scheduled）的 child 显示 pending，L30 后转 active；single 无 pending；parallel 进行中 child 显示 active；attention=`failed+timeout+budget+cancelled`；resume 加 `resumed` 徽章。失败原因展示限运行层可观测信号（stopReason/errorMessage/exitCode/logs）；语义层"未达到目标"不做自动判断。

---

## 4. Panel 展示规格（实时观测面）

### 4.0 每行必填信息字段
每个 Run Node 行必须能展示以下字段；空间不足按截断规则省略低优先级项，但 status/model 不可省：

| 字段 | 展示规则 | 数据源/可得性 |
|---|---|---|
| 运行状态 status | 必显；icon + 文案 | 第 3 节映射 |
| 使用模型 model | 必显；未知 `—`；active 早期允许调用侧 effective model，final 后纠正 | final `details.model`、single `run.json.model`、调用参数/frontmatter（仅展示） |
| 超时设置 timeout | 仅显式设置才展示，如 `timeout 300s`；未设置不展示，不显示默认 15min | 调用参数 `timeoutMs` / `tasks[i].timeoutMs` |
| token 消耗上限 budget | 仅显式 `usageBudget` 才展示，如 `cap 50k`；未设置不展示；自动 70% 只进 Diagnostics/logs | 调用参数 `usageBudget` / `tasks[i].usageBudget`；final `details.usageBudget+budgetAuto` 校验 |
| 上下文窗口占用 ctx | 有数据必显 `ctx 18%`；未知 `ctx —`；不伪造 | 子代理口径：`contextTokens / resolveModelWindow(子模型)`；窗口优先运行时 `details.model`，退化调用侧 effective model |
| 缓存命中率 CH | 有 cacheRead 数据必显 `CH 87%`；无数据不显；仅 cozy 密度显示 | 派生自 `usage.cacheRead / (cacheRead + input)`，无需新数据字段 (M07) |

紧凑行字段优先级：status icon → agent → status 文案 → model → ctx% → elapsed → usage tokens → CH → timeout(仅显式) → cap(仅显式) → cost → taskPreview/recent。窄行省略顺序：cost → CH → cap → timeout → recent → taskPreview → usage tokens（保留 status/model/ctx/elapsed）。

密度开关 (M07 定)：默认 **cozy** (全字段)；compact 预省 cost/CH/cap/timeout。

### 4.1 Inline Live Run Card（MUST）
结构 = M04 原型**变体 C 分段展开** (M07 定稿)：状态行 + recentTools 逐条行 + output 预览行。

执行中 single：
```text
⠿ explorer · active 00:37 · model openai/x · ctx 18% · ↑12.1k ↓3.4k W0.8k CH87% · $0.0412 · timeout 300s · cap 50k
   → read src/index.ts
   → grep "subagent"
   last: "找到 3 个候选入口…"
   alt+v 会话 · /agent-diagnose 诊断
```
active 图标为**动画 spinner** (⠋⠙⠹… 90ms 帧轮转, renderResult 第 4 参 `context.invalidate()` 驱动重绘, 与数据更新解耦)；终态静态 (✓/✗)。recentTools 最多 3 条 (expanded 可到 10 条)。timeout/cap 未显式设置则整段省略；model/ctx 未知显示 `—`/`ctx —`。

执行中 parallel (child 双行树形)：
```text
◐ parallel · 2/4 done · active 01:12 · total ↑31.2k ↓9.1k CH72% · $0.2210
   ✓ worker   · done 00:44 · model a/fast · ctx 12% · ↑8.1k ↓2.0k · timeout 60s
     → pnpm lint
   ✗ reviewer · failed 00:51 · model b/pro · ctx 31% · stop error · cap 80k
     last: "审查发现 2 处…"
   ⠿ worker   · active · model a/fast · ctx — · timeout 300s
     → read src/
   ◌ explorer · pending 等待并发槽 · task 收集测试用例
```
pending 行只显示 agent + taskPreview + `pending 等待并发槽`（无 model/ctx/elapsed/usage，不伪造）；L30 scheduled 后转 active 行。

操作呈现 (M07 定)：不提供卡上按钮/复制类操作；提示文案固定 `alt+v 会话 · /agent-diagnose 诊断`。**无手动 copy runId / copy resume cmd 入口** — resume 是父会话自主决策。

---

## 5. Session Viewer 规格（单次现场面）— M07 重定义
capturing 全屏 overlay (自绘, pi-tui 无 ScrollView/Tab 组件)；fire-and-forget 打开 (命令/快捷键 handler 内禁止 await, M01 硬约束)。

**信息组织 (v2 定稿)**：tab 栏 = 所选批次的子代理；首 tab 为 `Timeline`。

- **Timeline tab**：父会话历史上所有子代理**批次**的时间线 (一次工具调用 = 一个批次, single 调用也算)，按创建时间上早下晚。行 = 时间 + 模式 (single/parallel) + agent 列表 + 状态摘要 (如 `2/4 done · 1 failed`)。↑/↓ 选批次，Enter 确认 → 其余 tab 切换为该批次子代理。默认选中最新批次。
- **子代理 tab**：该子代理的会话内容，**视觉风格对齐 pi 父会话 transcript** (user/assistant/工具调用块)；active 子代理 followLive=true，用户上翻解除并提示，回到底恢复。底部状态区一行：ctx% / budget (区分显式 cap 与自动 70%) / hint / 关联 log event ids (即 v1 Diagnostics 内容并入此处)。

**键盘流 (M07 定)**：Tab/Shift+Tab 循环 + ←/→ 切 tab；数字键直跳；↑/↓ 选择 (Timeline) 或滚动 (子代理 tab)；PgUp/PgDn 翻页；Enter 仅 Timeline 确认；Esc 关闭。**toggle 语义**：overlay 打开时再执行 `/agent-sessions` 或 `alt+v` = 关闭。

**入口**：命令 `/agent-sessions` + 快捷键 `alt+v` (Windows 上 alt+v 被粘贴占用, 退回命令)；Run Card 提示文案 `alt+v 会话 · /agent-diagnose 诊断`。失败/timeout/budget 子代理的主操作 = Timeline 选中后进入其 tab + `d` 键诊断。**无 copy runId / copy resume cmd 按钮**。

**viewer 内快捷键**：`d` = diagnose 当前 tab 子代理 (映射 §7 diagnose, 带 runId 上下文)。

**宽度**：始终全屏, 不提供宽度调整。不做 overlay 内回放/演示功能。

**数据源 (M07 定)**：内存 store 为主 (onUpdate 喂入)；启动时从磁盘 run 记录 (run.json + run-*/session.jsonl) 回补最近 20 批历史；不从磁盘反推运行中状态。

事实边界：不保证每个 run 都有完整 tool_execution 事件流；parallel child 完成前完整 transcript 不可用 (M17 升级后 per-child 进度可透传)；resume 复用同一 sessionFile，无 boundary marker，只显示 `resumed` 徽章，不伪造分段。子代理会话渲染采用近似 pi transcript 的自绘方案，不追求逐像素一致。

---

## 6. Structured Logging（新增 MUST）

### 6.1 输出与保留
- 目录：`~/.pi/subagent_log/`。
- 文件：append-only JSONL，按日分文件 `subagent-YYYYMMDD.log`；诊断报告可选写 `diagnose/YYYYMMDD-HHMMSS-<target>.md`。
- 保留：与 sessions 相同，7 日 GC；同一触发点 `session_start` 执行；按文件日期/mtime 判断超龄，若文件仍被活跃 run/lease 引用则跳过并记 warn。
- 写入：父进程同步小写关键 error/fatal，info/debug 可批量 flush；崩溃路径尽量 best-effort，不阻塞子代理终止管线。

### 6.2 日志级别与 schema
级别：`trace < debug < info < warn < error < fatal`。默认运行记录 info+；`PI_SUBAGENT_LOG_LEVEL` 可降 debug/trace；trace 可含更敏感数据，默认关闭且仍需脱敏。

```ts
type SubagentLog = {
  ts: string;                 // ISO
  level: "trace"|"debug"|"info"|"warn"|"error"|"fatal";
  event: string;              // 稳定事件名，如 "single.spawn.ok"
  eventId: string;            // uuid
  pid: number;
  extVersion?: string;
  mode?: "single"|"parallel"|"resume"|"list"|"diagnose";
  toolCallId?: string;
  runId?: string; batchRunId?: string; childIndex?: number; nodeId?: string;
  agent?: string; model?: string; status?: DisplayStatus;
  timeoutMsExplicit?: number; usageBudgetExplicit?: number; contextPercent?: number | null;
  usage?: Partial<SlimUsage>;
  taskHash?: string; taskPreview?: string; // 不记录完整 task；preview 与 §3 同规则（≤120 字符/单行化/redaction）
  error?: { code?: string; message: string; stack?: string }; // message 脱敏；stack 仅 debug+
  data?: Record<string, unknown>; // 已脱敏、有界
};
```

脱敏 MUST：不记录完整 task、system prompt、session 内容、tool result 全文、secret；只记录 hash/preview/计数/路径。error.message 先过 secret redaction。

### 6.3 关键日志点（48 个）
| ID | level | event | 位置/触发 |
|---|---|---|---|
| L01 | info | tool.execute.start | execute 入口，记录 mode/params 摘要 |
| L02 | warn | tool.execute.validate_failed | 条件必填/互斥/未知 agent |
| L03 | info | agents.list.ok | action list 返回数量 |
| L04 | error | agents.discover.failed | discoverAgents 异常（当前多为静默，新增 warn/error 视影响） |
| L05 | info | run.id.created | makeRunId/sessionDir 计算完成 |
| L06 | info | run.json.write.ok | single/parallel run.json 原子写成功 |
| L07 | error | run.json.write.failed | run.json 写失败；settle 补丁写失败降级 warn 复用本事件（§8）|
| L08 | debug | pi.invocation.resolved | getPiInvocation 命中级别/命令（不记完整敏感 argv） |
| L09 | info | single.spawn.start | runSingleAgent 即将 spawn，含 agent/model/effective budget 摘要 |
| L10 | fatal | single.spawn.failed | spawn error/ENOENT |
| L11 | info | single.update.emit | onUpdate 初始/关键节点采样（高频 progress 不逐条 info） |
| L12 | warn | stdout.line.non_json | 非 JSON stdout 行进 tail 计数，超阈值升 warn |
| L13 | error | protocol.output_limit | failProtocol 实际调用（投影失败或不可投影后）|
| L14 | debug | aggregate.projection | 超限行投影尝试完成（成功/失败都记，含 projectedBytes）；同一超限行正常序列 = L14(failed) → L13，以 runId+toolCallId 关联 |
| L15 | info | message_end.usage | assistant usage 累加采样（每 N 次或 final） |
| L16 | warn | usage_budget.warn_80pct | used ≥ 80% × budget 且未触顶；每 run 单发，挂 usage 累加比对点；显式/自动 budget 均预警，data 标 budgetAuto |
| L17 | error | usage_budget.abort | budgetExceeded 成立并启动 abort sequence |
| L18 | warn | timeout.armed | timeout 定时器设置（debug 可；显式 timeout 时 info） |
| L19 | error | timeout.fired | timedOut 成立并启动 abort sequence |
| L20 | warn | signal.abort_requested | 父 AbortSignal 触发 |
| L21 | warn | process.signal.sent | SIGINT/SIGTERM/SIGKILL 发送结果 |
| L22 | info | final_drain.start | terminal stop/agent_settled 后进入 drain |
| L23 | warn | final_drain.forced | drain 超时强杀 |
| L24 | info | process.exit | exit 事件 code/signal |
| L25 | info | process.close.settled | close settle 完成，含 exitCode/stopReason/usage 摘要 |
| L26 | error | result.empty_output | exit 0 但无输出判定 |
| L27 | info | single.result.final | assembleSingleResult 完成，含 isError/diagnostics 摘要 |
| L28 | info | parallel.batch.start | batchRunId/tasks 数量/并发上限 |
| L29 | warn | parallel.batch.too_many | >8 拒绝 |
| L30 | info | parallel.child.scheduled | child 进入 worker（区分 scheduled，但不声称 queued 一等状态） |
| L31 | info | parallel.child.completed | child 完成，含 isError/stopReason/usage 摘要 |
| L32 | error | parallel.child.unknown_agent | per-child 未知 agent 独立失败 |

续表（resume/GC/render/diagnose 同样关键）：
| ID | level | event | 位置/触发 |
|---|---|---|---|
| L33 | info | resume.find.start | findRunForResume 输入 id 摘要 |
| L34 | warn | resume.find.ambiguous | 前缀歧义 |
| L35 | error | resume.find.not_found | Run not found / session 校验失败 |
| L36 | info | resume.lease.acquired | acquireSessionLease 成功 |
| L37 | warn | resume.lease.conflict | already running / stale retry 后失败 |
| L38 | info | resume.spawn.start | 恢复 spawn（沿用原 runId） |
| L39 | info | resume.result.final | resumed:true 结果摘要 |
| L40 | info | gc.sessions.start / gc.logs.start | session_start 触发两类 GC |
| L41 | info | gc.delete.ok | 删除超龄 session/log 文件计数 |
| L42 | warn | gc.skip.active_lease | 有活跃 lease 跳过 |
| L43 | error | gc.failed | 删除/扫描异常 |
| L44 | warn | render.update.failed | onUpdate/renderCall/renderResult 抛错回退 |
| L45 | info | diagnose.start | 诊断命令开始，含 target/since/limit |
| L46 | info | diagnose.evidence.collected | 读到 log 条数/session 文件计数 |
| L47 | warn | diagnose.insufficient_evidence | 无 error 或无 session 可关联 |
| L48 | error | diagnose.failed | 诊断读取/分析异常 |

默认采样：L11/L15 为采样或状态变化才 info，避免高频刷盘；error/fatal 不采样。

---

## 7. Diagnose 命令（新增 MUST）

### 7.1 调用面
用户可调用：
- 主命令：`subagent { action:"diagnose", id?: "<runId前缀|batchRunId#index|today>", since?: "24h|7d|all", levelMin?: "warn|error", limit?: number, writeReport?: boolean }`
- 若 pi 支持 slash：`/agent-diagnose [target] [since]` 映射到同一能力 (M07 定名)；Session Viewer 内 `d` 键 = 带当前 tab runId 上下文的等价调用。

说明：当前仓库 schema 固定 9 参数且无 `diagnose` action；本功能是 MUST 产品需求，但实现上标记为 **slim-subagent schema/action 扩展**。不得用 `list/resume` 伪装诊断。

### 7.2 行为
Diagnose 是只读分析器，默认不修改运行、不重启子代理、不自动修复：
1. 解析 target：缺省=最近 24h 的 error/fatal + 相关 run；`id` 支持 runId 前缀/随机尾段/`batchRunId#index`；歧义报错并列出候选。
2. 读取 `~/.pi/subagent_log/`：按 since/levelMin 过滤；error/fatal 必选，warn 作为上下文；按 runId/nodeId/toolCallId 聚类。
3. 关联 sessions：用 runId/sessionDir 找 `run.json/session.jsonl`；parallel child 用 `batchRunId + childIndex` 找 `run-<idx>/session.jsonl`；只读取证据所需片段，默认脱敏。
4. 启发式分析至少覆盖：
   - spawn failed/ENOENT/pi invocation 寻址失败
   - unknown agent / validate failed
   - timeout / usage_budget 触顶（区分显式 cap 与自动 70%）
   - protocol_output_limit / aggregate projection 失败
   - empty output / model error / stderr tail / signal termination
   - resume not_found/ambiguous/lease conflict/parallel resume 不支持
   - parallel child 失败分布、>8 拒绝、并发槽迹象
   - GC 删除异常/日志丢失迹象
5. 输出给调用者：content 为简洁中文结论（Top findings + 建议下一步）；details 含结构化 findings、evidence refs、reportPath（若 writeReport）。
6. `writeReport:true` 时写 `~/.pi/subagent_log/diagnose/...md`；报告同样 7 日 GC。

### 7.3 Finding schema
```ts
type DiagnoseFinding = {
  id: string;
  severity: "fatal"|"error"|"warn"|"info";
  title: string;
  category: "spawn"|"validate"|"timeout"|"budget"|"protocol"|"model"|"resume"|"parallel"|"gc"|"render"|"unknown";
  runIds: string[]; nodeIds?: string[];
  evidence: { logEventIds: string[]; logFile?: string; sessionFiles?: string[]; lineHints?: string[] };
  suspectedCause: string;
  recommendedFix: string;      // 面向用户/后续 agent 的可执行建议
  confidence: "low"|"medium"|"high";
  needsCodeChange: boolean;    // true=建议改 slim-subagent/pi；false=用法/配置/重试
};
```

隐私 MUST：Diagnose 输出不含完整 task/prompt/tool result/secret；evidence 用 eventId/path/line hint；需要更多上下文时提示用户打开 Session Viewer 并二次确认 reveal。

---

## 8. 一致性、恢复与降级

MUST：
- 节点键：`toolCallId + 顶层 details.mode + (single/resume: runId; parallel child: index)`；final details 必须携带 `mode` 且与 live 一致（v1.3 改造点，防 final 帧键漂移新建节点）；parallel child 自带 `details.mode="single"` 不参与键；onUpdate 增量投影同键覆盖；final 后冻结 status/usage。
- run.json settle 补丁写（v1.3）：settle 完成后二次原子写 run.json 补 `endedAtMs/finalStatus/usage` 摘要；写失败降级 warn（L07），不阻塞终止管线；run.json 缺字段时 archived 读用 session.jsonl mtime 近似，Viewer/Diagnostics 标注 `mtime-approx` 来源，Panel 行不加 `约`。
- resume 的 `startedAtMs` = 本次 resume spawn 时刻（details 带 `resumed:true` 标识），elapsed 显示本次运行时长；原 run 启动时刻不可复原，不伪造。
- live `results[0]` 是仓库 live 引用；UI/log 读取必须拷贝快照。
- 刷新/重建会话从 toolResult details 重建最后一帧；不从磁盘 sessions/logs 反推“正在运行”。
- logs 只能证明“父进程观测到什么”；子进程崩溃且未写 session 时，Panel 显示 failed/unknown，Session Viewer empty state，Diagnose 用 spawn/close/stderr logs 给证据。
- GC 后或文件缺失：打开 archived run/诊断显示可理解 empty state，不崩溃。
- 日志写入失败不得让子代理执行失败；降级为 warn（若能写）或静默计数到下一次 diagnose 的 `insufficient_evidence`。

依赖/改造点（非 MUST  unless stated）：
- `action:"diagnose"` 与日志点需要 slim-subagent 代码扩展（本版新增 MUST）。
- parallel child 实时会话/进度、queued/running 区分、独立 cancelled、resume boundary marker、skill 一等分类、持久 panel：仍为非 MUST 依赖项。

---

## 9. 安全、隐私与性能

安全 MUST：
- Panel/Viewer/Logs/Diagnose 默认遮蔽 secret；task/prompt/tool args/tool result/raw JSONL/log data 都可能敏感，展开 raw 前二次确认。
- 文件路径默认 basename，hover/展开 full path。
- 遥测不采集 session 内容、tool args、raw events、log data；只记录 open/switch/tab/diagnose 计数与错误码。
- trace 级别默认关闭；即使开启也不记录完整 prompt/task/session。

性能 MUST：
- recentTools ≤10、recentOutput ≤50 沿用仓库上限；日志高频点采样，error/fatal 不采样。
- onUpdate 按 animation frame/100–300ms 合并；终态立即应用。
- session/log 解析异步化；按 `(path,size,mtimeMs)` 缓存；初始渲染目标 ≤200ms：先 header + 最近 100 条 + counts。
- Diagnose 默认扫描上限：`since=24h`、`levelMin=warn`、`limit=2000 log events`；超限提示收窄范围，不阻塞 composer。

---

## 10. 验收标准

Panel MUST：
1. single 首个 onUpdate 显示 active 摘要；运行中可见 usage/recent 活动；final 状态映射正确。
2. parallel 初始显示 total；child 完成 done/total 增加；失败 child 不影响保序；批次开始预建全部 child 行，未进 worker 的显示 pending（无 model/ctx/elapsed），进 worker 转 active。
3. 每行必填字段：status/model 必显（model 未知 `—`）；ctx 有数据必显，未知 `ctx —`；timeout/cap 仅显式设置出现；自动 70% budget 不出现在 Panel 行。
4. active 早期 model/ctx 可从调用侧快照或 `—` 起步，final details 到达后纠正；调用侧快照不得覆盖 final 执行结果；final 卡自洽 — agent/taskPreview/timeout（仅显式）均来自 final details，不依赖调用侧快照。

Session Viewer MUST：
5. Timeline tab 按创建时间上早下晚列出全部批次，行含时间/模式/agent 列表/状态摘要；默认选中最新批次；↑/↓ 选择，Enter 确认后其余 tab 切换为该批次子代理。
6. 子代理 tab 渲染该子代理会话 (user/assistant/工具调用块, 视觉对齐 pi transcript)；有什么渲染什么，无记录显示 empty state；底部状态区含 ctx%/budget (区分显式与自动)/hint；active 子代理 followLive，上翻解除回底恢复。
7. 键盘流：Tab/Shift+Tab/←/→/数字键切 tab，Esc 关闭；toggle 语义 (重复 `/agent-sessions` 或 alt+v 关闭)；始终全屏。child 完成前明确显示完整 transcript 不可用；GC/缺文件 empty state 不崩溃。

Logging MUST：
8. 正常 single/parallel/resume 至少产生 L01/L05/L09 或 L28/L38、L25/L27/L31/L39 对应路径日志；失败路径必须产生对应 error/fatal 点（如 validate L02、spawn L10、timeout L19、budget L17、protocol L13、resume L35/L37）；budget 达 80% 产生 L16 warn（每 run 至多 1 条，显式/自动 budget 均计）；超限行投影失败时先 L14 后 L13。
9. 日志写入 `~/.pi/subagent_log/subagent-YYYYMMDD.log`，JSONL 每行可解析，含 level/event/ts/runId 或 toolCallId（可得时）；不含完整 task/prompt/session/secret。
10. `session_start` 同一触发点执行 sessions 与 logs 7 日 GC；活跃 lease 引用跳过并记 L42；GC 异常记 L43。

Diagnose MUST：
11. `action:"diagnose"` 缺省读取最近 24h warn+，error/fatal 必选；无证据返回 `insufficient_evidence`，不编造问题。
12. 指定 runId 前缀能关联对应 logs 与 session；歧义返回候选；parallel child 用 `batchRunId#index` 正确定位。
13. 对 timeout/budget/protocol/spawn/resume conflict 至少给出 category、suspectedCause、recommendedFix、confidence、needsCodeChange；content 为简洁结论，details 含 evidence refs。
14. `writeReport:true` 写 `~/.pi/subagent_log/diagnose/...md` 并同样 7 日 GC；报告不含 secret/完整 prompt/task/tool result。

---

## 11. 明确不做（本基线）

- 不做无限子代理树/递归 spawn 可视化。
- **不做 Mini Footer Summary 与 Persistent Widget Panel**（M07 原型评审裁决：widget 面板实测被否决, footer 摘要用户无诉求；实时观测面只有 Inline Run Card）。
- **不提供手动 copy runId / copy resume command 入口**（M07：用户无 copy 场景；resume 是父会话自主决策, 非用户手动操作）。
- 不做 Session Viewer 宽度调整（始终全屏）与 overlay 内回放/演示功能。
- 不承诺 parallel per-child 实时进度或实时完整会话，除非先改 slim-subagent。
- 不把 `action:"list"` 名册面板化。
- 不从磁盘 session/log 目录恢复“正在运行”状态。
- 不做 parallel resume。
- 不引入 waiting_input/blocked/queued 作为一等状态，直到运行时有明确事件（parallel child 的 `pending` 除外：tasks[] 全集减 scheduled 集合可推导，见 §3）。
- 不自动判断语义层任务是否达到目标；失败原因展示限运行层可观测信号。
- 不保证 skill 独立分类；只展示可检测调用迹象。
- Diagnose 不自动修复、不重启 run、不改代码；只给证据与建议。
- 日志不是 metrics/tracing 后端；不做长期留存、不做跨机器聚合。

---

## 12. 实现顺序（交给后续 agent）

1. 先加日志骨架：`~/.pi/subagent_log/` JSONL writer、level/redaction/taskHash、7 日 GC 挂到现有 `session_start`，覆盖 L01-L10/L25-L27/L40-L44 最小闭环。
2. 补失败/崩溃点：timeout/budget（含 L16 80% 预警）/protocol/abort/drain/signal/empty output（L11-L26）、parallel（L28-L32）、resume（L33-L39）。
3. 写 `projectSlimDetailsToRunNodes`：投影 details + 捕获调用侧展示字段（model override、显式 timeoutMs、显式 usageBudget、tasks[i] 覆盖），标 modelSource，关联 logCursor；`assembleSingleResult` 单点补丁：final details 补 `mode/agent/taskPreview/timeoutMsExplicit/startedAtMs/endedAtMs`、ctx 改子代理口径（删除父会话 getContextUsage 透传）、run.json settle 补丁写。
4. 增强 `renderResult`：partial live card、final 结果卡；执行第 4.0 必填字段与省略规则；错误行挂 `Diagnose`。
5. 加 Session Viewer：Timeline 批次时间线 + 子代理会话 tab (视觉对齐 pi transcript)；内存 store + 磁盘回补 20 批；tolerant JSONL reader；键盘流/toggle/followLive 按 §5。
6. 加 `action:"diagnose"`：扩展 schema/action；实现 target 解析、log/session 证据收集、启发式 findings、可选 report 写入；映射 `/agent-diagnose`。
7. 无 footer/widget 形态 (M07 裁决)；交付 A+D+E。
