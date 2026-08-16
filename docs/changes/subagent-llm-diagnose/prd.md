# subagent LLM 自由诊断 产品规格 (草稿 v0.1)

- 状态: **草稿, 待定稿** (未决问题见 §10, 需用户盘问拍板)
- 日期: 2026-08-16
- 起源: subagent-panel 验收 (AC 11) 中用户提出 — 启发式 Diagnose 只认预设失败模式, 期望「诊断失败日志, 找出优化点」的开放式归因能力. 用户拍板: PRD 范围变更, 另立新产品.
- 前置产品: subagent 可观测性控制面 (已交付, PRD v2.0 `../subagent-panel/pi_agent_subagent_panel_prd.md`, 交付说明 `../subagent-panel/milestone-16/delivery.md`)

## 1. North Star 与范围

### 1.1 一句话

在既有启发式 Diagnose (规则表, 认已知模式) 之上, 提供 **LLM 自由诊断**: 把脱敏证据包交给 LLM 做开放式归因, 产出人类可读的失败解释 + 可执行优化建议, 不止于预设类别.

### 1.2 解决什么问题

启发式 Diagnose 的硬边界 (已交付产品的已知限制 #1):

- 只识别 PRD §7.2 清单内的失败模式; 清单外的失败 (如 prompt 设计缺陷导致的任务跑偏, 工具使用顺序低效, 模型输出质量差但无错误信号) 一律 `insufficient_evidence`.
- `recommendedFix` 是预写模板, 不针对现场.
- 完全无告警的「成功但差」run (跑完了, 结果没用) 无任何入口.

LLM 自由诊断补这三类: **未知模式失败归因**, **现场-specific 建议**, **成功 run 的质量/效率优化点**.

### 1.3 观测对象与数据源

与既有 Diagnose 同源 (只读):

- `~/.pi/subagent_log/` 结构化日志 (全级别, 不限 warn+)
- `~/.pi/agent/slim-subagent/sessions/` 的 run.json / session.jsonl (子代理会话正文)
- 既有启发式 findings (作为 LLM 的初筛输入, 不重复劳动)

差异: 启发式只读日志元数据; LLM 诊断需要读 **session 正文片段** (task/prompt/工具调用/输出), 这是隐私边界的主要变化点 (§6).

### 1.4 形态分级

- MUST: LLM 诊断核心管线 (证据包组装 → LLM 调用 → 结构化报告)
- SHOULD: 与启发式 Diagnose 的联动 (先启发式初筛, 再 LLM 深挖)
- COULD: 优化建议的回看闭环 (建议是否被采纳的标记)

## 2. 调用面 (草案)

复用既有入口, 加分析模式参数, 不新增平行命令:

- 工具: `subagent { action:"diagnose", ..., analysis?: "heuristic" | "llm" }` — 缺省 `heuristic` (保持现状, 零成本零延迟), `llm` 显式触发.
- 命令: `/agent-diagnose [target] [since] --llm`.
- Session Viewer `d` 键: 维持启发式; LLM 诊断是否进 Viewer 待定 (§10-Q4).

target/since/levelMin/limit/writeReport 语义不变.

## 3. 行为 (草案)

LLM 诊断仍为**只读分析器**: 不修改运行, 不重启子代理, 不自动修复, 不改代码. 流水线:

1. **证据包组装** (复用 diagnose.ts): target 解析 → 日志收集 → 聚类 → 启发式初筛. 产出脱敏证据包:
   - 结构化: 日志行 (全级别), run.json 摘要, 启发式 findings (若有)
   - 非结构化: session.jsonl 关键片段 (task/最后 N 条消息/失败点前后窗口), 经既有 redactSecret 脱敏
   - 证据包体积上限 (§7), 超限截断并标注
2. **LLM 调用**: 证据包 + 诊断 system prompt → LLM. 实现路径候选见 §9.
3. **输出**: 中文自由归因报告, 结构约束 (§4), 落盘可选 (writeReport 语义沿用).
4. **纪律沿用**: 证据不足时明说 evidence 缺口, 不编造问题; 结论必须引用证据 (eventId/路径/消息序号), 不允许无出处的断言.

## 4. 输出契约 (草案)

```ts
type LlmDiagnoseReport = {
  target: string;                  // 同既有 targetLabel
  summary: string;                 // 一段话结论
  rootCauses: Array<{              // 开放式归因 (不限既有 11 类)
    title: string;
    explanation: string;           // 自由文本, 必须引用证据
    evidenceRefs: string[];        // eventId / session 路径 / 消息序号
    confidence: "low"|"medium"|"high";
  }>;
  optimizations: Array<{           // 优化点 — 本产品的核心增量
    suggestion: string;            // 可执行: 改 prompt/拆任务/调参数/换模型/改代码
    appliesTo: "usage"|"config"|"prompt"|"code";
    expectedBenefit: string;
    evidenceRefs: string[];
  }>;
  heuristicFindingsEcho?: string;  // 启发式初筛结论的一句话复述 (避免用户读两份)
};
```

content 为中文渲染版; details 为结构化上式; writeReport 落 `~/.pi/subagent_log/diagnose/*-llm.md`, 同 7 日 GC.

## 5. 与启发式 Diagnose 的关系

- **互补不替代**: 启发式快/免费/确定性, 继续作缺省; LLM 慢/花钱/非确定, 显式触发.
- 启发式 findings 作为 LLM 输入之一 (初筛), LLM 可推翻启发式结论 (须给理由).
- 共用: target 解析, 日志收集, 脱敏, 报告落盘, GC. 新增仅「证据包→LLM→报告」段.

## 6. 隐私与安全 (MUST 级, 相比既有产品的主要变化)

- 既有纪律沿用: 报告不落完整 task/prompt/tool result/secret; redactSecret 全路过.
- **新增风险**: 证据包含 session 正文片段, 会**出域到模型提供商**. MUST:
  - 出域内容在调用前向用户可见 (证据包预览或摘要), 或至少有开关确认机制 (具体形态 §10-Q3).
  - secret 脱敏在出域前完成, 不接受模型侧自觉.
  - 证据包体积上限硬约束 (§7), 防止整会话倾泻.

## 7. 成本与性能 (草案)

- 证据包上限: 建议 ≤ 32k tokens (待实测校准), 超限按「失败点前后窗口 > 末尾消息 > 头部 task」优先级截断, 截断处标注.
- 单次调用预算: 沿用 subagent 工具的 usageBudget 机制 (显式 cap 上卡).
- 延迟预期: 秒级~十秒级, 调用期间 Run Card 正常显示 (若走 spawn 管线则天然获得).

## 8. 验收标准 (草案, 定稿时编号)

1. 显式 `analysis:"llm"` 触发, 缺省行为与既有启发式完全一致 (回归).
2. 对一个未知模式失败 run (启发式报 insufficient_evidence 的), LLM 诊断给出非空归因或明确指出证据缺口.
3. 输出每条 rootCause/optimization 均带 evidenceRefs; 抽查无无出处断言.
4. 出域内容脱敏抽查: 证据包无 secret 明文.
5. 证据包超限截断 + 标注可见.
6. writeReport 落盘, 文件名可区分启发式报告, 同 7 日 GC.
7. LLM 调用失败 (网络/预算/模型错误) 降级为中文错误说明, 不影响启发式结果可用性.

## 9. 实现路径候选 (倾向 A, 待探路验证)

- **A. 复用 slim-subagent spawn 管线**: 内置 `diagnoser` agent (system prompt = 诊断专家), 证据包作为 task 传入, 子代理产出结构化报告. 优点: 天然获得 Run Card/日志/预算/超时机制, 零新基础设施; 缺点: 证据包体积受 task 参数限制, 报告解析需约定输出格式.
- B. pi 扩展 API 直接调模型: 扩展面有 `modelRegistry`/`getModel()`, 但未见现成 complete helper, 需自接 provider 流式协议. 排除倾向: 重复造轮, 且脱离既有观测面.
- C. 主会话内联: 把证据包作为工具结果返回主会话模型分析. 优点: 零成本接入; 缺点: 污染主会话上下文, 与大证据包冲突. 可作降级路径.

## 10. 未决问题 (定稿前需用户拍板)

- Q1 入口形态: 同命令加参数 (本草案) vs 独立 `/agent-diagnose-llm`? 倾向同命令.
- Q2 模型选择: diagnoser 用哪个模型/thinking 深度? 是否允许调用侧覆盖? 倾向内置 frontmatter 默认 + 可覆盖 (同 worker/explorer/reviewer 机制).
- Q3 出域确认形态: 每次确认 / 首次确认后记住 / 仅 evidence 预览? 涉及 HITL 交互设计.
- Q4 Viewer `d` 键是否加 LLM 档位 (如 `D` 大写)?
- Q5 「成功 run 优化点」是否在首版范围? 它不需要失败信号, target 可任选 run, 但证据包组装逻辑不同 (无失败点窗口). 倾向首版只做失败/告警 run, 成功 run 优化列 COULD.
- Q6 建议采纳闭环 (COULD) 是否直接砍?

## 11. 明确不做

- 自动修复 / 自动重启 / 自动改代码 (沿用既有纪律)
- 日志做 metrics 后端 / 趋势统计
- 跨 run 批量优化报告 (首版单 target)
- 语义层质量评审的完整产品化 (本 PRD 只覆盖诊断场景, 通用 LLM 评审是另一个产品)
