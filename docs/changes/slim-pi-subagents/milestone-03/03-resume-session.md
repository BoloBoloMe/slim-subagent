# M3-03 resume + session 生命周期 + pi session 写盘时机 (移植规格)

- 任务: 从 pi-subagents-main (v0.44.0, 只读) 提取 resume 相关隐性行为与可搬逻辑, 供 M4 slim-pi-subagents 施工
- 保留集依据: MILESTONE-01 DECISIONS.md D004 (resume 保留, v1 收敛=仅单子代理可 resume, 不与 parallel 组合), D003 (async 全删)
- 关键结论先行: **D012a 证实成立** — pi 侧 `--session/--session-dir` 是**增量写盘 (每 message_end 同步 appendFileSync)**, 非退出时一次写; SIGKILL 丢 in-flight turn, 恢复点 = 最后一个完整落盘 message. 静态 (dist 源码) + 动态 (/tmp e2e, pi 0.82.1) 双重证实.

---

## 考察点 1: 旧 resume 完整语义

### 旧码位置
- 入口分发: `src/runs/foreground/subagent-executor.ts:4752` (`if (action === "resume") return resumeAsyncRun(...)`)
- 主实现: `resumeAsyncRun` (subagent-executor.ts:1266-1560)
- 目标解析: `resolveForegroundResumeTarget` (subagent-executor.ts:657-716), `resolveResumeTarget` (subagent-executor.ts:730-776)
- follow-up 拼装: `buildRevivedAsyncTask` (src/runs/background/async-resume.ts:526-540)

### 行为描述
1. **参数**: `action:"resume"` + `id` (或 `runId`), 必带 `message` (follow-up 文本, 否则报错 "action='resume' requires message."); 可选 `index` (parallel/chain 子任务选择). `model` 覆盖被拒 ("reuses the persisted child model"), 恢复沿用原 model/thinking.
2. **寻址**: 双源并发解析 —
   - foreground 源 (内存态): `state.foregroundRuns` 按 `sessionId === state.currentSessionId` 过滤 (仅同父会话可见), `runId` 精确或前缀匹配, 前缀多命中报歧义; 要求 run 无 detached 子进程; `index` 必须落在 children 范围.
   - async 源 (磁盘态): `resolveAsyncResumeTarget` 读 `DIRS.async` 下的 async dir.
   - 双源同时命中且无精确匹配 → 歧义报错; 单源命中按精确优先.
3. **session 文件校验**: 目标 child 必须有 `sessionFile`, 扩展名必须 `.jsonl`, 且 `fs.existsSync` 必须真 (subagent-executor.ts:672-675), 否则报错不可恢复.
4. **恢复流程**: 新 runId + 复用原 sessionFile → `executeAsyncSingle` (后台 runner) 携带 `sessionFile: revivalSessionFile`, 即 pi 子进程以 `--session <原文件>` 打开原会话继续追加; task = `buildRevivedAsyncTask(原 run 元信息 + follow-up)` (提示模型 "Use the stored session context as background... Do not assume the original child process is still alive"); 携带 `revivalLease` 做并发锁 (见考察点 3). 复活后同一 session 文件同时含原对话与续写内容.
5. **恢复点定义**: 无显式 checkpoint 概念 — 恢复点即 session 文件里最后一个已落盘的 message (message_end 增量写, 见考察点 4). 中止原因 (timeout/token 上限) 本身不写入 session 文件; 父侧通过结果里 `timedOut`/`usageBudgetExceeded` 等标志判断可 resume.

### 移植规格 (v1: 仅单子代理前台 resume, 无 parallel 组合)
1. 参数面: `action:"resume"` + `id` (run-id 前缀可, 需歧义报错) + `message` (必填) + `timeoutMs` (可覆盖). 拒绝 `model` 覆盖, 复用原 agent/model/thinking (从 session 目录旁的 run 元信息文件读, 见考察点 2 规格).
2. 寻址: **只走磁盘 session 目录单源** (不依赖内存态, 旧 foreground 内存态寻址在 slim 中无 parallel/async 支撑价值): 在 trusted session root 下按 run-id 前缀匹配 `run-0/session.jsonl`, 多命中报歧义; 匹配不到报 "Run not found".
3. 校验: sessionFile `.jsonl` 且存在; 不存在的报错文本沿用旧码 (subagent-executor.ts:672).
4. 恢复 = 新 runId + 同一 sessionFile 的 `--session` spawn: 组装参数直接复用 M3-04 (spawn-args) 的 buildPiArgs 段 (`sessionFile` 分支, pi-args.ts:517-519); task 文本 = follow-up (可简化省略 buildRevivedAsyncTask 的包装, 或保留 2-3 行提示头 "continue the previous conversation"). 原 agent 的 systemPrompt 仍需注入 (`--append-system-prompt`), 因 --session 只恢复对话不恢复 agent 定义.
5. 恢复点语义直接采用: 最后完整落盘 message; 中止后父结果里 `timedOut`/`usageBudgetExceeded` 为 resume 判据 (与 M3-01/M3-02 结果字段对齐).

---

## 考察点 2: session 目录布局

### 旧码位置
- 根派生: `getSubagentSessionRoot` (extension/index.ts:222-229, fanout-child.ts:17-24 同款)
- run 目录组装: subagent-executor.ts:5123-5143 (`sessionRoot` / `sessionDirForIndex` / `childSessionFileForIndex`)
- flag 组装: pi-args.ts:517-528 (sessionFile 优先, 否则 --no-session + --session-dir)
- 无父会话兜底: `fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"))` (extension/index.ts:228)

### 行为描述
1. **根路径派生规则**: 父会话文件 `~/.pi/agent/sessions/<base>.jsonl` → 根 = `~/.pi/agent/sessions/<base>/` (去 .jsonl 后缀, 同目录); 无父会话 → 每次 mkdtemp 唯一临时目录. 可被 `params.sessionDir` / `config.defaultSessionDir` 覆盖 (subagent-executor.ts:5124-5131).
2. **run 目录**: `sessionRoot = <根>/<runId>` (8 位 hex, randomUUID().slice(0,8)); 子任务目录 `sessionRoot/run-<idx>/` (single 恒 `run-0`); 会话文件 `sessionRoot/run-<idx>/session.jsonl`. parallel 用 run-0..n-1.
3. **flag 组装**: `--session <file>` 存在时只推 `--session` (并 mkdir dirname); 否则 sessionEnabled=false 时推 `--no-session`, 有 sessionDir 时 mkdir 并推 `--session-dir` (pi-args.ts:517-528). 前台 single/parallel 恒传 sessionFile → 恒走 `--session`.
4. **目录内容**: 仅 pi 写入的 `<timestamp>_<sessionId>.jsonl`? 否 — `--session` 显式路径时 pi 直接写该路径 (session-manager.js `_setSessionFile`), 即 `session.jsonl` 单文件, 无其他元数据文件. 旧码没有 run 元信息文件 (model/agent 靠内存态记住).
5. **生命周期**: **旧码不删成功目录** — subagent-executor.ts 全文件无对 sessionRoot 的 rmSync; 目录永久留存于 `~/.pi/agent/sessions/<parentBase>/<runId>/`. 现有 GC 只覆盖: chain-runs 24h (shared/settings.ts:11-223) 与 artifacts 7d (shared/artifacts.ts:230-285, 启动+session 事件触发), 均与子代理 session 目录无关.

### 移植规格 (v1)
1. 根派生规则整搬 (extension/index.ts:222-229 约 8 行): 父会话 `<base>.jsonl` → `<base>/`; 无父会话时用固定 agent 目录 (如 `~/.pi/agent/subagents/sessions/`) 而非 mkdtemp, 否则 resume 无法跨进程寻址.
2. run 目录: `root/<runId>/run-0/session.jsonl`; runId 用 8 位 hex. 单子代理 v1 恒 `run-0`.
3. **新增 run 元信息文件** (旧码没有, v1 需要): resume 需知道原 agent/model/thinking, 旧码靠内存态, slim 必须落盘 → 每次 launch 时在 `sessionRoot/` 写 `run.json` `{runId, agent, model?, thinking?, cwd, startedAt, sessionFile: "run-0/session.jsonl", launchContractDigest?}` (writeAtomicJson, 约 5 行).
4. **成功即删 + 按龄 GC (D004 要求, 新行为)**: 旧码不删, 规格为 —
   - 成功 (exitCode===0 且非 interrupted/timedOut) 且未被 resume 引用 → 删除 `sessionRoot` (rmSync recursive, 在结果组装后 finally 执行);
   - 中止 (timeout/token 上限) → 保留;
   - 按龄 GC: 每次 execute/resume 入口顺带扫 `root/` 下所有 `run.json` 的 `startedAt`, 超过阈值 (建议 7 天, 对齐旧 artifacts cleanupDays=7) 且无活跃锁 (考察点 3) 的 run 目录删除; 扫面成本低 (每 run 一个 stat).
5. 组装规则整搬 pi-args.ts:517-528: resume 时传 sessionFile, 新跑时传 sessionFile (v1 恒持久化会话, 不再用 --no-session).

---

## 考察点 3: 并发 resume 锁 (session-lease.ts)

### 旧码位置
- 实现: `src/runs/shared/session-lease.ts` (全文 ~340 行)
- 使用方: 仅 async runner `src/runs/background/subagent-runner.ts:4623-4653` (revivalLease 握手) + `process-terminal.ts` 证明; foreground 直跑路径不用锁

### 行为描述
1. **锁粒度**: 以 session 文件的 canonical 标识加锁 — `canonicalSessionFilePath` (realpath) → sha256 → 锁目录 `TEMP_ROOT_DIR/session-leases/<hash>/owner.json` (TEMP_ROOT_DIR = `os.tmpdir()/pi-subagents-<scope>`, shared/types.ts:1902).
2. **owner 内容**: `{version:1, token, canonicalSessionFile, runId, sourceRunId, parentSessionId?, pid, hostname, processStartIdentity?, writerState: "none"|"spawning"|"running", writerPid?, acquiredAt, ...}`.
3. **抢占**: 写 owner.json 到 `.candidate-<token>` 临时目录后原子 `renameSync` 到锁目录; 已存在则视为冲突, 循环最多 4 次 (每次先尝试回收 stale owner).
4. **stale 判定** (防死锁): 同 hostname + owner pid 进程已死 (`process.kill(pid,0)` → ESRCH) 且 `processStartIdentity` 不匹配 (`/proc/<pid>/stat` 第 20 字段 startticks; darwin/freebsd 用 `/bin/ps -o lstart=`); writerState=spawning 时不回收; writer running 时需 writerPid 也死. 回收方式: 锁目录 rename 为 `.stale-<token>` 墓碑 (防后续竞争者误移新锁).
5. **冲突语义**: 抛 `SessionLeaseConflictError`, 消息含 owner 的 runId/sourceRunId/pid/hostname, 提示 "Wait for that revival to finish or start a separate continuation without reusing this session file."
6. **生命周期**: acquire → (async 路径) runner-startup 三握手 (ready/ack/proceed, subagent-runner.ts:4640-4652) → 子进程写 session 时 `updateWriter({state:"running", pid})` → 进程 exit 时 `release()` (删锁目录, token 校验防误删).

### 移植规格 (v1 最小锁)
1. 场景: v1 无后台 runner, resume 时原子进程已死 (timeout/token 终止协议先 SIGKILL, 见 M3-01). 锁目的收窄为: (a) 同一 sessionFile 不被两个并发 resume 同时打开 (用户/模型连发两次 resume); (b) 兜底防止原进程未死透时 resume 与之对写.
2. 最小实现 (~40 行, 可整搬 session-lease.ts 的 canonicalSessionId/sessionLeaseDir/acquire 骨架, 裁掉 writerState 三态与握手): 锁目录 `os.tmpdir()/slim-pi-subagents-session-leases/<sha256(realpath(sessionFile))>/owner.json`, owner = `{token, runId, pid, hostname, processStartIdentity, acquiredAtMs}`; 原子 rename 抢占; 冲突 → 检查 owner pid 死否 (同考察点 3 的 processIsAlive + /proc startticks), 死则 rename 墓碑后重试 (1-2 次), 活则报错 "session 已被 run X 占用".
3. resume 全流程持有: acquire 在 spawn 前, release 在子进程 exit 后 finally; `process.once("exit")` 兜底 release (死 owner 由下次抢占回收, 无需主动清).
4. 不移植: writerState 三态、runner 握手协议、process-terminal 证明链 (均属 async 体系, D003 删).

---

## 考察点 4: pi session 写盘时机 (D012a, 最重要)

### 旧码位置 (pi dist 源码, 非 pi-subagents-main)
- 写盘核心: `dist/core/session-manager.js` `_persist(entry)` (行 724-753), `_appendEntry` (754-762)
- 触发点: `dist/core/agent-session.js` `_handleAgentEvent` message_end 分支 (行 355-368): user/assistant/toolResult 消息 → `sessionManager.appendMessage(event.message)`
- 打开/新建: `dist/core/session-manager.js` `_setSessionFile` (607-657), `SessionManager.open/create/continueRecent` (1170-1273), `main.js` `createSessionManager` (205-271: --no-session→inMemory, --session→open, 默认→create/continueRecent)
- CLI flag 解析: `dist/cli/args.js:73-74` (--session-dir), `main.js:451` (sessionDir 归一化)

### 行为描述 (结论: 增量写, 每 message_end 同步落盘, 非退出时一次写)
1. `_appendEntry` 对每个 entry 同步调 `_persist`; `_persist` 逻辑 (session-manager.js:724-753):
   - 文件尚无 assistant 消息时: flushed=true 则 appendFileSync 单行; flushed=false 则**只入内存不落盘** (fileEntries 缓冲);
   - 首个 assistant message 到达时 (此时该 message 已 push 进 fileEntries): `openSync(..., "wx")` 整文件写一遍全部 entries → flushed=true;
   - 之后每个 entry: `appendFileSync` 增量追加 (同步 IO, 无批量/延迟).
2. 触发粒度: **message_end 事件** (消息完成, 含 stopReason/usage) — 流式 chunk (message_update) 绝不落盘. 所以 SIGKILL 丢的是"未到 message_end 的 in-flight 消息", 之前全部已完成消息已在盘上.
3. 新会话文件命名: 无 --session 时 `<sessionDir>/<ISO时间戳去冒号>_<sessionId>.jsonl`; 有 --session 时写显式路径. 目录在 SessionManager 构造时 mkdirSync recursive.
4. 恢复加载: 存在文件时读全部 entries 重建 byId/leaf 索引, 之后新 append 从 leaf 继续 (分支语义).

### 动态验证 (e2e, pi 0.82.1, 已清理 /tmp/pi-session-e2e)
命令与观察 (完整记录见下, 供 M5 对拍复现):
1. `pi --mode json -p --session-dir <tmp>/sess --model deepseek/deepseek-v4-flash --no-tools "先简短回答: 你叫什么名字? 然后简短回答: 1+1等于几?"` → 退出 0; sess 下生成 `<ts>_<id>.jsonl`, 内容 = session 头 + model_change + thinking_level_change + user msg + assistant msg (stop=stop).
2. 同参数跑长文任务, 在 stdout 出现 assistant 流式 (message_update) 后 1.5s `kill -9` → **sess2 目录为空** (首条 assistant 未到 message_end, user msg 被 flushed=false 缓冲, 文件尚未创建).
3. 先跑一轮两答任务建 sess3 文件; 再 `--session <sess3 文件>` 续跑长文任务, assistant 流式中 `kill -9` → 文件含 turn1 全部 (user + 2 条 stop=error 重试 assistant + 最终 stop=stop assistant) + **turn2 的 user message 已落盘**; turn2 部分 assistant 文本不落盘.

→ 三重印证: 增量写、message_end 粒度、恢复点=最后完整落盘 message、SIGKILL 丢 in-flight. **D004 的"恢复点=最后完整 turn"断言成立.**

### 移植规格 (对 M4/M5 的约束)
1. 恢复点语义直接采用, 无需 pi 侧任何配置.
2. 注意两个边角 (移植规格必须写进 v1 行为):
   - (a) 中断的 turn 其 **user message 已落盘**; resume 再追加相同 follow-up 文本 → 模型可能看到同一 prompt 两次 (一次悬空 + 一次新鲜). 旧码不处理 (buildRevivedAsyncTask 原样追加). v1 建议: 接受重复 (简单, 与旧码一致), 或 resume 时若最后一条已落盘 user 文本与 follow-up 相同则跳过追加 (可选优化, M5 对拍确认后再定).
   - (b) stop=error 的 assistant 消息也落盘 (重试痕迹); 恢复时模型可见失败尝试, 语义安全.
   - (c) 若 SIGKILL 落在工具执行期 (assistant toolCall 消息已落盘, tool_result 未落), session 文件 leaf 停在 toolCall 消息 — resume 后新 user 消息从其分支追加; 该 toolCall 是否重放取决于 pi 运行时, v1 不承诺, 标为 M5 对拍项.
3. M5 对拍脚本建议: 复现上面 3 条 e2e, 断言 (a) 会话文件行数与最后 message role, (b) kill 后目录/文件存在性.

---

## 考察点 5: /tmp 最小 e2e 记录

已执行 (pi 0.82.1, 网络模型 deepseek/deepseek-v4-flash, 均 --no-tools), 命令与观察见考察点 4 动态验证节; 全部临时文件已删 (`rm -rf /tmp/pi-session-e2e`). pi 可用, 静态分析结论与实测一致, 置信度: 高.

---

## 考察点 6: 移植规格汇总 (v1 最小实现, 行级步骤)

### 新增文件/函数建议 (总量 ~150-300 行, 对齐 D004 预估)
1. `session-root.ts` (~15 行): 整搬 getSubagentSessionRoot 派生规则 (extension/index.ts:222-229), 无父会话时回落固定 agent 目录 (非 mkdtemp).
2. `session-lease.ts` (~40-60 行): 从旧 session-lease.ts 裁剪 — canonicalSessionFilePath/canonicalSessionId/sessionLeaseDir/acquireSessionLease/release/stale 判定 (processIsAlive + /proc startticks); 删 writerState/握手.
3. resume 分支 (~60-80 行, 并入 executor):
   - `action:"resume"` 分发; 校验 message 必填 / model 覆盖拒绝;
   - 在 trusted root 按 run-id 前缀找 `run.json` → 读 agent/model/thinking/sessionFile; 多命中报歧义;
   - 校验 sessionFile `.jsonl` + 存在; acquireSessionLease → spawn (`--session <file>`, 复用 M3-04 args 组装) → finally release;
   - 结果复用 single 路径回收 (M3-02), 结果里标记 `resumed: true` + 原 runId.
4. run 元信息写盘 (~10 行): launch 时 writeAtomicJson `run.json` (考察点 2 规格 3).
5. 清理 (~30 行): 成功即删 sessionRoot (非 resume 引用时); 按龄 GC 7 天, 在 execute/resume 入口扫 root 下 run.json (跳过有活跃锁者).
6. 不实现: 内存态 foregroundRuns 寻址 (v1 磁盘单源)、index 参数、parallel/chain 组合恢复、detached/steer 变体、buildRevivedAsyncTask 包装 (可 2-3 行提示头替代).

### 与相邻 M3 产物接口
- M3-01 (01-process-lifecycle.md): 终止协议产出 `timedOut`/退出码 → resume 判据; SIGKILL 后锁 release 兜底.
- M3-02 (02-result-recovery.md): 结果 `sessionFile` 字段回填 (execution.ts:1679-1684 逻辑: sessionFile 存在或有 messages 才回填) → resume 的目标来源.
- M3-04 (04-spawn-args-frontmatter.md): buildPiArgs sessionFile 分支复用.

---

## 删除项确认 (本任务范围内发现但保留集已删的旧行为)

| 旧行为 | 位置 | 删除理由 |
|---|---|---|
| run-history.jsonl 运行账本 (recordRun/loadRunsForAgent, agent/taskHash/status/duration) | runs/shared/run-history.ts | 服务 agent-memory/refinements, D003/D011 删; resume 不依赖它 |
| async resume 全链路 (DIRS.async 寻址, subagent-runner revivalLease 握手 ready/ack/proceed, async-resume.ts resolveAsyncResumeTarget/recoveryDescriptor, process-terminal 证明链) | runs/background/* | D003 async 全删; v1 resume 只走前台单代理 |
| 双源 (foreground 内存态 + async 磁盘) 歧义消解与 detached/steer/nested/attachChain 等 resume 变体 | subagent-executor.ts:657-776, 1242-1338 | 单源磁盘寻址后无歧义; 变体均属 async/steer/intercom, D003 删 |
| 锁的 writerState 三态与 runner 启动握手 | session-lease.ts + subagent-runner.ts:4623-4653 | 无后台 runner; v1 锁收窄为 acquire/release + stale 回收 |
| 成功即删/按龄 GC: 旧码**无此行为** (子代理 session 目录永久留存); 仅 chain-runs 24h 与 artifacts 7d GC 存在 | subagent-executor.ts (无 rmSync), settings.ts:11, artifacts.ts:230 | D004 要求的新行为, 非移植, 需新写 (见考察点 2 规格) |
