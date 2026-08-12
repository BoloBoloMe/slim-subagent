# 精简 pi-subagents — 重写最小核心

## 目的地

一个可直接装载使用的精简版子代理扩展: 全新代码约 1300-1600 行 (现 66,465 行), 只暴露点名保留的能力, 注入模型的工具描述与 schema 缩减一个数量级. 基于 pi-subagents v0.44.0 能力盘点一次性重写, 钉死版本, 不追上游.

保留集已固化 (MILESTONE-01, 权威输入 = ../milestone-01/DECISIONS.md): single + parallel + 模型选择 + timeout (15min 默认 + 诊断载荷) + resume + token 上限 + 最小 list; 编排 (workflowScript/chain), async 后台, acceptance, contact_supervisor, worktree 等全删.

验收三件套:
1. 模型可见面 = 保留清单, 高频工作流全部可用 (MILESTONE-06 现场验证)
2. token 可量化下降: 静态工具面 ~6.1K → 目标 ~250-400 tok/请求, 450 硬顶 (MILESTONE-05 实测)
3. 代码易于维护且精简: 66.5K → ~1300-1600 行, 无 legacy 耦合

## 笔记

- 领域: pi 扩展开发 / 子代理编排. 产品背景: docs/2026-08-08-subagent-product-design-report.md. 本仓库无 docs/language, docs/adr.
- 旧码: pi-subagents-main/ (v0.44.0, src 66,465 行) — 全程只读, 一行不动; 新扩展独立成目录.
- 关键事实: pi 官方 examples/extensions/subagent/ (1141 行) 已是可信核心 (单次委派/chain/parallel/模型选择/结果回收) 完整参考实现, 重写 = 官方基线 + 隐性行为移植 + 搬运官方示例 agents/*.md.
- 每个会话应查阅的 skill: M4 用 tdd-as-orchestra (产物根目录 docs/changes/slim-pi-subagents/milestone-04/); 汇报用 adaptive-presentation. 保留集权威输入: ../milestone-01/DECISIONS.md (M1 已关闭) + ../milestone-02/DECISIONS.md (M2 已关闭, 暴露面定稿).
- M2 关键后续事实: (1) 反方攻击/校验子代理失败根因 = 内置 reviewer agent 配置引用不存在的 ai-work-* provider; 实际可用 deepseek/deepseek-v4-flash (env DEEPSEEK_API_KEY), 派子代理若默认配置失败可显式指定 model: deepseek/deepseek-v4-flash; (2) M5 golden 对拍新旧同名工具须分会场跑 — 旧会话装 settings packages, 新会话 pi -e 显式加载; (3) 装载两阶段: 测试期 pi -e, 切换后移入自动装载目录; (4) usageBudget 口径 = input+output+cacheWrite (cacheRead 不计).
- 固定偏好: 中文回复, 电报文, 半角标点; Python 一律 uv run python.
- M4 → M5 移交项: (1) fake-pi 罐头事件流与真实 pi 0.82.1 形状差异待 golden 对拍; (2) 渲染视觉验证 (折叠/展开/Ctrl+O) 移交 M6 现场; (3) resume 对 agent 定义删/改的限制 (AFK-08) 待 M5 评估; (4) onUpdate 裁剪 (AFK-04) 与 recentOutput 无字节上限为已知限制; (5) 冒烟须 `pi -ne -e` (-ne 避同名冲突, EXECUTION.md 实测备忘).
- 方向侦查结论 (完整报告在 docs/changes/slim-pi-subagents/direction-research/):
  - **已选 C 重写最小核心**: 800-1500 行交付, 1-2 人日, token 静态面 ~6.1K → 200-300 tok (5-10x↓); 三项验收全胜. 已知风险 = 隐性行为丢失 (timeout 三阶段终止/fallback 重试/非 JSON 容忍/进程寻址), 由 MILESTONE-03 提取规格, MILESTONE-05 golden 对拍消解.
  - 排除 A 原地硬删: 剩 26-41K 行, 4-8 人日, 终点仍重且有修剪痕迹; 报告降级为 MILESTONE-03 搬运地图 (含功能-代码行号映射).
  - 排除 B 只裁暴露面: 留 25-30K 行死代码, 维护面验收不及格; 其 token 账本 (schema+description 是大头) 被 C 继承.

## 已关闭决策

<!-- 每个已关闭 Milestone 一行: 链接 + 一句话摘要 -->
- [MILESTONE-01](MILESTONE-01.md) — 保留/删除清单固化: 仅 single+parallel+模型选择+timeout(15min+诊断载荷)+resume+token 上限+最小 list, 编排/async/acceptance/contact_supervisor/worktree 等全删; 账本 [../milestone-01/DECISIONS.md](../milestone-01/DECISIONS.md)
- [MILESTONE-02](MILESTONE-02.md) — 暴露面定稿: 单 subagent 工具同名一次性切换, schema 9 参数, 中文描述 v3 (450 tok 预算内), 诊断载荷+事后审查 (runId+sessionDir, 7 天 GC), 砍 project agents, 本地目录两阶段装载; 账本 [../milestone-02/DECISIONS.md](../milestone-02/DECISIONS.md)
- [MILESTONE-03](MILESTONE-03.md) — 移植规格 5 片落盘 [../milestone-03/](../milestone-03/): 三阶段 drain/timeout 管线/结果回收/usage/resume+session (D012a 成立: pi 会话增量写盘)/寻址链/frontmatter/list/并发 4+8/模型报错; F006 消解 (ctx.getContextUsage 拿百分比); 发现 D006 usage budget 语义缺口 (旧码=调度门), 待决策清单在 PORTING-SPEC §四
- [MILESTONE-04](MILESTONE-04.md) — 新扩展 slim-subagent/ 建成: 7 ISSUE 全关闭, 84/84 测试绿 (node:test + fake-pi 集成), 非 test 2204 行 (原估 1600, AFK-06 调整为 ≤2000 软目标后微超); 冒烟 `pi -ne -e` 装载/list/single 真实子进程全通过; 执行规格 [../milestone-04/EXECUTION.md](../milestone-04/EXECUTION.md) (含调和 1~16), AFK 期自行决策账本 [../milestone-04/AFK-DECISIONS.md](../milestone-04/AFK-DECISIONS.md); 事故: 归属不明写者预建 ISSUE-03 代码, 经双轴审查后采纳 (用户批准); 非 git 仓库, 提交步骤全程跳过
- [MILESTONE-05](MILESTONE-05.md) — 量化验收三件套全过: token 实测 ~303 tok/请求 (旧 ~6140, -95.1%/20.3x, 450 硬顶内, 子侧 1291→0); e2e 新模式 7/7 真实子进程通过; golden 对拍 7 条差异全有意/收敛 (resume runId/model 后缀/usageBudget 语义/存储布局/工具面) + 2 条收敛; 报告 [../milestone-05/ACCEPTANCE.md](../milestone-05/ACCEPTANCE.md), 账本 [../milestone-05/token-accounting.md](../milestone-05/token-accounting.md)
- [MILESTONE-06](MILESTONE-06.md) — 切换完成: 旧扩展+pi-intercom 净卸, slim-subagent 经 `pi install` 自动装载; 高频工作流 (list/single/parallel/timeout/resume) 现场全过; 两现场发现已裁决并修复 (中止 content 拼诊断信息块, runId 尾段报号, 85/85 绿); 旧扩展删除不留备份 (含仓库底本); 记录 [../milestone-06/SWITCH-NOTES.md](../milestone-06/SWITCH-NOTES.md)

## 前沿

(空 — 路线已走通)

## 未决迷雾

(空 — 存档策略已由 MILESTONE-06 裁决: 删除)

## 范围外

- 追上游 pi-subagents 更新 — 绘制时已决: 一次性裁剪, 钉死版本
- 发布精简版给他人使用 — 目的地之外
- 改动 pi 核心 — 目的地之外

## 阻塞关系

```
MILESTONE-01 ──► MILESTONE-02 ──► MILESTONE-04 ──► MILESTONE-05 ──► MILESTONE-06
     │                                ▲
     └──────► MILESTONE-03 ──────────┘

(全部关闭: MILESTONE-01~06. 另: 用户于 M6 后指示将工作目录发布到公开仓库 github.com/BoloBoloMe/slim-subagent — 原"发布给他人使用 = 范围外"被用户重划)
```
