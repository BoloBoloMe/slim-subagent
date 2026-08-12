# ISSUE-02 single 执行管线贯通

## 父级
- `../EXECUTION.md`

## 要构建什么

`agent`+`task` 前台同步执行全链路 (本里程碑核心 tracer bullet):

1. **寻址与 spawn**: pi 可执行 4 级寻址链 (`PI_SUBAGENT_PI_BINARY` env → standalone 可执行名 → argv[1] CLI 脚本 → 包 bin 解析 → PATH 兜底, M3-04 考察点 1); args 组装 (M3-04 考察点 2 保留段 + EXECUTION.md 调和 8): base `["--mode","json","-p"]`, 恒 `--session <per-run 文件>`, `--model` 直传 (有才加), `--tools` csv (有才加), 恒 `--no-skills` + `--no-extensions`, `--append-system-prompt <temp 文件>` (0600, close 后清理), `Task: <task>` (>8000 字符转 `@file`); spawn 配置 `stdio:["ignore","pipe","pipe"]`, `windowsHide:true`, `env:{...process.env}`, cwd 参数覆盖/继承.
2. **session 落盘**: run-id 生成 (`run-<YYYYMMDD-HHMMSS>-<6位随机>`), 目录 `~/.pi/agent/slim-subagent/sessions/<runId>/run-0/session.jsonl` (mkdir -p), 写 `run.json` `{runId, agent, model?, cwd, startedAt, sessionFile:"run-0/session.jsonl"}` (原子写).
3. **事件流解析** (M3-02 考察点 1/2): 事件类型全集处理表; message_end 全角色 push + assistant 的 usage 6 字段累加/contextTokens=最新 totalTokens/model 取首个/stopReason (遵守调和 11: 未中止才写模型级值)/errorMessage/terminal 判定; tool_execution_start/end 进度; agent_settled → drain 兜底; tool_result_end 2 行防御; turn_end/agent_end 聚合投影保留 (M3-01 考察点 5 + M3 §四 #3, 防大输出撑爆 16MB 单行误杀); 未知事件忽略.
4. **生命周期**: 三阶段 drain (terminal stop/agent_settled → 1s grace → SIGTERM → 3s SIGKILL, forcedDrainAfterFinalSuccess 归 0, M3-01 考察点 2); 取消 (abort → SIGTERM → 3s SIGKILL, M3-01 考察点 4); 非 JSON 容忍 + rawStdoutTail 128KB (close code!=0 整段 closeError); 16MB 单行上限 failProtocol; stderr 128KB 尾.
5. **结果构造** (M3-01 考察点 6 + M3-02 考察点 4 + M3 §六): closeError 优先序, finalCode 语义, 空输出判定, getFinalOutput; 正常载荷 (M2-D002a): content=finalOutput, details=`{usage, runId, sessionDir}` (sessionDir 绝对路径, M2-D006), isError = `exitCode!==0 || stopReason==="error" || stopReason==="aborted"`, 结果对象字段按 M3 §六.

适合 AFK: 全部行为有 M3-01/02/04 逐考察点移植规格 (含常量与逻辑步骤), 无决策残留.

## 覆盖依据
- Product: `../../milestone-01/DECISIONS.md`, M1-D001 (保留集第 1 项 single)
- Technical: `../../milestone-03/01-process-lifecycle.md` 考察点 1/2/4/5/6, `02-result-recovery.md` 考察点 1/2/3/4/6, `04-spawn-args-frontmatter.md` 考察点 1/2/3, `PORTING-SPEC.md` §四 #2/#3, §六

## 相关决策
- `../../milestone-01/DECISIONS.md`: D001, D010 (--no-skills 依据), D011 (env 管线等删除项)
- `../../milestone-02/DECISIONS.md`: D002 (正常载荷), D006 (runId+sessionDir 事后审查字段), D008 (cwd 参数)

## 允许范围
- `slim-subagent/` 内实现文件与 `test/` (含 `test/fixtures/fake-pi.mjs`); EXECUTION.md 全局允许范围.

## 禁止范围
- timeout 定时器与诊断载荷 (ISSUE-03); usageBudget 分支 (ISSUE-04); tasks[] 分支 (ISSUE-05); resume 分支与 GC (ISSUE-06); 渲染 (ISSUE-07).
- fallback 重试/thinking 后缀/env 管线/resolvePiLaunchToolPlan/watchdog/detach/interrupt control/turnBudget 状态机/structured output/transcript (M3 各分片删除项确认节).

## 代码定位提示
- 官方示例 `index.ts`: 249-262 (getPiInvocation 基线), 265-308 (spawn), 310-372 (processLine/close), 86-95 (isFailedResult/getResultOutput 口径).
- M3-01 考察点 2 的 drain 逻辑步骤伪码逐行照做; 常量 FINAL_STOP_GRACE_MS=1000, HARD_KILL_MS=3000, CANCEL_SIGKILL_DELAY_MS=3000, MAX_PENDING_LINE_BYTES=16MB, stdout/stderr 尾 128KB.
- M3-04 考察点 1 寻址链必须保留项 (a)-(d); 考察点 2 保留段确认清单.
- fake-pi.mjs: 行为开关经 env/argv; 须能发罐头 JSONL, 记录收到信号的时间戳到文件, 回显 argv, 模拟长眠/挂起/非零退出.

## TDD 切片

- TS-001:
  接缝: execute (single) 返回 + 文件系统.
  测试用例: TC-001 fake 发 user+assistant(stop) 后 exit 0 → content=assistant 文本, details.usage 六字段正确, runId/sessionDir 回传且 session.jsonl 与 run.json 落盘字段齐; TC-002 两条 assistant message_end → usage 累加, contextTokens 取最新 totalTokens, model 取首个; TC-003 stopReason="error" (exit 0) → isError true.
  先写的失败测试: `single run returns final text and usage details` — 失败因 spawn 管线未写.
  最小绿色实现范围: 寻址+spawn+行解析+close 结果构造主路径.
  不得测试: 寻址链内部函数; 解析器私有状态.
  覆盖: M2-D002(a), M2-D006, M3 §六.
- TS-002:
  接缝: argv 契约 (fake 回显).
  测试用例: TC-004 argv 含 `--mode json -p`/`--session <已存在路径>`/`--no-skills`/`--no-extensions`; agent 带 model/tools 时含 `--model`/`--tools` 值; `--append-system-prompt` 文件存在且内容=agent body, 权限 0600; 末参 `Task: <task>`; TC-005 task>8000 → 末参 `@<file>` 且文件存在; TC-006 cwd 参数透传 (fake 回显 pwd).
  先写的失败测试: `spawn args follow pinned contract` — 失败因 args 组装未写.
  最小绿色实现范围: buildPiArgs 保留段全集.
  不得测试: 寻址链每级分支 (仅 TC-007 env 覆盖级可测).
  覆盖: M3-04 考察点 2, EXECUTION.md 调和 8.
- TS-003:
  接缝: 错误与退出码 (close 路径).
  测试用例: TC-007 `PI_SUBAGENT_PI_BINARY` 指向 fake → 生效 (寻址第 1 级); TC-008 穿插非 JSON 行 exit 0 → 无害; TC-009 exit 1 且有非 JSON stdout → error=rawStdout 整段; TC-010 exit 1 仅 stderr → error=stderr 文本 (断言含 "not found" 的配错模型场景); TC-011 exit 0 无 assistant 文本 → exitCode 1 + "Subagent produced no output (possible model cold-start or empty response.)".
  先写的失败测试: `non-json stdout tolerated, surfaces on failure` — 失败因容忍/诊断未写.
  最小绿色实现范围: rawStdoutTail/stderrTail/closeError 优先序/空输出判定.
  不得测试: 尾部缓冲内部实现.
  覆盖: M3-01 考察点 5/6, M3-02 考察点 3.
- TS-004:
  接缝: 终止时序 (fake 记录信号时间戳).
  测试用例: TC-012 terminal stop 后 fake 不退出 → ~1s 收 SIGTERM, exitCode 归 0; TC-013 SIGTERM 后仍不退 → +3s SIGKILL; TC-014 agent_settled (无 terminal stop) → 同样触发 drain; TC-015 abort → SIGTERM, error="Subagent process terminated by signal SIGTERM.", exitCode 1.
  先写的失败测试: `terminal stop triggers drain then SIGTERM` — 失败因 drain 未写.
  最小绿色实现范围: drain 状态机 + 取消监听 + trySignalChild.
  不得测试: 定时器内部; 信号是否 unref.
  覆盖: M3-01 考察点 2/4.

## 验证入口
`node --test "slim-subagent/test/**/*.test.ts"` 本 issue 切片全绿.

## 风险提示
- fake 时序断言用宽松区间 (如 SIGTERM 落在 0.8-2s), 防 CI 抖动; 每测试超时 <10s.
- 16MB 行上限测试不要真造 16MB 行 — 用较小临时常量注入或标人工验证, 不伪造绿 (EXECUTION.md 停止条件).
- temp prompt 文件 close 后须清理, 测试断言不留残.

## 停止条件
- 需要新增 schema 参数或改结果字段集 (M2/M3 §六之外) → 停止.
- fake pi 无法模拟的 pi 真实行为分歧 → 记录降级人工验证, 不伪造.

## 适合 AFK 的原因
移植规格含常量/伪码/字段终版, 执行 = 照规格施工 + fake 验证.

## 验收标准
- [x] TS-001~004 全绿
- [x] 结果对象字段与 M3 §六一致
- [x] session 目录/run.json 落盘符合 EXECUTION.md 调和 1/3
- [x] 无 M3 删除项确认节所列行为残留

## 被阻塞于
- ISSUE-01
