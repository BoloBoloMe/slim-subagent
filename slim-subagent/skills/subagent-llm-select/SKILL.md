---
name: subagent-llm-select
description: 委派 subagent 前按任务画像给可用模型排序选 model; 评分表缺失时先调研建立
---

# Subagent LLM 选型

委派 subagent 时 `model` 传参决定任务成败与成本, 凭印象选等于放弃这条杠杆. 流程: 判画像 → 跑算分器 → 抄结论委派, 不手算.
评分表是 per-device 数据文件 `~/.pi/agent/slim-subagent/llm-scores.yaml`. 算分规则与画像权重的唯一真相源是本目录的 `score.py`, 评分依据与维护规则见 [scores-template.yaml](scores-template.yaml). 评分不进包的原因: 分数评的是本机 scoped 列表里的模型, 各设备可用模型不同.

## 步骤

1. **判画像**. 按任务内容选其一: `coding` 修 bug/实现/改造, `research` 探查/归纳, `review` 审查/挑错, `vision` 含图像输入, `long-doc` 超长输入提取, `cheap-batch` 大批量低难度, `general` 兜底.
   完成标准: 能说出任务内容与画像的对应关系.
2. **跑算分器**: `uv run <本 skill 目录>/score.py <画像> [thinking偏好]`. 它完成全部计算: scoped 解析, 价格派生, N/A 重归一化与过滤, 加权排序, thinking 支持集校验. 报错"评分表不存在"时进入 [bootstrap](#bootstrap), 建成后重跑.
   完成标准: 拿到输出末尾的 `委派: model=... thinking=...` 行.
3. **委派并报告**. 把结论行抄进 `model`/`thinking` 传参. 报告含: 画像名, 前三名总分, `[未评分]` 标注. 总分接近时并列呈现并说明, 不假装有区分度.

## bootstrap

评分表不存在时建立它, 不跳过选型. 逐模型联网调研而不用印象分: 没有依据的分数后续无法校对, 改分无从谈起.
1. 调研对象 = scoped 列表 (`~/.pi/agent/settings.json` 的 `enabledModels` ∩ 有凭证 provider).
2. 每个模型派一个 explorer 子代理并行调研, 任务中要求调用 `access-web` skill, 官方来源 (厂商文档/定价页/模型卡) 优先于第三方测评. 返回六维分 (coding/knowledge/longctx/multimodal/stability/speed, 基准 `opencode-go/deepseek-v4-flash` = 1, 比率分允许 >1), 每分附一行依据. price 不调研 (派生). speed 缺权威数据源, 允许经验分但标注依据弱.
   此时评分表不存在, 派子代理用各 agent 的默认 model — 已定义行为, 不构成循环.
3. 照 [scores-template.yaml](scores-template.yaml) 汇总落盘到 `~/.pi/agent/slim-subagent/llm-scores.yaml`.
4. 提示我检查: 给出文件路径, 每模型分数摘要, 以及依据弱的条目.
   完成标准: 我已拿到可逐行审改的评分表草稿.
