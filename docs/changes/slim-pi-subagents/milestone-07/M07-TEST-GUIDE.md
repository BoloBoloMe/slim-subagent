# M07 测试指南 (供新会话执行)

- 日期: 2026-08-13
- 被测版本: 提交 `7519096` (slim-subagent/ + docs)
- 被测内容: M07 中止恢复协议 (载荷自描述长版指令 + 强制预算 + 三步终止交接) + 审核修补 (预算行 ratio 文案同源 / 注释更正 / budgetAuto 缺省分支) + Windows 单测基建修复
- 对照标准: 同目录 `M07-RECOVERY-PROTOCOL.md` §4 行为契约表 (审核基准, 先读)
- 工作目录: `D:/Workspace/slim-subagent`

---

## 0. 前置条件

1. Node ≥ 24 (`node -v` 确认; 扩展 TS 原样装载).
2. 一个 API key 有效的子代理模型. **勿用 `deepseek/deepseek-v4-flash`** (key 已失效 401). 已验证可用: `ai-work-qwen/qwen3.8-max`.
3. 本仓库已 `pi install` (settings.json extensions 含 `D:\Workspace\slim-subagent\slim-subagent`). 重装: `pi install ./slim-subagent`.
4. 安全约束: 任何输出/日志中的凭据错误属环境状态, 不回写 key/token 到任何文件.

---

## 1. 单测层 (秒级, 先跑)

```bash
cd D:/Workspace/slim-subagent/slim-subagent
node --test --experimental-strip-types test/*.test.ts
```

**通过标准**: `pass 78, fail 0, skipped 11`.

11 个 skip 全部是平台性跳过 (Windows), 非缺陷:

- 9 个 `SKIP_POSIX_SIGNALS` (drain TC-012~015, single-line-limit TC-LIMIT-001/004/005, timeout TC-002, usage-budget TC-002/006): Windows 无 POSIX 信号语义, 子进程收不到 SIGINT/SIGTERM, 信号时序用例原理不可测.
- single-address TC-A1: Windows 建 symlink 需管理员/开发者模式.
- (single-spawn-args TC-004 的 0600 权限断言在 Windows 自动降级为只断言内容, 不算 skip.)

若在 POSIX 机器跑, 预期 `pass 89, fail 0, skipped 0` (信号用例应真实跑通 — 该环境顺带补验 Windows 跳过的信号时序).

M07 直接相关用例 (应全绿):

| 用例 | 验证点 |
|---|---|
| timeout TC-001 | sessionSaved 与磁盘实况等价, content 文案分支跟随 |
| timeout TC-004/004a/004b | 阈值默认 30 (25%→resume, 39%→新起) + env `PI_SUBAGENT_RESUME_HINT_PERCENT` 覆盖 |
| timeout TC-004c | 预算行数值与百分比随 `PI_SUBAGENT_BUDGET_RATIO` 同源同步 |
| usage-budget TC-005 | 未传 usageBudget → 自动预算 89600 (0.7×兜底窗口 128000), budgetAuto=true, content 纯净 |
| usage-budget TC-007 | 非法显式值报 "usageBudget must be a positive number" |

**已知 flake**: parallel TC-005 (timeoutMs 时序) 在全量并发跑时偶现调度抖动失败; 单跑 `node --test --experimental-strip-types test/parallel.test.ts` 稳定绿. 遇此单跑复验即可.

---

## 2. 函数层 (秒级, 可选)

无需真实模型, 验证预算解析三分支与 env 回退. 临时脚本放 `slim-subagent/` 内 (import `./single.ts` 相对解析), 跑完删除:

```js
import assert from "node:assert";
import { resolveEffectiveUsageBudget, resolveModelWindow } from "./single.ts";
assert.deepEqual(resolveEffectiveUsageBudget(12345, "p/m", undefined), { budget: 12345, auto: false });
assert.deepEqual(resolveEffectiveUsageBudget(undefined, "p/m", undefined), { budget: 89600, auto: true });
const ctx = { modelRegistry: { find: (p, m) => ({ contextWindow: 262144 }) } };
assert.deepEqual(resolveEffectiveUsageBudget(undefined, "prov/mod", ctx), { budget: 183501, auto: true });
process.env.PI_SUBAGENT_BUDGET_RATIO = "0.5";
assert.deepEqual(resolveEffectiveUsageBudget(undefined, "prov/mod", ctx), { budget: 131072, auto: true });
delete process.env.PI_SUBAGENT_BUDGET_RATIO;
console.log("OK");
```

跑法: `node dbg.tmp.mjs` (node 24 原生剥离 TS 类型).

---

## 3. 真实 e2e 层 (2-4 分钟/次, 核心验证)

命令模板 (每次把 `<提示词>` 换成各用例的):

```bash
cd D:/Workspace/slim-subagent
pi -ne -e ./slim-subagent/index.ts --no-session --mode json -p "<提示词>" > out.json
```

结果提取: `out.json` 事件流里找 `agent_end` → `messages` 中 `role:"toolResult"` 的项, 看其 `content` (模型可见文本) 与 `details` (结构字段). Windows 可 `node -e` 读文件过滤, 或直接文本搜索关键词.

### 用例 A: 自动预算 (registry 命中)

提示词: `调用 subagent 工具: agent=explorer, model=ai-work-qwen/qwen3.8-max, task="回复一个字: 好", 不要传 usageBudget`

通过标准:

- details.usageBudget = round(0.7 × qwen3.8-max 窗口), budgetAuto=true (窗口值可从本次 details 或 models.json 核; 窗口查不到时应为 89600)
- 正常完成: content 纯净 (无 `---` 信息块), details 带 usageBudget/budgetAuto, 无 sessionSaved 字段

### 用例 B: 显式预算尊重

提示词: 同 A, 追加 `, usageBudget=5000`.

通过标准: details.usageBudget=5000, budgetAuto=false.

### 用例 C: 中止载荷 — 未落盘分支 (sessionSaved=false)

提示词: `调用 subagent 工具: agent=explorer, model=ai-work-qwen/qwen3.8-max, task="先思考 10 秒再回复", timeoutMs=5`

通过标准 (content 内全部可见):

- 错误文本开头 + `---` 信息块: runId / sessionDir / usage / `预算: <N> tokens (自动 = 70% × 模型窗口)` / 上下文 / hint
- 长版指令含 "未留下可恢复会话…无法 resume — 直接以新子代理重发任务"
- details.sessionSaved === false

### 用例 D: 中止载荷 — 已落盘分支 (sessionSaved=true, 三步协议)

提示词: `调用 subagent 工具: agent=explorer, model=ai-work-qwen/qwen3.8-max, task="逐个列出当前目录文件并各写一句说明", timeoutMs=8000`

(目标: 让子代理超时前产出过消息使 session.jsonl 落盘; timeoutMs 按模型响应速度调, 落盘失败就加大.)

通过标准:

- details.sessionSaved === true
- content 含 `[1] 继续` (resume 调用模板, id=本 runId) / `[2] 终止交接` (a resume 收尾任务文案 + b `docs/handoff/YYYY-MM-DD-explorer-run-<runId>.md` 文件名模板 + c 新子代理接手) / `[3] 放弃` (7 天 GC)
- 判断规则行阈值数字与默认 30 一致 (`≤30%` 或 `>30%`)

### 用例 E (可选): 阈值 env 覆盖贯穿文案

在用例 D 基础上, 启动前 `set PI_SUBAGENT_RESUME_HINT_PERCENT=10` (或 shell export), 预期判断规则行变 `>10%/≤10%` — 验证 "改一处处处变" (hint 分支与指令文案同源).

### 用例 F (可选, 成本高): 完整三步链路

中止 → 按载荷 [2] resume 收尾 (`action="resume", id=<runId>, task="终止任务: …"`) → 确认 handoff 文档按其指引落盘 `docs/handoff/` → 新起子代理读交接接手. 此为 M07 遗留 3 (未实跑项), 走通则协议闭环实证完整. 注意: resume 收尾同样强制预算 (载荷 details 应带 usageBudget/budgetAuto, resumed=true).

---

## 4. 结果记录

### 4.1 验证结论 (2026-08-13 本会话实跑)

全过. 逐项:

1. 单测层: 全量跑出 77 pass / 1 fail / 11 skip, 唯一失败 = 已知 flake parallel TC-005; 单跑 `test/parallel.test.ts` 12 pass / 0 fail / 0 skip, 复验通过. 等价于指南基准 78/0/11.
2. 函数层: dbg 脚本 `OK` (三分支 + ratio env 全覆盖), 跑后已删.
3. e2e 层:
   - 用例 A ✅ `usageBudget:700000, budgetAuto:true` (窗口 1M × 0.7), content 纯净.
   - 用例 B ✅ `usageBudget:5000, budgetAuto:false`. 注: 首次按原提示词跑出 700000/auto=true — 是父模型漏传参数 (提示词措辞问题, 非缺陷); 改明确措辞 "usageBudget 参数必须传数值 5000" 后通过.
   - 用例 C ✅ sessionSaved=false 分支: 错误开头 + 信息块 (runId/sessionDir/usage/预算行 "700000 tokens (自动 = 70% × 模型窗口)"/上下文/hint) + "未留下可恢复会话…无法 resume — 直接以新子代理重发任务".
   - 用例 D ✅ sessionSaved=true 分支: [1]/[2]/[3] 三步齐备, handoff 文件名模板 `docs/handoff/YYYY-MM-DD-explorer-run-<runId>.md`, 判断规则行 `≤30% / >30%`.
   - 用例 E ✅ `PI_SUBAGENT_RESUME_HINT_PERCENT=10` → 判断规则行变 `≤10% / >10%`, 同源贯穿.
   - 用例 F ✅ 完整三步链路走通 (中止 run-20260813-173645-681cce → resume 收尾 `resumed:true` + 强制预算 700000/auto=true + 沿用原 runId/sessionDir → handoff 落盘 `docs/handoff/2026-08-13-explorer-run-20260813-173645-681cce.md` → 新子代理读交接完成原任务). 协议闭环实证.
4. 产物清理: out*.json 已删; handoff 文档为协议产物保留 (untracked, 未入库).

遗留 3 (完整三步未实跑) 由此勾销.

### 4.2 模板

- 全过: 在 `M07-RECOVERY-PROTOCOL.md` §6 勾销对应遗留项 (尤其遗留 3 若跑了用例 F).
- 有失败: 记录命令/载荷原文/期望差异, 对照 §4 契约表定位; 中止类用例优先核对 content 拼装 (single.ts `assembleSingleResult`) 与 `buildRecoveryDirective`.
- 测试产出 (out.json / dbg 脚本) 不入库, 验证后删除.
