# 状态: 待处理
# 类型: task
# 阻塞于: MILESTONE-08

## 问题

日志骨架 (PRD §12 第 1 步). AFK 编码任务, 调用 `tdd-as-orchestra` skill:

- `~/.pi/subagent_log/` append-only JSONL writer, 按日分文件 `subagent-YYYYMMDD.log`;
- level 体系 (trace..fatal) + `PI_SUBAGENT_LOG_LEVEL` + 脱敏 (不记完整 task/prompt/session/secret) + taskHash;
- 7 日 GC 挂现有 `session_start` 触发点, 活跃 lease 引用跳过并记 L42;
- 最小闭环日志点: L01–L10, L25–L27, L40–L44;
- 日志写入失败降级, 不得让子代理执行失败.

产物根目录 `docs/changes/subagent-panel/milestone-09/`. 完成标准: 正常/失败路径产生对应日志, JSONL 行可解析, 单测通过.
