# M3-04 移植规格: pi 可执行寻址 + pi-args 核心 + frontmatter + list + 并发上限 + 模型选择

- 类型: research (移植规格)
- 来源代码库: pi-subagents-main v0.44.0 (只读)
- 实测基线: pi CLI 0.82.1 (/home/bolo/.volta/bin/pi), 官方示例 /var/home/bolo/.volta/tools/image/packages/@earendil-works/pi-coding-agent/.../examples/extensions/subagent/
- 关联决策: D001 (保留集), D004 (resume→session-dir), D007 (fallback 删/配错显式报错), D008 (内置 3 agents), D009 (最小 list), D010 (无 skills)
- 依据文档: direction-research/C-rewrite.md §3.1 可搬运清单, MILESTONE-03

---

## 考察点 1: getPiSpawnCommand 完整逻辑 (pi 可执行寻址)

### 旧码位置
- src/runs/shared/pi-spawn.ts (163 行, 全读)
- 调用点: src/runs/foreground/execution.ts:465 (`getPiSpawnCommand(args)`), spawn :466-473
- 官方示例对应物: index.ts:249-262 `getPiInvocation` (简化版)

### 行为描述
`getPiSpawnCommand(args, deps)` (:141-163) 返回 `{command, args}`, 4 级优先级链:

1. **env 覆盖** (:143-146): `PI_SUBAGENT_PI_BINARY` (const :9) trim 后非空 → `command=env 值`, args 原样. 用户显式指定二进制, 最高优先.
2. **独立可执行** (:148-150): `process.execPath` 文件名匹配 `/^pi(\.exe)?$/i` (`isStandalonePiExecutable` :85-88) → `command=execPath`. 覆盖 bun 单文件打包/原生 pi 可执行场景.
3. **CLI 脚本解析** (`resolvePiCliScript` :92-138):
   a. `process.argv[1]` 存在且是 runnable node 脚本 (.mjs/.cjs/.js, `isRunnableNodeScript` :66-72) → realpath 后仍 runnable 且向上找 package.json `name === "@earendil-works/pi-coding-agent"` (`findPiPackageRootFromEntry` :18-28) → 返回该脚本 (扩展被 pi 以 node 加载时, argv[1] 就是 pi CLI 入口);
   b. 否则解析包: `import.meta.resolve(包名)` 向上找包根 (`resolveInstalledPiPackageRoot` :30-35) 或 `process.argv[1]` realpath 找包根 (`resolvePiPackageRoot` :37-45) → 读 package.json `bin` (string / `pi` 键 / 第一个值) → 拼接 CLI 脚本路径;
   c. 全失败 → undefined.
4. **PATH 兜底** (:160-162): `command="pi"`.

环境/路径处理: spawn 时 `cwd: options.cwd ?? runtimeCwd`, `env: {...process.env, ...sharedEnv, ...depthEnv}`, `stdio: ["ignore","pipe","pipe"]`, `windowsHide: true` (execution.ts:466-473). PiSpawnDeps (:58-75) 是 fs/execPath/argv1/env 依赖注入面, 供单测.

bun 场景: 官方示例显式检查 bun 虚拟路径 `/$bunfs/root/` (index.ts:250-251, argv[1] 是虚拟路径则跳过脚本分支); 旧码无显式检查, 但 `isRunnableNodeScript` 对 `$bunfs` 路径 fs.existsSync 为 false → 自然落到包解析/PATH 兜底, 行为等价.

### 移植规格
- **整搬 4 级链, 但裁掉依赖注入面**: 保留 `PI_SUBAGENT_PI_BINARY` env 覆盖 + `isStandalonePiExecutable` (打包场景) + argv[1] 脚本分支 + 包解析 + PATH 兜底; 保留 `PI_CODING_AGENT_PACKAGE` 常量与 `findPiPackageRootFromEntry` 纯函数. 裁剪: PiSpawnDeps 只留 `execPath/argv1/env` 三注入点 (删 platform/自定义 fs 注入), 或直接整搬 (~120 行, 官方示例超集).
- 必须保留项 (逐条): (a) env 覆盖 — 测试与用户显式指定二进制; (b) standalone 分支 — 打包场景; (c) argv[1] 脚本分支 — node 加载扩展时的主流路径; (d) 包 bin 解析兜底 — argv[1] 不可用时不依赖 PATH.
- spawn 参数: 保留 `cwd` (默认 ctx.cwd), `stdio: ["ignore","pipe","pipe"]`, `windowsHide: true`; env 仅继承 `process.env` (无 sharedEnv — 见考察点 2 env 管线删除).
- 官方示例 `getPiInvocation` 缺 env 覆盖与包解析, 不建议照抄; 旧码链是其超集, 照旧码搬.

---

## 考察点 2: pi-args 组装核心 (flags 全集与裁剪清单)

### 旧码位置
- src/runs/shared/pi-args.ts `buildPiArgs` (:514-597 args 组装, :599-800 env 管线)
- 调用点: execution.ts:311-330 (baseArgs 传入 `["--mode","json","-p"]` :312), spawn env 合并 :459
- 关联: TASK_ARG_LIMIT=8000 (:65), applyThinkingSuffix (:186-200), resolvePiLaunchToolPlan (:339-512)

### 行为描述 (args 组装, flags 全集与加条件)

| flag | 旧码行 | 加的条件 | 说明 |
|---|---|---|---|
| baseArgs | :515 | 恒加 | `["--mode","json","-p"]`; `-p`=--print 非交互 (pi --help 确认) |
| `--session <file>` | :517-519 | sessionFile 设 | 先 mkdirSync 父目录; resume 路径用 (executor.ts:674-683 校验 .jsonl 存在) |
| `--no-session` | :521-523 | 无 sessionFile 且 sessionEnabled=false | 旧默认 ephemeral; sessionEnabled 计算见 execution.ts:1418 (`Boolean(sessionFile||sessionDir)||shareEnabled`) |
| `--session-dir <dir>` | :524-527 | 无 sessionFile 且 sessionDir 设 | 先 mkdirSync; D004 resume 用 per-run 目录 |
| `--model <model>` | :530-533 | applyThinkingSuffix 结果非空 | 值 = model 或其 + `:thinking` 后缀 (见考察点 6) |
| `--tools <csv>` | :549-555 | explicitToolAllowlist 且 allowlist 非空 | 逗号连接; 空 allowlist → `--no-tools`; pi --tools 对 builtin+extension+custom 全生效 |
| `--no-extensions` | :556-558 | disableAmbientExtensions (显式 extensions 或 capability ceiling deny) | 见下 "M4 待决策" |
| `--extension <path>` | :559-560 | extensionArgs 非空 | 逐 path 加 |
| `--no-context-files` | :562-564 | inheritProjectContext=false | 子代理不读 AGENTS.md/CLAUDE.md |
| `--no-skills` | :565-567 | inheritSkills=false | 子代理不加载 skills (D010 保留此 flag: 内置 agents 无 skills, 防子进程误加载) |
| `--system-prompt` / `--append-system-prompt <file>` | :570-585 | systemPrompt 非 null/undefined | mkdtemp 写 `<stem>.md` (0600), stem 由 promptFileStem 清洗 `[^\w.-]`→`_`; mode=replace → --system-prompt, 否则 --append-system-prompt; 旧码注入 `<active_agent>` 标签 (:574-578, permission-system 用, 删) |
| `Task: <task>` / `@<file>` | :588-597 | task.length > 8000 → @file, 否则内联 `Task: ` 前缀 | @file 是 pi 原生 arg (`pi [options] [@files...] [messages...]`, 实测可用) |

env 管线 (:599-800) 全貌: PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT (:600-604), runtime-acknowledged-extensions (:605-615), tool-diagnostic (:616-625), MCP env (:626-628), SUBAGENT_CHILD/FANOUT env (:629-631), wait-tool (:632-635), 嵌套路由 SUBAGENT_PARENT_* 全系 (:636-720), intercom (:721-726), orchestrator (:727-731), permission (:732-748), run-id/child agent env (:749-758), MCP_DIRECT_TOOLS (:759-765), capability-ceiling (:766-769), PERMISSION_POLICY (:770-771), structured-output (:772-777), steer (:778-787), tool-budget (:789-795), watchdog (:796-798), SUBAGENT_PARENT_SESSION (:799-800).

### 移植规格
保留 (简化签名): `buildPiArgs({baseArgs, task, sessionEnabled, sessionDir, sessionFile, model, tools, systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, promptFileStem}) → {args, tempDir}`:
- baseArgs + `Task:`/@file (TASK_ARG_LIMIT=8000 保留, @file 机制 pi 原生支持);
- session 三态逻辑整搬 (:517-528); D004 用法: 普通执行传 sessionDir (per-run 目录, sessionEnabled=true → 不加 --no-session), resume 传 sessionFile → `--session <file>`;
- `--model` (:530-533) 去 thinking 后缀 (考察点 6);
- `--tools` (:549-555) 简化: `agent.tools?.length ? push("--tools", tools.join(",")) : 不加` (官方示例 index.ts:296 同款; 删 explicitToolAllowlist/--no-tools 分支? 保留 `--no-tools` 语义: 显式 tools 但空数组时 — 官方示例不处理, 建议照官方示例: 有 tools 才加);
- `--no-context-files`/`--no-skills` 保留 (inheritProjectContext/inheritSkills 布尔);
- system-prompt temp 文件 (:570-585) 保留, 删 `<active_agent>` 注入;
- tempDir 生命周期: 旧码 cleanupTempDir (:791-798, rmSync recursive force) 在进程 close 时调用 (execution.ts:1107); 官方示例 mkdtemp+用完删. 保留.

删除:
- resolvePiLaunchToolPlan 全链 (:339-512) 及其上游 (capability-ceiling / MCP 直连工具 / structured-output / permission-system 探测 :289-338);
- `--no-extensions`/`--extension` 段 (:556-560);
- env 管线 (:599-800) 整体删 — 见下方 "M4 待决策" 与删除项确认.

**M4 待决策 (防子代理递归调用)**: 旧码用 env `SUBAGENT_CHILD_ENV=1` + fanout-child.ts (:148-178) 在子进程内把 subagent 工具限制为 child-safe 模式; 新扩展无 child 扩展机制, 而官方示例装在 ~/.pi/agent/extensions 后子进程同样会加载 subagent 工具 (官方示例未处理递归). 选项: (a) 子进程恒加 `--no-extensions` (D007 "子进程零工具注入" 倾向); (b) 靠 agent.tools allowlist 排除 subagent (无 tools 字段时失效). 建议 (a), 但属 M4 施工决策, 此处仅记录.

---

## 考察点 3: frontmatter 解析

### 旧码位置
- src/agents/frontmatter.ts (149 行, 全读): parseFrontmatter (:86-149), parseFrontmatterList (:52-66), foldBlock (:16-48), escapeRegex (:4-8)
- 调用方: src/agents/agents.ts:1497-1510 (loadAgentsFromDir)
- 官方示例: agents.ts:7 用 pi 包 `parseFrontmatter` (dist/utils/frontmatter.js, 25 行, 基于 `yaml` 包真解析)

### 行为描述
旧 parseFrontmatter 规则:
- 仅处理文档开头单个 frontmatter 块: `startsWith("---")` 且 `indexOf("\n---", 3)` 找到结束; 无则整文当 body; **无多文档支持**; `\r\n` 归一为 `\n`.
- 手写行解析: 每行 `/^([\w-]+):\s*(.*)$/`; 简单值去首尾单双引号; 空值 + 后续更缩进行 = 块值 (去公共缩进存为带换行字符串); folded 指示符 `>`/`>-` → foldBlock (折叠换行为空格, 保留更缩进行与空行).
- 值全部 string 类型; 无默认值/校验 (校验在调用方).
- parseFrontmatterList: 逗号分隔或 `- item` 块列表 → string[] (只剥标准 `- ` 标记).
- 调用方: `name`/`description` 缺失 → **静默跳过**该文件 (不报错); 其余字段逐个解析 (agents.ts:1507-1560: package/runner/tools/mcpDirectTools/defaultReads/aliases/skills/skillPath/fallbackModels/systemPromptMode/inheritProjectContext/inheritSkills/defaultContext/async/timeoutMs/turnBudget/acceptance/memory...).
- pi 官方 parseFrontmatter: yaml 包真解析, 返回类型化值 (boolean/number/array/嵌套对象), 无折叠逻辑; 官方示例只读 name/description/tools/model + body.

### 移植规格
- **建议整搬官方示例方案**: import `parseFrontmatter` from `@earendil-works/pi-coding-agent` (peer 依赖已含, 官方示例 agents.ts:7 同款). 理由: (a) D008 新写 3 个内置 agents 用官方示例格式 (name/description/tools 逗号串/model/body, 见 agents/scout.md); (b) 少 ~150 行手写解析; (c) 官方示例已证明可用.
- 字段集 (裁剪后): 保留 `name`(必需, 缺失跳过), `description`(必需, 缺失跳过), `tools`(逗号串, 可选), `model`(可选), body = systemPrompt. 其余字段全删.
- **类型防御注意**: pi parseFrontmatter 对 `tools:` 的 YAML 块列表返回数组, 官方示例 `frontmatter.tools?.split(",")` 会崩; 新扩展若兼容用户老格式 (块列表), 需 `Array.isArray` 分支. 用户侧无自定义 agents (F003), 风险低, 规格注明即可.
- 若坚持零依赖 (可选): 只搬 parseFrontmatter+parseFrontmatterList (~70 行), 值全 string, 兼容逗号与 `- item` 两种 tools 写法; 弃 foldBlock/escapeRegex 复杂分支.

---

## 考察点 4: 旧 list action

### 旧码位置
- 分发: src/runs/foreground/subagent-executor.ts 管理 action 区 (:4424-4952); action 校验 `SUBAGENT_ACTIONS` (:4938, 清单在 shared/types.ts:1925, 含 "list"), 调 handleManagementAction (:4952)
- 实际处理: src/agents/agent-management.ts:1244 (`case "list"`) → handleList :753-790

### 行为描述
handleList 输出 (text):
```
Executable agents:
- <name> (<source>[<, context: ...><, aliases: ...>]): <description>
- (none)            ← 空时
[空行]
Restricted agents (not executable in this session...):  ← capability ceiling 段, 有才出
- ...
[空行]
Chains:
- <name> (<source>): <description>
[proactive 建议段 / chain 诊断段, 有才出]
```
数据来源: `discoverAgentsAll(ctx.cwd)` (agents.ts:1783, 四源 user/project/builtin/package 经 mergeAgentsForScope 合并), 过滤 disabled (:761) + capability ceiling (:762-764), 按 name localeCompare 排序 (:758-760).

### 移植规格 (D009 最小 list)
- 输出只回名字+一句话描述: 每行 `- <name>: <description>`; 空则 `- (none)` (或 "none", 参考官方示例 formatAgentList agents.ts:111-117 的 `${name} (${source}): ${description}` 可含 source, D009 定死"只回名字+一句话描述" → 建议纯 name+description).
- 数据源: 内置 3 (explorer/worker/reviewer) + user `~/.pi/agent/agents` + project (cwd 向上最近 `.pi/agents`, 官方示例 findNearestProjectAgentsDir) 三源合并, 按 name 排序.
- 删: capability ceiling 过滤/Chains 段/Restricted 段/诊断/proactive 建议 (那些功能全删, D003/D007/D011).
- 规模 ~40 行 (D009 预算).
- 官方示例本身无 list action (F001); 此动作是 pi-subagents 功能裁剪移植, 格式以 handleList 为祖型.

---

## 考察点 5: 并发上限 4 / 最大 8

### 旧码位置
- 上限 4: src/shared/types.ts:1901 `MAX_CONCURRENCY = 4`; src/runs/shared/parallel-utils.ts:256 `MAX_PARALLEL_CONCURRENCY = 4`
- 调度: parallel-utils.ts mapConcurrent (:186-242, 保序 worker 池 + 可选全局 semaphore), Semaphore (:129-160, DEFAULT_GLOBAL_CONCURRENCY_LIMIT=20 :126); chain-execution.ts:282 `concurrency = step.concurrency ?? MAX_CONCURRENCY` → mapConcurrent (:305)
- **旧码无 8**: 并发上限 4 唯一, 无并行任务数上限 (D001 的 "最大 8" 来自官方示例)
- 官方示例: index.ts:33 `MAX_PARALLEL_TASKS = 8`, :34 `MAX_CONCURRENCY = 4`; tasks.length>8 报错 (:584-590) `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`; mapWithConcurrencyLimit (:221-240): `limit = Math.max(1, Math.min(concurrency, items.length))`

### 行为描述
旧 mapConcurrent: `safeLimit = max(1, floor(limit))`, 固定 worker 池取号, 结果保序 (results[i]), Promise.all 等全部 settle; globalSemaphore 跨 step 全局限流 (DEFAULT_GLOBAL_CONCURRENCY_LIMIT=20, 为编排链服务); 动态 fanout (dynamicParallelStep) 不在保留集. 官方示例 mapWithConcurrencyLimit 语义等价但无 semaphore/无 global cap.

### 移植规格
- 常量: `MAX_PARALLEL_TASKS = 8`, `MAX_CONCURRENCY = 4` (官方示例同款数值, D001 已定).
- parallel tasks.length > 8 → isError 结果, 文本照官方示例: `Too many parallel tasks (N). Max is 8.`.
- 调度器: 整搬官方示例 mapWithConcurrencyLimit (~20 行) 或旧 mapConcurrent 简化 (删 globalSemaphore/onSchedulingSettled 参数); 保序输出必须保留 (results 按 index).
- 同目录执行 (D001): 默认 ctx.cwd; 官方示例允许 per-task cwd 覆盖 (index.ts:335 `cwd: cwd ?? defaultCwd`), 旧码同 (execution.ts:466 `cwd: options.cwd ?? runtimeCwd`). 无 worktree.
- 删: Semaphore/DEFAULT_GLOBAL_CONCURRENCY_LIMIT/dynamic fanout/failFast (无编排, D002).

---

## 考察点 6: 模型选择 (--model 组装 / 配错报错 / thinking 后缀)

### 旧码位置
- --model 组装: pi-args.ts:530-533 (applyThinkingSuffix :186-200 + push --model)
- 上游解析: model-fallback.ts 全部 (336 行): resolveModelCandidate (:191-207, 精确+fuzzy 匹配注册表, 匹配不上**原样返回不报错**), fuzzyResolveModel (:123-157), splitThinkingSuffix (:17-22), buildModelCandidates (:262-283, primary+fallbacks 去重), isRetryableModelFailure (:224-231, 模式列表 :197-223), resolveSubagentModelOverride (:234-267, 仅 modelScope enforce 时 throw)
- 调用点: execution.ts:1453 (buildModelCandidates(modelOverride ?? agent.model, agent.fallbackModels, ...)), 重试循环 :1530-1643
- 官方示例: index.ts:295 `if (agent.model) args.push("--model", agent.model)` — 无解析直传

### 行为描述
- **组装**: 旧码 agent.model → buildModelCandidates (fuzzy 归一化) → 每个候选经 applyThinkingSuffix 拼 thinking 后缀 → `--model <值>`. 官方示例: agent.model 原样直传.
- **配错报错 (D007 参考, 实测 pi 0.82.1)**:
  - 旧扩展侧不预校验: fuzzy 匹配不上就原样传 (model-fallback.ts:191-207); 唯一 throw 路径是 modelScope enforce (model-scope.ts, 功能删).
  - 实际报错来自**子进程 pi**: `--model "totally-bogus-model-xyz"` → stderr `Error: Model "totally-bogus-model-xyz" not found. Use --list-models to see available models.`, exit code 1, stdout 无 JSONL 事件. 旧码 execution.ts:1099-1100 把 stderr tail 收进 result.error, exitCode 1 → isError 结果透传给父会话 (消息面另收 message_end.errorMessage, :944).
  - **坑**: 已知 provider + 未知 id (`openai/gpt-9999...`) → pi 不报错, Warning `Model "..." not found for provider "openai". Using custom model id.` 后继续 (custom model 机制). 即 "配错" 只有完全未知的模型串才显式报错.
  - fallback 重试 (旧 execution.ts:1530-1643): 失败且 isRetryableModelFailure 命中 (rate limit/auth/model not found 等模式) 且还有候选 → 换下一模型重跑; 否则带错误返回. **这就是 D007 要删的"悄悄降级"链**.
- **thinking 后缀与 --model 格式**: applyThinkingSuffix (:186-200): model 末段已是 THINKING_LEVELS (off/minimal/low/medium/high/xhigh/max, model-info.ts:1) 则不重复, 否则拼 `${model}:${thinking}`. **后缀是 --model 值的一部分, 不是独立 flag**: pi --help 确认 `--model <pattern>` "supports provider/id and optional :<thinking>"; 实测 `--model anthropic/claude-sonnet-4-5:high` 被接受到 API key 检查才失败.

### 移植规格 (D001.3 + D007)
- agent.model → `--model` 直传 (官方示例同款), 无 fuzzy 解析, 无候选链: 删 buildModelCandidates/resolveModelCandidate/fuzzyResolveModel/isRetryableModelFailure/formatModelAttemptNote/resolveSubagentModelOverride/buildModelCandidates 及 execution.ts 重试循环 (:1530-1643).
- 配错显式报错: 不扩展侧预校验, 子进程 pi stderr 错误原样透传为 isError 结果 (文本含 `Model "..." not found. Use --list-models to see available models.`); 单次尝试, 无重试.
- thinking: D001 保留集未列 → 删 applyThinkingSuffix 与 thinking 参数 (模型选择只含 agent.model). 若 M4 决定补 thinking, 直接拼进 --model 值即可 (pi 原生支持 `:level` 后缀, 无需改 flag 结构).

---

## 删除项确认 (本任务范围)

| 段 | 位置 | 处置 |
|---|---|---|
| PiSpawnDeps 注入面 (platform/自定义 fs) | pi-spawn.ts:58-75 | 裁 (留 execPath/argv1/env) |
| resolvePiLaunchToolPlan 全链 + 上游 | pi-args.ts:289-512 | 删 (capability-ceiling/MCP/structured-output/permission-system) |
| --no-extensions / --extension 段 | pi-args.ts:556-560 | 删 (或 M4 改为恒加 --no-extensions, 见考察点 2 待决策) |
| env 管线 | pi-args.ts:599-800 | 删 (SUBAGENT_* 全系/intercom/steer/permission/watchdog/tool-budget/structured-output/capability-ceiling/MCP/PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT) |
| applyThinkingSuffix | pi-args.ts:186-200 | 删 (thinking 不在保留集) |
| cleanupTempDir | pi-args.ts:791-798 | 保留 (tempDir 清理语义) |
| 旧 frontmatter.ts 手写解析 | src/agents/frontmatter.ts 全 149 行 | 不搬, 用 pi 包 parseFrontmatter (官方示例同款); 零依赖备选只搬 parseFrontmatter+parseFrontmatterList |
| 旧 agents 字段集 | agents.ts:1507-1560 | 只留 name/description/tools/model + body |
| handleList 富格式 | agent-management.ts:753-790 | 裁为 name+description 最小 list (D009) |
| 旧并发调度 | parallel-utils.ts Semaphore/mapConcurrent 全量 | 裁为官方示例 mapWithConcurrencyLimit (~20 行); MAX_CONCURRENCY=4/MAX_PARALLEL_TASKS=8 采用官方示例数值 |
| model-fallback.ts 全部 | src/runs/shared/model-fallback.ts 336 行 | 删 (含 fuzzy 解析与重试链); model-scope.ts 同步删 |
| execution.ts 模型重试循环 | :1453, :1530-1643 | 删, 单次尝试 |

保留段确认 (不可删): 4 级可执行寻址链, baseArgs(--mode json -p), session 三态, --model, --tools, --no-context-files, --no-skills, --append-system-prompt temp 文件, Task:/@file (8000 上限), TASK_ARG_LIMIT 常量, spawn 的 cwd/stdio/windowsHide.

## 备注
- 本文件考察行号以 pi-subagents-main 现状为准; 与任务描述行号 (:418-560/:516-524/:600-798) 偏差因文件含 import 段, 实际锚点: args 组装 :514-597, session 三态 :517-528, env 管线 :599-800.
- 实测记录: pi 0.82.1 非法模型报错文本 / @file 支持 / :thinking 后缀格式均已在本文件记录, 供 M4 e2e 断言复用.
