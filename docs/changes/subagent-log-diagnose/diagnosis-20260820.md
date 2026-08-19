# Subagent 运行诊断报告 (只读)

- 日期: 2026-08-20
- 范围: 结构化日志 `~/.pi/subagent_log/subagent-YYYYMMDD.log` (20260816~20260820, 1633 条事件) + 子代理会话 `~/.pi/agent/slim-subagent/sessions/` (95 个 run 目录 / 141 个 session.jsonl) + 本仓 `slim-subagent` 源码交叉核对
- 方式: 只读诊断, 未修改任何运行产物

## 结论摘要

- 真实 run 91 次: 89 成功, 1 次外部中止 (exit 143), 1 次注入短超时→resume 成功
- 197 条合成测试事件 (`agent=Alpha, runId=run-20250101-000000-abc123`) 混入日志, 无显式标记
- 无数据损坏/无泄漏级 bug; 主要问题是"日志可归因/可审计"属性被削弱 + 少量数据语义缺陷
- 真成本 $5.41, 其中 08-19 kimi 日 $5.18 (占 96%)

## 发现的问题 (按严重度排序)

### B1 (中) 并行子代理在日志中无法归因到具体 child
- 同一 parallel batch 的每个 child, 其 `run.id.created`/`single.spawn.start`/`single.result.final` 全部复用父 runId; `batchRunId`/`childIndex` 在全量事件中 0 出现
- 例: `run-20260816-131622-faf56d` 三个 child 三条 result 同 runId, data 无 idx
- 运行态 idx 只存在于磁盘 `<batchRun>/run-<idx>/session.jsonl` 目录序; 日志与之一一对应只能靠时间顺序猜
- 证据: 字段计数 batchRunId/childIndex=0; subagent-20260816.log 05:16:22 三条 child 事件同 runId; 对拍 `sessions/run-20260816-131622-faf56d/run-{0,1,2}/session.jsonl`

### B2 (中低) 高频事件缺 runId
- `message_end.usage`(220)/`single.update.emit`(180)/`timeout.armed`(31)/`tool.execute.start`(63)/`process.close.settled`(91)/`parallel.child.*`(49+49) 全部不带 runId
- 成本/时长/超时归因只能靠 pid+ts 启发式; pid 跨天复用使启发式不可靠
- 证据: 以上事件带 runId 计数均 0

### B3 (低) `isError` 字段失真
- 真实 run 的 91 条 `single.result.final` isError 恒 None; 真实失败只能看 exitCode/stopReason
- 197 条合成事件的 isError 有真值 (含 197 条假 "isError=true, exit=0")
- 按 isError 聚合会得 197 个假失败; 同一语义两套表示
- 证据: 真 run result isError=None; Alpha 假事件 197 条

### B4 (低) 唯一中止无来源语义
- 全数据集唯一 abort: `signal.abort_requested` 只记 `{aborted:true}` + SIGTERM; 无法区分用户中断 vs 内部取消
- child exit=143 `stopReason=toolUse` 表示工具执行中被杀, 语义不直观
- 证据: subagent-20260816.log#227-228 (eventId 3a563bc2, d3db0bfb) + run-131622-faf56d child#2 result

### B5 (低) 日志轮转日期与 ts 时区不一致
- 文件名按本地日, `ts` 为 UTC(Z); 跨日事件落入相邻文件, 按文件名推断日期偏移 8 小时
- 证据: subagent-20260820.log 内含 `ts=2026-08-19T16:53:57` 事件 (eventId ad7b8c05)

## 各问题具体影响

- B1: 失败率/成本/时长只能做 batch 粒度粗账; 自动化告警按 runId 去重会把 batch 当 1 个 run, 少计失败, 失败率系统性低估; 排障要靠人工开 session 目录对拍
- B2: 最贵的 `message_end.usage` 不可定位到 run; 超时链路无法闭环审计; 工具执行时长性能分析做不了
- B3: 任何按 isError 过滤的消费者被 197 条假失败污染, 同时又漏真实失败信号
- B4: 若"内部取消逻辑出错"这类 bug 已发生, 无日志证据能区分它与用户主动操作
- B5: 日切成本统计口径漂移 (按文件名 vs 按 ts 差 8 小时); 日志 TTL 按文件名做会早删/晚删

## 优化建议

- A. child 事件补 `batchRunId`+`childIndex`; 其余高频事件补 `runId`
- B. 真实 `single.result.final` 填充 isError (=exitCode!==0), 与合成事件一致
- C. 合成测试事件加显式 `{fixture:true}` 或独立通道, 防污染统计
- D. 效率: `run-20260819-223337-6beb85` (737s/51 tool turns) 内 `pytest tests/testbed -q` 同命令 15 次 + 变体 14 次; 建议迭代期用 scoped 用例, 收尾才全量
- E. GC 日志只记 delete.ok 无 kept/scan 统计; 建议补一行 summary (scanned/kept/deleted)
- F. 超时/resume 链路已验证正常, 无需改

## 证据缺口

- per-child 成本/耗时无法精确归因, 只能按 session 目录序对拍
- GC_AGE_MS 常量值未核对 (源码注释 7 天, 行为吻合)
- 唯一 abort 的调用方来源无法确认
- 197 条 fixture 的注入机制无日志, 仅凭 runId 特征辨识
- 无 trace 级事件, 内部执行细节不可见

## 已排除项 (非 bug)

- 唯一 `timeout.fired` (18s, eventId 004be2db) 是注入测试; 超时→SIGINT→lease→resume 闭环成功
- GC 行为与源码一致 (7 天按龄 + 活跃锁豁免, `index.ts` session_start 挂点 / `resume.ts` runSessionGc), 20 次删除全为 8-12/8-13 龄期满者
- 磁盘结构正确: batch 根目录 run.json + run-<idx>/session.jsonl; 子代理不单独写 run.json 属设计
