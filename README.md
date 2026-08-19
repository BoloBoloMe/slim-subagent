# slim-subagent

[pi](https://github.com/badlogic/pi-mono) 的最小化子代理扩展: 单个 `subagent` 工具, 把可独立的任务委派给全新上下文的子进程执行.

从 66K 行的 pi-subagents 一次性重写: **~2.2K 行**, 静态工具面 **~366 tok/请求** (原 ~6.1K, -94%), 零 legacy 耦合.

## 能力

- **单次委派**: `agent` + `task`, 前台阻塞等待结果
- **并行**: `tasks[]` (≤8, 并发 4), 全部跑完汇总, 失败逐任务报告; 长度 1 时等价 `task` (走单次管线, 可 resume)
- **模型选择**: `model` 传参覆盖 agent 默认 model (settings.json `subagent.<name>.model`); 两者都缺则报错引导传参 (不静默继承 pi 默认模型, D024)
- **思考深度**: `thinking` 传参覆盖 agent 默认 thinking (settings.json `subagent.<name>.thinking`, 取值 off/minimal/low/medium/high/xhigh/max), 均无则走模型/pi 默认
- **timeout**: `timeoutMs` (默认 15min), 触发 SIGINT→SIGTERM→SIGKILL 三阶段终止, 返回诊断载荷 (用量/上下文占用/恢复建议)
- **usageBudget**: 累计 `input+output+cacheWrite` 触顶即运行中终止
- **resume**: `action:"resume"` + `id` (从头报前缀或随机尾段) 恢复被中止的运行, 带并发锁 (不排队) 与 7 天按龄 GC; `thinking` 可覆盖 (写回 run.json 快照), `model` 不可换
- **list**: `action:"list"` 名册 (内置 explorer/worker/reviewer + `~/.pi/agent/agents/` 用户自定义)

## 安装

要求: Node ≥ 24 (扩展为 TypeScript 原样装载) + 已装 pi.

```bash
git clone https://github.com/BoloBoloMe/slim-subagent.git
cd slim-subagent
npm install typebox @earendil-works/pi-coding-agent @earendil-works/pi-tui
pi install ./slim-subagent
```

注意: 与旧 pi-subagents 扩展同名互斥, 不可并存 — 先 `pi remove npm:pi-subagents` 再装.

## 使用

新会话里直接说人话即可, 模型会调 `subagent` 工具:

```text
派 explorer 看看当前目录结构, 一句话汇报
并行派两个 worker: 一个写 README 草稿, 一个审查 src/
调用 subagent, action:"list"
```

子代理 session 与运行元数据落盘 `~/.pi/agent/slim-subagent/sessions/<runId>/` (`run.json` + `run-0/session.jsonl`), 供事后审查与 resume.

## 子代理默认 model/thinking

agent 定义文件 (`agents/*.md`) 的 frontmatter 只管 `name`/`description`/`tools`; 默认 `model`/`thinking` 在全局 settings.json (`~/.pi/agent/settings.json`) 配置 — 多设备各自一份, 供应商/可选模型不同也不冲突:

```json
{
  "subagent": {
    "explorer": { "model": "opencode-go/deepseek-v4-flash", "thinking": "high" },
    "reviewer": { "model": "opencode-go/deepseek-v4-flash", "thinking": "max" },
    "worker":  { "model": "opencode-go/deepseek-v4-flash", "thinking": "high" }
  }
}
```

优先级: 调用参数 `model`/`thinking` > settings 默认 > pi 默认 (未配置字段的 agent 不加 `--model`/`--thinking`, 走模型/pi 默认). frontmatter 遗留的 `model`/`thinking` 字段静默忽略.

## 开发

```bash
node --test "slim-subagent/test/**/*.test.ts"
```

设计/决策/验收全记录: [`docs/changes/slim-pi-subagents/`](docs/changes/slim-pi-subagents/) (roadmap 下六份里程碑, 含新旧行为差异清单 milestone-05/ACCEPTANCE.md).
