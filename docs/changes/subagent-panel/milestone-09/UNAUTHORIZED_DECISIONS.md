# ISSUE-01 (日志骨架) AFK 自主决策记录

执行模式: AFK. 以下决策在权威输入未明确处由总指挥拍板, 供用户复核.

## 1. 日志根目录推导
- 问题: PRD §6.1 只写 `~/.pi/subagent_log/`, 未给代码级推导方式 (getAgentDir() = `~/.pi/agent`).
- 决策: `logRootDir() = path.join(path.dirname(getAgentDir()), "subagent_log")`.
- 理由: 与 sessions 目录 (`getAgentDir()/slim-subagent/sessions`) 同源派生, 自动继承 HOME/PI_CODING_AGENT_DIR 覆盖, 测试 withHome 隔离一致.
- 影响: 正常 `~/.pi/subagent_log`; 测试 `$HOME/.pi/subagent_log`.
- 风险: 若未来日志需迁入 agentDir 内 (`~/.pi/agent/subagent_log`), 改一处即可.

## 2. 日志 GC 的 lease 引用语义
- 问题: PRD §6.1 "若文件仍被活跃 run/lease 引用则跳过并记 L42" 与 ISSUE-01 TS-003 "活跃 lease 引用文件" 未给具体机制 (log 文件是共享按日文件, 无 per-run lease).
- 决策: `runLogGc(protectedFiles?: ReadonlySet<string>)` — 超 7 天且不在 protectedFiles 即删; 在集合内跳过并记 L42. 真实 session→log 关联 (RunNode.logCursor) 留 ISSUE-04 补, 届时 session_start 钩子由 logCursor 推导 protectedFiles 传入.
- 理由: ISSUE-01 无 logCursor, 无法建立 log 文件↔活跃 run 映射; 用注入集合保留跳过/L42 机制, 单测可确定性验证.
- 影响: 本 ISSUE session_start 调 `runLogGc()` 不传 protectedFiles (空集合), 跳过路径仅由单测覆盖.
- 风险: ISSUE-04 落地 logCursor 时须回填 protectedFiles 推导, 否则超 7 天仍被活跃 run 引用的 log 文件会被误删.

## 3. resume.ts 插桩归属
- 问题: ISSUE-01 允许范围列 "index.ts/single.ts/agents.ts", 但 L41/L42/L43 (session GC 侧) 语义落在 resume.ts 的 `runSessionGc`.
- 决策: 依 EXECUTION.md 全局允许范围 ("修改 ... resume.ts (仅插桩)") 对 `runSessionGc` 加 L41/L42/L43, 删除/跳过判定一行未改.
- 理由: L40-L44 覆盖 session 与 log 两类 GC, session GC 在 resume.ts, 不插桩则 L41/L42/L43 的 session 侧缺失.
- 影响: resume.ts 增加 3 处 logEvent 调用, 行为等价 (全量测试无新增红).
- 风险: 无 (仅加日志).

## 4. 既有测试基线漂移 (deepseek→opencode-go)
- 问题: `node --test test/*.test.ts` 基线有 3 个既有红 (agents.test.ts TC-001/002/003 断言模型 `deepseek/deepseek-v4-flash`, 但 agents/*.md frontmatter 已漂移到 `opencode-go/deepseek-v4-flash`).
- 决策: 不修 (既不回退 frontmatter 也不改测试断言), 视为既有失败, 回归标准 = 不新增红.
- 理由: agent 默认模型属产品决策, 该漂移是未记录决策变更, 超出 ISSUE-01 范围, 禁止执行期重开.
- 影响: 后续所有 issue 的"全绿"均以"89→96 过 + 仅这 3 红"为基线.
- 风险: 需用户确认该模型漂移是有意 (更新测试) 还是误改 (回退 frontmatter).
