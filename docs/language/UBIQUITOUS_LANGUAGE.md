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
