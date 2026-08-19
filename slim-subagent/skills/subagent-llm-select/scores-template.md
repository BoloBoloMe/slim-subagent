# LLM 评分表

基准: `opencode-go/deepseek-v4-flash` 全维 = 1. 其余模型分数为相对基准的比率分, 允许 >1 (强于基准) 或 <1.
`null` = N/A (该维度不适用): 排序时权重归零重归一化; 任务必需维度 N/A 的模型被过滤.
`price` 列恒为 `derived`, 不存数值: 单位成本 = 0.75×input + 0.25×output (数据源 `~/.pi/agent/models-store.json` 的 `cost` 字段), 价格分 = 基准单位成本 ÷ 该模型单位成本. 厂商调价后重算即新, 无需改表.

## 模型分数

| model | coding | knowledge | longctx | multimodal | stability | price | speed | updatedAt | note |
|---|---|---|---|---|---|---|---|---|---|
| opencode-go/deepseek-v4-flash | 1 | 1 | 1 | 1 | 1 | derived | 1 | YYYY-MM-DD | 基准 |

## 维护

- scoped 列表新增模型: 手动加行, 全维 1 占位待评
- 改分: 事件驱动 — 实际使用翻车或惊艳时改, 同时更新 `updatedAt` 并把依据写进 `note`; 无定期审查
- model 列永远用 `provider/model` 全限定名, 同名模型存在于多个 provider
