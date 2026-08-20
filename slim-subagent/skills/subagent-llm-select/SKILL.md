---
name: subagent-llm-select
description: 委派 subagent 前使用, 选出最佳 llm.
---

# Subagent LLM 选型

委派 subagent 时 `model` 传参决定任务成败与成本, 凭印象选等于放弃这条杠杆, 不手算.

## 步骤

1. **判画像**. 按任务内容选其一: `coding` 修 bug/实现/改造, `research` 探查/归纳, `review` 审查/挑错, `vision` 含图像输入, `long-doc` 超长输入提取, `cheap-batch` 大批量低难度, `general` 兜底.
   完成标准: 能说出任务内容与画像的对应关系.
2. **跑算分器**: `uv run <本 skill 目录>/score.py <画像> [thinking偏好]`. 报错"评分表不存在"时照 [bootstrap.md](bootstrap.md) 建表, 建成后重跑.
   完成标准: 拿到输出末尾的 `委派: model=... thinking=...` 行.
3. **报告**: 报告画像名与前三名总分; 总分接近时并列呈现并说明, 不假装有区分度.

## 更新评分

照 [bootstrap.md](bootstrap.md) 重评.
