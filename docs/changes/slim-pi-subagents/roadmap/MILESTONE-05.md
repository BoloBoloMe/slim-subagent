# 状态: 已关闭
# 类型: task
# 阻塞于: MILESTONE-04

## 问题

对照验收三件套做量化验收:
1. e2e 冒烟: 真实 spawn pi 子进程, 跑通保留的每种执行模式与模型选择
2. golden 对拍: 同一任务新旧扩展各跑一次, 对比行为差异; 产出已知行为差异清单 (timeout/drain/fallback 为重点)
3. token 实测: 序列化新 schema/description 计账, 对照 B 报告现状口径 (~6.1K tok/请求) 给出下降数字

产物: 验收报告 (含差异清单与 token 数字), 写入 docs/changes/slim-pi-subagents/milestone-05/.
