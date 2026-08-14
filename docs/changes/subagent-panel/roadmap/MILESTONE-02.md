# 状态: 待处理
# 类型: deliberate
# 阻塞于: 无

## 问题

契约审计发现 PRD (`docs/changes/subagent-panel/pi_agent_subagent_panel_prd.md`) 5 处缺口, 逐条盘问拍板并修订 PRD:

1. **contextPercent 语义错位**: `details.contextPercent` 现为父会话窗口占用 (single.ts:1213-1223); 子代理真实占用须用 `contextTokens / resolveModelWindow(child model)` 推导. §3/§4.0 数据源口径怎么改?
2. **final details 缺 agent/task/timeoutMs** (single.ts:1297-1316; renderResult 硬编码 `"subagent"` index.ts:518): 补哪些字段? taskPreview 截断/脱敏规则?
3. **endedAtMs 无记录**: settle 处补写 (single.ts:1021), run.json 是否同步加? GC 后用 session.jsonl mtime 近似是否接受?
4. **L16 "触顶前一刻"无对应触发点** (检查即中止, single.ts:873-879): 改措辞为同点 warn+error, 还是加阈值预警逻辑? L14 与 L13 同出口 (single.ts:989) 如何定界?
5. **R5 节点键漂移**: final single details 无 `mode` 字段 (live 有, single.ts:817 vs 1266+), §8 节点键补丁怎么打?

调用 `deliberate` skill, 产物根目录 `docs/changes/subagent-panel/milestone-02/`.

完成标准: 盘问闭环, 修订落入 PRD.
