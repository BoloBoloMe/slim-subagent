# M3 移植规格 01: 子进程生命周期与终止协议

- 来源: pi-subagents-main v0.44.0 (只读), 官方示例 examples/extensions/subagent/index.ts (1015 行)
- 用途: M4 施工图纸, 每个考察点给 {旧码位置, 行为描述, 移植规格}; 移植规格可直接照做, 含常量与逻辑步骤
- 保留集对齐: MILESTONE-01 DECISIONS.md D001/D004/D005/D007; timeout 默认 15min (旧 30min, D005 改), 无 fallback/无 watchdog/无 control/interrupt/无 detach/无 turnBudget (D002/D003/D007/D011)

---

## 考察点 1: spawn 调用参数与 stdio 配置

### 旧码位置
- execution.ts:443-462 (`resolveAttemptTimeout` + remainingMs===0 短路), :464-471 (spawn)
- pi-spawn.ts:1-163 (`getPiSpawnCommand`, 可执行寻址)
- pi-args.ts `buildPiArgs` (baseArgs `["--mode","json","-p"]` + session/model/tools/systemPrompt/task 组装)
- 官方示例 index.ts:265-272 (`getPiInvocation`), :300-308 (spawn)

### 行为描述
- spawn 参数: `spawn(command, args, { cwd, env, stdio: ["ignore","pipe","pipe"], windowsHide: true })`
  - stdin = ignore (子代理无交互输入), stdout/stderr = pipe (逐行解析 JSONL 事件 / 捕获诊断)
  - `windowsHide: true` 防 Windows 弹窗
- env: `{...process.env, ...buildPiArgs计算出的env(工具白名单/权限审计/子代理depth), ...getSubagentDepthEnv(...)}`; slim 无权限/工具注入, env 仅需 `{...process.env}` + depth (depth 可删)
- cwd: `options.cwd ?? runtimeCwd`
- 命令寻址链 (getPiSpawnCommand): env `PI_SUBAGENT_PI_BINARY` 覆盖 → process.execPath 是独立 pi 可执行 (basename 匹配 `/^pi(\.exe)?$/`) → 解析 `@earendil-works/pi-coding-agent` 包 bin 脚本 (execPath + [cliPath, ...args]) → 兜底 PATH 上的 `pi`
- 官方 getPiInvocation 简化版: 当前脚本 process.argv[1] 存在且非 bun 虚拟脚本 → `execPath + [currentScript, ...args]`; 否则 execPath 非 node/bun 运行时 → execPath; 否则 `"pi"`

### 移植规格
- args 组装 (slim 最小面): `["--mode","json","-p", "--model", m, "--tools", t, "--append-system-prompt", promptFile, "Task: " + task]`
  - session 相关: 弃 `--no-session` (D004 resume 需要持久会话), M4 按 D004 规格用 per-run session 目录 flag (旧 pi-args.ts:516-526 有 `--session`/`--session-dir` 参考)
- spawn 配置常量照搬:
```ts
const proc = spawn(cmd, args, {
  cwd: cwd ?? defaultCwd,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
```
- 命令寻址: 取官方 `getPiInvocation` 为基线 (扩展自身脚本可执行 → execPath 带脚本), 保留 env 覆盖 `PI_SUBAGENT_PI_BINARY` 与独立 pi 可执行名检查作为兜底 (细节归 pi-args worker 的规格, 此处只定 spawn 面)
- 不注入 `--timeout` 之类 flag: 子进程不知道超时, 超时是父进程定时器 (见考察点 3)

---

## 考察点 2: 三阶段终止协议 (terminal stop drain → SIGTERM → SIGKILL + agent_settled 兜底)

### 旧码位置
- execution.ts:554-555 (常量), :585-605 (`startFinalDrain`), :611-628 (`armWatchdogTail`, watchdog 分支), :649-663 (`finish` 清理), :1064-1066 (exit 清理)
- child-protocol.ts:394-401 (`projectChildLifecycle`: agent_end+willRetry→cancel-drain, agent_settled→start-drain, terminalAssistantStop→start-drain)
- execution.ts:919-952 (terminalAssistantStop 判定 + clean 标记 + drain 触发)

### 行为描述
- 常量: `FINAL_STOP_GRACE_MS = 1000`, `HARD_KILL_MS = 3000` (两个 timer 均 `.unref()`)
- 触发条件 (任一即 start-drain):
  1. terminal assistant stop: `message_end` 中 assistant 消息 `stopReason === "stop" && !hasToolCall` (toolCalls = content 中 type==="toolCall" 的部分)
  2. `agent_settled` 事件到达 (兜底: 某些路径 pi 不产出标准 stop, 但会发 settled)
  - 反向: `agent_end` 且 `willRetry === true` → cancel-drain (取消已排定的 drain; 旧码用于 model fallback 重试, slim 无 fallback 可保留此分支防御性忽略或删)
- drain 流程 (startFinalDrain, 有守卫: childExited/finalDrainTimer/lifecycleFinished/processClosed 时不重复启动):
  1. 等 1000ms (grace, 让子进程自然冲刷 stdout 退出)
  2. `trySignalChild(proc, "SIGTERM")`; 若发出成功且未退出 → `forcedTerminationSignal = true`
  3. 若此时仍未收到 clean terminal stop 且无 assistantError → 写 `result.error = "Subagent process did not exit within 1000ms after its terminal event. Forcing termination."` (仅当 result.error 未设)
  4. 再等 3000ms → `trySignalChild(proc, "SIGKILL")`
- "clean" 判定: `cleanTerminalAssistantStopReceived ||= !evt.message.errorMessage` (terminal stop 且消息无 errorMessage 才算干净完成); `agentSettledReceived = true` 于 agent_settled 事件
- 终止后 close: `forcedDrainAfterFinalSuccess = Boolean(forcedTerminationSignal || signal) && (cleanTerminalAssistantStopReceived || agentSettledReceived) && !closeError` → 最终退出码强制归 0 (见考察点 6)
- 子进程自然退出 (未到 SIGTERM 阶段): close 事件到, finalCode = code, 无 error

### 移植规格
- 常量: `FINAL_STOP_GRACE_MS = 1000`, `HARD_KILL_MS = 3000`; 信号序 SIGTERM → (3s) SIGKILL; 与 timeout 路径常量区分 (见考察点 3: 1000/4000)
- 状态机状态 (闭包变量): `childExited / lifecycleFinished / processClosed / forcedTerminationSignal / cleanTerminalAssistantStopReceived / agentSettledReceived / finalDrainTimer / finalHardKillTimer`
- 逻辑步骤 (M4 直接照做):
```
on message_end (assistant, terminal stop: stopReason==="stop" && 无 toolCall):
  cleanTerminalAssistantStopReceived ||= !msg.errorMessage
  startFinalDrain()
on agent_settled: agentSettledReceived = true; startFinalDrain()
on exit: childExited = true; clearFinalDrainTimers()
startFinalDrain():
  if childExited || finalDrainTimer || lifecycleFinished || processClosed: return
  finalDrainTimer = setTimeout(1000):
    if lifecycleFinished || processClosed: return
    termSent = trySignalChild(proc, "SIGTERM"); if (!termSent) return
    forcedTerminationSignal = true
    if !cleanTerminalAssistantStopReceived && !agentSettledReceived && !assistantError:
      result.error ??= "Subagent process did not exit within 1000ms after its terminal event. Forcing termination."
    finalHardKillTimer = setTimeout(3000):
      if lifecycleFinished || processClosed: return
      forcedTerminationSignal = trySignalChild(proc, "SIGKILL") || forcedTerminationSignal
    (unref)
  (unref)
finish(): clearFinalDrainTimers + 全部 timer 清理 + resolve(code)
```
- `trySignalChild` 小工具 (post-exit-stdio-guard.ts:18-26): `try { return child.kill(signal) } catch { return false }` (防已退出进程 kill 抛错)
- watchdog 分支不移植 (删除项见末节); 但 agent_settled 兜底必须保留 (pi 侧产物事件, 无 cost)
- 官方示例无此协议 (等 close 自然结束), 移植来源是 pi-subagents, e2e 需验证 pi 在 terminal stop 后自身退出速度 (风险 C-rewrite.md §4.1)

---

## 考察点 3: timeout 触发路径与诊断载荷

### 旧码位置
- subagent-executor.ts:1980 (`DEFAULT_FOREGROUND_TIMEOUT_MS = 30 * 60 * 1000`), :1982-2000 (`resolveForegroundTimeout` 校验), :5104-5107 (前台默认 30min 注入)
- execution.ts:169-171 (`formatTimeoutMessage`), :173-181 (`resolveAttemptTimeout`), :443-462 (remainingMs===0 短路), :1004-1027 (timeoutTimer 三阶段)
- execution.ts:1255-1262 (timedOut 诊断载荷拼装), 官方示例 index.ts:335-340 (usage.contextTokens 采集)

### 行为描述
- **父进程定时器, 非 --timeout flag 注入**: `setTimeout(fn, remainingMs)`, 子进程无感知; timeoutMs 参数 (Type.Integer minimum 1) 与 maxRuntimeMs 互为别名 (同时给且不同值 → 报错); 前台无参数时默认 30min (slim 改 15min, D005)
- deadline 语义: run 级固定 `deadlineAt = data.deadlineAt ?? (timeoutMs !== undefined ? Date.now() + timeoutMs : undefined)` (subagent-executor.ts:3399/3754); 每次 attempt `remainingMs = max(0, deadlineAt - now)`; remainingMs===0 → 不 spawn, 直接返回 timedOut 结果 (exitCode 1, timedOut, error=message)
- 触发序列 (execution.ts:1004-1027):
  1. `result.timedOut = true; result.error = message; result.finalOutput = message; progress.status="failed"; fireUpdate()`
  2. 立即 `SIGINT` (给子进程机会优雅收尾/写 session)
  3. +1000ms → SIGTERM
  4. +4000ms → SIGKILL (注意: 与 drain 的 HARD_KILL_MS=3000 不同)
- 超时后的退出码: close 的 signal 参数非空 → `isUnexplainedProcessSignal` 因 timedOut=true 判定 false (不写 processSignal 错误); `finalCode = forcedTerminationSignal || signal ? (code ?? 1) : (code ?? 0)` → 通常 code=null → exitCode=1
- 诊断载荷 (超时结果带):
  - `error` = "Subagent timed out after {timeoutMs}ms."
  - `finalOutput` = timeoutMessage + "\n\nPartial output before timeout:\n" + 已累积部分输出 (无部分输出则仅 timeoutMessage) - 拼装在 close 之后, 最终结果返回前
  - `messages` 全量保留 (部分输出数据源), `usage` 累加值, `progressSummary {toolCount, tokens, durationMs}`, `model`
  - 旧码无 contextTokens 字段 (D012 保底: 报绝对 contextTokens + model 名; 官方示例 index.ts:335-340 从 `msg.usage.totalTokens` 取 contextTokens)

### 移植规格
- 常量: `DEFAULT_TIMEOUT_MS = 15 * 60 * 1000` (D005, 旧 30min 改); timeout 终止序列: SIGINT @0ms → SIGTERM @+1000ms → SIGKILL @+4000ms (照搬旧值)
- 参数面: 仅 `timeoutMs` (正整数, minimum 1), 去 maxRuntimeMs 别名; 无参数 → 默认 15min
- 逻辑步骤:
```
resolveTimeout(options): { timeoutMs, deadlineAt: options.deadlineAt ?? now + timeoutMs }
attempt 内: remainingMs = max(0, deadlineAt - now)
if remainingMs === 0: 返回 timedOut 结果 (不 spawn)
timeoutTimer = setTimeout(remainingMs):
  result.timedOut = true
  result.error = `Subagent timed out after ${timeoutMs}ms.`
  result.finalOutput = 同 error
  progress.status = "failed"
  trySignalChild(proc, "SIGINT")
  after 1000ms: trySignalChild(proc, "SIGTERM")
  after 4000ms: trySignalChild(proc, "SIGKILL")
close 后拼装: fullOutput = result.finalOutput(部分输出?) 
  ? error + "\n\nPartial output before timeout:\n" + 部分输出
  : error
```
- 诊断载荷字段清单 (M4 结果对象): `{ timedOut: true, timeoutMs, error, finalOutput, messages(累积), usage, progressSummary, model, contextTokens(保底: msg.usage.totalTokens, M3 未验证 pi 是否恒有; 缺失则报 model + 绝对 input/output tokens) }`
- resume 关联: 超时结果必须可 resume (D004), 恢复点 = 最后完整 turn; SIGKILL 丢 in-flight turn 的行为须 e2e 验证 (M5 对拍, F005/D012-a)

---

## 考察点 4: 取消 (AbortSignal → kill 序列)

### 旧码位置
- execution.ts:1123-1132 (signal abort listener)
- 官方示例 index.ts:367-379 (signal → SIGTERM → 5s SIGKILL + wasAborted 标记)

### 行为描述
- pi-subagents: `kill = () => { if (processClosed || lifecycleFinished) return; proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL") }, 3000) }`
  - signal.aborted 已触发 → 立即 kill; 否则 `addEventListener("abort", kill, { once: true })`, finish 时 removeEventListener
  - 3000ms 兜底 (非 unref, 与 drain 的 trySignalChild 不同: 直接用 proc.kill, 有 proc.killed 检查)
- 取消不清 result.interrupted (interrupted 仅 control/interruptSignal 用, slim 删); 取消后 close 里 signal 非空 → isUnexplainedProcessSignal = true (interrupted/timedOut/stopped/turnBudgetExceeded 均 false) → `closeError = "Subagent process terminated by signal SIGTERM."`; 除非 forcedDrainAfterFinalSuccess (terminal stop 已收到) → exitCode 归 0
- 取消后 exitCode = `(code ?? 1)` = 1 (无特殊 0 语义)
- 官方差异: SIGKILL 延迟 5000ms; wasAborted=true → `throw new Error("Subagent was aborted")` → execute 层报错 (无 processSignal 诊断)

### 移植规格
- 常量: `CANCEL_SIGKILL_DELAY_MS = 3000` (取旧码 3s, 非官方 5s)
- 逻辑:
```
if (signal) {
  const kill = () => {
    if (processClosed || lifecycleFinished) return
    try proc.kill("SIGTERM") catch {}
    setTimeout(() => { if (!proc.killed) try proc.kill("SIGKILL") catch {} }, 3000)
  }
  if (signal.aborted) kill()
  else { signal.addEventListener("abort", kill, { once: true }); 记 removeListener 供 finish 清理 }
}
```
- 结果语义: 取消不单独构造 "aborted" 结果类型; 走通用错误路径 — close 后 error = "Subagent process terminated by signal SIGTERM." (signal 非空且无更具体 error 时), exitCode 1, isError true (考察点 6)
- 若取消发生在 terminal stop 已收到之后 (子进程正要自然退出): forcedDrainAfterFinalSuccess → exitCode 归 0, 不报错 (保留此优雅路径)

---

## 考察点 5: 非 JSON stdout 容忍

### 旧码位置
- execution.ts:830-841 (rawStdoutTail + JSON.parse catch)
- child-protocol.ts:6-8 (MAX_CHILD_PENDING_LINE_BYTES=16MB, MAX_CHILD_STDERR_BYTES=128KB), :244-340 (createBoundedLineReader), :233-238 (PI_AGGREGATE_EVENT_PROJECTOR), :240-242 (formatProtocolOutputLimit)
- execution.ts:1030-1045 (failProtocol), 官方示例 index.ts:315-322 (JSON.parse catch 直接 return)

### 行为描述
- 逐行处理: 空行 (trim 后空) 直接跳过; `JSON.parse(line)` try/catch — 解析失败: 该行 push 进 `rawStdoutTail` (有界尾部缓冲, 供失败诊断), 静默返回, **无告警** (注释明言 "Non-JSON stdout lines are expected; only structured events are parsed.")
- 非 JSON 行的最终去向: close 时若 `code !== 0` 且 rawStdout 非空且无更具体 closeError → `closeError = rawStdout.trim()` (整段当错误文本); code===0 时非 JSON 行完全无害
- 行读取: createBoundedLineReader 按 \n 分块累积; 单行超 16MB → failProtocol: `result.protocolError` 记录 + error=formatProtocolOutputLimit + SIGTERM → 3s → SIGKILL; 例外: `turn_end`/`agent_end` 前缀的巨型聚合行 (并行场景图片 payload 撑爆单行) 由 PI_AGGREGATE_EVENT_PROJECTOR 投影成保留 type 字段的合成事件, 不误杀
- 官方示例: JSON.parse 失败直接 return, 无 rawStdout 收集, 无行上限, 无投影; 尾部无换行的残 buffer 在 close 时补处理一次 (官方 index.ts:347-349; pi-subagents 由 stdoutReader.end() flush)

### 移植规格
- 核心行为 (必须保留, C-rewrite.md §4.1 点名): 空行跳过 → try JSON.parse → catch 时静默跳过但把原始行压入 rawStdoutTail → close 时 code!==0 且无更具体错误则整段作为 closeError
- 行缓冲实现: 简单分块缓冲即可 (buffer += chunk; split("\n"); 留残段), close 时 flush 残段; 官方示例写法够用
- 可选简化: 16MB 单行上限保留为防御 (常量 MAX_PENDING_LINE_BYTES = 16MB), 超限走 failProtocol (SIGTERM → 3s → SIGKILL); 聚合投影可保留 (防 parallel 大输出误杀) 或 M4 先删后按 golden 对拍决定 — 规格默认保留 `turn_end`/`agent_end` 投影, 代码 ~30 行
- 非 JSON 行不触发 drain/不触发错误 (code 0 时), 与官方一致

---

## 考察点 6: 错误路径 (stopReason/errorMessage, stderr, 退出码, isError)

### 旧码位置
- execution.ts:1083-1104 (close 内 closeError 优先序 + finalCode), :1106-1120 (proc error), :1029 (stderrTail 128KB), :1046-1051 (stderrReader), :944-950 (assistantError 捕获与清除)
- process-signal.ts:1-18 (isUnexplainedProcessSignal/formatProcessSignalError)
- utils.ts:280-319 (getFinalOutput 跳过 error 消息), :470-478 (hasEmptyTerminalAssistantResponse), :481-530 (detectSubagentError)
- execution.ts:1214-1233 (exitCode===0 时的消息级错误检测/空输出判定), :1171-1177 (interrupted 分支, slim 删)
- 官方示例 index.ts:86-89 (isFailedResult), :321-327 (stderr 累积), :357-363 (proc error → resolve(1)), :90-94 (getResultOutput)

### 行为描述
- 错误来源与 closeError 优先序: `result.error(已由 timeout/turnBudget/protocolError 等前置设置) ?? toolDiagnosticError ?? assistantError(来自 message_end 的 msg.errorMessage)`; 然后:
  1. 若 signal 非空且 `isUnexplainedProcessSignal` (interrupted/timedOut/stopped/turnBudgetExceeded/forcedDrainAfterFinalSuccess 全 false) → closeError = `"Subagent process terminated by signal {signal}."`; 且 `result.processSignal = signal`
  2. `code !== 0` 且 rawStdout 非空 → closeError = rawStdout.trim()
  3. `code !== 0` 且 stderr 非空 → closeError = stderr.trim()
- 退出码语义 (finalCode): `forcedDrainAfterFinalSuccess ? 0 : (forcedTerminationSignal || signal ? (code ?? 1) : (code ?? 0))`
  - 干净完成 (无强制信号) → 子进程 code
  - 被强杀 (signal 非空) → code ?? 1 (SIGKILL 时 code=null → 1)
  - terminal stop 后强制收尾但子进程其实已产出干净结果 → 0
  - close 后收尾: `result.error && exitCode===0 → exitCode=1`; `exitCode===0 && !error` 时再做消息级检测: detectSubagentError (最后 assistant 文本之后的 toolResult isError 消息 → error = "{toolName} failed (exit {n}): {details}") 与空输出判定 ("Subagent produced no output (possible model cold-start or empty response).")
- stderr 捕获: 有界尾部 128KB (createBoundedByteTail 默认), 供 close 诊断; 全量另写 transcript (slim 删)
- proc.on("error") (spawn 本身失败, 如 ENOENT): `result.error = error.message`, finish(1)
- assistantError 清除: terminal stop 消息无 errorMessage 且有正文 → assistantError = undefined (干净完成时错误不残留)
- getFinalOutput 语义: 从后向前找 assistant 消息, 跳过 `errorMessage 非空` 或 `stopReason==="error"` 的消息; 返回第一个有效文本
- stopReason 存放: 旧码只在 message 内 (SingleResult 无 stopReason 字段); 官方示例显式 `result.stopReason = msg.stopReason` + `result.errorMessage = msg.errorMessage`
- 官方 isFailedResult: `exitCode !== 0 || stopReason === "error" || stopReason === "aborted"`; 结果文本 = errorMessage || stderr || getFinalOutput || "(no output)"; isError: true
- interrupted (control) 分支: exitCode 归 0, interrupted=true, error 清空 — slim 删 (考察点 4 的 signal 取消不在此列, 语义不同)

### 移植规格
- message_end (assistant) 时记录: `result.stopReason = msg.stopReason; result.errorMessage = msg.errorMessage; result.model = msg.model ?? result.model; usage 累加 (input/output/cacheRead/cacheWrite/cost/turns); contextTokens = msg.usage?.totalTokens` (官方示例字段集)
- close 处理 (M4 直接照做):
```
closeError = result.error ?? assistantError(最后 errorMessage)
if (signal) result.processSignal = signal
if (!closeError && signal && !timedOut)  // slim 无 interrupted/stopped/turnBudget
  closeError = "Subagent process terminated by signal " + signal + "."
if (code !== 0 && rawStdout.trim() && !closeError && !forcedDrainAfterFinalSuccess)
  closeError = rawStdout.trim()
if (code !== 0 && stderr.trim() && !closeError && !forcedDrainAfterFinalSuccess)
  closeError = stderr.trim()
finalCode = forcedDrainAfterFinalSuccess ? 0 : (forcedTerminationSignal || signal ? (code ?? 1) : (code ?? 0))
if (!result.error && closeError) result.error = closeError
```
- 收尾判定 (exitCode===0 && !error 时): 空输出 → exitCode=1 + error "Subagent produced no output (possible model cold-start or empty response)." (hasEmptyTerminalAssistantResponse 判定可并入: 最后 assistant 消息 content 空且 usage.output===0); detectSubagentError 扫描可保留 (~30 行) 或 M4 以官方 isFailedResult 口径替代 — 规格: 两套都做, isFailedResult 是 execute 层判定 (stopReason error/aborted → isError), detectSubagentError 是消息层补强
- stderr: 有界尾部缓冲 `MAX_CHILD_STDERR_BYTES = 128KB`, close 时取 text(); 不写 transcript
- isError 构造 (execute 层返回 AgentToolResult): `isError: exitCode !== 0 || stopReason === "error" || stopReason === "aborted"`; content 优先 errorMessage → stderr → 最终输出 → "(no output)" (官方口径)

---

## 考察点 7: 与官方示例的差异

### 旧码位置
- 官方 index.ts:265-272 (getPiInvocation), :300-308 (spawn), :310-351 (processLine + stderr + close + error), :361-380 (取消 5s)
- pi-subagents execution.ts:464-471, :554-605, :1004-1027, :1083-1104, :1123-1132

### 行为描述 (差异清单)

| 维度 | 官方示例 | pi-subagents (移植源) |
|---|---|---|
| 终止协议 | 无 drain; 等 close 自然结束 | terminal stop/agent_settled → 1s grace → SIGTERM → 3s SIGKILL |
| 取消延迟 | SIGTERM → 5s SIGKILL + wasAborted → throw | SIGTERM → 3s SIGKILL, 无 throw, 走 processSignal 错误路径 |
| 取消结果 | throw Error("Subagent was aborted") | error="terminated by signal SIGTERM", exitCode 1 |
| timeout | 无 | 父进程定时器, 默认 30min, SIGINT→1s→SIGTERM→4s→SIGKILL, 诊断载荷 |
| 非 JSON 行 | 静默跳过 | 静默跳过 + rawStdoutTail 失败诊断 + 16MB 行上限/projection |
| stderr | 全量累积 (无上限) | 128KB 尾部 + transcript |
| 退出码 | code ?? 0; proc error → 1 | 强制信号时 code ?? 1; forcedDrainAfterFinalSuccess → 0; error&&exitCode 0 → 1 |
| 空输出 | 无检测, "(no output)" 文本 | exitCode 1 + 明确 error 消息 |
| usage 采集 | contextTokens = usage.totalTokens | 无 contextTokens, 有 cacheRead/cacheWrite/cost/turns |
| spawn | 无 windowsHide | windowsHide: true |
| agent_settled | 不处理 | drain 兜底触发源 |

### 移植规格
- 基线选择: 以官方示例为骨架 (M2 已定暴露面), 移植 pi-subagents 的 4 项增量: 三阶段 drain 协议 (考察点 2), timeout + 诊断载荷 (考察点 3), processSignal 错误语义 + exitCode 修正 (考察点 6), rawStdout 失败诊断 + 非 JSON 容忍 (考察点 5)
- 取消延迟取 3s (旧码值, 与 drain 一致), 不用官方 5s
- 空输出检测与 usage.contextTokens 采集从官方/旧码合并 (见考察点 6 规格)
- 行为差异清单 (交付时给用户, C-rewrite.md §4.2): 默认 timeout 15min (新), 无 fallback 重试 (D007), 无 control/interrupt (D003)

---

## 删除项确认 (本任务范围内发现, 保留集已删的旧行为)

以下行为在 execution.ts 终止/生命周期路径中发现, 保留集 (M1 DECISIONS) 已明确删除, M4 不移植:

1. **watchdog 子进程状态机** (execution.ts:586-587 armWatchdogTail, :615-628, :855-877 watchdog 事件分支; watchdog/child-status.ts): childWatchdogIsActive/agent_settled 后 watchdogTailTimeoutMs(默认 120s)/stale 状态 — 删 (D011)
2. **detach 后台化协议** (execution.ts:487-545 detachForeground, exitCode=-2, detached/detachedReason, onDetachReceipt, intercom detach 事件): 删 (D003 async 全删)
3. **interruptSignal control 中断** (execution.ts:1134-1159 + 1171-1183): interruptedByControl/result.interrupted=true/exitCode 归 0/error 清空 — 删 (D003 管理 action 全删); 注意与考察点 4 的 signal 取消区分, 取消保留
4. **turnBudget 三阶段终止** (execution.ts:741-810 requestTurnBudgetAbort: SIGINT → 1s SIGTERM → 4s SIGKILL, turnBudgetExceeded 结果构造): token 上限 (D006) 保留但作为新分支实现, 旧 turnBudget 状态机/软限/wrap-up 语义全删; 其终止信号序 (0/1000/4000) 与 timeout 同构, 可复用考察点 3 的时序常量
5. **protocol output limit 完整机制** (failProtocol + 16MB 行上限 + PI_AGGREGATE_EVENT_PROJECTOR): 官方示例无此机制; 规格保留为防御 (考察点 5 可选简化) — 若 M4 预算紧可整段删, 仅保留 128KB stderr 尾部与 rawStdout 尾部 (无上限)
6. **startup retry / model fallback 重试链** (subagent-startup-retry.ts, model-fallback.ts, execution.ts:1570-1600): 删 (D007), 连带 agent_end+willRetry→cancel-drain 分支失去主要触发源 (保留防御性处理或删, 见考察点 2)
7. **structured output 分支** (execution.ts:925-927 terminalStructuredOutputCall, :1217-1231 readStructuredOutput/MISSING_STRUCTURED_OUTPUT_CALL_ERROR): 删 (D001 保留集无此能力)
8. **completion guard / acceptance / artifacts / jsonl / transcript / 输出文件 (outputPath/outputMode/file-only)** (execution.ts 各处): 删 (D007/D011); resume (D004) 所需 session 目录与此无关
9. **assistantError 之外的控制事件流** (controlConfig/needs_attention/active_long_running/activityTimer, execution.ts:678-744, :1000-1003): 删 (D003)
10. **isUnexplainedProcessSignal 的 interrupted/stopped/turnBudgetExceeded 豁免项**: slim 结果对象不再有这三个字段, 判定简化为 `signal 非空 && !timedOut && !forcedDrainAfterFinalSuccess` (考察点 6 规格已体现)
