# ISSUE-06 Session Viewer 实现

## 父级
- `../EXECUTION.md`

## 执行(Execution)
- [ ] 已实现

## 要构建什么
`viewer.ts`: capturing 全屏 overlay — 首 tab `Timeline` 批次时间线 (上早下晚, ↑/↓ 选 Enter 换批, 默认最新) + 子代理会话 tab (视觉对齐 pi transcript, followLive, 底部状态区: ctx%/budget/hint/log event ids) + 键盘流 (Tab/Shift+Tab/←/→/数字键, PgUp/PgDn, Esc, toggle) + tolerant JSONL reader (无法识别行进 raw) + 数据源 (内存 store + 启动磁盘回补最近 20 批). `d` 键在本 issue 内实现, 先留 diagnose 接口桩 (ISSUE-08 接通). registerCommand/快捷键接线留 ISSUE-08. 适合 AFK: M06 原型用户已验收 ("就是我想要的").

## 覆盖依据
- Product: `../../pi_agent_subagent_panel_prd.md`, §5, §10 验收 5-7

## 相关决策
- `../../milestone-07/DECISIONS.md`: D007 (信息组织), D008 (键盘流), D009 (d 键), D011 (数据源)
- `../../milestone-08/DECISIONS.md`: D001 (viewer.ts), D002 (只新增文件, 接线留主会话), D003 (tolerant reader 单测)

## 允许范围
新增 `slim-subagent/viewer.ts`, `test/viewer*.test.ts` (reader/store 纯函数).

## 禁止范围
不改 index.ts (接线归 ISSUE-08); 不做宽度调整/overlay 内回放/copy·resume 入口 (PRD §11); 不 patch pi.

## 代码定位提示
- 原型直接对照: `docs/changes/subagent-panel/milestone-06/prototype/viewer.ts` (SessionViewerComponent 全结构) — 假数据生成器替换为真实 store
- overlay 硬约束: M07 F004 (fire-and-forget/capturing/Esc=done(null))
- session.jsonl 格式: pi 包 docs/session-format.md
- 磁盘回补: `~/.pi/agent/slim-subagent/sessions/` 目录结构 (PRD §2-7)

## TDD 切片
- TS-001: 接缝 = tolerant reader. TC-001: 混合合法/损坏/未知 JSONL 行 → 合法行解析, 无法识别行进 raw 不丢弃. 先写失败测试: `tolerant reader keeps unrecognized lines as raw`.
- TS-002: 接缝 = 批次时间线构建. TC-002: 多 run 记录 → 上早下晚排序, single 也算批次, 状态摘要正确. 先写失败测试: `timeline orders batches oldest first`.
- TS-003: 接缝 = 磁盘回补. TC-003: sessions 目录 20+ run → 只回补最近 20 批; GC 缺文件 → empty state 不崩. 先写失败测试: `backfill caps at 20 batches, survives missing files`.

## 验证入口
`node --test` 全绿; pty 冒烟一轮: overlay 打开/Tab 切换/Enter 换批/Esc/toggle/followLive.

## 风险提示
pty 冒烟断言用状态探针不用屏幕帧 (M06 误报教训, M07 F005); 真实 transcript 渲染是近似自绘, 不逐像素对齐 pi (用户已授权).

## 停止条件
session.jsonl 格式与 docs/session-format.md 冲突无法解析时停止.

## 适合 AFK 的原因
形态/键盘流/数据源全部经用户实测定稿, 原型可直接参照.

## 验收标准
- [ ] PRD §10 验收 5-7
- [ ] Timeline + 子代理 tab + followLive + toggle
- [ ] tolerant reader + 20 批回补
- [ ] node --test 全绿不回归

## 被阻塞于
- ISSUE-04
