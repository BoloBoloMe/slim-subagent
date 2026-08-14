# 状态: 已关闭
# 类型: task
# 阻塞于: 无

## 问题

搭原型骨架, 为 M04/M05/M06 三个原型铺路:

- 独立 scratch 扩展 (如 `~/.pi/agent/extensions/subagent-panel-proto/`, 自动发现 + `/reload` 热载), **不动 slim-subagent 本体**, 不污染基线 commit.
- 注册假工具 `subagent_proto`: 用定时器按真实触发点分布回放 onUpdate 序列喂假 RunNode 数据 — single 对照 single.ts:811-904 (spawn 初始/message_end/tool_result_end/close), parallel 对照 index.ts:265-275 (初始 1 次 + per-child 完成聚合).
- 验证 `/reload` 秒级热载循环.

完成标准: 骨架可跑, 回放时序对照真实分布; 载体路径与用法记录进 `docs/changes/subagent-panel/milestone-03/`.
