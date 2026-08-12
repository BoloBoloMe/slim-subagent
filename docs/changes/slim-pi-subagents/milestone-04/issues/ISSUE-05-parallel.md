# ISSUE-05 parallel 并行执行

## 父级
- `../EXECUTION.md`

## 要构建什么

`tasks[]` 并行分支 (M1-D001 第 2 项, M2-D004): `tasks.length > 8` → isError `Too many parallel tasks (N). Max is 8.` (官方示例文案); 调度器 mapWithConcurrencyLimit (并发 4, 结果按 index 保序, 官方示例 index.ts:221-240 整搬); 全部跑完再汇总, 每任务独立 isError, 不 fail-fast; 顶层 `model`/`timeoutMs`/`usageBudget` 作为本批默认值, item 级同名字段覆盖 (M2-D008 parallel 覆盖语义); 每 child 独立 session 子目录 `run-<idx>/session.jsonl` + 各自结果带 runId/sessionDir; 同目录执行 (cwd 继承或顶层 cwd, 无 worktree). 适合 AFK: 语义 M2-D004 钉死, 调度器有官方示例现成的.

## 覆盖依据
- Product: `../../milestone-01/DECISIONS.md`, M1-D001(2)
- Technical: `../../milestone-03/04-spawn-args-frontmatter.md` 考察点 5; 官方示例 index.ts:33-34 (常量), :221-240 (调度器), :584-590 (>8 报错)

## 相关决策
- `../../milestone-01/DECISIONS.md`: D001(2) (并发 4/最大 8, 同目录无 worktree)
- `../../milestone-02/DECISIONS.md`: D004 (全部跑完汇总/独立 isError/上限硬编码), D008 (顶层默认+item 覆盖)

## 允许范围
- `slim-subagent/` 内 tasks 分支与调度器; `test/` 与 fixtures 扩展 (fake 记录启动/退出时间戳).

## 禁止范围
- worktree; fail-fast; 全局 Semaphore (M3-04 考察点 5 删除项); 跨 child 的 budget 调度门 (EXECUTION.md 调和 5: budget 只作单 child 运行中终止); parallel 结果 resume 组合 (M1-D004 v1).

## 代码定位提示
- 官方示例 index.ts: 常量 33-34, mapWithConcurrencyLimit 221-240, 聚合 execute 分支 (tasks 处理段), render 无关本 issue.
- ISSUE-02 single 管线 = 每 child 的执行单元; run-<idx> 子目录分配在调度处.

## TDD 切片

- TS-001:
  接缝: execute (tasks) 聚合返回.
  测试用例: TC-001 9 个 tasks → isError, 文案 `Too many parallel tasks (9). Max is 8.`; TC-002 3 任务全成功 → 结果按 index 保序, 各自 content/isError 独立; TC-003 1 任务 exit 1 + 2 成功 → 全部跑完返回, 失败任务 isError 透传, 汇总 content 含失败标记.
  先写的失败测试: `parallel runs all tasks and aggregates in order` — 失败因 tasks 分支未写.
  最小绿色实现范围: 分支 + 调度器 + 聚合.
  不得测试: 调度器内部 worker 组织.
  覆盖: M2-D004.
- TS-002:
  接缝: 并发上限 (fake 时间戳观察).
  测试用例: TC-004 6 个各睡 300ms 的任务 → fake 侧最大同时在跑数 ≤4, 全部完成.
  先写的失败测试: `concurrency capped at 4` — 失败因限流未写.
  最小绿色实现范围: mapWithConcurrencyLimit 限流.
  不得测试: 精确的调度先后顺序.
  覆盖: M1-D001(2), M3-04 考察点 5.
- TS-003:
  接缝: 覆盖语义与独立 session.
  测试用例: TC-005 顶层 timeoutMs=60000 + 某 item timeoutMs=300 配长任务 fake → 该 item timedOut, 其余正常; TC-006 item model 覆盖顶层 model (fake 回显 argv 断言各自 --model 值); TC-007 每 child sessionDir=run-<idx> 独立存在.
  先写的失败测试: `item overrides batch defaults` — 失败因覆盖合并未写.
  最小绿色实现范围: 顶层默认+item 覆盖合并 + per-child 目录.
  不得测试: 合并函数内部.
  覆盖: M2-D008 (parallel 覆盖语义).

## 验证入口
`node --test "slim-subagent/test/**/*.test.ts"` 本 issue 切片全绿.

## 风险提示
- 并发测试 fake 实例端口/文件隔离, 防时间戳串扰; 宽松时序区间.
- 某 child 中止 (timeout/budget) 不影响其他 child 跑完 — TC-005 已覆盖, 不要在调度器里加取消传播.

## 停止条件
- 需要 fail-fast 或跨 child budget 语义 (改 M2-D004/调和 5) → 停止回用户.

## 适合 AFK 的原因
语义与文案钉死, 调度器整搬官方示例.

## 验收标准
- [x] TS-001~003 全绿
- [x] >8 报错文案与官方示例一致
- [x] 失败 child 不阻塞汇总; 结果保序

## 被阻塞于
- ISSUE-02, ISSUE-03, ISSUE-04
