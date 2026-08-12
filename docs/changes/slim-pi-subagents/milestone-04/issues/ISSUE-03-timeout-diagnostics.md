# ISSUE-03 timeout 管线与诊断载荷

## 父级
- `../EXECUTION.md`

## 要构建什么

timeout 中止条件 (M1-D005): `timeoutMs` 参数 (正整数, minimum 1), 缺省 900000 (15min); 父进程定时器 (子进程无 flag 感知); 触发序列 SIGINT @0ms → SIGTERM @+1000ms → SIGKILL @+4000ms (M3-01 考察点 3 常量); 超时结果带诊断载荷 (M2-D002b): details 含 `stopReason:"timeout"`, `partialOutput` (已累积部分输出), `usage` (同正常 6 字段), `diagnostics {contextTokens, contextWindow, contextPercent, model}` (优先 fakeCtx.getContextUsage() 打包 — 注意: 它返回父会话上下文占用, 供"resume vs 新起"权衡, 非子代理上下文; 不可得时保底 contextTokens=最新 totalTokens + model=message.model, M3-05 推荐字段清单), `runId`, `sessionDir`, `hint` (一句话建议 resume 还是新起); finalOutput = `Subagent timed out after {ms}ms.` + 有部分输出时拼 `"\n\nPartial output before timeout:\n"` + 部分输出; exitCode 1; session 目录保留 (可 resume 前提, M1-D004). 适合 AFK: M3-01 考察点 3 + M3-05 字段清单已钉死全部行为.

## 覆盖依据
- Product: `../../milestone-01/DECISIONS.md`, M1-D005
- Technical: `../../milestone-03/01-process-lifecycle.md` 考察点 3, `05-context-window.md` 考察点 3/4 + 推荐字段清单, `PORTING-SPEC.md` §六 diagnostics 字段

## 相关决策
- `../../milestone-01/DECISIONS.md`: D005, D012(b) (上下文保底, 已被 M3-05 消解为 getContextUsage 优先)
- `../../milestone-02/DECISIONS.md`: D002 (中止载荷字段集), D008 (timeoutMs 参数)

## 允许范围
- `slim-subagent/` 内 ISSUE-02 已建管线上的 timeout 分支与诊断组装; `test/` 与 fixtures 扩展.

## 禁止范围
- maxRuntimeMs 别名 (M3-01 考察点 3 已裁); usageBudget 分支 (ISSUE-04); resume 实现 (ISSUE-06, 本 issue 只保证超时结果可 resume 的字段前提); watchdog/turnBudget 旧状态机.

## 代码定位提示
- M3-01 考察点 3: 触发序列伪码/diagnosis 拼装/remainingMs===0 短路.
- M3-05 推荐字段清单 1-5: diagnostics 来源优先级.
- ISSUE-02 已建的 drain/close 结果构造 — timeout 与 drain 的交互 (forcedTerminationSignal/finalCode) 按 M3-01 考察点 3 退出码语义.

## TDD 切片

- TS-001:
  接缝: execute 超时路径 (fake 周期发 message_end 后不退出, 记录信号时序).
  测试用例: TC-001 timeoutMs=800, fake 每 200ms 发一条 assistant → 结果 stopReason="timeout", error="Subagent timed out after 800ms.", partialOutput 含已发文本, finalOutput 拼装正确, exitCode 1; TC-002 信号时序 SIGINT→(+~1s)SIGTERM→(+~4s)SIGKILL (宽松区间断言); TC-003 超时后 details 仍带 runId/sessionDir 且 session 目录保留.
  先写的失败测试: `timeout aborts with diagnostic payload` — 失败因 timeout 定时器未写.
  最小绿色实现范围: 定时器 + 三阶段信号 + 诊断拼装.
  不得测试: 定时器内部实现; 与 drain 共享闭包的组织方式.
  覆盖: M1-D005, M2-D002(b).
- TS-002:
  接缝: diagnostics 数据源.
  测试用例: TC-004 fakeCtx.getContextUsage() 返回 {tokens, contextWindow, percent} → diagnostics 打包三者 + model; TC-005 ctx 不可得 → diagnostics={contextTokens: 最新 totalTokens, model: message.model}, contextPercent=null.
  先写的失败测试: `diagnostics prefer ctx.getContextUsage` — 失败因数据源分支未写.
  最小绿色实现范围: diagnostics 两路取数.
  不得测试: getContextUsage 内部 (pi 行为).
  覆盖: M1-D012(b), M3-05.
- TS-003:
  接缝: 参数校验与默认值.
  测试用例: TC-006 timeoutMs=0/-5 → isError 校验报错; TC-007 未传 timeoutMs, fake 任务 1s 完成 → 正常返回不被误杀 (默认 15min 生效的弱断言).
  先写的失败测试: `timeoutMs must be positive` — 失败因校验未写.
  最小绿色实现范围: 校验 + 默认常量.
  不得测试: 15min 全时长真实等待.
  覆盖: M1-D005, M2-D008.

## 验证入口
`node --test "slim-subagent/test/**/*.test.ts"` 本 issue 切片全绿.

## 风险提示
- 信号时序测试全程 ~6s, 用宽松区间; 与 ISSUE-02 drain 时序测试隔离 fake 实例防串扰.
- hint 文案给父会话模型消费, 一句话, 中文, 含 "resume 恢复 / 新起子代理" 两选项指引.

## 停止条件
- 诊断字段集与 M2-D002b/M3-05 冲突 → 停止回用户.
- getContextUsage 在 fakeCtx 注入点与真实 ctx 签名不符 → 停止.

## 适合 AFK 的原因
常量/序列/字段清单全部有规格, 无裁量.

## 验收标准
- [x] TS-001~003 全绿
- [x] 诊断载荷字段与 M2-D002b + M3-05 清单一致
- [x] 超时结果可 resume 前提 (runId/sessionDir/session 保留) 成立

## 被阻塞于
- ISSUE-02
