# slim-pi-subagents M4 新扩展重写 Execution Spec

MILESTONE-04 (`../roadmap/MILESTONE-04.md`) 的执行规格. 以 pi 官方示例为骨架, 按 M2 暴露面 + M3 移植规格一次性重写最小核心.

## 权威输入

- Product Spec: 无独立文件; 产品意图 = [../milestone-01/DECISIONS.md](../milestone-01/DECISIONS.md) D001 (保留集总表)
- Technical Spec: [../milestone-03/PORTING-SPEC.md](../milestone-03/PORTING-SPEC.md) + 分片 `../milestone-03/01-process-lifecycle.md` ~ `05-context-window.md` (下文简称 M3-01~M3-05)
- Decisions: `../milestone-01/DECISIONS.md` (M1-Dxxx), `../milestone-02/DECISIONS.md` (M2-Dxxx)
- 参考实现 (全程只读):
  - 官方示例 `/var/home/bolo/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/` (index.ts 1015 行 + agents.ts + agents/*.md)
  - `pi-subagents-main/` (v0.44.0, 一行不动)

## 信源调和记录 (决策优先于 M3 规格; 施工前必读)

M3 分片部分规格写于 M2 定稿前或贴旧码, 以下调和已按决策/用户确认锁定, 执行者照此施工, 不再请示:

1. **session root 固定**: `~/.pi/agent/slim-subagent/sessions/<runId>/run-<idx>/session.jsonl` (M2-D005). 不采用 M3-03 考察点 2 的父会话派生规则与 mkdtemp 兜底.
2. **无成功即删**: 全部 run 保留, 统一按龄 7 天 GC, 挂在扩展 `session_start` 扫一次 (M2-D005; M1 原决已废除, M3-03 考察点 2 规格 4 的 "成功即删" 段作废).
3. **run-id 格式**: `run-<YYYYMMDD-HHMMSS>-<6位随机>` (M2-D005), 非 M3-03 的 8 位 hex.
4. **agents 发现两源**: 内置 (扩展目录 `agents/`) + user (`~/.pi/agent/agents/`), 无 project 源 (M2-D007; M3-04 考察点 4 三源段作废).
5. **usageBudget 语义 = B 运行中终止** (MILESTONE-04 认领会话用户确认, 关闭 M3 §四 #1): 纯 number 参数 (M2-D008), 口径 = 累计 `input+output+cacheWrite`, cacheRead 不计 (M2-D003); message_end 累加后比对, `used >= budget` 触顶, 复用 timeout 三阶段终止管线. M3-02 考察点 5 的 `{tokens:{soft,hard},costUsd}` 结构与调度门语义 (选项 A) 均不采用; costUsd 维度砍 (M2-D008 无此参数, 消解 M3 §四 #4).
6. **resume follow-up 复用 `task` 参数**: M2-D008 恰 9 参数无 message; M3-03 的 "message 必填" 调和为 `action:"resume"` 时 `id`+`task` 必填, `model` 同用报错 (M3-03 "拒绝 model 覆盖"), `agent` 忽略 (复用 run.json 原 agent). parallel 批次不支持 resume (M1-D004 v1 收敛), 命中 parallel run-id 报错.
7. **timeout 默认 15min** = 900000ms (M1-D005), 非旧码 30min.
8. **spawn flags 硬编码**: 恒加 `--no-skills` (M3-04 考察点 2 注, D010 防子进程误加载) 与 `--no-extensions` (M3 §四 #2 建议采纳, 防递归); 不加 `--no-context-files` (与官方示例一致, 继承项目上下文).
9. **防御项默认**: 16MB 单行上限 + failProtocol 保留 (M3 §四 #3); `tool_result_end` 2 行死分支防御保留不依赖 (M3 §三.4); resume 中断 turn 重复 user 提示接受重复 (M3 §四 #5, M5 对拍后再定).
10. **内置 agents 不带 model 字段**: 省略 --model, 继承 pi 默认模型 (可用模型环境见 M2-F003); tools/frontmatter 格式对齐官方示例 agents/*.md.
11. **stopReason 覆写优先级** (ISSUE-01 收口用户确认): 中止标记优先 — 仅未触 timeout/usageBudget 中止时, message_end 才写模型级 stopReason; M3-02 考察点 2 的"无条件覆写"段作废 (决策 M2-D002b 优先于 M3 规格).
12. **parallel run.json 布局** (同上确认): 批次根 `<runId>/run.json` 加 `"mode":"parallel"` + tasks 快照 (含各 child agent/model/tools), per-child 仅存 `run-<idx>/session.jsonl` 不写 run.json; resume 扫描命中 `mode:"parallel"` 报 "v1 仅支持 single resume" (M1-D004 收敛落地).
13. **resume 沿用原 runId** (同上确认): 决策 M2-D005 优先, M3-03 考察点 1 移植规格 4 "恢复 = 新 runId" 段作废; resume 不新建 run 目录, 不更新 startedAt, GC 龄仍按原 startedAt 起算 (7 天硬规则不动).
14. **resume --tools 重建** (同上确认): run.json 记录 tools 快照 (agent 定义解析后的工具面), resume spawn 按快照重建 `--tools`; agent 定义事后被删/改不影响恢复.
15. **锁目录名**: 取 `slim-subagent-leases` (ISSUE-06 文本), M3-03 考察点 3 的 `slim-pi-subagents-session-leases` 作废.
16. **同名 agent 冲突**: user 覆盖内置 (对齐官方示例 agentMap 去重语义); list 去重后只列一条.

## 全局允许范围

- 新建 `slim-subagent/` (仓库根): `index.ts` 入口, `agents/*.md` 内置 agents, 内部模块拆分自由 (模块设计属 M4 执行域, M2-D011), `test/*.test.ts` + `test/fixtures/` (fake pi 等).
- 仓库 `node_modules/` 下建 dev 软链: `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-tui` 指向本机 pi 安装内同名包 (测试解析用; 已验证 root exports 含 `parseFrontmatter`/`getAgentDir`/`CONFIG_DIR_NAME`).
- `typebox` 直接 import (仓库 node_modules 已有 1.1.38); pi-ai/pi-agent-core 的类型一律 `import type` (类型擦除, 不产生运行时解析).
- 测试运行期文件效果: 临时 HOME 隔离下的 `~/.pi/agent/slim-subagent/sessions/`; fake pi fixtures.
- 本产物目录 (`docs/changes/slim-pi-subagents/milestone-04/`) 文档.

## 全局禁止范围

- `pi-subagents-main/` 任何文件一行不动; 不改 pi 核心.
- 不动 `~/.pi/agent/settings.json` 与 `~/.pi/agent/extensions/` (新旧切换属 M6 之后, M2-D009 两阶段).
- M1 删除清单全部能力 (D002 编排 / D003 async / D007 acceptance+contact_supervisor+worktree+fallback / D011 批量清单); project agents 发现 (M2-D007); 附带 skills/prompts (M1-D010); npm 包/发布 (M2-D009, 范围外).
- 新增或改变任何决策内容 — 需要时停止, 回用户.

## 完成定义

- `node --test "slim-subagent/test/**/*.test.ts"` 全绿 (node:test + Node 24 原生类型擦除, 零新增依赖).
- `pi -e ./slim-subagent/index.ts` 装载成功, `action:"list"` 返回名册 (人工冒烟一次).
- single / parallel / resume 三种保留执行模式在 fake-pi 集成测试下各有绿测试.
- 新扩展代码 ~1300-1600 行 (不含 test/ 与 fixtures).

## 测试策略

框架与命令: node:test, `node --test "slim-subagent/test/**/*.test.ts"` (Node v24.16.0, 原生类型擦除; TS 只写可擦除类型, 不用 enum/namespace).

实测备忘 (ISSUE-01 收口): Node v24.16.0 test runner 不接受裸目录参数, 必须用 glob 形式 (上文命令已改); 测试期人工冒烟须 `pi -ne -e ./slim-subagent/index.ts` — 旧 pi-subagents 包仍在 settings packages, 同名 subagent 冲突会拒载, `-ne` 跳过自动装载后 `-e` 显式加载新扩展 (M2-D009 两阶段期形态). 冒烟已过一次: list 返回 `- (none)`.

已确认接缝 (M2/M3 钉死, 不再另行确认):

1. **工具 execute 接口**: fake ExtensionAPI 捕获 `registerTool` 注册, 直接调 `execute(params, fakeCtx)`; fakeCtx 提供 `cwd` / `getContextUsage()` / `model` stub. 断言 AgentToolResult 的 content/details/isError.
2. **pi CLI 边界 (子进程)**: `test/fixtures/fake-pi.mjs` — node 脚本, 按 argv/env 开关发出罐头 JSONL 事件流, 响应 SIGINT/SIGTERM/SIGKILL 并记录时序, 回显 argv, 按需创建 session 文件. 经 `PI_SUBAGENT_PI_BINARY` 环境变量注入 (M3-04 考察点 1 寻址链第 1 级, 其存在理由即测试).
3. **文件系统**: 临时 HOME 隔离, 断言 session 目录布局 / run.json / GC 结果.

真实模型 golden 对拍 = M5 范围 (M3 §五清单), 本 Spec 不做. 每个 issue 至少一个可执行 TDD 切片; ISSUE-07 渲染部分为人工验证特例.

## 任务图

- ISSUE-01: `issues/ISSUE-01-skeleton-discovery-list.md`; 覆盖: M1-D009, M1-D010, M2-D001, M2-D007, M2-D008, M2-D009, M2-D010; 依赖: 无.
- ISSUE-02: `issues/ISSUE-02-single-pipeline.md`; 覆盖: M1-D001, M2-D002(a), M2-D006, M3-01 (考察点 1/2/4/5/6), M3-02 (考察点 1/2/3/4/6), M3-04 (考察点 1/2/3), M3 §四 #2/#3; 依赖: ISSUE-01.
- ISSUE-03: `issues/ISSUE-03-timeout-diagnostics.md`; 覆盖: M1-D005, M1-D012(b), M2-D002(b), M3-01 考察点 3, M3-05; 依赖: ISSUE-02.
- ISSUE-04: `issues/ISSUE-04-usage-budget-midflight.md`; 覆盖: M1-D006, M2-D003, M3-02 考察点 5 (选项 B), M3 §四 #1; 依赖: ISSUE-03.
- ISSUE-05: `issues/ISSUE-05-parallel.md`; 覆盖: M1-D001(2), M2-D004, M2-D008 (parallel 覆盖语义), M3-04 考察点 5; 依赖: ISSUE-02, ISSUE-03, ISSUE-04.
- ISSUE-06: `issues/ISSUE-06-resume-session-lifecycle.md`; 覆盖: M1-D004, M1-D012(a), M2-D005, M2-D006, M3-03 全片, M3 §四 #5; 依赖: ISSUE-03, ISSUE-04.
- ISSUE-07: `issues/ISSUE-07-builtin-agents-rendering.md`; 覆盖: M1-D008, M1-D001(9); 依赖: ISSUE-01.

## 覆盖矩阵

- M1-D001 (保留集总表) -> ISSUE-01~07 分项落位; 第 9 项渲染 -> ISSUE-07 (人工验证); 第 10 项约束进描述 -> ISSUE-01 TC-schema.
- M1-D002/D003/D007/D011 (删除清单) -> 全局禁止范围, 无执行任务.
- M1-D004 (resume) -> ISSUE-06 -> TC-resume-* -> node --test.
- M1-D005 (timeout 15min+诊断载荷) -> ISSUE-03 -> TC-timeout-* -> node --test.
- M1-D006 (token 上限) -> ISSUE-04 -> TC-budget-* -> node --test.
- M1-D008 (内置 3 agents) -> ISSUE-07 -> TC-agents-* -> node --test + list.
- M1-D009 (最小 list) -> ISSUE-01 -> TC-list-* -> node --test.
- M1-D010 (约束进描述, 450 tok 硬顶) -> ISSUE-01 描述落盘; token 实测 = M5, M4 无任务.
- M1-D012(a) (恢复点语义) -> ISSUE-06; e2e 验证 = M5 对拍 (M3 §五.1).
- M1-D012(b) (上下文窗口保底) -> 已被 F006 消解 (M3-05: getContextUsage 官方 API) -> ISSUE-03 TC-diag-*.
- M2-D001 (同名+一次性切换) -> ISSUE-01 注册名 "subagent"; 切换动作 = M6 后, 无 M4 任务.
- M2-D002(a) 正常载荷 -> ISSUE-02 TC-normal-*; (b) 中止载荷 -> ISSUE-03 TC-timeout-*/ISSUE-04 TC-budget-*.
- M2-D003 (budget 口径) -> ISSUE-04 TC-budget-cacheread.
- M2-D004 (parallel 语义) -> ISSUE-05 TC-par-*.
- M2-D005 (resume 生命周期/GC/锁) -> ISSUE-06 TC-gc-*/TC-lock-*.
- M2-D006 (事后审查字段) -> ISSUE-02 TC-normal-details (runId+sessionDir).
- M2-D007 (砍 project agents) -> ISSUE-01 TC-list-sources.
- M2-D008 (schema 9 参数) -> ISSUE-01 TC-schema.
- M2-D009 (两阶段装载) -> ISSUE-01 人工冒烟 `pi -e`; 移入自动装载目录 = M6 后.
- M2-D010 (中文描述 v3) -> ISSUE-01 TC-schema-desc.
- M2-D011/D012 (范围切割/校验子代理模型) -> 本 Spec 元信息与全局风险, 无代码任务.
- M3 §四 #1 -> ISSUE-04 (B); #2/#3 -> ISSUE-02; #4 -> 消解 (M2-D008); #5 -> ISSUE-06 (接受重复).
- M3 §六 (结果对象字段终版) -> ISSUE-02/03 结果构造.

## 全局风险和停止条件

- 需要新增/改变 M1/M2 决策内容 -> 停止, 回用户.
- 需要扩大允许范围或触碰禁止范围 -> 停止.
- 测试环境模块解析失败 (jiti 与 node 解析差异, 软链不生效) -> 停止, 回报现场.
- fake pi 无法复现某行为 (如 agent_settled 真实时序) -> 记录降级为人工验证项, 不伪造绿测试.
- 行数预估超 1600 -> 停止, 回报裁剪选项.
- 派校验/审查子代理须显式 `model: deepseek/deepseek-v4-flash` (M2-F003/D012: 内置 reviewer 默认配置引用不存在的 ai-work-* provider).
