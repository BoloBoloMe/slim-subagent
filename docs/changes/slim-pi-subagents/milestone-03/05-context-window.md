# 05-context-window: timeout 诊断载荷的上下文窗口数据源验证

pi 版本: 0.82.1. 安装路径: `/var/home/bolo/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/` (下文缩写为 `$PI`).

结论先行: 扩展面 (ExtensionContext.ctx) 可直接拿百分比, 无需保底方案. `ctx.getContextUsage()` 返回 `{tokens, contextWindow, percent}`, 这是 pi 官方文档化的 API (docs/extensions.md:1036). JSON 事件流 (`--mode json`) 只有绝对 token 数 (`usage.totalTokens`), 无 contextWindow/percent, 保底方案仅作为 JSON 流侧或扩展面不可用时的 fallback.

---

## 考察点 1: model-config.js 中 contextWindow 的位置/形状/是否导出

### 证据位置
- `$PI/dist/core/model-config.js:140`: `contextWindow: Type.Optional(Type.Number())` — 属 `ModelDefinitionSchema` (provider.models[] 中每个 model 定义的可选字段).
- `$PI/dist/core/model-config.js:157`: `ModelOverrideSchema` 同样有 `contextWindow` (可选 number), 可覆盖 model 级值.
- `$PI/dist/core/model-config.js:198-247`: `export class ModelConfig` — 导出 `providers: Map<string, ProviderConfig>`, 方法 `getProvider/getProviderIds/getError`. contextWindow 是 schema 的一部分, 不是独立导出项.
- `$PI/dist/core/provider-composer.js:69`: `contextWindow: definition.contextWindow ?? 128000` — model 对象 (provider-composer 组装结果) 上 `contextWindow` 恒有值, 用户未配置时默认 128000.
- `$PI/node_modules/@earendil-works/pi-ai/dist/types.d.ts:651`: `Model` 接口中 `contextWindow: number` 为必需字段 (类型层面保证存在).
- 用户配置实证: `/home/bolo/.pi/agent/models.json` 中 `deepseek-v4-flash-0731` 显式配置 `"contextWindow": 1000000, "maxTokens": 384000`.

### 结论
- contextWindow 存在于每个 model 定义 (schema 可选, 运行时 model 对象恒有值, 默认 128000).
- ModelConfig 类导出, 但扩展面不直接暴露 ModelConfig; 而是通过 `ModelRegistry` (model-registry.js) 与 `ctx.model` 暴露组装后的 model 对象.
- 形状: `contextWindow: number` (token 数, 整数).

---

## 考察点 2: JSON 事件流实测 — message_end.usage 字段全集

### 证据位置 (实测)
命令 (在 /tmp 运行, 真实模型调用):
```
cd /tmp && timeout 120 pi --mode json -p --no-session --model deepseek/deepseek-v4-flash --no-tools '写一个词: ok'
```
message_end (assistant) 实测输出片段:
```json
{"type":"message_end","message":{"role":"assistant","content":[...],"api":"openai-completions","provider":"deepseek","model":"deepseek-v4-flash","usage":{"input":762,"output":355,"cacheRead":0,"cacheWrite":0,"reasoning":353,"totalTokens":1117,"cost":{"input":0.00010668,"output":0.0000994,"cacheRead":0,"cacheWrite":0,"total":0.00020608}},"stopReason":"stop","timestamp":1786376458026,"responseId":"c6d2b755-02ad-4a60-b502-e1e658c8f680"}}
```

### usage 实际字段全集 (实测逐个列出)
| 字段 | 类型 | 实测值 | 含义 |
|---|---|---|---|
| `input` | number | 762 | 输入 token |
| `output` | number | 355 | 输出 token (含 reasoning) |
| `cacheRead` | number | 0 | 缓存读 token |
| `cacheWrite` | number | 0 | 缓存写 token |
| `reasoning` | number (可选) | 353 | 推理 token, 是 output 的子集; 未上报时缺省 |
| `totalTokens` | number | 1117 | token 总数 (input+output+cacheRead+cacheWrite) |
| `cost` | object | {...} | 成本明细 {input, output, cacheRead, cacheWrite, total} |

类型定义佐证: `$PI/node_modules/@earendil-works/pi-ai/dist/types.d.ts:251-270` `Usage` 接口 (另有可选 `cacheWrite1h`, 仅 Anthropic 上报; 实测 deepseek 未出现).

### 结论
- usage 无 `contextTokens` 字段, 无 `contextWindow`, 无百分比. `totalTokens` 是唯一的 token 总数来源.
- assistant message 顶层有 `model: "deepseek-v4-flash"`, `provider: "deepseek"`, `api: "openai-completions"` — model 名可从 `message.model` 拿.
- 因此 JSON 事件流只能给绝对 contextTokens, 不能给百分比.

---

## 考察点 3: 扩展面可查性 — ExtensionAPI/ctx 上的 contextWindow/contextTokens 访问器

### 证据位置
- `$PI/docs/extensions.md:1036-1045`: 文档化 API `ctx.getContextUsage()` — "Returns current context usage for the active model. Uses last assistant usage when available, then estimates tokens for trailing messages." 示例: `const usage = ctx.getContextUsage(); if (usage && usage.tokens > 100_000) {...}`.
- `$PI/dist/core/extensions/types.d.ts:192-198`: `ContextUsage` 接口 = `{ tokens: number | null; contextWindow: number; percent: number | null }` (tokens/percent 在压缩后、下次响应前可能为 null).
- `$PI/dist/core/extensions/types.d.ts:238`: `ExtensionContext.getContextUsage(): ContextUsage | undefined` — ctx 上直接可用.
- `$PI/dist/core/extensions/types.d.ts:225-237` (ExtensionContext 接口): 另有 `model: Model<any> | undefined` — 当前模型对象, 其 `contextWindow` 字段类型见 pi-ai `dist/types.d.ts:651` (必需 number).
- `$PI/dist/core/extensions/runner.js:181`: `this.getContextUsageFn = contextActions.getContextUsage;` + runner.js:514-516 暴露给 ctx — 链路确认.
- 实现: `$PI/dist/core/agent-session.js:2537-2571` `getContextUsage()`: 取 `model.contextWindow`, 优先用最近一次 assistant usage 估算 (压缩边界后校验), 否则估算 trailing messages; 返回 `{tokens, contextWindow, percent}`, contextWindow<=0 或无模型时返回 undefined.

### 结论
- 扩展面完全可查, 且有官方文档支持:
  - 首选: `ctx.getContextUsage()` → `{tokens, contextWindow, percent}` (百分比直接可得).
  - 备选: `ctx.model.contextWindow` (当前模型的窗口大小, 恒有值) + `ctx.model.name`/`ctx.model.id` (model 名).
- `pi.getModelInfo` 不存在; `pi.runtime` 亦非公开 API. 无需这两个.

---

## 考察点 4: 诊断载荷设计结论

### (a) 能拿百分比 (扩展面场景, 推荐)
- 字段: `contextUsage.tokens` (number|null), `contextUsage.contextWindow` (number), `contextUsage.percent` (number|null).
- 获取路径: 扩展事件处理器/工具内 `ctx.getContextUsage()` (ExtensionContext, docs/extensions.md:1036).
- model 名: `ctx.model.name` 或 `ctx.model.id` (ExtensionContext.model, 类型见 pi-ai types.d.ts:644-652); 未运行时也可从 `message.model` 拿.

### (b) 保底方案 (仅 JSON 事件流或 ctx 不可用时)
- 字段: `contextTokens` = `message_end.message.usage.totalTokens` (绝对 token 总数); `model` 名 = `message_end.message.model` (实测存在, 字符串).
- 说明: JSON 流无 contextWindow/percent, 故保底只能报绝对数; model 名来源 `message.model` (assistant message 顶层字段, 实测输出确认).

### 诊断载荷最终字段 (两者归一)
```
diagnostics: {
  contextTokens: number | null,        // (a) getContextUsage().tokens 或 (b) usage.totalTokens
  contextWindow: number | undefined,   // (a) getContextUsage().contextWindow 或 ctx.model.contextWindow; JSON 流无 → undefined
  contextPercent: number | null,       // (a) getContextUsage().percent; JSON 流无 → null
  model: string                        // (a) ctx.model.name 或 (b) message.model
}
```

---

## 考察点 5: e2e 记录

- 命令 (真实模型调用, 在 /tmp, 极短任务):
  ```
  cd /tmp && timeout 120 pi --mode json -p --no-session --model deepseek/deepseek-v4-flash --no-tools '写一个词: ok'
  ```
- 输出片段 (message_end assistant 行, 见考察点 2): usage 字段全集 = {input:762, output:355, cacheRead:0, cacheWrite:0, reasoning:353, totalTokens:1117, cost:{...}}; 无 contextTokens/contextWindow/percent.
- 实测环境: pi 0.82.1, model `deepseek/deepseek-v4-flash`, 非离线, 调用成功.
- 置信度: 高 (真实模型响应, 非静态推断). 单次调用未覆盖 Anthropic `cacheWrite1h` 字段 (仅该 provider 上报), 与本次任务无关.

---

## 推荐字段清单 (直接给 M4)

M4 (timeout 诊断载荷) 采用以下字段, 来源优先级从高到低:

1. `contextPercent` (number|null): 首选 `ctx.getContextUsage().percent`; 不可用则 null.
2. `contextTokens` (number|null): `ctx.getContextUsage().tokens`, 或 JSON 流 `message_end.message.usage.totalTokens`, 或 null.
3. `contextWindow` (number|undefined): `ctx.getContextUsage().contextWindow` 或 `ctx.model.contextWindow`; JSON 流场景缺省.
4. `model` (string): `ctx.model.name` (扩展面) 或 `message_end.message.model` (JSON 流, 实测存在).
5. 规则: 扩展面场景直接打包 (1)+(2)+(3)+(4); JSON 流场景打包 (2)+(4), (1)(3) 置 null/undefined. 百分比缺失时消费端可自行用 `contextTokens/contextWindow` 计算 (contextWindow 有值且 >0 时).
