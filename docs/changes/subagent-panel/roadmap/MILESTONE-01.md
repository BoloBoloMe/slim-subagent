# 状态: 待处理
# 类型: research
# 阻塞于: 无

## 问题

R1 排雷: pi 的 overlay `nonCapturing` 浮层与 agent streaming/dialog 弹出时的共存行为, 文档零承诺 (仅 `examples/extensions/overlay-qa-tests.ts` 有用法). D Session Viewer 是 MUST, 其形态存亡系于此实测结论.

委派子代理实测 (pi 包路径见 ROADMAP 笔记):
- 以 `overlay-qa-tests.ts` 为模板搭实验扩展;
- streaming 期间浮层是否稳定渲染/被遮挡;
- dialog (如 model selector) 弹出时浮层行为, 关闭后是否恢复;
- nonCapturing 浮层是否抢/丢焦点;
- 多浮层堆叠行为.

产物: 分析文件写至 `docs/changes/subagent-panel/milestone-01/`.

完成标准: 分析文件已写, 共存行为有明确结论, D 形态有判据 (含负面结论时的约束清单, 供迷雾 F2 转化).
