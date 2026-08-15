# M02 数据/日志契约修订 决策账本

产物: PRD `docs/changes/subagent-panel/pi_agent_subagent_panel_prd.md` v1.2 → v1.3 (修订已落盘).
盘问方式: deliberate (2 轮产品/技术分层 + 自扫盲区; 用户指示跳过反方攻击子代理).
行号引用基线: 主仓库 HEAD `7f7640e` (2026-08-15). slim-subagent 为主仓库子目录 (无独立 .git); PRD 声明的代码基线 commit `492d9f3` 之后代码已漂移 (+27/-14 行), 本账本一律按 HEAD 标注.

## 决策

### D001 ctx% 一律子代理口径
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: `details.contextPercent` 从父会话窗口占用改为子代理口径 `contextTokens / resolveModelWindow(子模型)`. 窗口来源优先级: 运行时 `details.model` (首个 assistant 消息的实际模型) → 调用侧 effective model → 皆未知则 null (UI 显示 `ctx —`, 不伪造). 父会话占用完全移出 details, 本期不加 `diagnostics.parentContextPercent`. resume hint 阈值逻辑 (single.ts:1229-1233, "建议 resume/新起") 同步切子口径 — hint 评估的是子 session 恢复价值, 用父口径是 bug.
- 依赖事实: F001, F007
- 理由: 父口径对观测子代理无意义且现值误导 (父 80% 时子代理可能才 5%); live 期间 contextTokens 已知 (message_end totalTokens), 窗口推导路径已存在 (F007).
- 预计影响: `assembleSingleResult` 删除 `getContextUsage` 透传 (single.ts:1196, 1213-1223); index.ts:514 调用侧不再传 `getContextUsage`; hint 阈值比较改用推导值; PRD §2.9/§3/§4.0.

### D002 final details 补字段, assembleSingleResult 单点补丁
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: final details (single/resume) 补 `mode: "single"` / `agent: string` / `taskPreview` / `timeoutMsExplicit?: number` (仅显式) / `startedAtMs` / `endedAtMs`. 补丁打在 `assembleSingleResult` 一处, single/resume/parallel-child 三路径自动继承 (parallel child 的 details 来自 runSingleAgent 返回). 完整 task 永不进 details.
- 依赖事实: F002, F003
- 理由: final 卡必须自洽; renderResult 硬编码 `agent: "subagent"` (index.ts:518) 是现状缺陷; live 卡靠调用侧快照撑住的 agent/timeout 在 final 帧丢失.
- 预计影响: single.ts `assembleSingleResult` (1266-1290 返回体) + 其调用处补传 agent/task/timeoutMs; index.ts renderResult 去硬编码; PRD §2.5/§3/§10.4.

### D003 taskPreview 截断/脱敏规则
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: taskPreview ≤120 字符, 单行化 (换行折叠为空格), 过 secret redaction; details 与日志 (§6.2 taskPreview 字段) 同一规则, 单一实现点. 完整 task 永不进 details/日志 (对齐 §6.2/§9 脱敏 MUST).
- 理由: final 卡/Panel 行/日志三处消费同一 preview, 规则分叉必然泄露或显示不一致.
- 预计影响: 新增 preview 工具函数 (实现时定位置); PRD §3/§6.2 (≤120/单行化/redaction 细则已落).
- 依赖事实: F002

### D004 R5 节点键: 键只取顶层 details.mode
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 节点键 = `toolCallId + 顶层 details.mode + (single/resume: runId; parallel child: index)`. final details 必须携带 `mode` 且与 live 一致 (D002 已补), 防 final 帧键漂移新建节点. parallel child 自带 `details.mode="single"` (继承自 runSingleAgent) 不参与键.
- 依赖事实: F002
- 理由: live emitUpdate details 带 `mode:"single"` (single.ts:819), final details 无 mode → `toolCallId + mode + runId` 在 final 帧从 "...+single+..." 漂为 "...+undefined+...", 冻结失败会新建节点.
- 预计影响: PRD §8 节点键条目; 实现时投影函数 (projectSlimDetailsToRunNodes) 按此取键.

### D005 run.json settle 补丁写 + endedAtMs 三级来源
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: settle 完成后二次原子写 run.json, 补 `endedAtMs` / `finalStatus` / `usage` 摘要; 写失败降级 warn (L07), 不阻塞终止管线. endedAtMs 来源优先级: final details → run.json 补丁字段 → session.jsonl mtime 近似 (RunNode 标 `endedAtMsSource: "mtime-approx"`) → 皆无则不显示. mtime 近似在 Viewer/Diagnostics 标注来源, Panel 行不加 "约".
- 依赖事实: F005
- 理由: Session Viewer 读 archived 时 run.json 是一手元数据, 有精确 endedAtMs 就不用扫 session.jsonl 尾部猜; elapsed 是 timeout/budget 诊断的关键证据, 近似值优于空洞, 标来源保住事实边界.
- 预计影响: single.ts settle (1021+) 增加补丁写; L07 复用; PRD §3/§8; GC 原则不变 (7 日后文件删除, 那时三级来源全失效属预期).

### D006 L16 改为 80% 阈值单发预警
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: L16 event 改名 `usage_budget.warn_80pct`: `used ≥ 80% × budget` 且未触顶 → warn, 每 run 单发 (一个布尔守卫); 挂点 = 现有 usage 累加比对处 (single.ts:875-882, 同步无间隙). 显式/自动 budget 均预警, data 标 `budgetAuto`. 触顶仍走 L17 error + abort. 已知副作用: 短 run 可能 L16/L17 连发, 可接受 (eventId 各自独立).
- 依赖事实: F004
- 理由: "接近触顶" 是有真实诊断价值的信号 (区分 "差点够" 与 "远超"); 原文案 "触顶前一刻" 无对应触发点 (检查即中止). 已排除候选: 同点 warn+error 双发 (无提前量, 诊断价值低).
- 预计影响: single.ts budget 检查块加一个条件 + 守卫布尔; PRD §6.3 L16 行/§10.8.

### D007 L13/L14 序列定界
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: L14 (debug, aggregate.projection) 挂超限行投影 finish 处 — 每次投影尝试完成, 成功/失败都记, 含 projectedBytes; L13 (error, protocol.output_limit) 挂 failProtocol 实际调用处 (投影失败或不可投影后). 同一超限行的正常序列 = L14(failed) → L13, 两条日志以 runId+toolCallId 关联.
- 依赖事实: F006
- 理由: 两者本是因果序列不是同出口; 原文案 "L14 与 L13 同出口" 定界模糊会导致实现漏记或重记.
- 预计影响: PRD §6.3 L13/L14 行; 实现时 failProtocol/投影 finish 两处挂点.

### D008 pending 状态契约
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: DisplayStatus 加 `pending`, 仅 parallel child 可推导: 批次开始按 tasks[] 全集预建行, 未进 worker (未达 L30 scheduled) 的 child 显示 pending, L30 后转 active; single 无 pending. pending 行展示从简: agent + taskPreview + `pending 等待并发槽`, 无 model/ctx/elapsed/usage (均未产生, 不伪造). §11 queued 禁令收窄为 "pending 除外". 事实边界: 失败原因展示限运行层可观测信号 (stopReason/errorMessage/exitCode/logs), 语义层 "未达到目标" 不做自动判断.
- 依赖事实: F008
- 理由: 用户 2026-08-14 补充需求拍板形态; pending 由调度器自身状态可推导, 不算伪造状态, 且解决了 "tasks>4 时后排 child 不可见" 的观测空洞.
- 预计影响: PRD §1.3/§3/§4.1/§10.2/§11; 实现时 parallel 初始 emitUpdate 即含全部 child 槽位.

### D009 resume startedAtMs 口径
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: resume 的 `startedAtMs` = 本次 resume spawn 时刻 (非原 run 启动时刻); details 已有 `resumed: true` 标识; elapsed 显示本次运行时长. 原 run 启动时刻不可复原, 不伪造.
- 依赖事实: F011
- 理由: 观测价值在 "这次跑了多久"; 原时刻无证据可复原 (run.json 被覆盖/无历史).
- 预计影响: PRD §8; resume.ts spawn 路径.

### D010 领域文档处置
- 状态: 当前有效
- 约束性: 可调整
- 内容: 不新建 `docs/language/` 与 `docs/adr/`. 本仓库无领域文档约定 (AGENTS.md 无约定, 用户未要求初始化); 术语契约由 PRD §3 承载; 本批决策全部可逆且已入 PRD + 本账本, 无满足 ADR 三准则 (难逆转/缺上下文令人意外/真实权衡) 的条目.
- 理由: domain-modeling 惰性创建原则 — 无内容需要写时不创建文件.
- 预计影响: 无 (不创建文件).

## 事实

### F001 contextPercent 现为父会话口径
- 状态: 当前有效
- 来源: slim-subagent/index.ts:514 (`getContextUsage` 透传父 ctx) + single.ts:1213-1223 (`opts.getContextUsage()` 取值)
- 内容: `details.contextPercent` 来自父会话 `ctx.getContextUsage()`, 与子代理窗口无关; live 期间子代理 `contextTokens` 已知 (message_end `usage.totalTokens`, single.ts:871).

### F002 final details 缺 mode/agent/task/timeoutMs, live details 有 mode
- 状态: 当前有效
- 来源: slim-subagent/single.ts:817-826 (live emitUpdate details 带 `mode:"single"`) vs single.ts:1267-1290 (final details 返回体无 mode/agent/task/timeoutMs); index.ts:526 (renderResult 硬编码 `agent: "subagent"`)
- 内容: final 帧信息少于 live 帧; 节点键 `toolCallId+mode+runId` 在 final 帧漂移; renderResult 无法显示真实 agent 名.

### F003 parallel child final details 继承 runSingleAgent 返回
- 状态: 当前有效
- 来源: slim-subagent/index.ts:288-318 (runChild 执行 runSingleAgent 后返回包装对象 `completed`, `details: res.details` 于 314-318)
- 内容: `assembleSingleResult` 单点补丁即可让 single/resume/parallel-child 三路径继承新字段; parallel 顶层 details `mode:"parallel"` 由 index.ts emitParallelUpdate 设置 (index.ts:281).

### F004 budget 检查同步挂 usage 累加点, 检查即中止
- 状态: 当前有效
- 来源: slim-subagent/single.ts:873-882
- 内容: `used = input+output+cacheWrite` (cacheRead 不计), `used >= usageBudget` 立即置 `budgetExceeded` 并 `startAbortSequence()`; 无 "触顶前一刻" 的独立触发时机; 守卫: 已触顶/已 timeout/已收 terminal stop 不重发.

### F005 settle 无 endedAtMs 记录
- 状态: 当前有效
- 来源: slim-subagent/single.ts:1021+ (settle 函数)
- 内容: settle 只清定时器/flush 残段, 不记时间戳; run.json 仅启动时写 (L06), 无终态补丁.

### F006 超限行先投影后 failProtocol
- 状态: 当前有效
- 来源: slim-subagent/single.ts:959-989 (超限判断 960, 投影尝试 964-968, failProtocol 出口 979 起)
- 内容: 单行超限先尝试投影 (turn_end/agent_end), 投影 finish 失败才 failProtocol; 两事件是因果序列.

### F007 子模型窗口推导路径已存在
- 状态: 当前有效
- 来源: slim-subagent/index.ts (`resolveEffectiveUsageBudget` 用 modelRegistry 查子模型窗口推导自动 budget)
- 内容: ctx% 子代理口径无需新增依赖, 复用同一窗口推导; 子模型来源: 参数覆盖 → agent frontmatter.

### F008 parallel 调度与触发点分布
- 状态: 当前有效
- 来源: slim-subagent/index.ts:265-285 (allResults 槽位 + completedFlags + emitParallelUpdate 初始 1 次/per-child 完成 1 次), 硬并发 4, tasks 硬上限 8
- 内容: 批次开始时 tasks[] 全集已知; child 进 worker (scheduled) 与完成 (completed) 是两个可观测点; pending = 全集 − scheduled 集合可纯推导, 无需新增运行时事件.

### F009 M01 overlay 实测结论 (关联约束)
- 状态: 当前有效
- 来源: docs/changes/subagent-panel/milestone-01/overlay-coexistence-research.md
- 内容: nonCapturing overlay 可承载 D 形态; 打开必须非阻塞; 关闭靠外部 handle.hide()/自触发 done(); session 事件只走 pi.on() 不走 pi.events. M02 决策不触及, 列为下游 (M06/M13) 约束.

### F010 盲区自扫结论
- 状态: 当前有效
- 来源: M02 盘问会话 (用户确认)
- 内容: 反方攻击子代理按用户指示跳过; 自扫发现 2 项定义缺口已闭环 — 窗口来源优先级 (并入 D001), resume startedAtMs 口径 (D009).

### F011 resume 复用 single 结果装配
- 状态: 当前有效
- 来源: slim-subagent/single.ts (`assembleSingleResult` opts.resumed → details 带 `resumed: true`) + resume.ts
- 内容: resume 与 single 共用 runSingleAgent/assembleSingleResult; resume final details 带 `resumed: true` 标识; startedAtMs 随本次 spawn 产生, 原 run 启动时刻无落盘证据.
