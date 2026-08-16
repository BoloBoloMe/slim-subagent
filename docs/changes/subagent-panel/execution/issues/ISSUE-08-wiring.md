# ISSUE-08 接线整合 (integration 特例)

## 父级
- `../EXECUTION.md`

## 执行(Execution)
- [ ] 已实现

## 要构建什么
主会话统一接线 (非独立领取): registerCommand `/agent-sessions` + `/agent-diagnose`; registerShortcut `alt+v`; **schema/action 注册** (diagnose 入 subagent schema); viewer `d` 键接通 diagnose.ts 真实入口 (替换 ISSUE-06 的桩); index.ts 最终整理. 完成后全链路: 命令/快捷键 → viewer/diagnose → 真实数据. HITL/integration 原因: 并行三片的共享接线点, 归主会话 (M08 D002).

## 覆盖依据
- Product: `../../pi_agent_subagent_panel_prd.md`, §5 入口 + §7.1 命令面

## 相关决策
- `../../milestone-07/DECISIONS.md`: D009 (命令面/键位)
- `../../milestone-08/DECISIONS.md`: D002 (接线归主会话)

## 允许范围
`slim-subagent/index.ts` 接线区; viewer.ts 仅 d 键桩替换.

## 禁止范围
不重写 05/06/07 已交付逻辑; Windows alt+v 占用不做平台特判 (文档注明退回命令即可).

## 代码定位提示
- registerCommand/registerShortcut: pi 包 types.d.ts; 原型参考 `milestone-06/prototype/index.ts` 命令/快捷键注册
- d 键桩: ISSUE-06 交付时在 viewer.ts 标注的位置

## TDD 切片
- 非纯函数, 无单测切片; 走冒烟 (人工验证特例).

## 验证入口
pty 冒烟一轮: `/agent-sessions` 打开 viewer; alt+v toggle; `/agent-diagnose` 无参跑通; viewer 内 d 键输出诊断.

## 风险提示
接线后三个并行片首次合流 — 先跑全量 node --test 再冒烟.

## 停止条件
任一片交付不完整无法接线时停止, 回对应 issue 补齐.

## 适合 AFK 的原因
HITL/integration 特例: 主会话执行, 不委派.

## 验收标准
- [ ] 命令/快捷键/toggle/d 键全通
- [ ] node --test 全绿
- [ ] 冒烟一轮全绿

## 被阻塞于
- ISSUE-05, ISSUE-06, ISSUE-07
