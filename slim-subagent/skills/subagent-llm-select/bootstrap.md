# 评分表 bootstrap

逐模型联网调研而不用印象分: 没有依据的分数后续无法校对, 改分无从谈起.
1. **定基准**: 调研对象 = scoped 列表 (`~/.pi/agent/settings.json` 的 `enabledModels` ∩ 有凭证 provider). 从中推荐基线模型 (稳定主流中档, 使强模型 >1 弱模型 <1 有区分度), 问我确认. 基线各维 = 1, 其余模型分是相对它的比率.
   完成标准: 我已确认基线模型.
2. 其余模型派 explorer 子代理并行调研 (相对基线), 任务中要求调用 `access-web` skill, 审方来源 (厂商文档/定价页/模型卡) 优先于第三方测评. 返回六维分 (coding/knowledge/longctx/multimodal/stability/speed), 每分附一行依据; price 不调研 (派生). speed 缺权威数据源, 允许经验分但标注依据弱.
3. 照 [scores-template.yaml](scores-template.yaml) 汇总落盘到 `~/.pi/agent/slim-subagent/llm-scores.yaml` (基线条目各维 = 1).
4. 提示我检查: 给出文件路径, 每模型分数摘要, 以及依据弱的条目.
   完成标准: 我已拿到可逐行审改的评分表草稿.
