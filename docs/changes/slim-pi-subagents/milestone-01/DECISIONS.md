# slim-pi-subagents MILESTONE-01 决策账本 — 保留/删除清单

<!--
维护规则:
- 决策 D001 起, 事实 F001 起, 各自连续编号, 分命名空间.
- 决策/事实变化新建 ID, 旧条目原样保留; 改变决策内容/状态/约束性前, 必须得到我确认.
- 只记影响代码/测试/边界/追溯, 且无法从环境廉价查回的信息.
- 决策写完整内容与理由, 禁止只写摘要, 确保后续会话不丢失决策信息.
- 事实无约束性; 事实被推翻时新建 F-ID, 旧条目标已变更并附新 ID, 原样保留; 检索旧 F-ID 的全部引用, 依赖它的决策标待复核.
-->

## 决策

### D001 保留集总表 (模型可见面 + 行为面)
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 新扩展只暴露一个 `subagent` 工具, 保留能力全集 =
  1. 单次委派 (`agent`+`task`, 前台同步, 父会话阻塞等待);
  2. parallel (`tasks[]`, 并发上限 4/最大 8, 同目录执行, 无 worktree);
  3. 模型选择 (agent model 字段 → `--model` flag; 无 fallback 重试链, 配错显式报错);
  4. timeout (见 D005);
  5. resume (见 D004);
  6. token 消耗上限 (见 D006);
  7. 最小 `action:"list"` (见 D009);
  8. 内置 agents 3 个 (见 D008);
  9. TUI 官方示例级最小渲染 (renderCall 摘要 + renderResult 折叠/展开 + usage 统计, 整搬官方示例);
  10. 使用约束压缩进工具描述 2-3 行 (见 D010).
  除此之外 pi-subagents v0.44.0 的全部能力一律删除.
- 理由: 用户高频工作流 = 前台同步 single/parallel; 并发由 parallel 承担, 无需后台挂起; 规模与 token 指标优先于功能完整.
- 依赖事实: F001, F003
- 预计影响: 新扩展全部代码; ROADMAP 目的地指标已同步修订 (~1300-1600 行, ~250-400 tok)
- 实际影响: 待 M4 实现后补记

### D002 编排能力全删 (workflowScript + 参数式 chain + durable chain)
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 不实现任何编排能力 — 无 workflowScript (简化 VM 也不做), 无参数式 `chain:[{agent,task}]`, 无 durable chain (.chain.md/append-step/checkpoint). 多步流程由父会话模型自行多次调用 single/parallel 串接, 上一步输出在父上下文里天然可用.
- 理由: 用户在盘问末轮主动更改决策 (原 Q5 曾选保留 workflowScript, 后推翻); 删除后反方攻击 A3 (编排与 resume 的断层) 整体消解, 规模回落 ~1300-1600 行; 用户 skills/AGENTS.md 无 chain/workflowScript 引用, 无工作流断裂.
- 依赖事实: F003
- 预计影响: 新扩展无 VM/链调度代码; 工具 schema 无 chain/workflowScript 参数

### D003 async 后台运行全删
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 删除 async:true 后台运行, subagent_wait 工具, notify 通知, 及全部后台向管理 action (status/stop/interrupt/steer/append-step/grant-spawn-budget 等). 例外: list (D009) 与 resume (D004) 保留.
- 理由: 并发需求由 parallel 承担 (用户已确认 parallel 满足其 "父会话发起 n 个子代理并行执行并回收全部结果" 的流程); async 是最大规模开关, 保留会使规模涨至 3-5K 行且需重新推导隐性行为.
- 依赖事实: F001
- 预计影响: 无子进程 runner/结果回收链/会话目录管理 (除 D004 所需最小集)

### D004 resume 保留 (恢复中止的子代理)
- 状态: 已替代 (部分, → 见 ../milestone-02/DECISIONS.md D005/D006: session 保留策略修订为成功也保留 + 按龄 7 天 GC; run-id 寻址/用户级持久目录/锁冲突报错/恢复点条款仍有效)
- 约束性: 必须遵守
- 内容: 保留 `action:"resume"`, 用于恢复因 timeout (D005) 或 token 上限 (D006) 中止的子代理. 连带要求: 子会话持久化 (弃用 `--no-session`, 改用 per-run session 目录), run-id 寻址, 并发 resume 锁, 成功即删 session 目录 + 按龄 GC. 恢复点 = 最后一个完整 turn; SIGKILL 丢失 in-flight turn, 父缓冲部分输出不可恢复 — 此行为须 e2e 验证 (转 M3 提取规格/M5 对拍). v1 范围收敛: 仅单子代理可 resume (无编排, D002), 不与 parallel 组合恢复整组.
- 理由: 用户明确 "resume 不能删, 恢复超时或达 token 上限的子代理时要用"; 反方攻击 A1 证实机制可行 (旧码 pi-args.ts:516-519 `--session`, executor.ts:672/1285) 但成本 150-300 行, 须范围收敛.
- 预计影响: 新扩展 +session 持久化/GC/锁 ~150-300 行

### D005 timeout: 默认 15min + 诊断载荷
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 默认超时 15min (用户原决 5min, 反方攻击 A4 后改 15min), timeoutMs 参数可覆盖; 终止协议 drain → SIGTERM → SIGKILL (旧 execution.ts:531-604 可移植, ~40 行). 超时结果必须携带诊断载荷: 部分输出/产物情况/usage 统计/上下文窗口占用, 支撑父会话做两点分析 — (a) 超时原因 (执行情况与产物, 区分 "只是慢" 与异常); (b) 上下文占用是否进入 >30% 迟钝区, 权衡 resume vs 新起子代理.
- 理由: 用户决; 反方攻击 A4 (5min 收紧 6x 叠加 resume 丢 in-flight 会使超时成高频路径) 促成 15min.
- 依赖事实: F005, F006
- 预计影响: timeout 参数 + 三阶段终止 + 诊断载荷 ~60-150 行; 上下文百分比数据源待 M3 探查 (保底报绝对 contextTokens + model 名)

### D006 token 消耗上限作为中止条件
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: usage budget (token 消耗上限) 是与 timeout 并列的中止条件, 触顶即终止子代理, 结果可 resume (D004).
- 理由: 用户陈述需求 ("恢复达到 token 消耗上限的子代理").
- 预计影响: usage 累计比对 + 中止分支 ~30-60 行

### D007 acceptance/contact_supervisor/worktree/model-fallback 全删
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 删除 acceptance 验收门 (验收语义由 task 文本表达); 删除 contact_supervisor 双向通信, 且不依赖 pi-intercom 包 (日后确有需要再自行实现); 删除 worktree 隔离 (并行写冲突由 task 设计规避, 用户并行用法以只读审查/研究为主); 删除 model fallback 重试链 (配错显式报错, 不悄悄降级).
- 理由: 用户决; contact_supervisor 虽有 8 个 override 声明依赖, 但用户判断前台同步模式下 "等回复" 语义弱化为最终返回.
- 依赖事实: F002
- 预计影响: 子进程零工具注入 (仅 --append-system-prompt); 用户 settings.json 的 8 个 override 成死配置 (无副作用, 用户明确不管)

### D008 内置 agents 仅 3 个: explorer/worker/reviewer
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 新扩展内置 3 个 agent — explorer (读/探索), worker (写/执行), reviewer (审查+兜底); 对齐 codex explorer/worker/default 直觉. 旧 9 个内置 agents 全部放弃, 用户已配置的 8 个 override 角色 (researcher/context-builder/scout/planner/oracle/worker/reviewer/delegate) 不迁移, 一并放弃. 具体 prompt 内容属实施细节 (M4).
- 理由: 用户判断 "是否真的需要内置 agent — 如果一定要, 只需三个"; 旧角色不迁移是用户在知晓 override 失效事实后的明示选择 (Q12 选 b).
- 依赖事实: F002
- 预计影响: 3 个新 md 数据文件; agents/*.md 不搬运

### D009 agents 发现: user+project 目录 + project 确认 + 最小 list action
- 状态: 已替代 (部分, → 见 ../milestone-02/DECISIONS.md D007: 砍掉 project agents 发现, 只扫 user 目录; 最小 list action 条款仍有效)
- 约束性: 必须遵守
- 内容: 发现机制整搬官方示例 (user `~/.pi/agent/agents` + project `.pi/agents`, execute 时按 cwd 扫描, project agents 执行前 confirm). 另保留最小 `action:"list"` — 只回名字+一句话描述, ~40 行, ~40-60 tok. 这是对 "管理 action 全删" 的局部翻案 (其余仍删, D003).
- 理由: 反方攻击 B1 证实 — 描述是静态字符串, project agents execute 时才扫描, 纯 error-driven 发现每猜错一次浪费一轮往返; 且新内置名 (explorer) 无模型训练知识可猜. list 通道 token 账最稳 (不随 agent 数撑爆描述).
- 依赖事实: F004
- 预计影响: +list action ~40 行

### D010 skills/prompts 全删; 约束进描述; 450 tok 硬顶
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 不附带 skill, 不附带 prompts 模板. 使用约束 (单写者/同目录并行写风险) 压缩进工具描述 2-3 行 (~80-120 tok); 静态工具面 token 预算 450 为硬顶.
- 理由: 用户决; 反方攻击 B2 证实删 worktree 后约束从机制强制降为口头劝告, 模型对 pi 特有约束无训练知识, 故约束必须进每次注入的描述而非按需加载的 skill.
- 预计影响: 工具描述撰写受预算约束 (M2 定稿)

### D011 Q9 批量删除清单确认
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 以下一律不实现: watchdog 对抗二审, missions 存档, scheduled-runs 定时调度, slash 命令系统, profiles, inspectors/herdr, fleet 面板, RPC 桥, doctor, clarify TUI, steering 干预, durable chain (D002 重申), agent memory/refinements/proactive-skills, preflight/spawn-budget/mcp-allowlist, policy/authority, 跨扩展 API, config.json 配置系统 (新核心硬编码默认值).
- 理由: 三份方向报告均标为非核心/整体省略; 官方示例的存在本身即此清单可行性证明; 用户逐项确认全删.
- 依赖事实: F001
- 预计影响: 新扩展无上述任何模块

### D012 反方攻击转化的实施约束
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 反方攻击 (opposing-viewpoint, 报告见会话 2026-08-09) 成立项转化为下游约束 — (a) resume 恢复点 = 最后完整 turn, SIGKILL 丢 in-flight, e2e 验证 pi session 写入时机 (M3 提取, M5 对拍); (b) 上下文窗口 per-model 数据源未验证, 诊断载荷保底报绝对 contextTokens+model 名 (M3 探查); (c) 诊断载荷 "产物" 采集方式与字段清单 M2 钉死; (d) workflowScript 相关攻击 (B3/A3) 随 D002 消解. 舍弃项: 无.
- 理由: 反方攻击成立项若不转化为下游里程碑约束, 实施期易丢失; 攻击 (d) 已随 D002 消解故仅记前三项.
- 预计影响: M2/M3/M5 任务范围

## 事实

### F001 官方示例基线可信且已实读
- 状态: 当前有效
- 来源: /var/home/bolo/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/ (index.ts 1015 行 + agents.ts 126 行 + agents/ 4 md + prompts/ 3 md); direction-research/C-rewrite.md
- 内容: 官方示例覆盖 single/parallel (并发上限 4/最大 8)/参数式 chain/agents 发现 (user+project+confirmProjectAgents)/最小渲染/取消 (signal→SIGTERM→5s SIGKILL); 无 async/acceptance/contact_supervisor/worktree/workflowScript/durable chain/timeout/任何管理 action. 描述静态 306 字符, 无名册, unknown-agent 报错列候选 (index.ts:276-283).

### F002 用户 settings.json 有 8 个 agentOverrides, 将成死配置
- 状态: 当前有效
- 来源: ~/.pi/agent/settings.json (subagents.agentOverrides)
- 内容: 覆盖 researcher/context-builder/scout/planner/oracle/worker/reviewer/delegate 8 角色, tools 均含 contact_supervisor+intercom, systemPrompt 均有 "主管协调" 段. 该键为 pi-subagents 私有, 新扩展不读; 用户明示不迁移, 残留不管. 内置共 9 个 md, advisor 从未被配置.

### F003 用户侧无 chain/workflowScript/async 使用痕迹
- 状态: 当前有效
- 来源: grep ~/.pi/agent/skills/, ~/.pi/agent/AGENTS.md, ~/.pi/agent/agents/, .pi/ (2026-08-09)
- 内容: 无 workflowScript/subagent_wait/async 引用; 无自定义 agents 目录; 无项目级 .pi 设置.

### F004 project agents 发现为 execute 时扫描, 静态描述无名册
- 状态: 当前有效
- 来源: 反方攻击报告 B1 (reviewer 子代理, 2026-08-09) + 官方示例 index.ts:461-469 (静态描述), agents.ts discoverAgents, index.ts:276-283 (error-driven 发现)
- 内容: 工具描述在 registerTool 时静态固定; project agents 按 cwd 在 execute 时才扫描, 模型无法预知名册; unknown-agent 报错列候选是唯一兜底. 此事实促成 D009 保留最小 list.

### F005 旧前台默认超时 30min; SIGKILL 恢复点待验证
- 状态: 当前有效
- 来源: pi-subagents-main src/runs/foreground/subagent-executor.ts:1980 (DEFAULT_FOREGROUND_TIMEOUT_MS=30min), :1968 (per-agent defaultTimeoutMs); execution.ts:531-604 (三阶段终止); 反方攻击 A1
- 内容: 旧默认 30min 且有 per-agent frontmatter 覆盖; resume 恢复点 = 最后完整 turn, SIGKILL 丢 in-flight turn; pi session 写入时机 (增量 vs 退出时) 未验证, 需 e2e.

### F006 上下文窗口数据源未验证 (推测)
- 状态: 当前有效
- 来源: 反方攻击 A2 (置信度中低, 标推测)
- 内容: pi 侧 per-model contextWindow 存在于 dist/core/model-config.js:140, 但 CLI/扩展面可查性未验证; 旧 model-info.ts 无 contextWindow 字段. 诊断载荷设计须保底 (绝对 contextTokens+model 名).

## M4 引用索引 (to-execution-spec 双向索引, 不改变任何决策内容)

- D001 -> ISSUE-01~07 (分项落位, 见 milestone-04/EXECUTION.md 覆盖矩阵)
- D002/D003/D007/D011 -> EXECUTION.md 全局禁止范围 (无执行任务)
- D004 -> ISSUE-06; D005 -> ISSUE-03; D006 -> ISSUE-04 (用户已选定 B 运行中终止)
- D008 -> ISSUE-07; D009 -> ISSUE-01; D010 -> ISSUE-01 (token 实测 = M5)
- D012(a) -> ISSUE-06 (e2e 对拍 = M5); D012(b) -> ISSUE-03 (已被 M3-05 消解)
