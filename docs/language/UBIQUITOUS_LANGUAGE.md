# Subagent 可观测性控制面

pi 扩展 slim-subagent 的可观测性领域: 把阻塞式子代理委派升级为看得见状态, 追得回现场, 查得到错误的控制面.

## 语言

**批次 (Batch)**:
一次 `subagent` 工具调用产生的运行集合. single 调用 = 单节点批次; parallel 调用 = root + children 批次. 时间是批次的固有属性, Timeline 按创建时间排序批次.
_避免_: 批, 任务组, run 组

**Run Node**:
观测面上的一个运行节点: single run, parallel root, parallel child, 或 resume. 树深度硬限制 2. 带 **DisplayStatus**.
_避免_: 任务, 进程, job

**DisplayStatus**:
Run Node 的显示状态: pending / active / done / failed / timeout / budget / cancelled / attention. pending 仅 parallel child 可推导 (tasks[] 全集 − scheduled 集合); attention = failed+timeout+budget+cancelled 的聚合视角, 不是运行时状态.
_避免_: queued, starting, blocked, waiting_input (运行时无事件, 禁用)

**Run Card**:
Inline Live Run Card — transcript 内工具调用处的实时状态卡 (变体 C 分段展开结构), 唯一常驻实时观测面. active 图标为动画 spinner.
_避免_: Panel (已否决的 widget 面板), 卡片

**Session Viewer**:
全屏 capturing overlay, 单次现场面. tab 栏 = 所选 **批次** 的子代理; 首 tab 为 **Timeline**.
_避免_: 会话查看器以外的叫法; v1 的内容分类 tab (Tools/Events-Raw/Logs/Diagnostics) 已废弃

**Timeline**:
Session Viewer 首 tab: 全部 **批次** 按创建时间上早下晚的时间线; 选中批次后其余 tab 切换为该批次子代理.
_避免_: Conversation (v1 旧名, 已更名)

**followLive**:
子代理 tab 的跟随滚动模式: active 时自动滚到底, 用户上翻解除, 回到底恢复.

**Diagnose**:
只读诊断能力 (action:"diagnose" / `/agent-diagnose` / viewer 内 `d` 键): 日志+会话证据聚类, 给修复建议, 不自动修复.

## 示例对话

开发者: "reviewer 那个 run 失败了, 怎么看现场?"
领域专家: "按 alt+v 开 **Session Viewer**, **Timeline** 上最新**批次**已经在底部, Enter 选中, 切到 reviewer 的 tab 看会话; 要诊断按 `d` 触发 **Diagnose**."
开发者: "运行中想瞟一眼进度呢?"
领域专家: "看 **Run Card** — spinner 在转就是 active; parallel 批次没进并发槽的 child 显示 pending."

# Subagent LLM 选型评分

委派 subagent 时为 `model` 传参选型的领域: 评分表 × 任务画像 → 可复算的排序.

## 语言

**基准模型 (Baseline)**:
评分锚点 `opencode-go/deepseek-v4-flash`, 全维 = 1. 其余模型分数为相对它的比率分, 允许 >1 或 <1.
_避免_: 基线, 参照物

**画像 (Profile)**:
任务类型到七维权重向量的预设映射: coding / research / review / vision / long-doc / cheap-batch / general (兜底). 委派报告必须声明所用画像.
_避免_: 任务类型, 场景权重

**派生分 (derived)**:
price 维度不存表, 排序时按公式从 models-store.json 的 cost 字段现算, 随厂商调价自动更新.
_避免_: 价格分 (暗示存数值)

**N/A**:
维度不适用 (表中 `null`): 权重归零重归一化; 任务必需维度 N/A 的模型被过滤.
_避免_: 0 分 (记 0 是惩罚, N/A 是不参与)

**bootstrap**:
评分表缺失时的建立流程: 逐 scoped 模型派 explorer 联网调研 (官方来源优先), 照模板起草, 提示用户检查.

**scoped 模型**:
本机 settings.json `enabledModels` ∪ `--models` CLI flag 匹配可用目录且有凭证的模型集合, 选型只在其中进行.
_避免_: 可用模型 (24 个有凭证全集, 含义更宽)

## 示例对话

开发者: "要派 reviewer 审一批代码, 用哪个模型?"
领域专家: "走 subagent-llm-select: 候选集 = **scoped 模型**, 任务配 **画像** review, 查评分表算总分, **派生分**现算, 胜者作 model 传参."
开发者: "评分表里没有 grok-4.5 呢?"
领域专家: "它在 scoped 列表里才有意义; 若在而表未收录, 全维按 1 (= **基准模型**) 参与排序并标 `[未评分]`. 表整个不存在就走 **bootstrap**."
