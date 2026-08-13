# M07 中止恢复协议: 载荷自描述 + 强制预算 + 终止交接 (背景/目的/方案)

- 日期: 2026-08-13
- 范围: slim-subagent (`slim-subagent/` 下 single.ts / index.ts / resume.ts / test/timeout.test.ts)
- 用途: 供新会话审阅本协议实现是否符合下列契约 (审核对照标准 = 本文"行为契约"节)

---

## 1. 背景 (为什么会有这次修改)

1. **零先验消费方问题**: 使用 subagent 工具的父会话 AI 无法先验地知道"子代理中止后可恢复"的决策过程. 原实现的线索只在一句 `hint: "建议 resume 恢复任务..."` (details 字段). 而 M5 实证 (e2e-new-summary.md 观察 #1): text 模式下 pi 只把 `content` 喂给模型, `details` 仅供 TUI — 恢复决策所需信号放在不可见通道, 协议本身藏在项目文档里, 消费方读不到.
2. **三卡点**: 拿到中止载荷的零先验 AI 不知道 (a) resume 是 subagent 的 action, (b) resume 还必填 task, (c) task 应重发原任务目标.
3. **恢复可行性缺口**: M5 观察 #3 — timeout 中止且 0 完成消息时 session.jsonl 未落盘, resume 会撞出 "session file does not exist"; 载荷无 session 落盘状态, 父会话只能试错.
4. **阈值偏差**: M1-D005 规定上下文占用进入 >30% "迟钝区" 建议新起子代理; 代码实现写死 `> 50` (single.ts), 全库无 30→50 演进记录, 属实现偏差.
5. **新协议诉求 (用户)**: 每次启动子代理强制 token 上限 = 子代理模型上下文窗口 × 70%; 判定"不再继续启用" → resume 收尾 (终止任务) + skill:handoff 交接 + 新子代理接手.

## 2. 目的

- 恢复决策所需全部信息在**载荷可见部分 (content) 内闭环**, 零先验 AI 读文本即可走完决策, 不依赖环境/文档先验.
- 强制预算成为工具内保证 (不依赖父会话自觉传参).
- 中止后的三条出路 (继续/终止交接/放弃) 写成显式三步协议, 收尾与交接流程自动化.

## 3. 方案与实现位置

### 3.1 载荷自描述 (content 长版指令 + details 结构化)

用户拍板: **description 不扩写**; 文案取**长版指令**.

- `single.ts` `buildRecoveryDirective()`: 中止载荷 content 尾部悬挂长版指令, 三分支:
  - `sessionSaved=false` → "未留下可恢复会话, 无法 resume, 直接以新子代理重发任务"
  - `sessionSaved=true` → 三步:
    - [1] 继续: `action="resume", id="<runId>", task="<重发原任务目标, 可补一句已达成部分>"`
    - [2] 终止交接: a) resume 收尾 `task="终止任务: 总结已完成与未完成, 清理临时状态, 输出交接要点"`; b) 用 skill:handoff 自动生成交接文档, 文件名 = `docs/handoff/YYYY-MM-DD-<agent>-<runId>.md` (agent+runId 防重名覆盖, 用户要求); c) 新起子代理接手, 指引其先读交接文档与必读推荐
    - [3] 放弃: 会话目录保留 7 天后自动清理 (GC 既有行为)
- `details` 新增: `sessionSaved` (仅中止结果产出; 探测 `fs.existsSync(sessionFile)`), `usageBudget`, `budgetAuto` (正常结果也带后两者, content 保持纯净不拼).
- 中止 content 信息块新增预算行: `预算: <N> tokens (自动 = 70% × 模型窗口 | 显式)`.

### 3.2 阈值修正 + 一处可配置

- 30/50 阈值: 修正为默认 **30** (对齐 M1-D005), env `PI_SUBAGENT_RESUME_HINT_PERCENT` 可覆盖 (1-100, 非法回退 30).
- 引用点: `single.ts` `resumeHintPercent()` — hint 分支与长版指令判断规则行同源, "改一处处处变".

### 3.3 强制预算 (工具内, 用户拍板: OK)

- 预算解析 (`single.ts` `resolveEffectiveUsageBudget`): 显式 `usageBudget` → 原样 (`auto=false`); 未传 → `round(window × ratio)` (`auto=true`). 调用处: index.ts single/parallel 每 child, resume.ts (收尾同强制, 用户拍板: 是).
- 窗口来源 (`single.ts` `resolveModelWindow`): `ctx.modelRegistry.find(provider, modelId)` → pi-ai Model `contextWindow` (与设置/modelOverrides 同源, 实测 deepseek-v4-flash 窗口 1M 命中); 兜底 `PI_SUBAGENT_DEFAULT_WINDOW` (缺省 128000). 模型寻址 `<provider>/<modelId>` 与 `--model` 同形.
- ratio: `PI_SUBAGENT_BUDGET_RATIO` 可覆盖, 缺省 0.7 (约束 0<r<1, 非法回退).

### 3.4 模型窗口 API 事实 (踩坑记录)

- `ctx.modelRegistry.getProvider(id)` 返回的 provider **不含 models 列表** (实测仅 id/name/baseUrl/auth) — 第一版失败点.
- 正确通道 = `ctx.modelRegistry.find(provider, modelId)` (ModelRegistry 接口见 pi dist/core/model-registry.d.ts, 暴露给扩展的兼容层含 getAll/getAvailable/find/getProvider 等).

## 4. 行为契约 (审核对照标准)

| 项 | 契约 |
|---|---|
| 自动预算值 | `round(modelContextWindow × 0.7)`, model 取 `<provider>/<model>`; 未传 usageBudget 时 |
| 显式预算 | 原样透传, `budgetAuto=false`; 0/负数/NaN/非 number 报 `usageBudget must be a positive number` |
| 窗口兜底 | 无 registry/查不到 → 128000 (env 可覆盖), 预算 = 89600 |
| 中止 content | 错误文本开头 (error + partial, M6 修复 1 保持) + `---` 信息块 (runId/sessionDir/usage/预算/上下文/hint) + 长版指令 (sessionSaved 分支) |
| sessionSaved | 探测 session.jsonl 存在性, 仅中止结果产出该字段 |
| 阈值默认 | 30; `percent > 阈值` → 建议新起 (hint + 判断规则行标注 `>30% 迟钝区`); `≤` → 建议恢复 |
| details 新字段 | `sessionSaved` / `usageBudget` / `budgetAuto`; 正常完成 content 纯净 (无信息块), details 带 usageBudget/budgetAuto |
| resume | 同强制预算 (未传按原 run 模型窗口); 不接受 model 覆盖 (既有); 结果 `resumed:true` 沿用原 runId/sessionDir |
| env 变量 | `PI_SUBAGENT_RESUME_HINT_PERCENT` / `PI_SUBAGENT_DEFAULT_WINDOW` / `PI_SUBAGENT_BUDGET_RATIO`; 非法值一律回退默认, 不炸进程 |

## 5. 验证证据 (真实 e2e, pi -ne -e ./slim-subagent/index.ts --no-session --mode json -p)

- 自动预算: 未传 usageBudget, model=deepseek/deepseek-v4-flash → `usageBudget:700000, budgetAuto:true` (窗口 1M × 0.7, find 命中).
- 中止载荷 (timeoutMs=5, 0 消息): content 含预算行 700000 自动 + "无法 resume, 直接以新子代理重发任务" (sessionSaved=false 分支).
- 中止载荷 (timeoutMs=8000, 慢任务, 有消息落盘): content 含 [1]/[2]/[3] 三步 + `docs/handoff/YYYY-MM-DD-explorer-run-<runId>.md` 文件名模板 (sessionSaved=true 分支).
- 函数级: explicit 尊重 / 无 registry 兜底 89600 / registry 262144 → 183501 (dbg 脚本).

## 6. 遗留 (审核时注意)

1. ~~单测 (node --test) 本机 Windows 全红~~ **已修 (2026-08-13 审核)**: (a) helpers.ts withHome 同时覆盖 %USERPROFILE% (Windows 上 os.homedir() 的实际读源); (b) getPiInvocation env 覆盖分支对 .mjs/.js/.cjs 用当前 node 执行 (Windows 无 shebang, spawn EFTYPE); (c) 依赖 POSIX 信号语义的 11 例 (drain TC-012~015 / single-line-limit TC-LIMIT-001/004/005 / timeout TC-002 / usage-budget TC-002/TC-006) Windows 跳过 (helpers.SKIP_POSIX_SIGNALS); (d) single-address TC-A1 Windows 跳过 (symlink EPERM); (e) single-spawn-args TC-004 的 0600 权限断言仅 POSIX. 全套件绿: 78 pass / 0 fail / 11 skip.
2. 子代理模型 `deepseek/deepseek-v4-flash` 的 DEEPSEEK_API_KEY 已失效 (401), 真实慢任务 e2e 用 `ai-work-qwen/qwen3.8-max` 完成; 复跑中止场景需换 key 有效模型.
3. ~~完整三步 e2e (中止 → resume 收尾 → handoff 落盘 → 新子代理接手) 未实跑~~ **已实跑 (2026-08-13, 见 M07-TEST-GUIDE.md §4.1 用例 F)**: 全链路走通, resume 收尾 resumed=true + 强制预算 700000/auto=true + 沿用原 runId/sessionDir, handoff 落盘, 新子代理读交接完成原任务.
4. `test/timeout.test.ts` 已改 (阈值用例 25/39/env50 + sessionSaved 断言), 本机全绿 (见 1).
5. 审核修补 (2026-08-13, 与契约无冲突): (a) 中止 content 预算行百分比改为从 `usageBudgetRatio()` 插值 (原硬编码 "70%", env 覆盖 ratio 时文案失步); (b) `resolveModelWindow` 上方注释从失败的 getProvider 路径更正为 find; (c) budgetAuto 未传时预算行不再误标 "(显式)"; (d) 新增 TC-004c (ratio env 覆盖 → 预算行数值与百分比同步), TC-005 更新为强制预算语义 (未传 → 自动 89600/budgetAuto=true).

## 7. 用户决策记录 (拍板项)

- description 不扩写; 文案长版指令.
- 阈值做成可配置 ("改一处处处变") → env 覆盖 + 集中读取.
- 工具内强制预算 (OK).
- handoff 自动执行, 文件名带子代理会话名 (agent+runId) 防重名覆盖.
- resume 收尾同强制预算.
- 修改了 `docs/` 目录外的项目文件: 仅 `slim-subagent/` 下 4 文件 (single.ts/index.ts/resume.ts/test/timeout.test.ts), git status 可核.