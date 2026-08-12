# 状态: 已关闭
# 类型: task
# 阻塞于: MILESTONE-02, MILESTONE-03

## 问题

AFK 编码任务, 调用 tdd-as-orchestra skill 驱动, 产物根目录 docs/changes/slim-pi-subagents/milestone-04/.

以 pi 官方 examples/extensions/subagent/ 为骨架建新扩展目录:
- 按 MILESTONE-02 定稿实现工具面 (schema/描述/命名)
- 按 MILESTONE-03 规格移植隐性行为 (timeout/fallback/drain/容忍/寻址)
- 搬运保留的内置 agents 与 prompts
- 不动 pi-subagents-main 一行代码

完成标准: 新扩展可装载, 保留的每种执行模式可跑通, 测试覆盖核心行为.
