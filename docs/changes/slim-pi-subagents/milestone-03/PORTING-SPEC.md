# M3 移植规格总纲 — 隐性行为提取与可搬运清单

- 状态: MILESTONE-03 已关闭产物
- 用途: M4 施工图纸入口; 分片规格见下表, 每片 {旧码位置, 行为描述, 移植规格} 三要素齐备
- 来源: pi-subagents-main v0.44.0 (只读), 官方示例 examples/extensions/subagent/ (index.ts 1015 行), pi 0.82.1 (实测)
- 关联决策: MILESTONE-01 DECISIONS.md D001-D012

## 一、考察范围校准 (绘制时清单 vs M1 保留集)

MILESTONE-03 绘制时列的必查项按 M1 已关闭保留集调整:

| 绘制时清单 | 校准后处置 |
|---|---|
| timeout 三阶段终止 (execution.ts:531-604) | 保留提取 → 01 (D005) |
| fallbackModels 重试链与 thinking 后缀 (model-fallback.ts) | **降级为删除确认** → 04 考察点 6 (D007 全删; thinking 不在保留集; --model 直传) |
| 非 JSON stdout 容忍 (execution.ts:835-843) | 保留提取 → 01 考察点 5 |
| pi 可执行寻址 (pi-spawn.ts) | 保留提取 → 04 考察点 1 |
| 结果回收 JSONL 解析核心 (execution.ts:831-970) | 保留提取 → 02 |
| agents/*.md 搬运 | **删除** → 不搬 (D008: 新写 3 个 explorer/worker/reviewer, prompt 属 M4) |
| prompts/*.md 搬运 | **删除** → 不搬 (D010: skills/prompts 全删) |
| frontmatter 解析 | 保留 → 04 考察点 3 (改用 pi 包 parseFrontmatter, 不搬手写解析器) |
| pi-args 核心段 | 保留 → 04 考察点 2 |
| config.ts 搬运 | **删除** → 不搬 (D011: config.json 配置系统删, 硬编码默认值) |
| (新增) resume/session 生命周期 | M1 点名拉回 (D004) → 03 |
| (新增) 上下文窗口数据源 | D012(b)/F006 指派 → 05 |

## 二、规格分片索引

| 分片 | 文件 | 主责 | 关键锚点 |
|---|---|---|---|
| 01 生命周期 | 01-process-lifecycle.md | spawn/三阶段 drain 终止/timeout 管线/取消/非 JSON 容忍/错误路径/退出码 | execution.ts:464-604, 1004-1132 |
| 02 结果回收 | 02-result-recovery.md | processLine 事件全集/message_end 累积/usage 6 字段/getFinalOutput/token 上限 | execution.ts:831-970, usage-budget.ts |
| 03 resume/session | 03-resume-session.md | resume 语义/会话目录/并发锁/pi 写盘时机 (D012a e2e) | subagent-executor.ts:1266-1560, session-lease.ts, pi dist/session-manager.js:724-753 |
| 04 spawn/args/发现面 | 04-spawn-args-frontmatter.md | 4 级寻址链/pi-args 保留 flags/frontmatter/list/并发 4+8/模型报错 | pi-spawn.ts, pi-args.ts:514-597, frontmatter.ts |
| 05 上下文窗口 | 05-context-window.md | ctx.getContextUsage() 验证 (F006 消解)/诊断载荷字段 | pi dist model-config.js:140, extensions.md:1036 |

## 三、关键事实 (本 Milestone 落定的结论)

1. **D012a 成立**: pi `--session` 增量写盘, message_end 粒度同步 appendFileSync (session-manager.js:724-753), 流式 chunk 不落盘; SIGKILL 丢 in-flight turn, 恢复点 = 最后完整落盘 message. 静态 + e2e 双重证实 (03 考察点 4).
2. **F006 消解**: `ctx.getContextUsage()` 返回 {tokens, contextWindow, percent}, 官方文档化 API (extensions.md:1036), 百分比直接可得; JSON 流只有 `usage.totalTokens` 绝对数 (05 实测, usage 无 contextTokens/contextWindow 字段).
3. **D006 语义缺口**: 旧码 usage budget 是调度门 (parallel 每 child 启动前比对已累计, single 仅事后报告), **无运行中终止**; D006 说 "触顶即终止" 与之不符 → 待决策 A/B (见下).
4. **tool_result_end 是死分支**: pi 0.82.1 不发此事件, 工具结果以 message_end role="toolResult" 到达; 保留 2 行防御, 不得依赖 (02 考察点 7).
5. **并发上限**: 旧码只有 4 (types.ts:1901), "最大 8" 来自官方示例 MAX_PARALLEL_TASKS=8 (index.ts:33); 两常量照官方示例数值 (04 考察点 5).
6. **配错模型报错路径**: 扩展侧不预校验 (旧码 fuzzy 匹配不上原样传), 报错来自子进程 pi stderr `Model "..." not found. Use --list-models...` exit 1 透传为 isError; 坑: provider+未知 id 走 custom model 不报错 (04 考察点 6 实测).
7. **旧码无成功即删/按龄 GC**: 子代理 session 目录永久留存; D004 要求为新增行为, 需新写 (03 考察点 2).
8. **旧码无 run 元信息文件**: model/agent 靠内存态; resume 需跨进程寻址 → 新增 run.json (03 考察点 2 规格 3).

## 四、M4 施工待决策清单 (研究浮出, 不阻塞 M3 关闭)

| # | 决策点 | 选项 | 建议 | 处理时机 |
|---|---|---|---|---|
| 1 | D006 token 上限语义 | A 照搬调度门 (并行启动前比对+跳过, single 事后报告, ~30 行) / B 运行中终止 (message_end 累加后比对, 复用 SIGINT@0→SIGTERM@+1s→SIGKILL@+4s 管线, ~40 行, 贴 D006 原文但偏离旧码) | A (行为有旧码背书, 规模小); 采纳 B 前需用户确认口径 | M4 动工前, 问用户 |
| 2 | 子进程防递归 | 恒加 `--no-extensions` / 不处理 (官方示例未处理) | 恒加 --no-extensions (D007 倾向 "子进程零工具注入") | M4 施工决策 |
| 3 | 16MB 单行上限 + turn_end/agent_end 聚合投影 | 保留防御 (~30 行) / 整删 (官方示例无) | 预算紧可删; 默认保留 | M4 预算决策 |
| 4 | costUsd 预算维度 | 照搬两维 / 只留 tokens | 默认两维 (+~10 行); 砍由 M2 暴露面定 | M2 |
| 5 | resume 重复 user 提示边角 (中断 turn 的 user 已落盘, resume 追加同文本) | 接受重复 (旧码同) / 相同文本跳过追加 | 默认接受, M5 对拍后再定 | M5 |

## 五、M5 对拍清单 (golden 对比)

1. 会话写盘时机: 复现 03 考察点 4 的 3 组 e2e (正常一轮 / 首轮流式 kill -9 / 已有会话 turn2 流式 kill), 断言文件行数与最后 message role.
2. 配错模型: `--model totally-bogus` 报错文本与 exit 1 断言 (04 已实测, 复用).
3. 非 JSON 容忍: 注入非 JSON 行, 断言静默跳过 + code!=0 时整段进 closeError.
4. 三阶段 drain: terminal stop 后 1s grace → SIGTERM → 3s SIGKILL 时序断言.
5. toolCall 中途 kill 的 session leaf 行为 (03 考察点 4 边角 c, v1 不承诺, 对拍确认).
6. 空输出判定: 冷启动空响应 → exitCode 1 + "Subagent produced no output..." 消息.

## 六、结果对象字段终版 (合并 01/02/05, M4 直接引用)

```ts
interface SingleResult {
  index: number;                       // launch 顺序 (parallel 保序)
  agent: string; task: string;
  exitCode: number;                    // 01 考察点 6 语义 (强制信号 code??1 / forcedDrain 归 0)
  processSignal?: string;              // close 时 signal
  timedOut?: boolean;                  // 01 考察点 3
  usage: { input, output, cacheRead, cacheWrite, cost, turns };  // 02 考察点 2 (不含 cacheRead/cacheWrite 于 budget 口径)
  messages?: Message[];                // message_end 全角色累积
  model?: string;                      // 首个 assistant message 的 model
  stopReason?: string;                 // 官方字段, isError 判定
  errorMessage?: string;               // 官方字段
  error?: string;                      // closeError 链 (01 考察点 6)
  finalOutput?: string;                // getFinalOutput / 超时诊断文本 (01 考察点 3)
  contextTokens?: number;              // usage.totalTokens 最新一条 (D012b 保底)
  progress?: AgentProgress;            // 流式展示 (toolCount/recentTools/recentOutput/tokens...)
  sessionFile?: string;                // resume 目标来源 (03 考察点 6)
  diagnostics?: { contextTokens, contextWindow, contextPercent, model };  // 05 推荐字段 (ctx.getContextUsage 优先)
}
```

诊断载荷: 扩展面 `ctx.getContextUsage()` 打包 {contextPercent, contextTokens, contextWindow, model}; JSON 流保底 {contextTokens: usage.totalTokens, model: message.model} (05 推荐字段清单).

## 七、删除项汇总 (各分片详述)

watchdog 状态机 / detach 后台化 / interrupt control / turnBudget 状态机 / structured output / completion guard / acceptance / transcripts / control 事件流 / run-history 账本 / async resume 全链路 / session-lease writerState 握手 / env 管线 200 行 / resolvePiLaunchToolPlan / model-fallback 336 行 / 重试循环 / applyThinkingSuffix / 旧 frontmatter 手写解析 / handleList 富格式 / Semaphore 全局限流 / workflowScript 相关钩子 — 全部删除, 位置与理由见各分片末节.
