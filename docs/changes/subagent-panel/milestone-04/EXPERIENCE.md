# M04 Inline Run Card 原型 — 手动体验清单

前置: 扩展在 `~/.pi/agent/extensions/subagent-panel-proto/`, pi 启动自动加载.
卡只在**真实工具调用**时渲染 (走 onUpdate 管线); `/subagent-proto single|parallel` 纯命令回放只写日志, 不渲染卡.

## 0. 启动

```bash
pi        # 正常启动即可, 不限 provider/model
```

进入后先确认扩展活着:

```
/subagent-proto status
```

应回显当前 variant/density. 若无此命令 → 扩展没加载, 告诉我.

## 1. 变体 A — PRD 双行卡 (基准)

```
/subagent-proto variant a
请调用 subagent_proto 工具, 参数 mode=single
```

观察 (执行中 ~4s + 结束后定格):
- 首行: icon+agent+状态+model+ctx+usage — 字段排布是否一眼可扫
- 次行: task + recent 拼接 — 信息够不够, 吵不吵
- 结束态: final 卡字段是否补齐 (model 纠正/endedAt)

再触发 parallel 形态:

```
请调用 subagent_proto 工具, 参数 mode=parallel
```

- 聚合行 + 4 child 行, reviewer 会 failed — 失败行是否醒目

## 2. 变体 B — 单行致密

```
/subagent-proto variant b
请调用 subagent_proto 工具, 参数 mode=single
请调用 subagent_proto 工具, 参数 mode=parallel
```

观察: 单行信息是否够用; recent 只剩尾段一个片段是否太瞎; parallel 聚合+child 单行的扫描效率.

## 3. 变体 C — 分段展开

```
/subagent-proto variant c
请调用 subagent_proto 工具, 参数 mode=single
请调用 subagent_proto 工具, 参数 mode=parallel
```

观察: recentTools 三条各占一行是否值得这个纵向空间; 与 A/B 比, 高度换来的清晰度值不值.

## 4. 密度开关

```
/subagent-proto variant a
/subagent-proto density compact
请调用 subagent_proto 工具, 参数 mode=single
/subagent-proto density cozy
请调用 subagent_proto 工具, 参数 mode=single
```

对照 compact/cozy: 省略 cost/cap/timeout 后是否更清爽; 哪个适合当默认.

## 5. 截断体感 (80 / 120 列)

终端窗口拖到 **80 列**, 三个变体各触发一遍 single; 再拖到 **120 列** 重复.
重点: PRD §4.0 省略顺序 (cost → cap → timeout → recent → taskPreview → usage) 的实际观感 — 丢字段的顺序对不对, status/model 是否始终保住.

## 6. 连绘噪音 (storm)

```
/subagent-proto variant a
请调用 subagent_proto 工具, 参数 mode=single, scenario=storm
```

50ms 一次 onUpdate 共 ~40 次. 观察: recent 区滚动是否闪烁/抖动; 16ms 节流下卡是否稳定; 哪个变体抗噪音最好 (B/C 各试一遍更佳).

## 7. pending → active (parallel-pending)

```
请调用 subagent_proto 工具, 参数 mode=parallel, scenario=parallel-pending
```

6 child / 4 并发槽: 开头 2 行 ◌ pending, 随后转 active. 观察: 预建行是否有助于理解"还有排队"; 转换瞬间是否突兀.

## 8. 主题可读性

light / dark theme 各过一遍变体 A 的 single+parallel: ⠿◐✓✗◌ 图标与语义色 (active/failed/done) 是否清晰可辨.

## 9. F1 材料

parallel 卡只有聚合进度 (2/4 done), 无 per-child 实时进度. 体验时留意: 这个"瞎"的程度是否可接受 — 决定 F1 升不升级.

## 10. 回填结论

回来告诉我四项:
1. 变体选择: A/B/C 或拼装 (如 "A 的首行 + C 的 recent 列表")
2. 默认密度: compact 还是 cozy
3. 截断/省略规则: 维持 PRD §4.0 还是要调
4. F1: 升级 per-child 进度 (会裂出改造里程碑) 还是确认不做

## 已知坑

- LLM 偶发 abort / 不调工具 → 重发一遍即可.
- 改了扩展代码后 `/reload`, ~1s 生效.
- 变体/密度是模块级状态, `/reload` 后回默认 (a/cozy).
