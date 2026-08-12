你是执行者. 单一目标: M6 现场验证暴露的两处修复, TDD 先红后绿. cwd = /var/mnt/DATA/Workspace/subagent (非 git 仓库, 禁止任何 git 操作). 全套件当前 84/84 绿; 测试命令 `node --test "slim-subagent/test/**/*.test.ts"`; Node v24.16.0, 禁 enum/namespace.

## 修复 1: 中止结果把 details 关键字段拼进 content (用户裁决)
背景: pi 只把工具结果的 content 喂给模型, details 仅供 TUI. 实测超时后模型只收到一行 "Subagent timed out after 8000ms.", 拿不到 runId/diagnostics/hint (M1-D005 诊断载荷目的落空).
范围: slim-subagent/single.ts 的 timeout 与 usage_budget 中止结果构造处. 仅中止路径, 正常结果的 content 保持纯净 (纯 finalOutput).
要求: 中止 content = 现有文本 (error 行 + partial output 段) 末尾追加一个信息块, 含: runId (并注明 "恢复: action:\"resume\", id 用此值"), sessionDir, usage 摘要 (input/output/cacheWrite 数值, 注明 cacheRead 不计), diagnostics 摘要 (contextTokens/contextPercent/model, 缺省值按现有语义), hint 全文. 格式自拟但须紧凑纯文本 (几行, 不用 markdown 表格).
测试 (先红): 改造 timeout.test.ts 与 usage-budget.test.ts 的中止用例, 断言 content 文本含 runId 值/sessionDir/hint 关键词/usage 数字; 正常完成用例断言 content 不含 "runId:" (防过度拼接).

## 修复 2: resume 的 id 匹配放宽 (用户裁决 = b)
背景: runId 形如 run-20260813-004857-4b0db6, 当前 findRunForResume 只支持从头前缀匹配, 报中段/尾段 (如 "004857") 会 Run not found.
范围: slim-subagent/resume.ts 的 run 查找逻辑.
要求: id 命中规则改为 — 完整 runId 前缀匹配, 或 runId 最后一个 `-` 后的随机段的前缀匹配; 两种规则合并去重后: 唯一命中 → 恢复; 多命中 → 歧义报错 (沿用现有文案形态); 零命中 → "Run not found".
测试 (先红): resume.test.ts 新增 — 随机尾段前缀命中恢复成功; 歧义 (两个 run 随机段同前缀) 报错; 原 TC-002 前缀用例保持绿.

## 范围外
- 不动工具描述 v3 原文 (M2-D010 逐字钉死); 不动正常结果 content; 不动 schema 9 参数; 其他一切维持.
- ~/.pi/agent/ 下只读 (测试继续用临时 HOME).

## 输出契约
- 修改文件清单; RED 证据; GREEN 证据 (全量全绿摘要); 非 test 行数 (wc -l slim-subagent/*.ts); 缺口/风险 (无则写无).
