# LLM 评分选型 决策账本

## 决策

### D001 消费形态: 数据文件 + 流程约定, 零代码
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 评分体系以"评分表数据文件 + 流程 skill"被消费, 主代理委派 subagent 前自行读表, 加权, 排序, 把胜者作 `model` 传参. 不写 slim-subagent 扩展代码 (否决了 `action:"recommend"` 等自动选模型功能). 理由: 评分维度与权重未经实战校验, 先跑数据流再考虑固化成代码; 零代码方案一次会话内可落地.
- 预计影响: `slim-subagent/skills/subagent-llm-select/` 两个文件, 无扩展代码改动

### D002 评分语义: 比率分, 基准 = 1, 允许 >1
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 基准模型 `opencode-go/deepseek-v4-flash` 全维 = 1, 其余模型为相对基准的比率分, 允许 >1 或 <1, 不压 [0,1] 区间 (基准在当前可用模型中偏入门, 压区间会损失头部区分度). 每个模型附 `updatedAt` 日期与一行 `note` 依据, 不建引用库. 评分主体为手工维护 (例外见 D009).
- 依赖事实: F002
- 预计影响: scores-template.md 表头与说明

### D003 排序规则: 预设画像权重表, 禁止自由赋权
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 总分 = Σ 权重 × 分数, 权重来自预设任务画像, 主代理不得按任务临场自由赋权 (纯自由赋权使同任务选出不同模型, 不可复现). 画像共 7 个, `general` (七维等权) 为兜底, 匹配不到任何画像时用它; 委派报告必须显式声明所用画像名. 权重向量 (七维顺序 coding/knowledge/longctx/multimodal/stability/price/speed, 0 = 不参与):
  coding: .40/.10/.20/0/.10/.10/.10
  research: .05/.35/.25/0/.10/.10/.15
  review: .30/.20/.20/0/.10/.05/.15
  vision: .10/.15/.10/.40/.10/.05/.10 (multimodal 为门槛)
  long-doc: .10/.15/.45/0/.10/.10/.10
  cheap-batch: .10/.05/.05/0/.10/.35/.35
  general: 各 1/7
  设计逻辑: 权重集中于定义性维度 (单维峰值 .35-.45), 供应商稳定性恒占 .10 (持续在场但永不主导).
- 预计影响: SKILL.md 步骤 3 权重表

### D004 未评分模型的处理
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 候选集中评分表未收录的模型, 全维按 1 (与基准持平) 参与排序, 并在排序结果中标注 `[未评分]`. 不禁止选用 — 禁止会让新模型永远没机会被试用积累评分.
- 预计影响: SKILL.md 步骤 4

### D005 N/A 语义
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 维度不适用记 `null`: 排序时该维度权重归零, 剩余权重重归一化; 任务必需维度为 N/A 的模型直接过滤 (如 vision 画像过滤 multimodal=null 者). 否决记 0 分 — 会让纯文本任务错误惩罚无图像能力的模型.
- 预计影响: SKILL.md 步骤 4, scores-template.md 说明

### D006 维度清单与命名
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 七维: coding (编程/软件工程), knowledge (知识广度), longctx (长上下文检索), multimodal (多模态), stability (供应商稳定性), price (价格竞争力), speed (时间效率). 供应商维度表头简称 `稳定性`. 刻意剔除竞赛刷分类与 Agent 演示类指标.
- 预计影响: 评分表列名, SKILL.md 权重表列名

### D007 评分表载体: Markdown 单文件
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 评分表用 Markdown: 模型分数 = MD 表格 (一行一模型, 一列一维度), 规则与公式 = 表旁文字. 否决 JSON (人读差), YAML (7×7 矩阵不直观), JSON+MD 双产物 (同步成本). 核心消费动作是"人审分 + LLM 查数排序", MD 表格对两者均最优; LLM 解析 MD 表格可靠.
- 预计影响: scores-template.md

### D008 流程载体: pi 包内 skill, 禁止写入 AGENTS.md
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 选模型流程做成 skill `subagent-llm-select`, 放 `slim-subagent/skills/subagent-llm-select/SKILL.md`, 随 slim-subagent 包安装即被 pi 自动装载. 明确禁止写入 AGENTS.md (用户原话). skill 为模型调用型, description 含"委派 subagent 前"触发分支.
- 依赖事实: F004, F005
- 预计影响: slim-subagent/skills/ 新目录

### D009 价格分派生
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: price 不存数值, 表中恒标 `derived`, 排序时现算: 单位成本 = 0.75×input + 0.25×output (agentic 编码会话输入远多于输出), 价格分 = 基准单位成本 ÷ 该模型单位成本, 数据源 `~/.pi/agent/models-store.json` 的 `cost` 字段. 否决含 cacheRead 的加权 (各厂商 cache 折扣不一, 伪精度). 这是 D002 "手工维护" 的唯一例外: 手工估价格分是劣化, 派生自动跟进调价.
- 依赖事实: F003
- 预计影响: scores-template.md 公式说明, SKILL.md 步骤 4

### D010 维护规则
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: scoped 列表新增模型 → 手动加行, 全维 1 占位待评. 改分事件驱动: 实际使用翻车或惊艳时改, 同时更新 updatedAt 与 note; 无定期审查 (3-5 个模型的表, 定期检查是过度流程).
- 预计影响: scores-template.md 维护节

### D011 产物拆分: 规则随包, 分数 per-device
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 随包 (slim-subagent/skills/subagent-llm-select/): SKILL.md (流程+画像权重+规则) 与 scores-template.md (模板). 不随包: 评分数据文件 `~/.pi/agent/slim-subagent/llm-scores.md`, per-device. 理由: 分数评的是本机 scoped 列表里的模型, 各设备可用模型/provider 不同 (settings.json 本就 per-device); 随包会被多设备互相覆盖与 pi update 冲刷. 代价: 多设备分数各自演化不自动同步, 要同步需自行 git 管理.
- 依赖事实: F005
- 预计影响: 上述两路径

### D012 bootstrap 行为: 评分表缺失时调研建立
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 评分表缺失时不跳过选型, 执行 bootstrap: (1) 调研对象 = 当前 scoped 候选集; (2) 每模型派一个 explorer 子代理并行, 任务要求调用 access-web skill, 官方来源 (厂商文档/定价页/模型卡) 优先于第三方测评, 返回六维分 + 每分一行依据; price 不调研 (走 D009 派生); speed 无权威数据源, 允许经验分但标注依据弱; (3) 照模板落盘; (4) 提示用户检查 (路径+分数摘要+弱依据条目). 自指说明: bootstrap 时无表, 派子代理用各 agent 默认 model, 属已定义行为, 无循环依赖. 本决策取代早期方案"由主代理基于公开 benchmark 起草初始分" — 起草被标准化为 skill 的 bootstrap 分支, 任何会话触发结果一致.
- 依赖事实: F006
- 预计影响: SKILL.md bootstrap 节

### D013 覆盖范围: 仅 scoped 列表内模型
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 评分表与 bootstrap 只覆盖 scoped 列表内的模型. 不收录列表外可用模型 (当前 24 个可用中只评 scoped 的 3 个): D004 已保证未收录模型行为有定义, 全收录是无信息占位.
- 依赖事实: F002
- 预计影响: SKILL.md 步骤 1 与 bootstrap

### D014 非目标
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 本特性不做: (1) 自动 benchmark 跑分; (2) 扩展代码实现 (D001 推论); (3) 收录 scoped 列表外模型的评分; (4) 历史分数版本追踪 (改分即覆盖, 不用 git 管分数历史).

### D015 验收标准
- 状态: 当前有效
- 约束性: 必须遵守
- 内容: 完成判定三条: (a) 评分表含 scoped 3 模型七维分 + updatedAt, price 列可按 D009 公式重算验证一致; (b) `subagent-llm-select` skill 存在且 description 含"委派 subagent 前"触发场景; (c) 模拟一次委派: 按 skill 流程对给定任务输出排序 (画像名+总分+标注), 结果可手工复算.

### D016 已知风险与缓解
- 状态: 当前有效
- 约束性: 可调整
- 内容: 盲区扫描确认三项, 均接受不阻塞: (1) 触发可靠性 — skill 靠 description 匹配触发, 主代理可能凭记忆跳过, 软约束无强制手段, 是 D001 零代码形态的固有代价; (2) 同名模型歧义 — 已用全限定名规则缓解 (见 F006); (3) 3 模型排序退化 — scoped 仅 3 个且分数接近时排序对权重敏感, 并列/微差为正常输出, SKILL.md 步骤 5 要求并列呈现.

## 事实

### F001 scoped 模型解析机制
- 状态: 当前有效
- 来源: pi 官方文档 docs/extensions.md (ctx.scopedModels 节), docs/usage.md
- 内容: scoped 模型 = `--models` CLI flag 与 settings.json `enabledModels` 的并集, 经 minimatch 匹配可用目录 (支持 `provider/modelId` 或裸 modelId, 支持 glob 如 `opencode-go/*`, 可带 `:thinking` 后缀), 会话启动时解析; TUI `/scoped-models` 命令展示同一集合. 无配置时为空 = 全部可用模型可选.

### F002 当前环境模型清单 (2026-08-19)
- 状态: 当前有效
- 来源: `jq` 查询 `~/.pi/agent/models-store.json` + `auth.json` + `settings.json`
- 内容: 有凭证 provider: kimi-coding, opencode-go. 可用模型 24 个 (models-store 全集 26, 含无凭证的 deepseek provider 2 个不可用): kimi-coding/{k3, k3-256k, kimi-for-coding, kimi-for-coding-highspeed}, opencode-go/{deepseek-v4-flash, deepseek-v4-pro, glm-5.1, glm-5.2, glm-5.3, gpt-5.6-luna, grok-4.5, hy3, kimi-k2.6, kimi-k2.7-code, kimi-k3, mimo-v2.5, mimo-v2.5-pro, minimax-m2.7, minimax-m3, muse-spark-1.2-contributor, qwen3.6-plus, qwen3.7-max, qwen3.7-plus, qwen3.8-max}. scoped (enabledModels) 3 个: kimi-coding/k3, opencode-go/deepseek-v4-flash, kimi-coding/kimi-for-coding. 目录中 deepseek provider (deepseek-v4-flash/pro) 无凭证不可用.

### F003 models-store.json 结构
- 状态: 当前有效
- 来源: `~/.pi/agent/models-store.json`
- 内容: pi 把全部已知模型目录落盘该文件, 按 provider 分组, 每模型含 id/name/api/baseUrl/reasoning/cost {input, output, cacheRead, cacheWrite}/contextWindow/maxTokens 等字段. cost 为价格分派生的数据源.

### F004 pi 包 skills 装载机制
- 状态: 当前有效
- 来源: pi 官方文档 docs/packages.md
- 内容: pi 包通过 `skills/` 约定目录 (或 package.json 的 `pi.skills` 声明) 装载 skill: 递归发现含 SKILL.md 的目录, 顶层 .md 也作 skill 加载. local path 包同样适用, 不复制文件, 直接从原路径加载.

### F005 slim-subagent 安装方式
- 状态: 当前有效
- 来源: `~/.pi/agent/settings.json` packages 字段, 仓库根 README.md:41
- 内容: slim-subagent 以 local path 包安装 (`packages: [".../slim-subagent"]`), 因此 `slim-subagent/skills/` 下新增 skill 无需重装即被装载. 其运行数据落盘约定目录为 `~/.pi/agent/slim-subagent/`.

### F006 同名模型歧义
- 状态: 当前有效
- 来源: `~/.pi/agent/models-store.json`
- 内容: deepseek-v4-flash 在 deepseek 与 opencode-go 两个 provider 下各有一条目录记录, 价格/可用性不同. 一切模型引用 (评分表 model 列, 基准, model 传参) 必须用 `provider/model` 全限定名.
