# 子代理 (subagent) 产品功能设计调查报告

- 调查日期: 2026-08-08
- 调查对象: Claude Code, Codex (OpenAI), pi-subagents (pi 社区插件, nicobailon/pi-subagents)
- 调查范围: 仅产品功能层面 (功能如何被呈现, 触发, 约束, 沉淀), 不涉及具体实现
- 配套可视化: `/tmp/pi-presentation-LDjNoG/2026-08-08-subagent-design-three-way.html`

## 1. 调查背景与方法

三家 coding agent 工具均提供了子代理能力. 本报告基于三方一手资料:

- Claude Code 官方文档 `code.claude.com/docs/en/sub-agents`
- Codex 官方文档「Subagents」页 (learn.chatgpt.com 镜像) 及 GitHub openai/codex issue #2604
- pi-subagents 仓库 README, `docs/agents.md`, `docs/workflows.md`

方法: 提取三方文档中的产品决策 (定位表述, 触发模型, 定义格式, 权限模型, 运行管理, 成本表述), 先归纳共性, 再对比分歧, 最后收拢为各自的产品哲学与取舍.

## 2. 问题定义: 同一个敌人, 两种表述

- Claude Code: 搜索记录, 日志, 文件内容会 "flood your main conversation".
- Codex: 直接引用术语 **context pollution** (上下文污染) 与 **context rot** (上下文腐烂, 引 Chroma 研究).
- pi-subagents: 几乎不谈上下文, 主打 "a second or third set of model eyes" (第二/第三双眼睛).

结论: 商业两家主治**上下文噪声**; 该插件还治**轻信** (单模型一本正经犯错, 换个脑子/换家厂商模型再审一遍). 这一表述差异预告了后续全部产品分歧.

共同处方: 主上下文是系统中最贵的资产, 噪声任务外包给独立上下文窗口的子代理, 只把摘要带回主线 (上下文卫生).

## 3. 共同骨架 (行业已收敛部分)

1. **运行骨架**: 主线程分派 → 子代理并行 → 摘要汇聚回主线.
2. **内置最小角色集**: 读 (探索), 写 (执行), 审查/兜底.
   - Claude Code: Explore / general-purpose / Plan (+ claude 兜底)
   - Codex: explorer / worker / default
   - pi-subagents: scout / worker / reviewer / delegate, 另加 oracle (决策质疑)
3. **文件即定义**: 一个文件 = 一个 agent; 项目级/个人级两处存放; 鼓励项目级入库共享. Claude Code 与 pi-subagents 同为 Markdown + YAML frontmatter; Codex 为 TOML.
4. **权限默认继承, 可按 agent 收紧** (如钉成只读/窄工具白名单).
5. **模型与算力按角色分配**: 探索用便宜快模型, 审查用高档推理; pi-subagents 另支持跨厂商 fallbackModels.
6. **明示成本**: 两家商业文档均警告子代理独立消耗 token, 账单高于单线程.

## 4. 分歧分析

### 4.1 谁来决定 spawn (触发模型)

| 产品 | 触发哲学 | 关键证据 |
|---|---|---|
| Claude Code | 自动委派是一等设计 | 模型按 description + 任务 + 上下文自动路由; description 可写 "use proactively"; 显式通道兜底三级 (自然语言/@-mention/--agent) |
| Codex | 显式触发是一等设计 | 文档原话 "Codex only spawns subagents when you explicitly ask it to"; description 官方定性为 human-facing guidance |
| pi-subagents | 意图在人, 编排在模型 | 用户自然语言点名意图 ("Use reviewer to review this diff"), 是否调用/选谁/怎么组合由 Pi 自主决定; README 明确 "装插件 ≠ 自动 reviewer, 它只是给了 Pi 一把委派的工具" |

洞察: 同一个 description 字段有三种读者 — Claude Code 喂给模型当路由信号, Codex 写给人当门牌, pi-subagents 两者兼顾且允许人在设置里覆写.

### 4.2 子代理是什么 (设计预算花在哪)

| 产品 | 本质 | 复杂度花在 |
|---|---|---|
| Claude Code | 可沉淀的**资产**: Markdown frontmatter, 五层作用域 (managed > --agents > 项目 > 用户 > plugin), 可入版本控制, 可插件分发; 字段体系含 tools/model/permissionMode/hooks/skills/memory/isolation/background 等; 近期默认后台运行, 可 resume | 定义 |
| Codex | 一等的**运行线程**: agent thread 可在桌面端/CLI/IDE 检视, steer, stop, close; 编排 (spawn, 路由, 等待, 关线程) 全托管; 自定义 TOML 本质是 "spawn 会话的配置层", 官方自承格式未定 ("the format may evolve") | 运行 |
| pi-subagents | 可编程的**编排原语**: 子代理 = 完整 pi 子会话; chain/parallel/async/fork 上下文/saved workflow/定时调度/mission 存档均为一等概念; 暴露 workflowScript 允许用 JS 编程编排; FleetView 常驻面板 + fleet 检视器; 自定义格式同宗 Claude Code (四层 scope: builtin < package < user < project), 带 eject/disable/reset 管理动作 | 组合 |

### 4.3 并行写冲突

- Claude Code: **工程解**. `isolation: worktree` 给子代理独立 git 工作区副本; 命令落回主 checkout 直接报错, 隔离由工具强制执行.
- Codex: **纪律解**. 文档建议读密集任务放心并行, 写密集 "be more careful"; 缓解手段仅按 agent 收紧沙箱.
- pi-subagents: **机制与纪律全都要**. 工作流级 `worktree: true` (每写子代理独立工作区, patch + handoff 清单回收), 同时明文规定 "keep one writer", 写后须由 fresh-context 独立 reviewer 复核, 父会话负责综合 (文档称其为安全关键准则).

### 4.4 信任工程 (pi-subagents 独自开辟的战场)

商业产品的信任模型是 "信任平台, 平台信任模型"; pi-subagents 的信任模型是 "默认不信任, 用流程换信任", 并把其做成产品功能:

1. **验收阶梯 (acceptance gates)**: 结果可要求 attested → checked → verified 证据等级; 可强制独立复核 (写者的活儿由另一个干净上下文 agent 签字).
2. **对抗性二审 (watchdog)**: 可选组件盯着改动挑刺, 推荐用**互补模型** (别家厂商强模型) 做二审 — 把模型异构当安全特性, 单厂商商业产品结构上无法提供.
3. **显式边界**: 子代理默认不是编排者, 禁止再 spawn; 递归深度守卫默认两层; 追加 spawn 配额需人明确确认.
4. **双向通信 (contact_supervisor)**: 子代理遇决策点可反问父会话 (需要决策/请求访谈/进度通报), 而非瞎猜; worker 内置角色的纪律是 "未批准的决策升级上报, 不猜".

## 5. 产品哲学与取舍

| 产品 | 赌注 | 代价 |
|---|---|---|
| Claude Code | 专才会复利: 定义沉淀为团队资产 (版本控制, 插件分发, 跨会话记忆), 委派自动化 | 概念面大 (五层作用域, 十几字段); 自动委派引入路由误判的不确定性 |
| Codex | 简单即可靠: 分工是资源决策, 由人或仓库指令显式做出; 运行体验极致 (线程可见可干预可收尾) | 触发负担在用户 (不主动要求就没有并行); 专精配置沉淀弱, 格式未定 |
| pi-subagents | 控制面值得暴露: 验收等级, 对抗审查, 异构模型, 递归守卫, 配额全部摆上台面, 编排可用 JS 直接写 | 概念最多, 学习曲线最陡; 价值依赖使用者纪律; 绑定 pi 生态, 受众小 |

一句话: Claude Code 卖资产沉淀, Codex 卖简单可靠, pi-subagents 卖控制. 商业产品为规模优化, 社区插件为控制欲优化.

## 6. 结论

1. 子代理的产品形态已收敛出共同骨架 (独立上下文 + 摘要返回 + 读/写/审查角色 + 文件定义), 竞争点不在骨架, 在骨架之上.
2. 三家的真实分歧是**信任与控制权如何分配**: 交给模型路由 (Claude Code), 交给人显式触发 (Codex), 或给人全套控制旋钮并辅以流程化验收 (pi-subagents).
3. pi-subagents 证明了一个单厂商商业产品难以覆盖的空位: 跨厂商模型异构 + 对抗性验收 + 完全可编程编排. 商业产品大概率不会主动提供 "用竞争对手的模型审查自己" 这种功能.
4. 观察趋势: 商业双方在互相靠拢 (Claude Code 加后台/线程式管理, Codex 自定义 agent 在积累字段); 社区插件则向信任工程纵深发展.

## 7. 事实出处

- Claude Code: code.claude.com/docs/en/sub-agents (内置 agent, frontmatter 字段, 作用域优先级, worktree 隔离, 后台运行, agent teams)
- Codex: learn.chatgpt.com/docs/agent-configuration/subagents (官方文档镜像); GitHub openai/codex issue #2604 (子代理支持状态)
- pi-subagents: github.com/nicobailon/pi-subagents — README, docs/agents.md (自定义 agent 与覆写机制, 内置六角色), docs/workflows.md (编排, worktree, supervisor 通信, 递归守卫)
