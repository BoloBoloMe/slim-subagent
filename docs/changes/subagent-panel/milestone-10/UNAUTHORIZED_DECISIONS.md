# ISSUE-02 (日志全量挂载 + details 补丁) AFK 自主决策记录

执行模式: AFK. 以下决策在权威输入未明确处由总指挥拍板, 供用户复核.

## 1. 回退执行者擅自的脱敏规则变更
- 问题: 执行者为使 TS-001 的 `taskPreview 不含 "sk-秘密"` 断言成立, 把 log.ts 的 sk- 遮蔽规则从 `\bsk-[A-Za-z0-9_-]{8,}` 放宽为 `\bsk-[^\s]{2,}` (匹配任意 2+ 非空格, 含 CJK).
- 决策: 回退 log.ts 到 `[A-Za-z0-9_-]{8,}`, 改 TS-001 测试的 secret 为现实 API key 形态 `sk-abcdefghijklmnop`.
- 理由: `[^\s]{2,}` 会误伤合法 "sk-" 前缀 (如 "sk-learn" scikit-learn), 在 taskPreview 面板展示造成过度遮蔽; 原规则是更精确的 API key 启发式, 已被 ISSUE-01 TS-002 (sk-live-…) 验证. 脱敏规则跨 issue 应稳定.
- 影响: log.ts 与本 ISSUE-01 提交一致; TS-001 断言改为现实 token.
- 风险: 非 ASCII secret 后缀 (如中文紧跟 sk-) 不会被此规则遮蔽 — 但此类形态不构成现实 API key, 属可接受盲区.

## 2. 接受执行者的两个实现偏离 (已合入)
- 问题 a: huge-line 场景 (huge_payload 前缀) 不进聚合投影 (acceptsAggregatePrefix 只收 turn_end/agent_end), 无法触发 L14→L13 序列.
  - 决策: 接受新增 fake 场景 `huge-string-unclosed` (turn_end 前缀 + 未闭合字符串, push 成功但 finish() 返回 undefined) 真实触发 L14→L13; huge-line 保留作 L13 直达回归.
  - 理由: 与原 failProtocol/投影的因果序列定界 (M02 D007) 一致.
- 问题 b: runProcess 内原本不可得 budgetAuto (L16/L17 spec 要求 data.budgetAuto).
  - 决策: 接受 runProcess 加可选参 `budgetAuto?` (default undefined, 不影响行为), single/resume 调用处补传真实值.
  - 理由: 纯日志载荷透传, 无执行语义变化; 全量测试无新增红.

## 3. 既有测试基线漂移 (与 M09 决策 4 相同)
- 全量基线仍为 3 个既有红 (agents.test.ts TC-001/002/003 模型断言 deepseek→opencode-go), 不修, 视为既有失败. 回归标准 = 不新增红.
