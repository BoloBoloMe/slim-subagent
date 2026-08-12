# M5 验收报告: slim-subagent 保留模式量化验收

- 状态: M5 验收 (对照 ROADMAP 目的地验收三件套, 问题定义见 ../roadmap/MILESTONE-05.md)
- 日期: 2026-08-12 (与 e2e-new-summary.md 同期)
- 方法: 新扩展侧真实 spawn pi 0.82.1 子进程 (evidence/G*-new*.txt, 权威值取 `--mode json` 事件流 toolResult message_end); 旧扩展 v0.44.0 侧 golden 实测 (父会话, G*-old, 单次样本); token 静态面计账 (token-accounting.md, 口径 chars/4).
- 结论: **验收三件套全部通过**, 详见 §5.

## 1. 验收三件套结论表

| # | 验收项 | 依据 | 判定 |
|---|---|---|---|
| 1 | e2e 冒烟: 保留模式全跑通 (single/parallel/timeout/resume/model 错误/usageBudget/list) | e2e-new-summary.md + evidence/G1~G7-new*.txt | **通过** (7/7) |
| 2 | golden 对拍: 同一任务新旧各跑, 产出行为差异清单 | 本报告 §2 (7 条) + 父会话 G*-old 实测 | **通过** (7 条全部有意/收敛, 无未预期差异) |
| 3 | token 实测: 静态工具面下降 | token-accounting.md | **通过** (~303 tok, 达标) |

## 2. 已知行为差异清单 (7 条)

每条: 差异 / 旧行为 / 新行为 / 性质. 性质 = 有意 (附决策编号) / 收敛 (两侧同型或同机制).

### 2.1 resume runId 语义

- 旧: 恢复 = **新 runId** + 同一 sessionFile (G4-old: resume 6c3a8ff4 → 新 runId 6b0241b6, 输出 "已恢复").
- 新: 恢复 = **沿用原 runId**, sessionDir 不变 (G4-new: runId 沿 run-20260812-220039-84e004, run.json 快照复用).
- 性质: 有意 (EXECUTION.md 调和 13: M2-D005 优先, M3-03 移植规格 4 "恢复 = 新 runId" 段作废).

### 2.2 model thinking 后缀

- 旧: 自动追加 thinking 后缀 ":high" (G5-old: `Model "totally-bogus:high" not found`).
- 新: model 参数直传, 无后缀 (G5-new: `Model "totally-bogus" not found`).
- 性质: 有意 (M1-D007 model-fallback 全删, M3-04 考察点 6 model 直传). 提示: 新扩展用户若需 thinking 后缀, 自行写在 model 参数里.

### 2.3 usageBudget 语义 (调度门 → 运行中终止)

- 旧: `{tokens:{soft,hard}}` 结构, 语义 = 调度门 (schemas.ts:127-130 注释 "Hard limits prevent future child launches; running children are not stopped"); 单次 run 74df9bdd 实际用量远超 50 tok 仍正常完成.
- 新: 纯 number 参数, 运行中终止 (G6-new: stopReason:"usage_budget", "reported tokens 179 reached limit 50"; 口径 input+output+cacheWrite, cacheRead 不计).
- 性质: 有意 (EXECUTION.md 调和 5: M2-D003 口径 + M3 §四 #1 选项 B 用户确认).

### 2.4 session 存储布局 / GC / 并发锁

- 旧: 父会话目录派生 + /tmp/pi-subagents-uid-1000/async-* + .pi-subagents/artifacts 三处; session 目录永久留存无 GC (M3 关键事实 7), artifacts 另有旧码自带 7d GC (pi-subagents-main src/runs/shared/artifacts.ts:230-285).
- 新: 固定 `~/.pi/agent/slim-subagent/sessions/<runId>/` + 7 天按龄 GC (挂在 session_start 扫) + 并发锁 (slim-subagent-leases).
- 性质: 有意 (M2-D005).

### 2.5 工具面 4 → 1

- 旧: 注册 subagent + subagent_wait + subagent_supervisor + intercom 4 工具.
- 新: 仅 subagent 1 个.
- 性质: 有意 (M1-D003 async/subagent_wait 全删, M1-D007 contact_supervisor 全删); 量化见 token-accounting (父侧 -95.1%/20.3x, 子侧 1291→0).

### 2.6 超时 0 消息不可 resume (两侧收敛)

- 旧: G3-old (run 1f7977ba, 子进程 boot 期超时, 无消息落盘) → 超时消息 "Subagent timed out after 6000ms.", 对其 resume 报 "Foreground run ... session file does not exist".
- 新: G4-new-resume-no-session 同型同文案 ("Foreground run '...' session file does not exist").
- 性质: 收敛, 记已知限制 (子进程被 SIGINT 中断未刷盘, session 无 ≥1 完成消息即不可 resume; 子进程侧行为, 非扩展抛错).

### 2.7 pi core 事件级 isError 恒 false (两侧同机制)

- 旧/新同: pi 0.82.1 toolResult 事件 isError 仅按 execute 抛异常判定 (agent-loop.js executePreparedToolCall 固定返回 `isError:false`), 扩展侧 isError (exitCode≠0/timeout/usage_budget) 不体现于事件级, 语义经 details (exitCode/stopReason) 与 content 完整传达.
- 性质: 收敛, 呈现差异属 pi core, 不影响扩展载荷.

## 3. PORTING-SPEC §五 对拍清单 6 项逐项交代

| # | 清单项 | 覆盖方式 | 状态 |
|---|---|---|---|
| 1 | 会话写盘时机 (正常一轮 / 首轮流式 kill -9 / 已有会话 turn2 流式 kill, 断言行数与最后 message role) | M3 e2e (D012a 成立, M3-03 考察点 4 三组 e2e 双重证实) + M4 fake-pi (single.test.ts:83 落盘断言, single-spawn-args.test.ts:76-80, resume.test.ts:169-182 session 校验); 本 golden 真实佐证: G3-partial 112KB session 落盘, G4 argv 验证同一 sessionFile 112297B→113359B follow-up 追加 | 已覆盖 (M3 e2e + M4 fake-pi) |
| 2 | 配错模型: 报错文本 + exit 1 | M3-04 考察点 6 已实测 (复用) + M4 fake-pi (single-errors.test.ts:122-129 stderr 断言) + 本 golden G5 新旧真实对拍 (§2.2) | 已覆盖 (M3 实测 + M4 + golden) |
| 3 | 非 JSON 容忍: 静默跳过 + code!=0 整段进 closeError | M4 fake-pi (single-errors.test.ts TC-008: exit 0 非 JSON 行静默跳过无害; TC-009: exit 1 + 非 JSON → error=rawStdout 整段) | 已覆盖 (M4 fake-pi) |
| 4 | 三阶段 drain: terminal stop → 1s grace SIGTERM → 3s SIGKILL 时序 | M3 e2e + M4 fake-pi (drain.test.ts TC-012/013/014: terminal stop 与 agent_settled 兜底均触发 1s SIGTERM → 3s SIGKILL, exitCode 归 0; timeout.test.ts TC-002 同管线; single-line-limit.test.ts TC-LIMIT-005 SIGTERM 忽略后 +3s SIGKILL) | 已覆盖 (M3 e2e + M4 fake-pi) |
| 5 | toolCall 中途 kill 的 session leaf 行为 (03 考察点 4 边角 c) | **未覆盖**: v1 不承诺 (M3-03 明确), 本 golden 未做真实 kill -9 对拍 (G3-old 的 0 消息超时与 kill -9 场景不同); 记已知限制, 移交 M6 现场验证 | 未覆盖 (已知限制) |
| 6 | 空输出判定: 冷启动空响应 → exitCode 1 + "Subagent produced no output..." | M4 fake-pi (single-errors.test.ts:144 断言文案 + exitCode 1); 本 golden 未真实复现 (真实模型基本必输出, 复现成本高) | 已覆盖 (M4 fake-pi) |

汇总: 6 项中 5 项已覆盖 (1/4 = M3 e2e + M4 fake-pi; 3/6 = M4 fake-pi; 2 = M3 实测 + M4 + 本 golden), 1 项 (5) 未覆盖 = v1 明确不承诺, 移交 M6.

## 4. 残余风险

- **fake-pi 保真度**: 罐头事件流与真实 pi 0.82.1 形状差异 (M4→M5 移交项); G1-G7 真实载荷与 fake-pi 断言核对一致, 已部分消解, 但未穷尽 (如 agent_settled 真实时序、真实 kill -9).
- **15min 默认 timeout 未真实长跑**: SIGTERM/SIGKILL 升级时序只验证了 6s/20s 中止路径 (G3/G6, 成本约束), 长跑路径的时序断言由 fake-pi 承载.
- **渲染视觉验证移交 M6**: 折叠/展开/Ctrl+O (M4 ISSUE-07 人工验证项) 不在本验收范围.
- **text 模式呈现限制**: 父模型上下文无工具 details (pi 呈现行为), 本报告权威值全部取自 `--mode json` 事件流; text 模式用户需依赖 content 回显.
- **旧侧 golden 样本量 1**: 每场景单次实测, 未做多次重复稳定性.
- **运行时面不计入**: prompt caching 下 cacheRead 随轮次线性膨胀是运行时行为, 静态工具面计账不含 (token-accounting §5 已知限制).

## 5. 结论

验收三件套全部通过:

1. **e2e 冒烟**: 新扩展保留模式 7/7 通过 (single/parallel/timeout/resume/model 错误/usageBudget/list), 无人工验证待办 (引 e2e-new-summary.md).
2. **golden 对拍**: 已知行为差异清单 7 条, 全部为有意设计 (决策编号可追溯: 调和 13 / M1-D003+D007 / 调和 5+M2-D003 / M2-D005 / M1-D007) 或两侧收敛 (超时 0 消息不可 resume, pi core isError 机制), 无未预期差异.
3. **token 实测**: ~303 tok/请求, 落在目标区间 250-400 内, 低于 450 硬顶 (余量 ~33%), 相对基线 ~6140 tok 下降 ~20.3x (-95.1%); 子侧 1291 → 0 (引 token-accounting.md).

M5 验收关闭. 未覆盖项与残余风险移交 M6 现场验证 (渲染视觉验证, kill -9 session leaf 边角, 长跑 timeout 时序, 新旧切换装载).
