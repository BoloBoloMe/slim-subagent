# M6 切换记录

日期: 2026-08-13. HITL 执行, 用户在场.

## 切换动作

1. 卸载旧扩展: `pi remove npm:pi-subagents` + 清理 settings.json `subagents` 节 (agentOverrides 含用户手写 prompt, 按用户指示不备份), npm lock 重建, 跨项目子会话目录/artifacts//tmp 残留全清.
2. 卸载 pi-intercom (用户追加指示): broker 进程 kill, `~/.pi/agent/intercom/` 删除. 环境零扩展包.
3. 装载新扩展: `pi install ./slim-subagent` → settings packages 本地路径自动装载 (M2-D009 第二阶段).
4. 旧扩展存档: pi-subagents-main/ 仓库底本也一并删除 (用户裁决), 不留备份 — 钉死版本参考使命已由 M3 移植规格 + M4 实现承接.

## 现场验证 (自动装载的全新会话, 真实子进程)

| 工作流 | 结果 |
|---|---|
| 自动装载 (无 -e/-ne) | 6/6 工具在位, stderr 零报错 |
| list | 3 内置 agents 名册正常 |
| single | 真实 explorer 任务跑通 |
| parallel | 双任务保序聚合正常 |
| timeout | 8s/6s 掐断 sleep 任务, 中止载荷正常 |
| resume | 从头前缀与随机尾段两种报号均恢复成功 |

观察项 (非扩展缺陷): 2/10 次 headless 运行中父模型 (k3) 自称无 subagent 工具, 但 6/6 工具枚举实验证明装载可靠 — 判为模型侧偶发误判, 与含 JSON 参数的复杂提示词相关.

## 两个现场发现与裁决 (均已施工, 85/85 绿)

1. **details 模型不可见** (pi 只喂 content 给模型, details 仅供 TUI): 超时后模型只收到一行错误文本, runId/diagnostics/hint 全不可达, M1-D005 诊断载荷目的落空. 裁决 (用户): 中止结果把 details 关键字段拼进 content 尾部 (runId+恢复指引/sessionDir/usage 摘要/上下文/hint), 正常结果保持纯净. 实施: single.ts assembleSingleResult 中止分支追加信息块; 测试 timeout/usage-budget 中止用例断言含字段, 正常用例断言不含.
2. **runId 前缀须从头报** (旧扩展裸 hex 任意前缀可报): 裁决 (用户) = 放宽 — 完整 runId 前缀或随机尾段前缀均可命中, 歧义报错不变. 实施: resume.ts findRunForResume 尾段匹配 + TC-002c.

两处修复由总指挥直接施工 (子代理派发通道当时出现生成故障, 偏离 tdd-as-orchestra 派遣纪律, 已在最终汇报记录).

## 完成标准核对

- 日常环境已在跑新扩展 ✓ (settings packages 自动装载)
- 高频工作流验证通过 ✓ (上表)
- 旧扩展处置有明确结论 ✓ (删除, 不留备份/底本)
