# ISSUE-06 resume 与 session 生命周期

## 父级
- `../EXECUTION.md`

## 要构建什么

`action:"resume"` 与 session 目录生命周期 (M1-D004, M2-D005/D006):

1. **resume**: `id` 必填 (run-id 前缀匹配, 多命中歧义报错, 无命中 "Run not found"), `task` 必填 (follow-up 文本, EXECUTION.md 调和 6), `model` 同用报错, `timeoutMs`/`usageBudget`/`cwd` 可覆盖; 寻址 = 扫 `~/.pi/agent/slim-subagent/sessions/*/run.json` 单源磁盘; run.json 属 parallel 批次 → 报 "v1 仅支持 single resume" (M1-D004); sessionFile 校验 (.jsonl + 存在, 报错文本沿旧码 M3-03 考察点 1); 恢复 spawn = `--session <原 sessionFile>` + 原 agent 的 `--append-system-prompt` 重建 + follow-up 原文追加 (接受中断 turn 重复, M3 §四 #5); 结果标记 `resumed:true`, runId/sessionDir = 原 run 的.
2. **并发锁** (M3-03 考察点 3 最小锁 ~40-60 行): `os.tmpdir()/slim-subagent-leases/<sha256(realpath(sessionFile))>/owner.json` {token, runId, pid, hostname, acquiredAtMs}; 原子 rename 抢占; 活冲突 → 报错 "already running" (M2-D005 语义, 不排队); owner pid 死 → 墓碑回收重试 ≤2; spawn 前 acquire, 子进程 exit 后 finally release, `process.once("exit")` 兜底.
3. **按龄 GC** (M2-D005): 扩展 `session_start` 时扫 sessions/ 下所有 run.json, `startedAt` 超 7 天且无活跃锁 → 删 run 目录.

适合 AFK: M3-03 全片规格 + M2-D005 钉死; D012a (恢复点=最后完整落盘 message) 已由 M3 e2e 证实, 本 issue 只消费语义不重复验证 (e2e 对拍 = M5).

## 覆盖依据
- Product: `../../milestone-01/DECISIONS.md`, M1-D004
- Technical: `../../milestone-03/03-resume-session.md` 考察点 1/2/3/4 (移植规格节), `PORTING-SPEC.md` §四 #5

## 相关决策
- `../../milestone-01/DECISIONS.md`: D004, D012(a)
- `../../milestone-02/DECISIONS.md`: D005 (目录/格式/GC/锁语义), D006 (事后审查)

## 允许范围
- `slim-subagent/` 内 resume 分支/锁模块/GC hook; `test/` 与 fixtures.

## 禁止范围
- 内存态寻址/index 参数/parallel 组合恢复/buildRevivedAsyncTask 包装/writerState 三态与握手 (M3-03 删除项); 成功即删 (已废除, 调和 2); resume 新建 run 目录 (结果沿用原 runId).

## 代码定位提示
- M3-03 考察点 1 移植规格 1-5 (参数/寻址/校验/恢复 spawn); 考察点 3 移植规格 1-4 (最小锁); 考察点 2 移植规格 3 (run.json — ISSUE-02 已写盘, 此处消费).
- 旧码报错文本: pi-subagents-main `src/runs/foreground/subagent-executor.ts:672-675` (session 文件校验), `src/runs/shared/session-lease.ts` (锁骨架裁剪源, 只读参考).
- GC 挂点: pi 扩展 `session_start` 事件 (官方示例无, pi docs/extensions.md 事件表).

## TDD 切片

- TS-001:
  接缝: execute (resume) 返回 + fake argv.
  测试用例: TC-001 先 single 跑出 run (fake 建 session.jsonl), 再 resume → fake 收到 `--session <原路径>` + follow-up 文本 + 原 agent prompt 文件; 结果 resumed:true, runId=原; TC-002 id 前缀匹配成功/多命中歧义报错/无命中 "Run not found"; TC-003 缺 id/缺 task/带 model → 各报错; TC-004 sessionFile 被人为删除 → 报错 (旧码文本).
  先写的失败测试: `resume reopens persisted session with follow-up` — 失败因 resume 分支未写.
  最小绿色实现范围: 寻址 + 校验 + 恢复 spawn + 结果标记.
  不得测试: run.json 解析内部; 锁 (TS-002).
  覆盖: M1-D004, M2-D005.
- TS-002:
  接缝: 并发锁.
  测试用例: TC-005 第一个 resume 的 fake 挂住不退出, 第二个同 id resume → "already running"; 不同 id 不受影响; TC-006 伪造 owner.json (pid=不存在) → stale 回收后 resume 成功; TC-007 第一个 resume 子进程退出后锁释放, 同 id 可再 resume.
  先写的失败测试: `concurrent resume on same run rejected` — 失败因锁未写.
  最小绿色实现范围: acquire/release/stale 回收.
  不得测试: /proc startticks 解析细节 (processIsAlive 即可).
  覆盖: M2-D005 (锁语义), M3-03 考察点 3.
- TS-003:
  接缝: GC (session_start hook + 文件系统).
  测试用例: TC-008 造 startedAt=8 天前与 3 天前的 run 目录 → 触发 hook → 8 天删, 3 天留; TC-009 超龄但有活跃锁 (owner pid=当前进程) → 跳过不删.
  先写的失败测试: `gc removes sessions older than 7 days` — 失败因 GC 未写.
  最小绿色实现范围: 扫描 + 龄期判定 + 删除 + 锁豁免.
  不得测试: session_start 的 pi 内部触发机制 (hook 直接调用测).
  覆盖: M2-D005.

## 验证入口
`node --test "slim-subagent/test/**/*.test.ts"` 本 issue 切片全绿.

## 风险提示
- 锁测试用真实子进程挂住 fake, 注意测试收尾强杀防泄漏; 锁目录用临时 tmpdir 隔离.
- resume 复用 single 结果回收全路径 (ISSUE-02), 中止载荷 (03/04) 同样适用 — 不重复测试, 只测 resume 特有分支.

## 停止条件
- 需要 parallel 组合 resume 或 message 独立参数 (改 M1-D004/M2-D008) → 停止回用户.

## 适合 AFK 的原因
寻址/锁/GC 全部有移植规格与决策钉死.

## 验收标准
- [x] TS-001~003 全绿
- [x] 锁冲突文本含 "already running"; stale 可回收
- [x] GC 7 天龄期 + 锁豁免生效; 成功 run 不删 (调和 2)

## 被阻塞于
- ISSUE-03, ISSUE-04
