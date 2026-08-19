---
name: subagent-llm-select
description: 委派 subagent 前按任务画像给可用模型排序选 model; 评分表缺失时先调研建立
---

# Subagent LLM 选型

委派 subagent 时 `model` 传参决定任务成败与成本, 凭印象选等于放弃这条杠杆. 本 skill 把选择变成可复算的流程: 候选集 × 评分表 × 任务画像 → 排序, 同样的任务永远选出同样的模型.
评分表是 per-device 数据文件 `~/.pi/agent/slim-subagent/llm-scores.md`, 表结构, 字段规则与维护规则见 [scores-template.md](scores-template.md). 评分不进包的原因: 分数评的是本机 scoped 列表里的模型, 各设备可用模型不同.

## 步骤

1. **定候选集**. scoped 模型 = (`~/.pi/agent/settings.json` 的 `enabledModels` ∪ `--models` CLI flag, 均支持 glob) 匹配 `~/.pi/agent/models-store.json` 目录, 且 provider 有可用凭证 (本机凭证在 `~/.pi/agent/auth.json`).
   完成标准: 候选列表每条目为 `provider/model` 全限定名 — 同名模型可存在于多个 provider (如 deepseek-v4-flash), 不带前缀的引用是歧义.
2. **读评分表**. 文件缺失时进入 [bootstrap](#bootstrap), 建成后回到步骤 3.
3. **选画像**. 按任务内容匹配下表唯一画像; 都不匹配时用 `general`. 权重 0 表示该维度不参与此画像.

   | 画像 | coding | knowledge | longctx | multimodal | stability | price | speed |
   |---|---|---|---|---|---|---|---|
   | coding 修 bug/实现/改造 | .40 | .10 | .20 | 0 | .10 | .10 | .10 |
   | research 探查/归纳 | .05 | .35 | .25 | 0 | .10 | .10 | .15 |
   | review 审查/挑错 | .30 | .20 | .20 | 0 | .10 | .05 | .15 |
   | vision 含图像输入 | .10 | .15 | .10 | .40 | .10 | .05 | .10 |
   | long-doc 超长输入提取 | .10 | .15 | .45 | 0 | .10 | .10 | .10 |
   | cheap-batch 大批量低难度 | .10 | .05 | .05 | 0 | .10 | .35 | .35 |
   | general 兜底 | 等权 | | | | | | |

   完成标准: 选定一个画像并能说出任务内容与它的对应关系.
4. **算分排序**. 总分 = Σ 权重 × 分数. 规则:
   - price 不读表, 按模板中的公式从 `models-store.json` 的 `cost` 字段现算 — 厂商调价后存数值会过期
   - 分数 `null` = 该维度 N/A: 权重归零, 剩余权重重归一化; 任务必需维度 N/A 的模型直接过滤 (如 vision 画像过滤 multimodal 为 null 者)
   - 表中未收录的候选模型全维按 1 (与基准持平) 处理, 标注 `[未评分]` — 不禁止选用, 否则新模型永远没机会积累评分
   完成标准: 每个候选模型有一个可手工复算的总分.
5. **委派并报告**. 总分第一者作 `model` 传参. 报告含: 画像名, 每模型总分, `[未评分]` 标注. 总分接近时并列呈现并说明, 不假装有区分度.
   thinking 定值: 调用方显式要求 > agent 默认 > high. 最终值必须在模型支持集内 — pi 对不支持的级别静默 clamp (先向上再向下取最近), 不校验会让意图漂移 (如 k3 连 off 都不支持, 会被 clamp 成 low). 支持集从 `models-store.json` 现查: `reasoning=false` 只有 off; `thinkingLevelMap` 中值为 null 的级别不支持, xhigh/max 须显式映射, 无 map 则 off~high.

## bootstrap

评分表不存在时建立它, 不跳过选型. 逐模型联网调研而不用印象分: 没有依据的分数后续无法校对, 改分无从谈起.
1. 调研对象 = 步骤 1 的候选集.
2. 每个模型派一个 explorer 子代理并行调研, 任务中要求调用 `access-web` skill, 官方来源 (厂商文档/定价页/模型卡) 优先于第三方测评. 返回六维分 (coding/knowledge/longctx/multimodal/stability/speed, 基准 `opencode-go/deepseek-v4-flash` = 1, 比率分允许 >1), 每分附一行依据. price 不调研 (派生). speed 缺权威数据源, 允许经验分但标注依据弱.
   此时评分表不存在, 派子代理用各 agent 的默认 model — 已定义行为, 不构成循环.
3. 照 [scores-template.md](scores-template.md) 汇总落盘到 `~/.pi/agent/slim-subagent/llm-scores.md`.
4. 提示我检查: 给出文件路径, 每模型分数摘要, 以及依据弱的条目.
   完成标准: 我已拿到可逐行审改的评分表草稿.
