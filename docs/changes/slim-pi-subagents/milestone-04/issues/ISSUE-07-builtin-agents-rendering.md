# ISSUE-07 内置 agents 与 TUI 渲染

## 父级
- `../EXECUTION.md`

## 要构建什么

1. **内置 3 agents** (M1-D008): `slim-subagent/agents/explorer.md` (tools: read, grep, find, ls), `worker.md` (无 tools 字段 = 全工具), `reviewer.md` (tools: read, grep, find, ls, bash + prompt 内只读约束, 对齐官方 reviewer.md 直觉); frontmatter 格式对齐官方示例 (name/description/tools 逗号串, **均不带 model 字段** — 继承 pi 默认模型, EXECUTION.md 调和 10); body = system prompt, 中文撰写 (用户环境全中文), explorer=读/探索, worker=写/执行, reviewer=审查+兜底.
2. **TUI 最小渲染** (M1-D001 第 9 项): renderCall 摘要 + renderResult 折叠/展开 + usage 统计, 整搬官方示例 `index.ts:700-` 与 `:744-` 段 (含 formatTokens 等辅助函数与 pi-tui Container/Markdown/Spacer/Text 依赖).

适合 AFK (agents md + 渲染搬运); 渲染效果本身为人工验证特例 (TUI 无法 node:test 断言).

## 覆盖依据
- Product: `../../milestone-01/DECISIONS.md`, M1-D008, M1-D001(9)
- Technical: 官方示例 `agents/*.md` (格式), `index.ts:700-`/`:744-` (渲染段)

## 相关决策
- `../../milestone-01/DECISIONS.md`: D008, D001(9)

## 允许范围
- `slim-subagent/agents/*.md` 3 个新文件; index.ts 渲染段; `test/` 增补.

## 禁止范围
- 搬运旧 9 个 agents 或用户 8 个 override 角色 (M1-D008); 给内置 agents 写 model/fallbackModels/skills 字段; 自研渲染风格 (整搬官方).

## 代码定位提示
- 官方示例 `agents/explorer 对应物`: scout.md/worker 对应物见 examples agents/ 目录 4 个 md; reviewer.md 已含只读 bash 约束范文.
- 渲染: 官方示例 index.ts:700- (renderCall), :744- (renderResult), 顶部 import 的 pi-tui 组件与 formatTokens/COLLAPSED_ITEM_COUNT=10/PER_TASK_OUTPUT_CAP=50KB 常量.
- ISSUE-01 发现机制已消费 agents/ 目录 — 本 issue 填内容即自动出现在 list.

## TDD 切片

- TS-001:
  接缝: list 与 spawn argv (fake 回显).
  测试用例: TC-001 list 返回含 explorer/worker/reviewer 且描述非空; TC-002 用 explorer 执行 → fake argv 含 `--tools read,grep,find,ls`; TC-003 用 worker 执行 → argv 无 `--tools` 且无 `--model`.
  先写的失败测试: `builtin agents discoverable with pinned tools` — 失败因 md 未写.
  最小绿色实现范围: 3 个 md 文件.
  不得测试: prompt 文本内容措辞 (人工审查); frontmatter 解析器.
  覆盖: M1-D008.
- TS-002 (人工验证特例, 非代码切片):
  接缝: TUI 渲染.
  人工验证清单: `pi -e` 装载后跑一次 single — renderCall 显示 agent+task 摘要; renderResult 折叠态 ≤10 行/可展开; usage 统计行 (tokens/cost/turns) 显示; parallel 时每任务分块渲染.
  覆盖: M1-D001(9).

## 验证入口
- `node --test "slim-subagent/test/**/*.test.ts"` TS-001 全绿.
- TS-002 人工验证清单逐项过.

## 风险提示
- 渲染段整搬后 import 的 pi-tui 组件在测试环境仅模块加载 (不调用 render), 解析失败按 EXECUTION.md 软链方案处理.
- prompt 撰写保持短 (内置 agent 描述进 list 名册, 一句话).
- 填充内置 agents 后, ISSUE-01 依赖空内置目录的全量名册断言失效 (list.test.ts TC-003/004/005, validate.test.ts TC-010): 本 issue 须同步改造这些测试 — 内置源隔离 (测试内替换/过滤内置目录) 或改写断言为含内置 3 agents 的名册.

## 停止条件
- 需要第 4 个内置 agent 或 model 字段 (改 M1-D008/调和 10) → 停止回用户.

## 适合 AFK 的原因
agents 内容与渲染段均有官方示例祖型, prompt 撰写属实施细节 (M1-D008 明示).

## 验收标准
- [x] TS-001 全绿; 3 个 md 无 model 字段
- [x] TS-002 人工验证清单通过 (headless 冒烟替代, 视觉项移交 M6 — AFK-10)
- [x] list/渲染中内置 agents 可见可用

## 被阻塞于
- ISSUE-01
