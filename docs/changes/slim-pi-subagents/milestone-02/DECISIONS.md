# slim-pi-subagents MILESTONE-02 决策账本 — 暴露面定稿

<!--
维护规则 (真实账本中不出现这些注释):
- 决策 D001 起, 事实 F001 起, 各自连续编号, 分命名空间.
- 决策/事实变化新建 ID, 旧条目原样保留; 改变决策内容/状态/约束性前, 必须得到我确认.
- 只记影响代码/测试/边界/追溯, 且无法从环境廉价查回的信息.
- 决策写完整内容与理由, 禁止只写摘要, 确保后续会话不丢失决策信息.
- 事实无约束性; 事实被推翻时新建 F-ID, 旧条目标已变更并附新 ID, 原样保留; 检索旧 F-ID 的全部引用, 依赖它的决策标待复核.
-->

## 决策

### D001 工具命名 `subagent` 同名 + 一次性切换
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 新扩展工具名保持 `subagent`, 与旧扩展同名; 新旧扩展不能同会话共存 (同名工具注册冲突). 用户明示: 测试足够可用后直接切换弃用旧 pi-subagents, 不留双轨并存期. 切换 = 卸载/移除旧扩展 (settings.json packages 移除 npm:pi-subagents), 再把新扩展移入/软链进自动装载目录 (见 D009).
- 理由: 同名让模型训练知识里的 subagent 直觉继续生效; M1 F003 未发现用户侧对旧扩展的使用痕迹 (无 workflowScript/subagent_wait/async 引用, 无自定义 agents/项目 .pi 设置), 工具名未见引用, 改名无迁移成本; 用户补充了切换节奏 (测试后直接切, 不留双轨).
- 依赖事实: F003 (M1 账本)
- 预计影响: 扩展注册名; M5 golden 对拍须新旧分会话跑 (见 F004 本账本)
- 实际影响: 待 M4 实现后补记

### D002 结果载荷形态: 正常 + 中止两套
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 分两种载荷. (a) 正常完成: content = 最后一条 assistant 文本; details 含 `usage` (input/output/cacheRead/cacheWrite/cost/turns) + `runId` + `sessionDir` 绝对路径. (b) 中止 (timeout/usageBudget): details 含诊断载荷 — `stopReason` (timeout/usage_budget/error/aborted), `partialOutput` (已有部分输出), `usage` (同正常), `contextTokens` (绝对量) + `model` 名 (F006 M1 保底), `runId` + `sessionDir`, `hint` (一句话建议 resume 还是新起). "产物情况" 由 `sessionDir` + `partialOutput` 承担, 不做独立产物扫描 (无 missions/artifacts 概念, D011 M1).
- 理由: D005/D012(c) M1 要求诊断载荷支撑两点分析 (超时原因 + 上下文占用权衡); D006 M1 要求可 resume; 用户确认字段集.
- 依赖事实: F006 M1
- 预计影响: 结果类型定义 + 载荷组装 ~40-80 行
- 实际影响: 待 M4 实现后补记

## M4 引用索引 (to-execution-spec 双向索引, 不改变任何决策内容)

- D001 -> ISSUE-01 (同名注册; 切换动作 = M6 后)
- D002 -> ISSUE-02 (正常载荷) + ISSUE-03 (中止载荷)
- D003 -> ISSUE-04; D004 -> ISSUE-05; D005 -> ISSUE-06; D006 -> ISSUE-02 (details runId/sessionDir)
- D007 -> ISSUE-01; D008 -> ISSUE-01; D009 -> ISSUE-01 (pi -e 冒烟; 移入自动装载 = M6 后); D010 -> ISSUE-01
- D011/D012 -> EXECUTION.md 元信息与全局风险 (无代码任务)

### D003 usageBudget 口径: input + output + cacheWrite, cacheRead 不计
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 参数名 `usageBudget`; 计量口径 = 子代理全程累计 `input + output + cacheWrite`, **cacheRead 不计入**. 触顶 = 走与 timeout 相同的三阶段终止 + 诊断载荷 (D005/D006 M1), 结果可 resume. cacheRead 仍完整报在 usage 统计里供诊断.
- 理由: 原案 (Q3) 曾定全计入含 cacheRead; 自扫发现 prompt caching 下每个 turn 都把整个前缀作为 cacheRead 重读, 200K 上下文跑 10 轮即 2M cacheRead, 预算是虚高的会提前触顶且不可预期. budget 的作用是成本控制 (D006 M1), cacheRead 单价极低且随轮次线性膨胀, 计入后失去可预期性. 用户确认修订.
- 依赖事实: 无
- 预计影响: 预算累计逻辑 (~30-60 行, D006 M1 量级)
- 实际影响: 待 M4 实现后补记

### D004 parallel 失败语义: 全部跑完汇总, 上限硬编码
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: `tasks[]` 部分子代理失败/中止时, 全部跑完再汇总返回, 每个任务独立 `isError`, 不 fail-fast. 并发上限硬编码: 默认 4, 硬顶 8, 不可调 (不做参数); `tasks` 超过 8 直接报错.
- 理由: 用户并行用法以只读审查/研究为主 (D007 M1 理由), fail-fast 会丢已完成的调研结果; 上限不做参数符合 D011 M1 "新核心硬编码默认值" 的配置哲学.
- 依赖事实: D007 M1
- 预计影响: parallel 调度返回聚合 ~150 行 (官方示例同款)
- 实际影响: 待 M4 实现后补记

### D005 resume 生命周期: run-id 寻址 + 用户级持久目录 + 按龄 GC
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: run-id = `run-<YYYYMMDD-HHMMSS>-<6位随机>`. session 目录放**用户级持久目录** `~/.pi/agent/slim-subagent/sessions/<run-id>/`, 不用系统临时目录 (tmpfs 重启即清空 + systemd-tmpfiles 10 天自动清, 会废掉 resume 能力). GC 按龄: 超过 7 天的 session 目录自动删除, 挂在扩展 `session_start` 时扫一次. 并发 resume 同 run 显式报错 "already running", 不排队 (前台同步模式下排队会卡死父会话). resume 成功完成即删 session 目录的 M1 原决**废除** — 成功 run 也保留, 统一按龄 7 天 GC (见 D006). 恢复点 = 最后一个完整 turn, SIGKILL 丢 in-flight turn (D012a M1).
- 理由: 用户问询后确认 — resume 是点名保留能力, 不该被重启废掉; GC 代码 ~15 行成本可忽略.
- 依赖事实: F001 本账本 (子会话持久化机制), D004 M1, D012a M1
- 预计影响: 目录管理 + GC + 锁 + 寻址 ~150-300 行 (D004 M1 量级)
- 实际影响: 待 M4 实现后补记

### D006 事后审查为必要产品功能
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 用户明示 "事后审查子代理 session 几乎是刚需", 记为必要产品功能. 每次运行 (成功/中止) 结果 details 一律带 `runId` + `sessionDir` 绝对路径; 用户可用 `pi --session <sessionDir下的session.jsonl>` 打开子代理完整对话记录审查. 目录统一按龄 7 天 GC (D005), 7 天内任何子代理行为可回看. 对 D002 的修订: 正常完成的 details 从 `usage + runId` 扩为 `usage + runId + sessionDir`.
- 理由: 新扩展是全新代码, 调试期 (M5/M6) 事后审查子代理 session 是刚需; 7 天后自动清无堆积 (单次运行几十-几百 KB 文本).
- 依赖事实: F001 本账本 (session 格式与 --session 用法)
- 预计影响: details 字段 + 目录保留策略 (已并入 D005/D002 实现)
- 实际影响: 待 M4 实现后补记

### D007 砍掉 project agents 发现 (对 M1 D009 局部翻案)
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 不实现 project agents 发现 (`<项目>/.pi/agents/` 扫描 + confirm). 只扫 user 目录 `~/.pi/agent/agents/`; schema 不含 `agentScope`/`confirmProjectAgents` 两个参数; agents 发现 = user 目录 frontmatter md 加载 (官方示例 agents.ts 简化, ~126 行 → 更少). 将来确有需要 project agents 时再从官方示例搬回 (现成代码, 半小时).
- 理由: 用户确认 — (1) 用户无任何 project agents 也无计划 (M1 F003); (2) 官方默认 agentScope="user" 下 confirm 本就不触发; (3) 砍掉省 2 个 schema 参数 (~40-60 tok) 与 ~80 行代码, 且从威胁模型删除一整条供应链注入通道 (clone 他人仓库 → md 注入子代理 system prompt).
- 依赖事实: F002 本账本 (官方 confirm 行为实证), M1 F003
- 预计影响: 无 agentScope/confirmProjectAgents 参数; 无项目目录扫描代码
- 实际影响: 待 M4 实现后补记

### D008 schema 恰好 9 参数定稿
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 参数表 (对照旧 63 参数):
  1. `agent` (string, 必需, action="list" 时可省) — agent 名
  2. `task` (string) — 单次任务; 与 `tasks` 互斥
  3. `tasks` (array) — parallel; item = `{agent, task, model?, timeoutMs?, usageBudget?}`, ≤8
  4. `model` (string?) — 覆盖 agent frontmatter 的 model
  5. `timeoutMs` (number?, 默认 900000=15min) — 超时毫秒
  6. `usageBudget` (number?) — 累计 input+output+cacheWrite token 上限, 触顶中止
  7. `cwd` (string?) — 子代理工作目录, 默认继承父会话
  8. `action` (enum? `"list"`/`"resume"`) — 缺省 = 执行
  9. `id` (string?) — resume 目标 run-id
  parallel 覆盖语义: 顶层 `model`/`timeoutMs`/`usageBudget` 作为本批默认值, item 级字段覆盖之. 预估 schema JSON ~1800-2200 chars ≈ 250-300 tok. 条件必填 (agent 在 list 时省) 由 execute 校验 + 报错承担, typebox 不表达.
- 理由: 对照 C-rewrite 官方示例 API 面 + B-surface-trim token 账本裁剪; 无 agentScope/confirmProjectAgents (D007), 无 output/reads/skills 等附加面 (D011 M1).
- 依赖事实: D011 M1
- 预计影响: schemas.ts ~100-150 行 + execute 校验
- 实际影响: 待 M4 实现后补记

### D009 装载方式: 本地扩展目录 + 两阶段切换
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 本地扩展目录 `~/.pi/agent/extensions/slim-subagent/index.ts` (pi 自动装载, jiti 免编译, `/reload` 热重载), 目录名 `slim-subagent`, 单 `index.ts` 入口, 不需要 package.json, 不做 npm 包. **两阶段装载** (对 Q8 的补充): 测试期 (M5/M6) 新扩展留在仓库目录, 用 `pi -e <路径>` 显式加载验证 — 因本地扩展目录自动装载, 一旦放进即与旧扩展在每个会话冲突 (同名工具, D001); M6 验证通过后卸载旧扩展 (移除 settings.json packages 的 npm:pi-subagents), 再把新扩展移入/软链进自动装载目录完成切换.
- 理由: 与 "不发布给他人" (范围外) 一致; 测试期 pi -e 显式加载同时天然满足 M5 golden 对拍的新旧分会场需求.
- 依赖事实: 无
- 预计影响: 目录布局; M5 对拍脚本用 -e 加载
- 实际影响: 待 M4 实现后补记

### D010 工具描述中文定稿 (v3)
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 描述用**中文**, 符合 writing-for-agents 要求 (指针措辞, 正向表述, 杀空操作, 引导词). 定稿全文:
  `把可独立的任务优先委派给子代理, 保持主会话上下文精简; 调用后阻塞等待结果. 单次: agent + task. 并行: tasks[] (≤8, 并发 4), 全部跑完, 失败逐任务报告 — 适合只读工作 (审查/研究) 和写互不重叠产物的任务; 改动共享文件 (项目代码/配置) 须串行单写. action:"list" 发现可用 agents; "resume" + id 恢复被 timeout/usageBudget 中止的运行.`
  语义要点: 首句 = 鼓励委派杠杆 (模型默认倾向自己干活, "优先委派" 是真行为杠杆) + 理由 (保持主会话上下文精简, 可迁移到未列场景); "阻塞等待" 消除 async 先验歧义; 并行/单次 = 分支触发器; 写入三档正向规则 (只读→并行 / 写互不重叠产物→并行 / 共享文件→串行单写, 判定标准 = "共享文件 (项目代码/配置)" 而非黑名单); action 句 = 辅助分支触发器. 用户两点要求已并入: 鼓励多用子代理 + 写入语义 (并行只给读/互不重叠产物, 共享文件串行单写).
- 理由: 用户指定中文 + writing-for-agents; 描述是常驻注入的指针, 逐词付费, 只写能改变默认行为的内容 (D010 M1: 450 tok 硬顶).
- 依赖事实: D010 M1, D001 M1 (约束进描述)
- 预计影响: 描述字符串 + 预算实测 (M5); 预估总账 420-540 tok, 超限剪枝顺序: (1) schema 参数描述再压; (2) 删 "全部跑完, 失败逐任务报告"; (3) 删理由句只留裸杠杆. 鼓励句与写入约束不剪.
- 实际影响: 待 M4 实现后补记

### D011 范围切割: 模块设计 → M4, 测试设计 → M5
- 状态: 当前有效
- 约束性: 必须遵守
- 依赖事实: 无
- 内容: MILESTONE-02 只钉暴露面 (schema/描述/装载/载荷/session 策略). 模块内部设计 (文件拆分/接口, 按 codebase-design 原则) 属 MILESTONE-04 执行域; 测试设计 (按 tdd 哲学) 属 MILESTONE-05 执行域. 本切割已向用户明示, 用户无异议.
- 理由: 避免在暴露面未定时过早钉实现细节; deliberate skill 的技术层面在此 Milestone 收敛到暴露面.
- 预计影响: M4/M5 范围
- 实际影响: 待 M4/M5 补记

### D012 反方攻击环境失败, 降级纯自扫 (记录性质)
- 状态: 当前有效
- 约束性: 可调整
- 依赖事实: 无
- 内容: 扫描盲区时派出的反方攻击子代理 (reviewer) 因模型配置失败 (ai-work-deepseek/ai-work-zai 均无 API key), 按 grilling 规则禁止重试, 降级为加深自扫. 自扫产出两项真实修正: usageBudget 口径 (D003) 与两阶段装载 (D009). 其余自扫项判定无决策影响. 注意: 后续校验/审查子代理可能同样受模型配置影响, 需显式指定可用模型 (见 F003).
- 理由: 记录降级事实, 供后续 Milestone 校验时参考.
- 预计影响: M4/M5 校验子代理须显式指定模型
- 实际影响: 无

## 事实

### F001 pi 会话存储机制实证
- 状态: 当前有效
- 来源: pi docs/sessions.md, docs/session-format.md; 本机 ~/.pi/agent/sessions/ 实况
- 内容: pi 会话 = JSONL 文件, 每行一个带 type 的事件 (session/message/tool 等), 树形 id/parentId 结构. 默认存 `~/.pi/agent/sessions/--<cwd>--/<父会话时间戳>_<uuid>/<run-id>/run-N/session.jsonl`. `--session <path|id>` 打开/继续指定会话, `--no-session` 临时模式不落盘. 旧 pi-subagents 的子会话即存于此处 (实测路径含 run-0/run-1 目录). 此机制是 resume 的原料与事后审查的入口.

### F002 官方示例 project agents 行为实证
- 状态: 当前有效
- 来源: examples/extensions/subagent/agents.ts:99-115, index.ts:443-524 (已实读)
- 内容: 官方示例 `agentScope` 默认 `"user"` — project agents (项目 `.pi/agents/`) **默认不扫描**; 显式 agentScope="both"/"project" 才扫. confirm 仅在 project 范围启用且 `confirmProjectAgents` (默认 true) 时触发, 且为**批量一次** — 收集本批所有 project agents 名单, 单次 `ctx.ui.confirm` (index.ts:511-518), 非逐 agent 弹窗. 用户当前无 project agents (M1 F003).

### F003 可用模型环境 (校验用)
- 状态: 当前有效
- 来源: ~/.pi/agent/auth.json, ~/.pi/agent/settings.json, 本机 env (DEEPSEEK_API_KEY, PI_PROVIDER), pi docs/models.md
- 内容: 本机 auth 仅有 `kimi-coding` OAuth, 但对应 provider 名并非 moonshotai (显式指定 `moonshotai/kimi-k2.5` 实测无 key 失败). 实际可用 = env `DEEPSEEK_API_KEY` (sk-bec9...) + provider `deepseek` / model `deepseek-v4-flash` (本会话即用它, PI_PROVIDER=deepseek, PI_MODEL=deepseek-v4-flash). 反方攻击与首次校验失败的真实原因 = 内置 reviewer agent 配置引用不存在的 `ai-work-deepseek`/`ai-work-zai` provider (全盘无 ai-work 痕迹). 后续派子代理: 若默认 agent 配置引用 ai-work-* 会失败, 显式指定 `model: "deepseek/deepseek-v4-flash"` 可绕过; 不指定且 agent 默认配置正常时默认解析不失败.

### F004 M5 golden 对拍须新旧分会话 (操作事实)
- 状态: 当前有效
- 来源: 自扫发现 (M2 盘问)
- 内容: 新旧扩展工具同名 `subagent` (D001), 同一会话装不下两个, 而 M5 对拍要新旧各跑同一任务比输出. 解法: 两个独立会话 — 一个只装旧 (settings packages), 一个用 `pi -e` 只装新 (D009 测试期形态), 分别跑同一 task 后比输出/usage. 不改变任何决策.
