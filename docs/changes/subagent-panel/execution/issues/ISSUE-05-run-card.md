# ISSUE-05 Run Card 实现

## 父级
- `../EXECUTION.md`

## 执行(Execution)
- [ ] 已实现

## 要构建什么
`card.ts`: Inline Run Card — 变体 C 分段展开 (状态行 + recentTools ≤3 条逐行 + output 预览行; parallel 聚合行 + child 双行树形 + pending 预建行); spinner 动效 (⠋⠙⠹… 90ms, context.invalidate 驱动, settled 停); §4.0 必填字段与窄行省略 (cost→CH→cap→timeout→recent→taskPreview→usage, 死保 status/model/ctx/elapsed); CH 段 (cozy); 密度开关; 提示文案 `alt+v 会话 · /agent-diagnose 诊断`; index.ts 渲染接线 (renderCall/renderResult 换血, 归本 issue). 可观测: pty 里 single/parallel 卡与原型一致. 适合 AFK: M07 定稿 + 原型可对照.

## 覆盖依据
- Product: `../../pi_agent_subagent_panel_prd.md`, §4.0/§4.1, §10 验收 1-4

## 相关决策
- `../../milestone-07/DECISIONS.md`: D001 (变体 C), D002 (cozy), D003 (省略顺序), D004 (CH), D005 (spinner), D009 (提示文案), D013 (per-child 数据源)
- `../../milestone-08/DECISIONS.md`: D001 (card.ts + index.ts 归本 issue), D002 (并行纪律), D003 (截断单测), D005

## 允许范围
新增 `slim-subagent/card.ts`, `test/card*.test.ts`; index.ts 渲染接线 (renderCall/renderResult 替换).

## 禁止范围
不动 viewer.ts/diagnose.ts (并行纪律); 不实现 registerCommand 接线 (ISSUE-08); 禁止卡上按钮/copy 类操作 (M07 D010).

## 代码定位提示
- 原型直接对照: `docs/changes/subagent-panel/milestone-05/prototype/index.ts` (cCard/cDetailLines/renderSegLine/spinner 机制 + RunCardComponent) — 允许搬运逻辑, 禁止搬运原型债 (无测试/错误处理从简的部分重写)
- context.invalidate: pi 包 tool-execution.js:89-107; types.d.ts:321 (ToolRenderContext)
- 现有渲染: index.ts renderCall/renderResult 现状

## TDD 切片
- TS-001: 接缝 = 卡渲染纯函数 (details→行数组). TC-001: §4.0 省略顺序逐档 — 宽度递减时按 cost→CH→cap→timeout→recent→taskPreview→usage 依次消失, status/model/ctx/elapsed 永在. 先写失败测试: `narrow width drops fields in §4.0 order`.
- TS-002: 接缝 = 同上. TC-002: parallel 聚合 + pending 预建行 (无 model/ctx/elapsed 不伪造) + child 双行树形. 先写失败测试: `parallel card renders pending prebuilt rows`.
- TS-003: 接缝 = CH 计算. TC-003: cacheRead/(cacheRead+input), 无 cacheRead 不显, compact 密度不显. 先写失败测试: `CH shown only with cacheRead in cozy`.

## 验证入口
`node --test` 全绿; pty 冒烟一轮: single active 卡 spinner 转 + parallel pending 行 + 80/110 列截断.

## 风险提示
spinner 定时器必须 settled 即停 + 内容不变不重绘 (原型闪烁教训); 命令解析 NFKC 归一化 (全角教训, 若涉及).

## 停止条件
渲染 API 行为与原型期事实 (M07 F001) 冲突时停止上报.

## 适合 AFK 的原因
形态/字段/顺序/动效全部定稿, 原型可作像素级参照.

## 验收标准
- [ ] PRD §10 验收 1-4
- [ ] spinner 动效 + settled 停转
- [ ] CH 段 + 密度开关 + §4.0 截断
- [ ] node --test 全绿不回归

## 被阻塞于
- ISSUE-04
