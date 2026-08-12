# ISSUE-01 骨架与发现面

## 父级
- `../EXECUTION.md`

## 执行(Execution)
- [x] 已实现

## 要构建什么

新扩展目录 `slim-subagent/` 可经 `pi -e ./slim-subagent/index.ts` 装载, 注册同名工具 `subagent` (M2-D001): typebox schema 恰 9 参数 (M2-D008 参数表, 条件必填由 execute 校验承担), 工具描述 = M2-D010 中文 v3 原文逐字. agents 发现两源: 内置 (扩展目录 `agents/`, 本 issue 阶段可为空目录) + user (`~/.pi/agent/agents/`), 用 pi 包 `parseFrontmatter` 解析, `name`/`description` 缺失静默跳过, `tools` 兼容逗号串与 YAML 块列表数组 (Array.isArray 防御, M3-04 考察点 3). `action:"list"` 返回最小名册 (名字+一句话, 按名排序, 空则 `- (none)`). execute 校验: 未知 agent 报错并列候选名; `task` 与 `tasks` 互斥; 缺省 action 时二者至少其一; `action:"list"` 时 agent 可省. 适合 AFK: 暴露面已被 M2-D008/D010 逐字钉死, 无任何产品/API 决策残留.

## 覆盖依据
- Product: `../../milestone-01/DECISIONS.md`, M1-D009 (最小 list), M1-D010 (约束进描述)
- Technical: `../../milestone-03/04-spawn-args-frontmatter.md` 考察点 3/4; 官方示例 `agents.ts` (discoverAgents) 与 `index.ts:276-283` (unknown-agent 报错), :461-469 (静态描述), :584-590 (校验报错形态)

## 相关决策
- `../../milestone-01/DECISIONS.md`: D009, D010
- `../../milestone-02/DECISIONS.md`: D001 (同名注册), D007 (只扫 user 目录), D008 (恰 9 参数), D009 (pi -e 两阶段装载), D010 (描述 v3 原文)

## 允许范围
- `slim-subagent/` 全部新文件 (index.ts 与内部模块拆分自定); `slim-subagent/agents/` 空目录或占位; `slim-subagent/test/`; 仓库 `node_modules/` dev 软链 (EXECUTION.md 全局允许范围).

## 禁止范围
- spawn/子进程执行逻辑 (ISSUE-02); resume/list 之外的 action 分支实现; TUI render (ISSUE-07); project agents 扫描; 任何配置文件体系.
- `pi-subagents-main/` 只读; 不写 `~/.pi/agent/extensions/`.

## 代码定位提示
- 官方示例: `index.ts` 顶部 registerTool 骨架与 schema 写法, `agents.ts` 全文 (discoverAgents/formatAgentList 简化来源), `index.ts:276-283` unknown-agent 报错文本形态.
- M3-04 考察点 3 (frontmatter 字段集裁剪: name/description/tools/model + body) 与考察点 4 (list 最小格式 `- <name>: <description>`).
- M2-D008 参数表逐项; M2-D010 描述全文 (逐字拷贝, 含标点).
- user agents 目录路径用 pi 包 `getAgentDir`/`CONFIG_DIR_NAME`; 测试用临时 HOME 隔离.

## TDD 切片

- TS-001:
  接缝: 工具注册面 (fake ExtensionAPI 捕获 registerTool 的 schema/描述).
  测试用例: TC-001 schema 参数名集合恰为 {agent, task, tasks, model, timeoutMs, usageBudget, cwd, action, id}; TC-002 描述字符串 === M2-D010 v3 原文.
  先写的失败测试: `schema exposes exactly 9 pinned params` / `description matches pinned v3 text` — 失败因扩展文件尚不存在.
  最小绿色实现范围: index.ts 骨架 + registerTool + schema + 描述常量.
  不得测试: 内部模块结构; schema 内部嵌套细节之外的私有常量.
  覆盖: M2-D008, M2-D010.
- TS-002:
  接缝: `action:"list"` 的 execute 返回.
  测试用例: TC-003 临时 HOME 放 2 个 user agent md → list 返回二者名字+一句话, 按名排序; TC-004 无任何 agent → `- (none)`; TC-005 缺 name 或 description 的 md 被静默跳过; TC-006 tools 为 YAML 块列表 (数组) 不崩且正确解析.
  先写的失败测试: `list merges user agents sorted by name` — 失败因发现逻辑未写.
  最小绿色实现范围: 两源发现 + frontmatter 解析 + list 格式化.
  不得测试: 文件系统 walk 的内部顺序; parseFrontmatter 本身 (pi 包行为).
  覆盖: M1-D009, M2-D007.
- TS-003:
  接缝: execute 参数校验 (action 缺省执行分支的入口校验, 不触发 spawn).
  测试用例: TC-007 未知 agent → isError 且文本含全部候选名; TC-008 task 与 tasks 同给 → 报错; TC-009 缺省 action 且 task/tasks 均缺 → 报错; TC-010 action:"list" 且无 agent → 正常返回 (不报错).
  先写的失败测试: `unknown agent error lists candidates` — 失败因校验未写.
  最小绿色实现范围: execute 分发前的校验层 (spawn 调用可留 TODO 抛错, 属 ISSUE-02).
  不得测试: spawn 行为; 校验函数的内部组织.
  覆盖: M2-D008 (条件必填), M1-D009 (error-driven 兜底).

## 验证入口
- `node --test "slim-subagent/test/**/*.test.ts"` 全绿.
- 人工冒烟: `pi -e ./slim-subagent/index.ts` 启动, `action:"list"` 返回名册, 无装载报错.

## 风险提示
- node 与 jiti 模块解析差异: 装载/测试时 `@earendil-works/pi-coding-agent` 解析失败 → 按 EXECUTION.md 停止条件回报, 不绕路改写发现逻辑.
- schema 用 typebox `Type.Union([Type.Literal("list"), Type.Literal("resume")])` 表达 action 枚举, 避免引入 pi-ai `StringEnum` 运行时依赖.

## 停止条件
- 需要改 schema 参数集/描述文案 (即改 M2 决策) → 停止回用户.
- 发现 list 需要 project 源才能满足某用例 → 停止 (M2-D007 禁止).

## 适合 AFK 的原因
schema/描述/发现源/校验行为全部被 M2 决策逐字钉死, 无自由裁量.

## 验收标准
- [ ] schema 恰 9 参数, 描述 === M2-D010 v3 原文
- [ ] list 两源合并/排序/空名册/跳过坏文件/数组 tools 防御全绿
- [ ] unknown-agent 报错列候选; task⊕tasks 互斥校验全绿
- [ ] `pi -e` 人工冒烟 list 可用

## 被阻塞于
- 无
