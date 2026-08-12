# M3 移植规格 02: JSONL 事件流解析与结果回收 (usage 统计 + token 上限中止)

- 来源: pi-subagents-main v0.44.0 (只读), 官方示例 examples/extensions/subagent/index.ts (1015 行), pi 0.82.1 `docs/json.md` 与 `@earendil-works/pi-ai` Usage 类型定义
- 用途: M4 施工图纸, 每个考察点给 {旧码位置, 行为描述, 移植规格}; 移植规格可直接照做, 含常量与逻辑步骤
- 保留集对齐: MILESTONE-01 DECISIONS.md D001/D002/D003/D006/D007/D011; 本规格负责 结果回收 (JSONL 解析/最终输出/结果结构), usage 统计, usage budget (token 上限) 中止
- 交叉引用: 子进程生命周期/终止协议/错误路径/非 JSON 行 → 规格 01 (01-process-lifecycle.md), 本规格只写 processLine 视角与结果构造视角, 不重复 01 已定内容
- 前置依赖: 规格 01 (spawn/close/终止), 规格 05 (05-context-window.md: usage 实测字段全集, contextTokens 数据源)

---

## 考察点 1: processLine 完整逻辑 (事件类型全集与逐类处理)

### 旧码位置
- execution.ts:831-970 (`processLine` 全函数), 事件类型规范: pi `docs/json.md` (AgentSessionEvent = AgentEvent + queue_update/compaction/retry 系列)
- execution.ts:844-852 (agent_settled + 生命周期投影), :855-877 (watchdog 分支, 删除项), :874-898 (tool_execution_start), :899-913 (tool_execution_end), :914-957 (message_end), :958-969 (tool_result_end)

### 行为描述
- 入口约定: 每行一个 JSON 事件 (stdout 按 `\n` 分块, 见规格 01 考察点 5); 空行直接 return
- 事件类型全集与处理 (pi 0.82.1 实际会发的 + 旧码防御性处理的):

| 事件类型 | 旧码处理 |
|---|---|
| `session` (首行头) | 忽略 (不解析字段) |
| `agent_start` / `turn_start` / `message_start` / `message_update` | 忽略 |
| `message_end` | 核心累积 (考察点 2): push message; assistant 才做 usage/turns/model/stopReason/errorMessage/terminal 判定 |
| `turn_end` | 忽略 (pi 在此事件带 toolResults 数组, 旧码不用 — toolResult 消息已由 message_end 到达) |
| `agent_end` | 仅经 projectChildLifecycle 处理: `willRetry === true` → cancel-drain (旧码 fallback 重试用, slim 删, 见删除项 6); 其余忽略 |
| `agent_settled` | `agentSettledReceived = true` → startFinalDrain (规格 01 考察点 2 兜底) |
| `tool_execution_start` | 进度累积 (考察点 1b) |
| `tool_execution_end` | 进度累积: recentTools.push + 清 currentTool |
| `tool_execution_update` | 忽略 |
| `tool_result_end` | 防御分支 (pi 0.82.1 不发此事件, 见考察点 7): push message + recentOutput + 清理 pendingToolResult |
| `queue_update` / `compaction_*` / `auto_retry_*` / `summarization_*` | 忽略 (未知类型一律不报错) |
| 非 JSON 行 | 容忍 (考察点 3) |

- 处理顺序骨架 (每类事件之间不 break, 顺序 if):
  1. `line.trim()` 空 → return
  2. `JSON.parse` try/catch (考察点 3)
  3. `agent_settled` → 置位 + drain (规格 01)
  4. watchdog 状态机 (删除项 1)
  5. `tool_execution_start` / `tool_execution_end` (1b)
  6. `message_end` (考察点 2)
  7. `tool_result_end` (防御)
  8. 每个事件后视需要 `fireUpdate()` (考察点 6)

- 1b tool_execution_start/end 细节 (execution.ts:874-913):
  - start: `progress.toolCount++`; `progress.currentTool = evt.toolName`; `currentToolArgs = extractToolArgsPreview(args)` (截断预览); `currentToolStartedAt = now`; 记 `pendingToolResult = {tool, path, mutates, startedAt}`; fireUpdate
  - end: `progress.recentTools.push({tool: currentTool, args: currentToolArgs || "", endMs: now})`; 清空 currentTool/currentToolArgs/currentToolStartedAt/currentPath; pendingToolResult 保留到 tool_result_end 消费; fireUpdate
  - start 内另有 structuredOutput/intercom 钩子 (删除项 3/4) 与 toolBudget 分支 (删除项 5)

### 移植规格
- slim 事件处理清单 (M4 直接照做):
```
onLine(line):
  if !line.trim(): return
  evt = try JSON.parse(line) catch { rawStdoutTail.push(line); return }   // 考察点 3
  if evt.type === "agent_settled": agentSettledReceived = true; startFinalDrain()
  if evt.type === "tool_execution_start":
    progress.toolCount++
    progress.currentTool = evt.toolName
    progress.currentToolArgs = preview(evt.args)          // 截断 ~200 chars, 官方示例 renderCall 需要
    progress.currentToolStartedAt = Date.now()
  if evt.type === "tool_execution_end":
    if progress.currentTool: progress.recentTools.push({tool, args, endMs: Date.now()})
    progress.currentTool = undefined; currentToolArgs = undefined
  if evt.type === "message_end" && evt.message:           // 考察点 2 全量逻辑
    ...
  if evt.type === "tool_result_end" && evt.message:       // 防御分支, 可整段删 (pi 不发)
    result.messages.push(evt.message)
  fireUpdate()
```
- 状态变量 (闭包): `result` (SingleResult), `progress` (AgentProgress), `assistantError`, `cleanTerminalAssistantStopReceived`, `agentSettledReceived`, `pendingToolResult` (可删, 仅 toolBudget 用)
- progress 结构 (slim 子集): `{ status, toolCount, recentTools: [{tool,args,endMs}], recentOutput: string[≤50], tokens, inputTokens, outputTokens, durationMs, lastActivityAt, model?, currentTool? }`
- 不做: watchdog/structuredOutput/intercom/toolBudget/turnBudget/control 分支 (删除项确认)

---

## 考察点 2: message_end 累积细节 (messages/usage/turns/model/stopReason)

### 旧码位置
- execution.ts:914-957 (message_end 主分支)
- usage 字段类型: `@earendil-works/pi-ai/dist/types.d.ts:251-270` (Usage), 实测字段全集见规格 05 考察点 2
- 官方示例 index.ts:351-372 (同款累积 + contextTokens + stopReason/errorMessage 显式记录)

### 行为描述
- 无条件: `result.messages.push(evt.message)` — 所有角色 (assistant/user/toolResult) 都进 transcript; 后续 getFinalOutput 只扫 assistant
- 仅 `role === "assistant"` 时:
  - `result.usage.turns++` (turns = assistant 消息条数, 不是轮数)
  - 取 `stopReason` 与 toolCalls: `toolCalls = content.filter(part => part.type === "toolCall")`; `hasToolCall = toolCalls.length > 0`; `terminalAssistantStop = stopReason === "stop" && !hasToolCall`
  - terminalAssistantStop 且消息无 errorMessage → `cleanTerminalAssistantStopReceived = true` → startFinalDrain (规格 01)
  - usage 累加 (u = evt.message.usage, 各字段可能缺失, 一律 `|| 0`):
    - `result.usage.input += u.input`
    - `result.usage.output += u.output`
    - `result.usage.cacheRead += u.cacheRead`
    - `result.usage.cacheWrite += u.cacheWrite`
    - `result.usage.cost += u.cost?.total` (cost 是嵌套对象 {input,output,cacheRead,cacheWrite,total}, 只取 total 金额)
    - `progress.tokens = input + output`; `progress.inputTokens = input`; `progress.outputTokens = output`
  - model: `progress.model = evt.message.model`; `result.model` 只在首次赋值 (第一个 assistant 消息的 model, 后续不覆盖)
  - errorMessage: `assistantError = evt.message.errorMessage` (供 close 兜底错误, 规格 01 考察点 6)
  - recentOutput: `extractTextFromContent(content).split("\n").slice(-10)` 追加, 总上限 50 行 (appendRecentOutput)
  - terminal stop 且正文非空且无 errorMessage → 清 assistantError
- usage 字段结构 (pi 0.82.1 实测, 05-context-window.md 考察点 2):
  - `input/output/cacheRead/cacheWrite` number, `reasoning?` (output 子集, 可选), `totalTokens` (=input+output+cacheRead+cacheWrite), `cost{input,output,cacheRead,cacheWrite,total}`, `cacheWrite1h?` (仅 Anthropic)
  - 注意: 无 contextTokens 字段; totalTokens 是唯一总数来源
- 官方示例额外差异: `usage.contextTokens = usage.totalTokens` (最新一条, 非累加); `result.stopReason = msg.stopReason`; `result.errorMessage = msg.errorMessage` (SingleResult 显式字段)

### 移植规格
- slim usage 聚合结构 (结果对象字段, 直接照搬旧码 6 字段):
```ts
interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number }
// 初值 emptyUsage(): 全 0
```
- message_end (assistant) 处理步骤 (M4 照做):
```
result.messages.push(msg)                                  // 所有角色都 push
if msg.role !== "assistant": fireUpdate(); return       // 非 assistant 不再处理
usage.turns++
stopReason = msg.stopReason; toolCalls = msg.content.filter(p => p.type === "toolCall")
terminalAssistantStop = stopReason === "stop" && toolCalls.length === 0
if u = msg.usage:
  usage.input += u.input || 0
  usage.output += u.output || 0
  usage.cacheRead += u.cacheRead || 0
  usage.cacheWrite += u.cacheWrite || 0
  usage.cost += u.cost?.total || 0
  progress.tokens = usage.input + usage.output
  result.contextTokens = u.totalTokens ?? result.contextTokens   // 保底: 最新一条 (D012-b, 05 已验)
if msg.model && !result.model: result.model = msg.model
result.stopReason = stopReason                                // 官方示例字段, isError 判定用
if msg.errorMessage: result.errorMessage = msg.errorMessage; assistantError = msg.errorMessage
if terminalAssistantStop:
  cleanTerminalAssistantStopReceived ||= !msg.errorMessage
  startFinalDrain()                                           // 规格 01 考察点 2
fireUpdate()
```
- token 上限比对挂点 (D006, 考察点 5): 在 usage 累加之后、fireUpdate 之前插 budget 检查 (mid-flight 选项见考察点 5 移植规格)

---

## 考察点 3: 非 JSON 行容忍 (execution.ts:835-843)

### 旧码位置
- execution.ts:830-843 (rawStdoutTail + JSON.parse catch), close 时 :1092-1096 (code!==0 且 rawStdout 非空 → closeError = rawStdout.trim())
- 行读取/超长行保护: 规格 01 考察点 5 (createBoundedLineReader/16MB 上限/投影)

### 行为描述
- processLine 视角: 空行跳过; `JSON.parse` 失败 → `rawStdoutTail.push(line)` (有界尾部缓冲, 默认 128KB, createBoundedByteTail), 静默 return — 不告警不报错 ("Non-JSON stdout lines are expected; only structured events are parsed.")
- 非 JSON 行的最终作用: 仅当 `exitCode !== 0` 且无更具体错误时整段作为 closeError 文本 (规格 01 考察点 6 已定, 此处不重复)
- 官方示例: 失败直接 return, 无收集 (差异见考察点 7)

### 移植规格
- 照搬 processLine 三行:
```
try { evt = JSON.parse(line) } catch { rawStdoutTail.push(line + "\n"); return }
```
- rawStdoutTail: 有界尾部缓冲 `MAX_STDOUT_TAIL_BYTES = 128 * 1024` (旧 MAX_CHILD_STDERR_BYTES 同值), close 时 `rawStdoutTail.text()` 供错误诊断; 行上限/投影按规格 01 考察点 5 (防御项, 可简化)
- 不触发 drain/不触发 fireUpdate (与官方一致)

---

## 考察点 4: 最终输出构造 getFinalOutput 与结果结构 (SingleResult)

### 旧码位置
- utils.ts:280-319 (`getFinalOutput`), :582-605 (`extractTextFromContent`)
- types.ts:861-990 (SingleResult 全字段), execution.ts:392-440 (result 初始化), :1214-1233 (空输出/消息级错误检测), :1248-1256 (acceptance 剥离, slim 删), :1317-1328 (finalOutput 赋值 + 最终 onUpdate)
- 官方示例 index.ts:86-95 (isFailedResult/getResultOutput), :156 (UsageStats/SingleResult 示例字段)

### 行为描述
- getFinalOutput (utils.ts:280): 从后向前遍历 messages:
  1. 跳过非 assistant 消息
  2. 跳过带 `errorMessage` 或 `stopReason === "error"` 的 assistant 消息
  3. 收集该消息中 `type === "text"` 且非空的部分, 按 content 顺序 join("\n") 得 messageText
  4. 从该消息 content 尾部再逐 part 收集文本; 若命中 acceptance report / JSON report (含 criteriaSatisfied+changedFiles 等键) / `ACCEPTANCE_REPORT:` 标记 → 立即返回该消息全文 (slim 无 acceptance, 此逻辑删)
  5. 兜底返回 `validTextParts[0] ?? ""` (最后一条有效 assistant 文本)
- extractTextFromContent (utils.ts:582): content 为 string 直接返回; 数组遍历: `{type:"text",text}` / `{type:"tool_result",content}` (递归) / `{text}` 无 type; 拼接非空文本
- fireUpdate 的输出选择 (execution.ts:826): `(result.timedOut || result.turnBudgetExceeded) && result.finalOutput ? result.finalOutput : getFinalOutput(messages)`, 空则 `"(running...)"` (考察点 6)
- 最终 finalOutput 赋值 (execution.ts:1317): 正常路径 `result.finalOutput = fullOutput` (fullOutput = getFinalOutput 去 acceptance 后的文本); timeout/turnBudget 时 finalOutput = 错误消息 + 部分输出 (规格 01 考察点 3)
- 空输出判定 (execution.ts:1216-1228): exitCode===0 且无 error 时, getFinalOutput 为空且非 structuredOutput → exitCode=1, error="Subagent produced no output (possible model cold-start or empty response)."
- SingleResult 字段全集 (types.ts:861-990) 中 slim 需要的最小子集:

| 字段 | 类型 | 来源 |
|---|---|---|
| `index` | number | launch 顺序, 稳定标识 (parallel 用) |
| `agent` / `task` | string | 入参 |
| `exitCode` | number | close 计算 (规格 01) |
| `processSignal?` | string | close 时 signal |
| `timedOut?` | boolean | timeout 路径 (规格 01 考察点 3) |
| `usage` | {input,output,cacheRead,cacheWrite,cost,turns} | 本规格考察点 2 |
| `messages?` | Message[] | message_end/tool_result_end push |
| `model?` | string | 第一个 assistant 消息的 model |
| `stopReason?` / `errorMessage?` | string | 官方示例字段, isError 判定 |
| `error?` | string | closeError 链 (规格 01 考察点 6) |
| `finalOutput?` | string | getFinalOutput / 超时诊断文本 |
| `contextTokens?` | number | msg.usage.totalTokens 保底 (D012-b) |
| `progress?` / `progressSummary?` | 对象 | 流式展示/诊断载荷 |

- 官方示例 SingleResult 字段 (index.ts:156): agent/agentSource/task/exitCode/messages/stderr/usage/model/stopReason/errorMessage/step — slim 结果对象以旧码字段为主, 补 stopReason/errorMessage/contextTokens (官方有, 旧码无)

### 移植规格
- getFinalOutput (slim 版, 去 acceptance 分支):
```
getFinalOutput(messages):
  for i from messages.length-1 downto 0:
    msg = messages[i]; if !msg || msg.role !== "assistant": continue
    if msg.errorMessage || msg.stopReason === "error": continue
    parts = msg.content.filter(p => p.type === "text" && p.text.trim())
    if parts.length: return parts.map(p => p.text).join("\n")
  return ""
```
- 结果结构: 旧码 SingleResult 子集 (上表) + 官方 stopReason/errorMessage/contextTokens; `contextTokens` 语义 = 最新一条 assistant 消息的 totalTokens (官方口径, 非累加)
- 空输出检测保留: exitCode 0 且 error 空 且 finalOutput 空 → exitCode=1 + error "Subagent produced no output (possible model cold-start or empty response)." (hasEmptyTerminalAssistantResponse 细化判定可并入: 最后 assistant 消息 content 空)
- 结果文本选择 (execute 层, 官方 isFailedResult/getResultOutput 口径, 规格 01 考察点 6 已定): isError 时 errorMessage → stderr → 最终输出 → "(no output)"

---

## 考察点 5: token 上限 (usage budget) — 累计比对与中止分支

### 旧码位置
- runs/shared/usage-budget.ts 全文件 (14 行 validate, 44-58 state, 61-66 message)
- types.ts:836-856 (UsageBudgetLimitConfig/UsageBudgetConfig/UsageBudgetMetricState/UsageBudgetState)
- 执行挂点: subagent-executor.ts:2987-2999 (parallel 每 child 启动前), :3869 (single 完成后报告), chain-execution.ts:625-628 + :755 (chain 每步启动前, slim 无 chain, 参考)
- 参数面: schemas.ts:122-130 + :330 (usageBudget 参数), subagent-executor.ts:244/341 (类型), D006 决策

### 行为描述
- 配置结构 (UsageBudgetConfig): `{ tokens?: {soft?, hard}, costUsd?: {soft?, hard} }`; hard 必填正数, soft 可选 ≤ hard; 校验失败报错 (validateUsageBudgetConfig)
- 状态计算 (usageBudgetState(config, totals: {inputTokens, outputTokens, costUsd})):
  - `tokens.used = inputTokens + outputTokens` — **不含 cacheRead/cacheWrite** (旧码口径)
  - `costUsd.used = Σ result.usage.cost` (sumResultsCost, utils.ts:395-406)
  - metric: `used >= hard` → "hard-exceeded"; `soft 存在且 used >= soft` → "soft-exceeded"; 否则 "within-budget"
  - `exhausted = tokens.hard-exceeded || costUsd.hard-exceeded`; `reason = "tokens" | "costUsd"`
  - state 形状: `{version: 1, source: "reported", tokens?, costUsd?, exhausted, reason?}` (source="reported": 只按已报告 usage 计, 无预估)
- 中止消息 (usageBudgetExceededMessage): `"Usage budget exhausted: reported tokens {used} reached hard limit {hard}."` / `"Usage budget exhausted: reported cost ${used.toFixed(6)} reached hard limit ${hard.toFixed(6)}."`
- **执行语义 (关键)**: usage budget 是调度门, 不是 in-flight 终止器:
  - parallel (subagent-executor.ts:2987-2999): mapConcurrent 中每个 child **启动前** 计算 `usageBudgetState(config, sumResultsCost(completedResults))` (只含已完成的 child); exhausted → 该 child 不启动, 返回 skipped 结果: `{index, agent, task: taskTexts[index] ?? "(skipped)", exitCode: 1, messages: [], usage: 全 0, error: usageBudgetExceededMessage, skipped: true}` — 已完成的 child 结果全部保留
  - single (subagent-executor.ts:3869): 运行**完成后**才在 details.usageBudget 报告状态, 运行中不检查
  - chain 顺序步 (chain-execution.ts:755): 每步启动前检查, exhausted → 中止整个 chain 返回错误结果, 已跑步骤保留
  - 无任何 mid-flight (运行中按实时 usage 杀进程) 的检查点; usage 只在 message_end 累加, 累加后不做 budget 比对
- resume 关联: 被 skip 的 child 从未启动 (无 session, 不可 resume); 已运行的 child 结果保留且其 session 持久化 (D004) — "结果可 resume" 在旧码语义 = 已运行子代理可恢复, 与 budget skip 无直接耦合

### 移植规格
- D006 与旧码语义差异 (M4 必须知晓): 旧码不在 single 运行中终止, 只做调度门 + 报告. D006 说 "触顶即终止子代理". 两个选项:
  - **选项 A (照搬旧码, 推荐)**: 调度门语义 — parallel 每 child 启动前比对已累计 usage; single 运行结束报告 budget 状态; 触顶 → 未启动 child skip + error 消息, 已运行 child 保留结果 (可 resume). 实现 ~30 行 (validate + state + 挂点), 无新终止管线
  - **选项 B (运行中终止)**: 在 message_end usage 累加后立即比对 (考察点 2 挂点); exhausted → 复用规格 01 考察点 3 的终止序列 SIGINT @0ms → SIGTERM @+1000ms → SIGKILL @+4000ms (旧码 turnBudget requestTurnBudgetAbort 同构管线, execution.ts:741-810), 结果置 error = usageBudgetExceededMessage + exitCode 1 + 部分输出进 finalOutput (同 timeout 诊断载荷拼装) + session 保留可 resume. 新增 ~40 行; 语义更贴 D006 但偏离旧码 (需 M4 与用户确认口径, e2e 验证 SIGKILL 丢 in-flight turn 行为同 F005)
- 移植规格 (选项 A 为主体, 选项 B 为挂点说明):
```
// 常量与函数 (usage-budget.ts 可整体搬, 65 行, 无外部依赖)
interface UsageBudgetConfig { tokens?: {soft?: number; hard: number}; costUsd?: {soft?: number; hard: number} }
usageBudgetState(config, totals): UsageBudgetState | undefined   // 见行为描述公式
usageBudgetExceededMessage(state): string                        // 见行为描述文案

// parallel 调度内 (每个 child 启动前):
budgetState = usageBudgetState(usageBudget, sumCost(completedResults))
if budgetState?.exhausted:
  返回 skipped 结果 {exitCode: 1, messages: [], usage: 全 0, error: usageBudgetExceededMessage(budgetState), skipped: true}

// single 完成后:
details.usageBudget = usageBudgetState(usageBudget, sumCost([result]))   // 仅报告

// 选项 B 挂点 (若 M4 选):
// message_end usage 累加后:
//   budgetState = usageBudgetState(usageBudget, {inputTokens: usage.input, outputTokens: usage.output, costUsd: usage.cost})
//   if budgetState?.exhausted && !result.timedOut: 走 SIGINT→SIGTERM→SIGKILL 管线, 结果构造同 timeout
```
- sumCost 实现 (utils.ts:395): `{inputTokens: Σ usage.input, outputTokens: Σ usage.output, costUsd: Σ usage.cost}` (不含 cacheRead/cacheWrite, 与旧码一致)
- 参数面: 工具 schema 增加 `usageBudget` 可选参数 `{tokens: {soft?, hard}, costUsd?: ...}` (至少一个), 校验失败显式报错 (validateUsageBudgetConfig)
- resume 衔接 (D004): 触顶中止/超时的 child 必须留 session 目录; 被 skip 的 child 无 session — 文档/工具描述需向父会话说明 "budget 触顶后剩余任务未执行, 需调整预算或拆任务重发" (旧码无此文案, M4 自定, 属 D010 描述预算内)

---

## 考察点 6: 流式更新 fireUpdate/onUpdate 粒度与 payload

### 旧码位置
- execution.ts:823-829 (fireUpdate), :807-821 (emitUpdateSnapshot), :230-237 (snapshotProgress), :239-266 (snapshotResult), :268-274 (snapshotStreamResult), :998-1000 (spawn 后立即一次), :1001-1003 (activityTimer 1s 心跳), :1319-1330 (close 后最终 onUpdate)
- 官方示例 index.ts:313-319 (emitUpdate), :342-372 (触发点)

### 行为描述
- 触发点: spawn 后立即 1 次; `tool_execution_start` / `tool_execution_end` / `message_end` / `tool_result_end` 各 1 次; timeout/turnBudget/protocolError 触发时 1 次; controlConfig.enabled 或 onUpdate 存在时 1s 心跳 (activityTimer, slim 删); close 后最终 1 次
- payload (emitUpdateSnapshot): `onUpdate({ content: [{type:"text", text}], details: { mode: "single", results: [resultSnapshot], progress: [progressSnapshot], controlEvents } })`
  - text: `(result.timedOut || result.turnBudgetExceeded) && result.finalOutput ? result.finalOutput : getFinalOutput(messages)`, 空则 `"(running...)"`
  - resultSnapshot = snapshotStreamResult: **剥离 messages** (防单事件超协议行上限 MAX_CHILD_PENDING_LINE_BYTES), 换成 toolCalls 摘要 (boundStreamedToolCalls); usage 深拷贝; progress 挂入
  - progressSnapshot = snapshotProgress: recentTools/recentOutput 有界拷贝 (≤10 recentTools, ≤50 recentOutput)
  - controlEvents: 控制事件队列 (slim 删)
- close 后最终 onUpdate (execution.ts:1319-1330): 同 payload, text = finalOutput || error || "(no output)", results 含最终完整结果
- 官方示例: 触发点 = message_end / tool_result_end; payload = `{content: [{type:"text", text: getFinalOutput(messages) || "(running...)"}], details: makeDetails([currentResult])}` — **直接带完整 messages**, 无剥离; 无 spawn 后立即更新, 无心跳

### 移植规格
- 触发点照官方示例 (message_end + tool_result_end) + spawn 后 1 次初始 "(running...)" + close 后 1 次最终 (旧码 spawn 后立即 1 次值得保留, TUI 有即时反馈)
- payload 结构 (D001 第 9 项: TUI 官方示例级最小渲染, 整搬官方示例):
```
onUpdate({
  content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
  details: { mode: "single", results: [result], progress: [progressSnapshot] },
})
```
- messages 携带策略: 官方口径直接带 (M4 默认, TUI 渲染/父会话诊断都需要); 若 parallel 并发 4 时单次 onUpdate 体积担心, 可加旧码式剥离 (toolCalls 摘要 + usage), 但官方示例没做且工作正常 — 默认不剥离
- progress 快照: 深拷贝 + recentTools/recentOutput 有界截断 (照旧码 boundStreamedRecentTools/boundStreamedRecentOutput 语义: ≤10/≤50), 防止闭包引用被后续事件污染
- 心跳/controlEvents/剥离逻辑全删 (删除项 7/9)

---

## 考察点 7: 与官方示例解析的差异点

### 旧码位置
- 官方 index.ts:310-353 (processLine), :313-319 (emitUpdate), :351-372 (message_end/tool_result_end)
- pi-subagents execution.ts:831-970 (processLine)

### 行为描述 (差异清单)

| 维度 | 官方示例 | pi-subagents (移植源) |
|---|---|---|
| 事件处理全集 | 仅 message_end + tool_result_end | + agent_settled (drain 兜底) + tool_execution_start/end (进度) + watchdog/structuredOutput/intercom/toolBudget 钩子 (全删) |
| tool_result_end | 处理 (push message) | 处理 (push + recentOutput + pendingToolResult 消费) — **两者都是死分支: pi 0.82.1 不发此事件** (docs/json.md 无此类型; 工具结果以 message_end role="toolResult" 到达, agent-session.js:363 佐证) |
| 非 JSON 行 | JSON.parse catch 直接 return | catch + rawStdoutTail 收集 (close 诊断) + 16MB 行上限/投影 |
| usage 累积 | 6 字段 + contextTokens=totalTokens (最新) | 6 字段 (无 contextTokens); cost 同为 u.cost?.total |
| stopReason/errorMessage | 显式写 result.stopReason/errorMessage | 只存 message 内 + assistantError 闭包 |
| model | 只补首个 (if !result.model) | progress.model 每消息覆盖 + result.model 只首个 — 语义一致 |
| turns | usage.turns++ (assistant) | 同 |
| 流式 payload | 完整 messages | 剥离 messages → toolCalls 摘要 + controlEvents + progress |
| 流式触发 | message_end/tool_result_end | + tool_execution_start/end + spawn 后 + 1s 心跳 + timeout/终止事件 |
| turn_end | 不处理 | 不处理 (pi 的 toolResults 数组弃用) |
| agent_end | 不处理 | 仅 willRetry → cancel-drain (fallback 用, slim 删) |

### 移植规格
- 基线: 官方示例 processLine (message_end + tool_result_end + JSON catch) 为骨架
- 移植 pi-subagents 增量: agent_settled → drain 兜底 (规格 01), tool_execution_start/end → progress 流式展示 (D001 第 9 项 renderResult 需要), rawStdoutTail 失败诊断 (考察点 3), spawn 后初始 onUpdate
- **tool_result_end 分支处理决策**: 保留为防御分支 (2 行, 与官方一致, 零成本) — pi 事件流演进可能补发; 但不得依赖它 (工具结果已由 message_end role="toolResult" 进入 messages)
- contextTokens/stopReason/errorMessage 从官方示例补入结果对象 (考察点 2/4 规格已含)
- usage 字段解析 (input/output/cacheRead/cacheWrite/cost.total/totalTokens) 两套一致, 无冲突

---

## 删除项确认 (本任务范围内发现, 保留集已删的旧行为)

1. **watchdog 子进程状态机** (execution.ts:855-877 processLine 内 isChildWatchdogStatusEvent 分支 + child-status.ts): 删 (D011); agent_settled 置位与 drain 兜底保留 (规格 01)
2. **structured output 钩子** (execution.ts:925-927, tool_execution_start 内 structured_output 检测 + 收尾 readStructuredOutput): 删 (D001 保留集无此能力)
3. **intercom detach 钩子** (execution.ts:929-931, toolName intercom/contact_supervisor 检测 + intercomStarted): 删 (D007)
4. **toolBudget 分支** (execution.ts:935-937 toolBudgetState, :961-963 toolBudgetBlocked, tool-budget.ts): 删 (D011; 注意与 D006 token budget 是两回事 — token budget 保留, 见考察点 5)
5. **turnBudget 状态机** (execution.ts:741-810 updateTurnBudget/requestTurnBudgetAbort, turn-budget.ts): 删 (D002/D011; 其 SIGINT→1s→SIGTERM→4s→SIGKILL 管线模式保留为考察点 5 选项 B 的参考, 不搬状态机)
6. **mutating failure 追踪** (execution.ts:966-976 recordMutatingFailure/shouldEscalateMutatingFailures + mutatingFailures 状态): 删 (control/needs_attention 删, D003)
7. **controlConfig/updateActivityState/activityTimer 1s 心跳/controlEvents** (execution.ts:807-821 emitUpdateSnapshot 内, :1001-1003, buildControlEvent): 删 (D003)
8. **jsonlWriter/transcriptWriter** (execution.ts:832/841-842/1046-1049): 删 (D011 transcript 无保留); rawStdoutTail/stderrTail 保留 (错误诊断)
9. **流式 payload 的 messages 剥离 + toolCalls 摘要** (snapshotStreamResult/boundStreamedToolCalls): 删 (官方口径直接带 messages, 考察点 6)
10. **acceptance report 检测** (getFinalOutput 内 acceptance/JSON report/ACCEPTANCE_REPORT 三处返回分支, utils.ts:295-313): 删 (D007 acceptance 全删, 规格 01 已同删 acceptance 收尾)
11. **assistantError 之外的消息级错误检测** (detectSubagentError/hasEmptyTerminalAssistantResponse, execution.ts:1222-1228): 保留空输出检测, detectSubagentError 可删可留 (规格 01 考察点 6: 两套口径二选一)
12. **usageBudget 的 costUsd 维度**: D006 只点名 token 上限 — costUsd 是否保留由 M2 暴露面定; 本规格默认照搬两维 (costUsd 代码同构, 多 ~10 行), M4 若砍 costUsd 只删 config 分支即可
