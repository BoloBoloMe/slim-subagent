# ISSUE-07 (Diagnose) AFK 自主决策记录

执行模式: AFK. 并行施工期 (M12/M13/M14) 关键发现与决策, 供用户复核.

## 1. 日志挂载缺口 (M14 施工中揭露, 未越界修复)
- 问题: `timeout.fired` (L19) 行不携带 `timeoutMsExplicit`; 而携带显式标记的 `timeout.armed` (L18, info/debug) 与 `single.spawn.start` (L09, info) 在 diagnose 的 `levelMin≥warn` 过滤下永远缺失 → 真实运行中 timeout 的「显式 cap vs 自动 70%」无法区分.
- 决策: 不补启发式猜测 (遵守纪律). diagnose 实现三态: 数据可得时精确区分; 不可得时 title/cause 如实标注 `(已知日志挂载缺口)` 并降 confidence.
- 理由: 缺口的根因在 ISSUE-01/02 的 L19 载荷设计, 非 diagnose 职责; 擅自猜配会引入假证据.
- 影响: timeout 类 finding 在真实运行中 confidence 可能为 low/medium, 但 finding 仍产出.
- 风险: 用户需知晓此缺口. 建议后续补丁 (优先) 在 `timeout.fired` 行加 `timeoutMsExplicit` 字段.

## 2. 并行纪律遵守 (M12/M13/M14)
- M12 (card.ts + index.ts 渲染接线), M13 (viewer.ts), M14 (diagnose.ts) 三者并行, 文件互不重叠 (仅 M12 触 index.ts); M13/M14 只新增文件, index.ts 注册归 ISSUE-08. 全量 137 测试 134 过 3 既有红, 无新增回归.
