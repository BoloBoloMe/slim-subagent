# M08 实现方案定稿 决策账本

产物根目录: `docs/changes/subagent-panel/milestone-08/`. 上游权威输入: PRD v2.0 确认版 + M07 账本 (`../milestone-07/DECISIONS.md`). 本轮决策经用户逐条确认 (第 1 轮 Q1-Q4 全部同意).

## 决策

### D001 模块划分: 五新文件 + 现有文件只插桩
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: slim-subagent 内新增 `log.ts` (JSONL writer/level/脱敏/taskHash/7 日 GC, M09-M10), `projection.ts` (projectSlimDetailsToRunNodes/状态映射/modelSource, M11), `card.ts` (Run Card 组件/spinner/截断, M12), `viewer.ts` (overlay/Timeline/transcript 渲染/tolerant reader, M13), `diagnose.ts` (target 解析/证据收集/findings, M14). 现有 index.ts/single.ts/resume.ts 保留执行逻辑, 只加日志插桩与 details 补丁 (M10) — **例外: M17 的 runParallelTasks per-child onUpdate 透传属功能改造** (M07 D013 拍板), 不受"只插桩"限制; registerCommand/schema 接线留 index.ts. 理由: 文件与里程碑一一对应, 冲突面最小, 单一职责; 用户确认.
- 预计影响: slim-subagent/ 新增 5 文件; index.ts/single.ts/resume.ts 插桩

### D002 M12/M13/M14 并行纪律
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: M11 完成后三者并行子代理施工. 纪律: M13 只新增 viewer.ts, M14 只新增 diagnose.ts, index.ts 归 M12; M13/M14 的接线 (registerCommand/shortcut) 由主会话在各子代理交付后统一做. 串行段: M09→M10→M17→M11 不变. 理由: 原型轮教训 = 串行太慢; 文件纪律足以防撞; 用户确认.
- 预计影响: 施工编排; M16 前主会话接线提交

### D003 单测覆盖梯度
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 必须先行的纯函数单测 (node --test, red-green): ① 投影映射 (details→RunNode 全状态机); ② 状态映射 (pending 推导/attention 聚合); ③ 日志脱敏 + taskHash; ④ diagnose target 解析 (前缀/尾段/歧义); ⑤ 卡截断省略顺序 (§4.0 逐档); ⑥ tolerant JSONL reader (无法识别行进 raw 不丢弃, M13). 名单非排他, 新纯函数按同哲学补. TUI 行为 (spinner/overlay/键盘流) 走 pty 冒烟, 每里程碑 1 轮全绿即过, 不求断言覆盖率. 理由: 逻辑密集纯函数 TDD 收益最大, TUI 单测性价比低; 用户确认.
- 预计影响: slim-subagent/test/ 新增对应测试文件

### D004 提交策略
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 每里程碑 1 个 `feat: <范围> <简述>` 提交 (代码+测试), 提交前该里程碑测试全绿; 文档产物单独 `doc:` 提交 (沿用现有惯例). slim-subagent 无独立 .git, 提交落主仓库. 理由: 用户确认.
- 预计影响: 全部施工里程碑

### D005 委派约束: 禁验证剧场
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: M09-M14/M17 委派 worker 时统一约束: 单测 + 一轮 pty 冒烟全绿即交付, 禁止深度 pty harness/反复截帧/多轮重试; 超时风险优先砍验证不砍功能. 理由: M04/M06 worker 两轮均超时在验证环节, 功能本身早已完成.
- 预计影响: 施工期所有 worker 任务书

## 事实

### F001 代码基线结构
- 状态: 当前有效
- 来源: 2026-08-15 实测 (wc -l)
- 内容: slim-subagent 源码 5 文件 2379 行: index.ts 529 / single.ts 1371 / resume.ts 263 / session-lease.ts 123 / agents.ts 93; 测试 17 文件 3588 行 (node --test); 无 package.json (jiti 直跑 ts).

### F002 走廊依赖图
- 状态: 当前有效
- 来源: ROADMAP.md 阻塞关系 (M07 后版本)
- 内容: M09→M10→M17→M11 串行; M12/M13/M14 并行阻塞于 M11; M16 (验收) 阻塞于 M12/M13/M14; M15 已关闭记因.

## 执行索引 (→ execution/issues)
- D001 → ISSUE-01..07 (文件归属)
- D002 → ISSUE-05/06/07 并行 + ISSUE-08 接线
- D003 → 各 issue TDD 切片
- D004 → 全部 (提交策略)
- D005 → 全部 (委派约束)
- F001, F002 → 全部 (代码基线/依赖图)
