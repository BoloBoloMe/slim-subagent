# M5 token 实测: slim-subagent 静态工具面计账

- 日期/环境: node v24.16.0 (原生 type stripping), typebox@1.x, 实测产物为临时脚本 (接缝 = test/helpers.ts captureTool 同款: fake ExtensionAPI 捕获 registerTool), 用完已删.
- 口径: ~tokens = chars/4 (与 B-surface-trim.md §2 同口径, 可比). chars = JS 字符串长度, schema 为 JSON.stringify(parameters) 序列化字符数.
- 被测对象: slim-subagent/index.ts 默认导出 (84/84 测试绿, 功能已验收, 本次只做静态测量, 不改源码).

## 1. 新扩展实测表

| 工具 | name | label | description chars | schema JSON chars | 合计 chars | ~tok |
|---|---|---|---|---|---|---|
| subagent | subagent | Subagent | 221 | 992 | 1213 | ~303 |

- 注册工具数 = 1, 仅 "subagent"; 无 subagent_wait/subagent_supervisor/intercom 附带注册 (fake API 捕获计数确认).
- schema JSON 992 chars < M2 预估 1800-2200 chars (DECISIONS.md:98 保守估), 无需触发 DECISIONS.md:121 剪枝顺序.
- description 221 chars 与 TC-002 钉死的 v3 原文一致 (schema.test.ts 复验通过).

## 2. 父会话静态面对照 (每请求)

| 项 | chars | ~tok |
|---|---|---|
| 旧扩展 v0.44.0 (B 报告账本) | 24559 | ~6140 |
| 新扩展 slim-subagent 实测 | 1213 | ~303 |
| 下降 | 23346 (-95.1%) | ~5837 (-95.1%) |
| 倍数 | 24559/1213 ≈ 20.2x | 6140/303 ≈ 20.3x |

- 旧账本构成 (B-surface-trim.md §2): subagent desc 4049 + schema 16988 + subagent_wait 2828 + subagent_supervisor 349 + intercom 345 = 24559 chars ≈ 6140 tok.
- 新账本构成: 单工具 desc 221 + schema 992 = 1213 chars ≈ 303 tok.
- 下降来源: 工具数 4→1 (删 wait/supervisor/intercom) + 描述 4049→221 (中文 v3 精简) + schema 16988→992 (63 props → 9 params).

## 3. 子会话侧对照 (每 spawn 固定开销)

| 项 | chars | ~tok |
|---|---|---|
| 旧扩展子进程 (B 报告账本) | ~5163 | ~1291 |
| 新扩展子进程 | 0 | 0 |

- 旧构成: subagent_wait 2828 + contact_supervisor 363 + intercom bridge 指令注入 1627 + intercom 345 (仅白名单含时) ≈ 5163 chars ≈ 1291 tok/child.
- 新 = 0 依据: 子进程恒 `--no-skills --no-extensions` (single.ts:331, resume.ts:104; single-spawn-args.test.ts:92-94 与 resume.test.ts:77 断言), 子侧 pi 不装载任何扩展, 上述注入全部不存在. 下降 100%.

## 4. 对照验收目标 (ROADMAP)

- 目的地: "静态工具面 ~6.1K → 目标 ~250-400 tok/请求, 450 硬顶" (ROADMAP 验收 2, MILESTONE-05 实测).
- 实测: ~303 tok/请求.
- 判定: 达标. 303 tok 落在目标区间 250-400 内, 且低于 450 tok 硬顶 (余量 ~33%); 相对基线 ~6140 tok 下降约 20.3x (-95.1%).

## 5. 方法说明

口径 = chars/4 (与 B 报告一致); 接缝 = test/helpers.ts captureTool 同款 fake ExtensionAPI 捕获 registerTool, 对注册工具逐一量 description 与 JSON.stringify(parameters) 字符数; 子侧依据 spawn argv 恒 --no-extensions --no-skills (源码 + 测试断言).

## 缺口 / 风险

- 无: 实测数字与 B 报告同口径可比, 模块装载与 schema.test.ts 复验均通过.
- 已知限制 (非本次范围): prompt caching 下 cacheRead 随轮次线性膨胀是运行时行为, 静态面计账不含; 运行时 prompt 注入 (append-system-prompt 等) 不属于静态工具面.
