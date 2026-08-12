# M5 e2e 冒烟: 新扩展 (slim-subagent) 保留模式 — 真实 pi 子进程

- 日期/环境: 2026-08-12, pi 0.82.1, 父会话模型 = 环境默认 (kimi-coding/k3), 子进程任务显式 `model:"deepseek/deepseek-v4-flash"` (DEEPSEEK_API_KEY 在环境).
- 装载形态 (两阶段测试期): `pi -ne -e ./slim-subagent/index.ts --no-session --mode json -p '<提示词>'`; `-ne` 跳过 settings packages 旧 pi-subagents (同名 subagent 冲突拒载).
- 每项一次 headless 运行, `timeout 300` 兜底; 完整 stdout 存 `evidence/G<N>-new*.txt`.
- 真实 HOME 副作用保留: `~/.pi/agent/slim-subagent/sessions/` 下的 run 目录即证据 (任务预期).

## 证据捕获机制 (重要)

- text 模式下, 父模型上下文的工具结果**不含 details** (模型回显 content 正常, 声称"无 details 字段") — 这是 pi text 模式对模型消息的呈现行为, 非扩展缺陷.
- 因此父会话统一改用 `--mode json`: 事件流中 toolResult 的 `message_end` 事件携带 **content + details 权威全量** (usage 六字段/runId/sessionDir/stopReason/exitCode/hint/diagnostics). 本报告关键字段值全部取自该事件 (证据文件内可 grep `"role":"toolResult"`).
- 提示词仍要求模型回显 content/details (任务契约), 回显结果作为佐证, 权威值以事件流为准.

## 逐项结果

### G1 single 基线 — 通过

- 参数: `agent:"explorer"`, `model:"deepseek/deepseek-v4-flash"`, `task:"直接回复两个字: 正常. 不调用任何工具."`.
- content: `正常`.
- details: `usage {input:87, output:2, cacheRead:1792, cacheWrite:0, cost:1.77576e-05, turns:1}`, `runId: run-20260812-215634-b8542c`, `sessionDir: ~/.pi/agent/slim-subagent/sessions/run-20260812-215634-b8542c`, `exitCode:0`, `contextTokens:2826`, `model:"deepseek-v4-flash"`, `stopReason:"stop"`, `contextPercent:0.2695`, `contextWindow:1048576`, `partialOutput:"正常"`.
- 磁盘: run.json 含 agent/model/cwd/startedAt/tools 快照/sessionFile.
- 证据: `evidence/G1-new.txt`.

### G2 parallel — 通过

- 参数: `tasks:[{agent:"explorer",task:"直接回复一个词: 苹果."},{agent:"explorer",task:"直接回复一个词: 香蕉."}]`, 顶层 `model:"deepseek/deepseek-v4-flash"`.
- content: `Parallel: 2/2 succeeded` + 逐任务块 (保序: index 0 苹果, index 1 香蕉).
- details: `mode:"parallel"`, `runId: run-20260812-215709-226f6f`, `results[]` 每 child 独立 `isError:false`、`sessionDir` 分别为 `.../run-0` 与 `.../run-1`、child `model:"deepseek-v4-flash"` (顶层 model 生效).
- 磁盘: 批次 `run.json` 含 `mode:"parallel"` + `tasks` 快照 (各 child agent/task/model/tools); per-child 仅 `run-<idx>/session.jsonl`, 无 per-child run.json (调和 12).
- 备注: 父模型先自发调了一次 `action:"list"` (名册同 G7) 再执行并行, 无副作用.
- 证据: `evidence/G2-new.txt`.

### G3 timeout — 通过 (载荷字段全集捕获)

- 主运行参数: `timeoutMs:6000`, task "先逐字拼出 1 到 50 的数字再回复" — **6s 内完成**, 未触发超时 (正常 stop 载荷, `evidence/G3-new.txt`, 记录 fast-model 行为).
- 触顶运行 (`evidence/G3-new-timeout.txt`, timeoutMs 6000, task 拼 1..2000): 载荷字段全集:
  - content: `Subagent timed out after 6000ms.`
  - `stopReason:"timeout"`, `exitCode:1`, `processSignal:"SIGINT"`, `error:"Subagent timed out after 6000ms."`, `hint:"建议 resume 恢复任务, 复用已产生的部分输出."`, `contextTokens:2827`, `contextPercent:0.2696`, `contextWindow:1048576`, usage 全零 (无完成消息), `partialOutput:""`.
- 补充运行 (`evidence/G3-new-partial.txt`, timeoutMs 20000, task read+逐字回显 `single.ts` 全文): 首条消息完成后长流中途触发 timeout — `usage {input:14633, output:176, turns:2}`, `processSignal:"SIGINT"`, session.jsonl **已落盘** (112KB, 供 G4 resume), `partialOutput:""` (第二条消息未完成).
- 判定: 通过. 差异观察见文末 #3.

### G4 resume — 通过

- 目标: G3-partial 的 run `run-20260812-220039-84e004` (timeout 中止且 session 落盘).
- 参数: `action:"resume"`, `id`, `task:"直接回复: 已恢复."` (无 model).
- 载荷: `resumed:true`, `runId` 沿用 `run-20260812-220039-84e004`, `sessionDir` 沿用, content `已恢复.`, `stopReason:"stop"`, `exitCode:0`, `model:"deepseek-v4-flash"` (run.json 快照复用, 非调用方传), `cacheRead:17408` (恢复携带原 112KB 上下文).
- argv 验证 (--session 原路径): 同一 `run-0/session.jsonl` 由 112297B → 113359B (follow-up 追加进原文件), 非新建.
- model 覆盖报错 (`evidence/G4-new-model-error.txt`): `action:"resume" 不接受 model 覆盖 (复用原 run 的 model)` — 与 resume.ts 文案逐字一致, details 空 usage/runId/sessionDir; 同一运行内模型随后无 model 重试成功 (两条 toolResult 都在证据内).
- 边界 (`evidence/G4-new-resume-no-session.txt`): resume 无 session 文件的 timeout run → `Foreground run 'run-20260812-215815-557a92' session file does not exist: .../run-0/session.jsonl` (明确报错).
- 判定: 通过.

### G5 配错模型 — 通过

- 参数: `agent:"explorer"`, `model:"totally-bogus"`, 简单 task.
- content: `Error: Model "totally-bogus" not found. Use --list-models to see available models.` (子进程 stderr 回传).
- details: `exitCode:1`, `stopReason:null`, usage 全零, `model:null`, runId/sessionDir 正常; run.json 快照 `model:"totally-bogus"` (记录生效值).
- 判定: 通过 (isError 谓词 exitCode≠0 → true, 经 details/exitCode 传达; 事件级 isError 见观察 #2).

### G6 usageBudget — 通过

- 参数: `usageBudget:50` (极小必触顶), task read+回显大文件.
- 触顶时机: 首条 assistant 消息 usage 累加后 used = input 109 + output 70 + cacheWrite 0 = **179 ≥ 50** → 立即中止 (M2-D003 口径: input+output+cacheWrite, cacheRead 不计).
- content: `Usage budget exhausted: reported tokens 179 reached limit 50.` (used/limit 数值含在文案).
- details: `stopReason:"usage_budget"`, `exitCode:1`, `processSignal:"SIGINT"`, `hint:"建议 resume 恢复任务, 复用已产生的部分输出."`, usage `{input:109, output:70, cacheRead:1792, cacheWrite:0, turns:1}`.
- 磁盘: session.jsonl 1583B **已落盘** (首条消息完成, resume-able).
- 判定: 通过.

### G7 list — 通过

- 参数: `action:"list"`.
- content (3 内置 agents 名册, 与 `agents/*.md` 一致):
  ```
  - explorer: 代码库探查与只读研究, 返回结构化发现
  - reviewer: 代码审查与质量/安全检查 (只读)
  - worker: 通用执行 agent, 全工具, 处理写/执行任务
  ```
- details: `{}`.
- 判定: 通过.

## 关键差异 / 观察 (不修代码, 如实记录)

1. **text 模式父模型上下文无工具 details**: 模型无法回显 details (G1/G2 模型均称"无 details 字段"). 证据捕获改由父会话 `--mode json` 事件流 toolResult message_end 承担 (权威全量). 扩展行为本身无异常.
2. **事件级 isError 恒 false**: pi core 的 toolResult 事件 isError 仅按 execute 抛异常判定 (agent-loop.js `executePreparedToolCall` 固定返回 `isError:false`), 扩展返回的 isError 不体现于事件级; 中止/错误结果的扩展语义经 details (`exitCode`/`stopReason`) 与 content 完整传达 (谓词含 exitCode≠0/timeout/usage_budget → 扩展侧 isError=true). 呈现差异属 pi core, 不影响扩展载荷.
3. **timeout 中止且 0 完成消息 → session.jsonl 未落盘** (run-0/ 空, 子进程 pi 被 SIGINT 中断未刷盘), 该 run 不可 resume (报 session 文件不存在); 有 ≥1 完成消息时 (G3-partial/G6) session 正常落盘且 resume 可用. 属子进程侧观察, 非扩展抛错.
4. **explorer agent 拒绝"拼数字"类无意义任务** (只读研究 prompt 下的模型行为, G3 首次变体), 换真实探查任务 (read+回显) 后正常执行 — 属模型/agent 定义行为, 非扩展问题.

## 结论

- 7/7 保留模式全部跑通 (single/parallel/timeout/resume/model-错误/usageBudget/list), 无一项需要人工验证待办.
- 证据: `evidence/G1-new.txt`, `G2-new.txt`, `G3-new.txt`, `G3-new-timeout.txt`, `G3-new-partial.txt`, `G4-new.txt`, `G4-new-model-error.txt`, `G4-new-resume-no-session.txt`, `G5-new.txt`, `G6-new.txt`, `G7-new.txt` (+ 辅助脚本 `run-headless.sh`).
- 真实 run 目录留存: `~/.pi/agent/slim-subagent/sessions/run-20260812-{215634-b8542c,215709-226f6f,215738-a729b7,215815-557a92,220039-84e004,220230-3019a3,220255-2b2932,220000-b10ba1}`.

## 缺口 / 风险

- 父会话模型 (k3) 的 tool 调用参数形变风险已通过精确提示词规避; 每次运行均核实 toolResult 载荷.
- 未做 golden 对拍 (旧扩展同任务对比) — 属 M5 另一子任务 (新扩展侧本文档覆盖).
- timeout 默认值 (15min) 与 SIGTERM/SIGKILL 升级时序未在真实长跑中验证 (受成本约束, 只验证了 6s/20s 中止路径).
