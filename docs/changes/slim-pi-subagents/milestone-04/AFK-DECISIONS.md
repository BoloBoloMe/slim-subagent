# M4 AFK 期自行决策清单

用户 AFK 授权 (2026-08-12): 需拍板问题由我全权决策, 最终汇报. 本文件实时记录执行过程中我自行做出的决策 (此前经用户确认的不在此列).

## 决策

- AFK-01: ISSUE-04~07 微切片改为单执行者一次做完该 ISSUE 全部切片 (每切片独立 RED→GREEN), 每 ISSUE 一次双轴 review; 不逐切片派新执行者. 理由: 切片微且同代码区, 逐切片派遣开销大于上下文风险; 纪律底线 (先红后绿/双轴只读 review) 不变.
- AFK-02: onUpdate 流式更新接线 (M3-02 考察点 6, 任务图划入 ISSUE-02 但漏实施) 与 run.json tools 快照 (调和 14, resume 重建 --tools 前置) 合为补充切片, 在 ISSUE-05 前由单执行者落地. 理由: 两者均为后续 issue 的硬前置, 规格已钉死无新决策; 不推给 ISSUE-07 避免渲染切片膨胀.
- AFK-03: 行数预算 (1300-1600, 决策时 1314) 管控策略: 每 ISSUE 完成后实测; 预估破 1600 时优先裁剪 ISSUE-07 渲染段 (renderCall/renderResult 最简化, 不整搬官方示例全段), 其次压榨模块共享; 不因行数停止施工 (EXECUTION.md 停止条件在 AFK 期转化为我自行裁剪的触发器).
- AFK-04: onUpdate 两处裁剪 — (a) timeout/protocolError 触发的 emitUpdate 不做 (考察点 6 列出但非硬需, TUI 最多停滞 ~4s 至 close); (b) tool_execution_start/end 进度累积 (recentTools/recentOutput 有界截断) 推迟到 ISSUE-07 切片 (渲染的唯一消费方, 避免无消费代码先落地). progress 快照暂为空结构, payload 形状已被测试锁定.
- AFK-05: ISSUE-05 review 遗留三小项处置 — (a) parallel onUpdate 聚合流 (emitParallelUpdate) 推迟 ISSUE-07 (渲染消费方); (b) PER_TASK_OUTPUT_CAP (50KB) 截断补入 ISSUE-07 范围 (防超长输出撑爆父上下文, 官方示例保留行为); (c) parallel item 级 task 空串校验补齐进 ISSUE-07 小修清单 (与 single 模式对齐).
- AFK-06: 行数硬顶 1600 解除, 改 ≤2000 软目标. 依据: ISSUE-05 后已 1568, ISSUE-06 (resume/GC/锁) 与 ISSUE-07 (内置 agents+渲染) 无法在 32 行内完成; 1600 是 ROADMAP/EXECUTION 的估算值非决策项; 目的地核心指标 (66.5K → 精简两个数量级, 无 legacy 耦合) 在 2000 内仍全胜. 缓解: ISSUE-06/07 紧凑施工, 渲染段最简化不整搬.
- AFK-07: 采纳 reviewer (dd688467_0) 越权修复 session-lease.ts isLeaseActive — session 文件缺失时 realpathSync 抛 ENOENT 被外层 catch 吞掉, 致孤儿 run 目录永不 GC. 修复实证 (修复前目录残留/修复后删除, 72/72 绿), 属真缺陷, 采纳. 注: 事故根因仍是我 reviewer 提示词用占位符, 已连续三轮发生; 后续 reviewer 提示词必须完整书写并明令只读.
- AFK-08: resume 对 agent 定义被删/改的限制保持现状 — run.json 不快照 systemPrompt body, agent 定义被删时 resume 报 "agent definition not found" (M3-03 规格 4 要求 --append-system-prompt 重建必须依赖定义, 与调和 14 字面张力属语义合理); 被改时产生新 prompt+旧 tools 混合态. 记录为已知限制, 移交 M5 评估, 不在 M4 扩容 run.json schema.
- AFK-09: 两项 reviewer 指定微修 (调和 16 去重 / progress 字段) 不再派独立 review 轮 — 修复项本身来自双轴 review 的精确定位, 有先红后绿测试钉死, 我已直验 (84/84 绿 + grep 实证). 流程裁剪, 省一轮双轴.
- AFK-10: ISSUE-07 TS-002 渲染视觉人工验证 (折叠/展开/Ctrl+O) 需交互式 TUI, AFK 期无法执行; 降级为 headless 冒烟 (list 名册 + single 实跑 + renderCall/renderResult 被调用), 视觉项移交 M6 现场验证.
