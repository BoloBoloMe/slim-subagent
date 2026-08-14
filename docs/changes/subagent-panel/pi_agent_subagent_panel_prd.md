# pi agent — Subagent Observability 产品规格（唯一版）

版本：v1.2-observability  
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
1. **Run status**：active/done/failed/timeout/budget/cancelled 的显示状态。
2. **Run details**：`onUpdate/final details` 中的 usage、model、stopReason、diagnostics。
3. **Session transcript**：`run.json + session.jsonl` 的对话/工具/原始事件证据。
4. **Operational logs**：父进程在关键路径写出的结构化日志，尤其失败/崩溃/错误点。

### 1.4 形态分级
- **A Inline Live Run Card（MUST）**：增强 `subagent` 工具 render/onUpdate 消费。
- **B Mini Footer Summary（SHOULD）**：pi 有 footer/status/header 面时显示聚合摘要。
- **C Persistent Above-Composer Panel（COULD）**：依赖 pi 持久面板 API。
- **D Session Viewer（MUST）**：Panel/Run Card 的只读详情入口。
- **E Structured Logs + Diagnose（MUST，本版新增）**：日志落盘 `~/.pi/subagent_log/`，7 日 GC，提供用户可调用诊断命令。

---

## 2. 基线事实与硬约束

规格只承诺 slim-subagent 当前可证明的能力；缺口必须显式标记为“依赖/改造点”。

1. 唯一工具入口 `subagent`，阻塞式执行；缺省执行，`action:"list"` 列名册，`action:"resume"` 恢复 single。新增诊断能力需要扩展 action/schema，见第 7 节。
2. 执行模式：single=`agent+task`；parallel=`tasks[]` 硬上限 8、硬并发 4，全部跑完汇总、不 fail-fast；resume 仅支持 single，parallel 批次不支持恢复。
3. 层级只有两级：single run，或 parallel batch root → children。子进程不递归 spawn。
4. 流式更新：single `onUpdate` 在 spawn 初始、message_end、tool_result_end、close 最终触发；parallel 只有初始 1 次 + 每个 child 完成后各 1 次聚合，不转发 per-child 流式进度。
5. 可展示数据：`usage{input,output,cacheRead,cacheWrite,cost,turns}`、`runId/sessionDir`、`model/stopReason/errorMessage/exitCode/processSignal`、`contextTokens/contextPercent/contextWindow`、`partialOutput/hint`、`usageBudget/budgetAuto`、中止时 `sessionSaved`、resume final 的 `resumed:true`。调用侧参数可在 `renderCall`/execute 入参捕获用于展示；final details 不一定回带 `timeoutMs`。
6. 状态语义：`timeout` 与 `usage_budget` 是显式 stopReason；用户取消走通用 signal 错误路径，无独立 cancelled；无 queued/starting/blocked/waiting_input 一等状态。
7. 落盘：single=`~/.pi/agent/slim-subagent/sessions/<runId>/run.json + run-0/session.jsonl`；parallel root=`run.json(mode:"parallel")`，child=`run-<idx>/session.jsonl`。sessions 已按 7 天龄期在 `session_start` GC。
8. 现有 TUI：`renderCall/renderResult` 已支持调用摘要、结果折叠、Ctrl+O 展开、usage 统计。
9. 必填展示字段可得性：model 多数可得；timeoutMs 与 usageBudget 只有“显式设置”才在 Panel 展示，自动 70% 预算不进 Panel 行，只进 Diagnostics/logs；context window 占用百分比优先 `contextPercent`，其次 `contextTokens/contextWindow` 推导，不可得显示 `—`，不伪造。
10. 日志是父进程观测：能可靠记录 slim-subagent 扩展自身路径、spawn/close/stdout/stderr 事件；不能保证记录子进程内部未暴露的思考或工具细节，除非它们出现在 session/messages/stdout/stderr。

---

## 3. 观测数据契约

```ts
type SlimUsage = { input:number; output:number; cacheRead:number; cacheWrite:number; cost:number; turns:number };

type DisplayStatus =
  | "active" | "done" | "failed" | "timeout" | "budget" | "cancelled" | "attention";

type RunNode = {
  id: string;                    // single/resume: runId；parallel child: `${batchRunId}#${index}`
  kind: "single" | "parallel-root" | "parallel-child" | "resume";
  parentId?: string;
  agent: string;
  taskPreview: string;           // 截断；不展示完整敏感 task
  status: DisplayStatus;
  isError?: boolean;
  startedAtMs?: number;
  endedAtMs?: number;
  usage?: SlimUsage;
  model?: string;                 // 优先 final details.model / run.json；active 早期可用调用侧 effective model；未知 `—`
  modelSource?: "details" | "run.json" | "call-params" | "message" | "unknown";
  timeoutMsExplicit?: number;     // 仅显式设置才填；Panel 不显示默认 15min
  usageBudgetExplicit?: number;   // 仅显式设置才填；自动 70% 不进 Panel 行
  contextPercent?: number | null; // 优先 details.contextPercent；否则 contextTokens/contextWindow 推导；未知 `—`
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
1. active/final 当前工具调用：`onUpdate/final result.details`。
2. 调用侧展示快照：`renderCall`/execute 入参里的 `model/timeoutMs/usageBudget/tasks[i].*` 仅用于展示字段；冲突时 final details 胜。
3. finished/archived：single 读 `run.json + run-0/session.jsonl`；parallel root 读批次 `run.json`，child 读 `run-<idx>/session.jsonl`。
4. operational logs：`~/.pi/subagent_log/` 用于错误证据与诊断，不作为运行态唯一来源。
5. raw fallback：无法识别 JSONL/log 行进 raw，不丢弃。

状态映射规则不变：MUST 不使用 queued/starting/blocked/waiting_input；parallel 未完成 child 显示 active；attention=`failed+timeout+budget+cancelled`；resume 加 `resumed` 徽章。

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
| 上下文窗口占用 ctx | 有数据必显 `ctx 18%`；未知 `ctx —`；不伪造 | 优先 `contextPercent`；其次 `contextTokens/contextWindow` |

紧凑行字段优先级：status icon → agent → status 文案 → model → ctx% → elapsed → usage tokens → timeout(仅显式) → cap(仅显式) → cost → taskPreview/recent。窄行省略顺序：cost → cap → timeout → recent → taskPreview → usage tokens（保留 status/model/ctx/elapsed）。

### 4.1 Inline Live Run Card（MUST）
执行中 single：
```text
⠿ explorer · active 00:37 · model openai/x · ctx 18% · ↑12.1k ↓3.4k W0.8k $0.0412 · timeout 300s · cap 50k
   task 搜索当前目录结构 · recent: read src/ · grep "subagent" · last: "找到 3 个候选入口…"
   [Open session] [Copy runId] [Diagnose]
```
timeout/cap 未显式设置则整段省略；model/ctx 未知显示 `—`/`ctx —`。

执行中 parallel：
```text
◐ parallel · 2/4 done · active 01:12 · total ↑31.2k ↓9.1k $0.2210
   ✓ worker   · done 00:44    · model a/fast · ctx 12% · ↑8.1k ↓2.0k · timeout 60s        [Open session]
   ✗ reviewer · failed 00:51  · model b/pro  · ctx 31% · stop error · cap 80k             [Open session] [Copy resume cmd] [Diagnose]
   ⠿ worker   · active        · model a/fast · ctx —   · timeout 300s                     [Open session]
   ⠿ explorer · active        · model —      · ctx —                                        [Open session]
```

### 4.2 Mini Footer Summary（SHOULD）
```text
Agents 2/4 · attention 1 · 40.3k tok · $0.26 · errors 2
```
无 active 且无未确认 attention 时隐藏；点击聚焦最近 attention 行；`errors` 来自今日 error/fatal 日志计数，可与 attention 不一致（例如校验错误未产生 run）。

### 4.3 Persistent Panel（COULD）
transcript 下、composer 上；树深度硬限制 2；提供 column 配置以显隐 timeout/cap/ctx/cost。

---

## 5. Session Viewer 规格（单次现场面）

入口 MUST：每个 Run Node 行有 `Open session`；parallel root 开批次总览，child 开 `run-<index>/session.jsonl`；失败/timeout/budget 行把 `Open session`、`Copy resume command`、`Diagnose` 作为主操作；Viewer 打开后 `Esc` 可返回。

切换 MUST：Viewer 与 Panel 共用 `selectedRunId`；active 默认 `followLive=true`，用户上翻后 false；archived 单独分区 `Archived (not running)`；active 与 archived 同 runId 冲突时 active 优先。

布局：
```text
Subagent session · explorer · done · run-20260813-173645-681cce
model openai/x · ctx 18% · usage ↑12.1k ↓3.4k R0 W0.8k $0.0412 · timeout 300s(显式) · cap 50k(显式)
budget effective 89.6k(auto 70%) · sessionDir ~/.pi/agent/slim-subagent/sessions/run-.../
logs ~/.pi/subagent_log/subagent-20260813.log (event L27 close)   [Copy runId] [Copy resume cmd] [Diagnose] [Open folder]

[Conversation] [Tools 3] [Events/Raw 41] [Logs] [Diagnostics]
```
Tabs MUST：
- Conversation/Tools/Events-Raw：同前版规则；有什么渲染什么；skill 只在有 `resolve_skill` 或同类证据时出现。
- Logs：展示与该 runId/nodeId 关联的 operational logs，默认 info+，可切 level；error/fatal 置顶；不默认展开敏感 data。
- Diagnostics：final `SingleDetails` 或 run.json 元数据；区分显式 timeout/cap 与实际生效 budget/timeout；显示关联 log event ids。

事实边界：不保证每个 run 都有完整 tool_execution 事件流；parallel child 完成前完整 transcript 不可用；resume 复用同一 sessionFile，当前无 boundary marker，只显示 `resumed` 徽章，不伪造分段。

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
  taskHash?: string; taskPreview?: string; // 不记录完整 task
  error?: { code?: string; message: string; stack?: string }; // message 脱敏；stack 仅 debug+
  data?: Record<string, unknown>; // 已脱敏、有界
};
```

脱敏 MUST：不记录完整 task、system prompt、session 内容、tool result 全文、secret；只记录 hash/preview/计数/路径。error.message 先过 secret redaction。

### 6.3 关键日志点（32 个）
| ID | level | event | 位置/触发 |
|---|---|---|---|
| L01 | info | tool.execute.start | execute 入口，记录 mode/params 摘要 |
| L02 | warn | tool.execute.validate_failed | 条件必填/互斥/未知 agent |
| L03 | info | agents.list.ok | action list 返回数量 |
| L04 | error | agents.discover.failed | discoverAgents 异常（当前多为静默，新增 warn/error 视影响） |
| L05 | info | run.id.created | makeRunId/sessionDir 计算完成 |
| L06 | info | run.json.write.ok | single/parallel run.json 原子写成功 |
| L07 | error | run.json.write.failed | run.json 写失败 |
| L08 | debug | pi.invocation.resolved | getPiInvocation 命中级别/命令（不记完整敏感 argv） |
| L09 | info | single.spawn.start | runSingleAgent 即将 spawn，含 agent/model/effective budget 摘要 |
| L10 | fatal | single.spawn.failed | spawn error/ENOENT |
| L11 | info | single.update.emit | onUpdate 初始/关键节点采样（高频 progress 不逐条 info） |
| L12 | warn | stdout.line.non_json | 非 JSON stdout 行进 tail 计数，超阈值升 warn |
| L13 | error | protocol.output_limit | failProtocol 触发 |
| L14 | debug | aggregate.projection | turn_end/agent_end 投影成功/失败 |
| L15 | info | message_end.usage | assistant usage 累加采样（每 N 次或 final） |
| L16 | warn | usage_budget.crossed | used >= usageBudget 触顶前一刻 |
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
- 若 pi 支持 slash：`/agents diagnose [target] [since]` 映射到同一能力。

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
- 节点键：`toolCallId + details.mode + runId/index`；onUpdate 增量投影同键覆盖；final 后冻结 status/usage。
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
- 文件路径默认 basename，hover/展开 full path；`Open folder` 仅本地受支持环境显示。
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
2. parallel 初始显示 total；child 完成 done/total 增加；失败 child 不影响保序；未完成 child 只显示 active。
3. 每行必填字段：status/model 必显（model 未知 `—`）；ctx 有数据必显，未知 `ctx —`；timeout/cap 仅显式设置出现；自动 70% budget 不出现在 Panel 行。
4. active 早期 model/ctx 可从调用侧快照或 `—` 起步，final details 到达后纠正；调用侧快照不得覆盖 final 执行结果。

Session Viewer MUST：
5. `Open session` header 显示 agent/runId/status/usage/model/sessionDir/log 关联；缺失显示 `—`。
6. Conversation/Tools/Events-Raw 有什么渲染什么；无 tool/skill 记录显示 empty state；skill 只在有证据时出现。
7. parallel root 可切换 child；child 完成前明确显示完整 transcript 不可用；archived 与 active 分区分离；GC/缺文件 empty state 不崩溃。

Logging MUST：
8. 正常 single/parallel/resume 至少产生 L01/L05/L09 或 L28/L38、L25/L27/L31/L39 对应路径日志；失败路径必须产生对应 error/fatal 点（如 validate L02、spawn L10、timeout L19、budget L17、protocol L13、resume L35/L37）。
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
- 不承诺 parallel per-child 实时进度或实时完整会话，除非先改 slim-subagent。
- 不把 `action:"list"` 名册面板化。
- 不从磁盘 session/log 目录恢复“正在运行”状态。
- 不做 parallel resume。
- 不引入 waiting_input/blocked/queued 作为一等状态，直到运行时有明确事件。
- 不保证 skill 独立分类；只展示可检测调用迹象。
- Diagnose 不自动修复、不重启 run、不改代码；只给证据与建议。
- 日志不是 metrics/tracing 后端；不做长期留存、不做跨机器聚合。

---

## 12. 实现顺序（交给后续 agent）

1. 先加日志骨架：`~/.pi/subagent_log/` JSONL writer、level/redaction/taskHash、7 日 GC 挂到现有 `session_start`，覆盖 L01-L10/L25-L27/L40-L44 最小闭环。
2. 补失败/崩溃点：timeout/budget/protocol/abort/drain/signal/empty output（L11-L26）、parallel（L28-L32）、resume（L33-L39）。
3. 写 `projectSlimDetailsToRunNodes`：投影 details + 捕获调用侧展示字段（model override、显式 timeoutMs、显式 usageBudget、tasks[i] 覆盖），标 modelSource，关联 logCursor。
4. 增强 `renderResult`：partial live card、final 结果卡；执行第 4.0 必填字段与省略规则；错误行挂 `Diagnose`。
5. 加 Session Viewer：Inline 工具卡内 Session tab 先行；tolerant JSONL reader；Logs tab 关联 runId/nodeId；Persistent Panel 后再做 master-detail。
6. 加 `action:"diagnose"`：扩展 schema/action；实现 target 解析、log/session 证据收集、启发式 findings、可选 report 写入；`/agents diagnose` 若 pi 支持再映射。
7. 若 pi 有 footer/status 面加 mini summary；若 pi 有持久 panel API 再启动形态 C；否则交付 A+D+E(+B) 并写明限制。
