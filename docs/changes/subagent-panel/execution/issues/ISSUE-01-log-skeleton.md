# ISSUE-01 日志骨架

## 父级
- `../EXECUTION.md`

## 执行(Execution)
- [ ] 已实现

## 要构建什么
`~/.pi/subagent_log/` append-only JSONL writer (按日分文件 `subagent-YYYYMMDD.log`) + level 体系 (trace..fatal, `PI_SUBAGENT_LOG_LEVEL`) + 脱敏 (不记完整 task/prompt/session/secret) + taskHash + 7 日 GC 挂现有 session_start (活跃 lease 引用跳过记 L42) + 最小闭环日志点 L01-L10/L25-L27/L40-L44. 可观测: 跑一次 single/parallel 后日志文件含对应 JSONL 行. 适合 AFK: 纯基建, 无产品决策.

## 覆盖依据
- Product: `../../pi_agent_subagent_panel_prd.md`, §6.1/§6.2, §10 验收 8-10 的骨架部分

## 相关决策
- `../../milestone-08/DECISIONS.md`: D001 (log.ts 归属), D003 (脱敏+taskHash 单测先行), D004 (feat 提交), D005 (禁验证剧场)
- `../../milestone-07/DECISIONS.md`: D012 (测试策略)

## 允许范围
新增 `slim-subagent/log.ts`, `slim-subagent/test/log*.test.ts`; `index.ts`, `single.ts`, `agents.ts` 仅加日志插桩 (挂 L01-L10/L25-L27/L40-L44, 不改执行逻辑); index.ts 挂 session_start GC 触发点.

## 禁止范围
不改 single.ts/resume.ts 执行逻辑; 不实现 L11-L39 (ISSUE-02)

## 代码定位提示
- 入口: `slim-subagent/index.ts` (session_start 钩子现状), `slim-subagent/session-lease.ts` (活跃 lease 判定, GC 跳过依据)
- 日志点编号语义: ROADMAP.md 笔记 "契约审计结论" + PRD §6.3 (48 日志点清单)
- 测试基建: `slim-subagent/test/helpers.ts` + 现有 *.test.ts 模式

## TDD 切片
- TS-001: 接缝 = log.ts 公开 writer API. TC-001: 写一条 info 日志 → 当日文件含该 JSONL 行且字段齐 (ts/level/event/runId/taskHash). 先写失败测试: `log writer appends daily jsonl` (log.ts 不存在). 最小绿色: writer + 按日文件名.
- TS-002: 接缝 = 脱敏函数. TC-002: 含 secret 形态的 task 文本 → 日志行不含原文, 含 taskHash. 先写失败测试: `redaction masks task, keeps taskHash`. 最小绿色: 脱敏 + sha 前缀 hash.
- TS-003: 接缝 = GC 函数. TC-003: 造 8 天前日志文件 + 活跃 lease 引用文件 → 旧文件删, lease 引用跳过且记 L42. 先写失败测试: `gc removes >7d, skips leased`. 最小绿色: GC + lease 检查.

## 验证入口
`cd slim-subagent && node --test test/log*.test.ts` 全绿 + 既有测试不回归; 手动: 真实 pi 会话跑一次 subagent 调用, `~/.pi/subagent_log/` 出现当日文件含 L01/L05/L09 等.

## 风险提示
GC 误删活跃 run 引用文件是最大风险 — lease 判定复用 session-lease.ts 现有逻辑, 不自造.

## 停止条件
需要改日志 schema (PRD §6.2) 或 lease 语义时停止.

## 适合 AFK 的原因
纯基建, 契约已在 PRD §6 定死, 无产品/API 决策.

## 验收标准
- [ ] 按日 JSONL 写入, level 过滤生效
- [ ] 脱敏: task/prompt 不落原文, taskHash 稳定
- [ ] 7 日 GC + lease 跳过 + L42
- [ ] L01-L10/L25-L27/L40-L44 挂载 (含 L43 GC 点 try/catch)
- [ ] node --test 全绿

## 被阻塞于
- 无
