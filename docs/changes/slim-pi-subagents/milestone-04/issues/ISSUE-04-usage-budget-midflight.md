# ISSUE-04 usageBudget 运行中终止 (选项 B)

## 父级
- `../EXECUTION.md`

## 要构建什么

token 消耗上限中止条件 (M1-D006, 用户选定 B 运行中终止, EXECUTION.md 调和 5): `usageBudget` 参数 (纯 number, 正数); 每条 message_end 的 usage 累加后立即比对, `used = input + output + cacheWrite` (cacheRead 不计, M2-D003), `used >= usageBudget` 触顶 → 复用 timeout 同款终止序列 SIGINT @0ms → SIGTERM @+1000ms → SIGKILL @+4000ms (M3-02 考察点 5 选项 B 挂点: usage 累加之后, fireUpdate 之前); 结果: `stopReason:"usage_budget"`, error=`Usage budget exhausted: reported tokens {used} reached limit {budget}.`, finalOutput=error + 有部分输出时拼部分输出 (同 timeout 拼装), 诊断载荷同 ISSUE-03 (diagnostics/usage/runId/sessionDir/hint), exitCode 1, session 保留可 resume. 适合 AFK: B 语义已由用户确认, 管线复用 ISSUE-03, 口径 M2-D003 钉死.

## 覆盖依据
- Product: `../../milestone-01/DECISIONS.md`, M1-D006
- Technical: `../../milestone-03/02-result-recovery.md` 考察点 5 (选项 B 挂点), `PORTING-SPEC.md` §四 #1 (已关闭: B)

## 相关决策
- `../../milestone-01/DECISIONS.md`: D006
- `../../milestone-02/DECISIONS.md`: D003 (口径 input+output+cacheWrite), D002 (中止载荷), D008 (usageBudget 纯 number)

## 允许范围
- `slim-subagent/` 内 message_end 累加点后的 budget 检查分支; `test/` 与 fixtures 扩展.

## 禁止范围
- 旧码调度门语义 (选项 A: parallel 启动前比对/skip) 不实现; `{soft,hard}`/costUsd 结构不实现; turnBudget 旧状态机不搬; resume 实现 (ISSUE-06).

## 代码定位提示
- M3-02 考察点 5 选项 B 段落 (挂点与结果构造); error 文案沿旧码 usageBudgetExceededMessage 改单维 (无 costUsd).
- ISSUE-03 已建终止管线 — 抽出共用或复用调用, 不重写.

## TDD 切片

- TS-001:
  接缝: execute budget 触顶路径 (fake 控制每条 assistant 的 usage).
  测试用例: TC-001 两条 assistant 累加 used 跨过 budget → 第二条后触发终止序列, stopReason="usage_budget", error 文案含 used/budget 数值, exitCode 1, 诊断载荷同 timeout; TC-002 触顶后 fake 不退 → SIGTERM/SIGKILL 时序同 timeout 管线.
  先写的失败测试: `usage budget aborts mid-flight at pinned threshold` — 失败因 budget 分支未写.
  最小绿色实现范围: 累加点比对 + 复用终止序列 + 结果构造.
  不得测试: 与 timeout 共享管线的内部组织.
  覆盖: M1-D006, M2-D003.
- TS-002:
  接缝: 口径边界.
  测试用例: TC-003 usage 含大额 cacheRead (input+output+cacheWrite 远低于 budget) → 不触顶, 正常完成; TC-004 cacheWrite 计入: used 恰等于 budget → 触顶 (>= 边界); TC-005 未传 usageBudget → 无任何 budget 行为, 正常载荷无 budget 痕迹.
  先写的失败测试: `cacheRead excluded from budget meter` — 失败因口径未写.
  最小绿色实现范围: 三字段求和 + 边界判定.
  不得测试: usage 累加本身 (ISSUE-02 已覆盖).
  覆盖: M2-D003.
- TS-003:
  接缝: 竞态.
  测试用例: TC-006 timeoutMs 与 budget 均接近触发点, fake 时序使 timeout 先到 → stopReason="timeout" (先触发者胜, 不双发).
  先写的失败测试: `first abort reason wins` — 失败因互斥守卫未写.
  最小绿色实现范围: 终止一次性守卫 (lifecycleFinished 语义).
  不得测试: 全排列时序组合.
  覆盖: M1-D005/D006 交互.

## 验证入口
`node --test "slim-subagent/test/**/*.test.ts"` 本 issue 切片全绿.

## 风险提示
- budget 检查在 fireUpdate 前同步执行, 不引入异步间隙 (M3-02 挂点要求).
- 触顶终止与 drain 已启动的竞态: terminal stop 已收到后 budget 不应再触发 (结果已干净完成) — 测试或代码守卫二选一, 选守卫.

## 停止条件
- 需要改口径或引入 costUsd/soft 层 (改 M2 决策) → 停止回用户.

## 适合 AFK 的原因
B 语义/口径/挂点/文案全部钉死, 管线复用.

## 验收标准
- [x] TS-001~003 全绿
- [x] 口径 = input+output+cacheWrite, cacheRead 不计
- [x] 触顶结果带完整诊断载荷且可 resume (session 保留)

## 被阻塞于
- ISSUE-03
