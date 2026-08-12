# 状态: 已关闭
# 类型: deliberate
# 阻塞于: 无

## 问题

逐功能点名, 固化保留/删除集. 清单来源: direction-research/A-excision.md 的功能-代码映射 (全量功能盘点) 与 B-surface-trim.md 的暴露面账本.

必判决策点 (对规模影响大, 须逐项给结论):
- async 后台运行 (subagent_wait/notify/结果回收链)
- acceptance 验收门
- contact_supervisor 双向通信
- worktree 隔离
- chain 的表达形态: workflowScript 顺序 await vs 参数式 chain; durable chain (.chain.md) 存废
- 内置 agents 保留子集 (scout/worker/reviewer/oracle/researcher/delegate)
- 管理 action 保留子集 (list/get/status/models/stop/interrupt/resume/steer...)
- TUI 渲染 (renderCall/renderResult) 保留程度
- skills/prompts 模板去留

前置事实 (认领后先自行探查, 不问用户): 用户侧自定义 agents (~/.pi/agent 与项目级) 对被裁内置角色的引用情况.

产物: 保留/删除清单决策文件, 写入 docs/changes/slim-pi-subagents/milestone-01/.
