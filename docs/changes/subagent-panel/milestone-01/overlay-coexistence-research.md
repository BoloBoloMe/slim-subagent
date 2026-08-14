# R1: overlay (nonCapturing) 共存行为排雷实验报告

- 日期: 2026-08-14
- 目标: 判定 D 形态 Session Viewer 能否用 `nonCapturing` overlay 承载 (全屏详情面板, 与 streaming/dialog/键盘输入共存)
- 方法: 真实 pi TUI + 伪终端 (Python pty) 驱动, 按键序列驱动 + 帧级截图断言; 配合 `dist/` 源码静态佐证
- 结论: **可以承载, 但有 2 条硬约束 (打开方式必须非阻塞; 关闭只能靠外部句柄/自触发), 1 条实测死锁坑 (blocking command 打开会冻结主交互循环)**
- 实测通过率: 26/26 断言 (5 个考察点全覆盖)

---

## 0. TL;DR

| 考察点 | 结论 | 证据等级 |
|---|---|---|
| P1 基础渲染 | 正常, 不抢焦点, 不挡编辑器输入 | 实测 + 源码 |
| P2 streaming 期间 | 稳定渲染, 不被遮挡/不闪烁, 流内容正常 | 实测 + 源码 |
| P3 dialog 期间 | 与内置 dialog (model selector) 无冲突, 打开/关闭均不影响 | 实测 + 源码 |
| P4 焦点/键盘 | 默认键盘全到主输入区; 显式 `focus()` 后可交互; `unfocus()` 归还 | 实测 + 源码 |
| P5 多浮层 | 后开者在上 (focusOrder), capturing 与非捕获混开正常, 关闭顺序无 LIFO 强约束 | 实测 + 源码 |

**核心判据 (D 形态)**:
- nonCapturing overlay 本身渲染/共存能力合格, 但**打开方式决定生死**: 用 `ctx.ui.custom({overlay:true})` 且命令 handler 内 `await` 它, 会冻结主交互循环 (用户消息/命令全部静默排队, 实测 14s 内无任何处理); 必须 fire-and-forget (不 await) 或从非命令上下文 (registerShortcut handler / tool / 事件) 打开.
- 关闭路径受限: 非捕获 overlay 收不到键盘, 不能 Esc 关闭; 只能外部 `handle.hide()`/`setHidden()` 或 panel 自触发 `done()`.
- 与 `pi.events` 相关的重要发现: session 事件 (message_start/message_update 等) **只走 `pi.on()` typed handler, 不走 `pi.events` 共享总线** (实测 pi.events 订阅 0 命中); Viewer 要实时刷新必须用 `pi.on("message_update")`.

---

## 1. 实验设置与复现

### 1.1 实验扩展代码要点

实验扩展 `/tmp/pi-overlay-exp/overlay-coex.ts` (临时目录, 不污染 pi 包与 slim-subagent), 基于 `overlay-qa-tests.ts` 的 `PassiveDemoController`/`FocusDemoController` 模式:

```ts
// 关键 1: 非阻塞打开 (Pattern B) - 从 shortcut handler fire-and-forget
pi.registerShortcut("alt+s", {
  handler: (ctx) => {
    void ctx.ui.custom<void>((tui, theme, _kb, done) => {
      const p = new CoexPanel(tui, theme, "A", done, false, /*autoClose*/ true);
      return p;
    }, {
      overlay: true,
      overlayOptions: { nonCapturing: true, anchor: "top-right", width: 60, margin: { top: 1, right: 1 } },
      onHandle: (h) => { handles.set("A", h); },
    });
  },
});

// 关键 2: 阻塞对照 (Pattern A) - 命令 handler 内 await custom
pi.registerCommand("coex-open", { handler: async (_a, ctx) => {
  await ctx.ui.custom<void>((tui, theme, _kb, done) => { ... }, { overlay: true, overlayOptions: {...} });
}});

// 关键 3: 实时状态证据 - panel 每秒 tick 并写 /tmp/pi-overlay-exp/events.log
class CoexPanel implements Component {
  handleInput(data) { /* 记录收到的每个按键 (验证焦点路由) */ }
  render(width) { /* 输出 ALIVE / tick / idle / stream / gotInput 等自检字段 */ }
}
```

Panel 自检字段设计 (把内部状态渲染到 overlay 上, 供伪终端帧断言):
- `COEX-A [nonCapturing] ALIVE` - 存活与模式标记
- `tick=NNN` - 每秒递增, 证明渲染循环存活
- `idle=true/false` - 实时轮询 `ctx.isIdle()`, 标记 agent 是否在跑
- `stream=true/false` - `pi.on("message_start/end")` 事件驱动
- `gotInput=N / last=...` - 收到的按键计数 (验证焦点路由)

事件订阅必须用 `pi.on("message_start", ...)`; `pi.events.on(...)` 收不到 session 事件 (见 §2.2 附注).

### 1.2 伪终端 harness 要点

`/tmp/pi-overlay-exp/harness2.py` (Python 内置 `pty` 模块, 零依赖):
- `pty.fork()` + `TIOCSWINSZ` 设 110x36, `TERM=xterm-256color`, 环境变量继承 `DEEPSEEK_API_KEY`
- 启动: `pi --no-session --provider deepseek --model deepseek/deepseek-v4-flash --thinking off -ne -e overlay-coex.ts -ns -np -nc`
- 帧捕获: pi TUI 全量重绘会输出 `\x1b[2J\x1b[H\x1b[3J`(清屏) ... `\x1b[?2026l`(同步结束), 取两标记之间内容按 `\r\n` 分行, 取末 36 行即当前视口; 触发全量重绘用尺寸抖动 (`TIOCSWINSZ` cols+1 再还原)
- 断言: 帧文本 grep `COEX-A/ALIVE/tick/idle`, 事件日志 count `STREAM=on`/`INPUT name=X`/`HANDLE_X=...`

### 1.3 复现步骤

```bash
# 1. 准备
mkdir -p /tmp/pi-overlay-exp/out
# 2. 放 overlay-coex.ts (§1.1) 与 harness2.py (§1.2) 到 /tmp/pi-overlay-exp/
# 3. 跑 5 考察点全量实测 (每考察点独立 pi 进程)
cd /tmp/pi-overlay-exp && uv run python -u harness2.py
# 4. 单点复现 (Pattern A 阻塞行为 / Pattern B 非阻塞行为)
uv run python -u e1-queued.py   # A: 消息排队 + autoClose 后补处理
uv run python -u e2-shortcut.py # B: 消息实时处理 + 命令可用
# 产物: out/screen-*.txt (帧), events.log (事件时间线), 断言汇总
```

---

## 2. 五个考察点结论

### P1 基础渲染: PASS [实测 5/5 + 源码]

- 实测: `alt+s` 打开 nonCapturing overlay (top-right) 后, 帧内 `COEX-A [nonCapturing] ALIVE` 完整渲染, tick 每秒递增; 同时向主输入区键入 `hello-p1`, 帧末行 (编辑器) 出现该文本, overlay 内 `gotInput=0`.
- 源码佐证: `showOverlay` 对 `nonCapturing` 不调用 `setFocus` (tui.js:299); 合成在软件层完成 - `doRender` 先 `render()` 再 `compositeOverlays()` 再 diff (tui.js:1001-1003), overlay 与背景内容无终端级覆盖竞争.

### P2 streaming 期间: PASS [实测 6/6 + 源码]

- 实测: overlay 打开时发消息 "write numbers 1 to 400", agent run 开始 (`STREAM=on` 事件 + 帧内 `idle=false stream=true`); streaming 期间 3 次帧截图 overlay 全部完整 (`COEX-A ALIVE` + tick 持续), 流式数字内容正常渲染在 overlay 之下/旁; streaming 结束后 overlay 仍在.
- 反例排除: 实验中第 3 帧曾出现 overlay 消失, 排查为测试脚手架自身 14s autoClose 触发, 非渲染问题 (改 60s 后 26/26 全过); 无 overlay 撕裂/遮挡证据.
- 源码佐证: `compositeOverlays` 按 `focusOrder` 升序合成, 每个 overlay 相对视口定位 `idx = viewportStart + row + i` (tui.js:804-871), 内容滚动 (viewportStart 变化) 不改变 overlay 屏幕位置; diff 渲染只重写变化的行, overlay 行不变则不重绘 → 无闪烁.

### P3 dialog 期间: PASS [实测 4/4 + 源码]

- 实测: overlay 打开时按 `Ctrl+L` (app.model.select) 弹出 model selector, 帧内 selector 与 `COEX-A ALIVE` 同屏渲染, overlay 完整无遮挡; `Esc` 关闭 dialog 后 overlay 仍在.
- 源码佐证: 内置 dialog **不是 overlay** - `showSelector` 直接清空并替换 editorContainer 内容 + `setFocus(selector)` (interactive-mode.js:3378-3390), 走的是内容区 inline 组件, 与 overlay 栈无交集; overlay 相对屏幕定位在其上合成 (同 P2 合成机制).

### P4 焦点/键盘: PASS [实测 5/5 + 源码]

- 实测:
  - 未聚焦时: 键入文本出现在主编辑器, overlay `gotInput=0` → 键盘不丢, 不被抢.
  - `handle.focus()` 后: 键入 `xyz` 被 overlay 接收 (`INPUT name=A` 事件 +3).
  - panel 内按 `u` 触发 `handle.unfocus()` 后: 键入 `after-u` 回到主编辑器.
- 源码佐证: TUI 输入只路由给 `focusedComponent.handleInput` (tui.js:613); `focus()` = focusOrder 置顶 + setFocus (tui.js:345); `unfocus()` 回退目标 = topmost 可见 capturing overlay, 否则 `preFocus` (tui.js:352), 而 `getTopmostVisibleOverlay` 跳过 nonCapturing (tui.js:417) → 非捕获 overlay 永不成为焦点回退目标, 归还给打开时的编辑器.
- 注意: capturing overlay 打开时抢焦点, 实测键入被它全部吃掉 (P5 佐证: `/coex-close` 命令字符被 C 面板吞掉, 命令未执行) - 这是**特性而非 bug**, 但说明"开着 capturing 浮层时键盘全归它".

### P5 多浮层堆叠: PASS [实测 8/8 + 源码]

- 实测: A (top-right) + B (top-left, 宽 60 与 A 重叠) 同开, 两 box 均渲染, 重叠区左侧显示 B 的标题 (后开者 focusOrder 高, 合成在上); 再开 capturing C (bottom-center) 三者共存; C 关闭 (Esc) 后 A+B 仍在; `/coex-close` (逐个 `handle.hide()`) 后全部消失, 编辑器恢复可输入.
- 源码佐证: 合成按 `focusOrder` 升序逐层覆盖 (tui.js:805); `handle.hide()` 从栈中精确移除指定 entry, 仅当被移除者持有焦点才转移 (tui.js:312-330); `hideOverlay()` (custom done 走它) 只弹栈顶 (tui.js:387-402).
- 关闭顺序结论: 无强 LIFO 约束 - 用 `handle.hide()` 可任意顺序关; 但 **`ctx.ui.custom` 的 `done()` 走 `hideOverlay()` 只弹栈顶**, 嵌套 custom 场景非 LIFO 关闭会错杀栈顶 (见 §4.6).

### 附注: `pi.on` vs `pi.events` (实测踩坑, 影响 Viewer 实时刷新)

- 实验最初用 `pi.events.on("message_start", ...)` 订阅, 实测 0 命中; 改为 `pi.on("message_start", ...)` 后正常.
- 源码佐证: session/agent 事件经 `_emitExtensionEvent` → `extensionRunner.emit` 分发到 typed handler registry (agent-session.js:351-353, runner.js:569-598); `pi.events` 是扩展间自定义事件共享总线 (loader.js:186-309), session 事件不进它.

---

## 3. D 形态判据

**结论: nonCapturing overlay 可以承载 Session Viewer (D 形态).** 渲染, streaming 共存, dialog 共存, 焦点隔离, 多浮层均已实测通过. 前提是满足 §4 的约束.

D 形态推荐实现形态 (基于实测结论):
1. **打开**: 从命令 handler fire-and-forget 打开 (`void ctx.ui.custom(...)` 不 await), 或 `registerShortcut` handler 内打开; 打开后主循环保持响应 (实测 B: 消息实时处理, `/coex-close` 命令可用).
2. **内容刷新**: 订阅 `pi.on("message_update")` + 轮询 `ctx.isIdle()` 驱动 Viewer 重绘; overlay 组件内 `tui.requestRender()` 触发帧更新 (实测 tick 循环 + streaming 期间渲染稳定).
3. **交互**: 默认只读不抢焦点; 需要滚动/翻页时显式 `handle.focus()` 接管键盘, 空闲后 `handle.unfocus()` 归还.
4. **关闭**: 外部按键 (custom 面板自己聚焦时 Esc) 或生命周期钩子 (session 结束/超时) 调 `handle.hide()`; 若用 blocking custom, 则必须 `done()` (见 §4.2).

---

## 4. 负面约束清单 (坑) 与降级方案

按严重度排序, 每条给规避方案:

### 4.1 [严重, 实测] blocking command 打开会冻结主交互循环

- 现象: `/coex-open` (命令 handler 内 `await ctx.ui.custom`) 打开 overlay 后, 键入消息 + Enter, 3s 内 `STREAM=on` 计数为 0; 实测 14s 内无任何处理, 消息静默排队.
- 机理: 主交互循环 `getUserInput() → session.prompt(text)` (interactive-mode.js:652-658) → `prompt` 里 `await _tryExecuteExtensionCommand(text)` (agent-session.js:800) → `await command.handler()` (agent-session.js:932) → handler 又 await `custom()` → 循环卡死, 后续消息进 `pendingUserInputs` 队列不被消费.
- 规避: 打开 overlay 的命令/快捷键 handler 一律 fire-and-forget; 需要"命令打开 + 主循环继续"用 `registerShortcut` (其分发本就异步不阻塞, interactive-mode.js:1396 "Run handler async, don't block input").

### 4.2 [严重, 实测] blocking custom + `handle.hide()` 死锁

- 现象: 4.1 场景下, 若只用 `handle.hide()` 隐藏 overlay 而不让 panel 调 `done()`, `custom()` promise 永不 resolve → 命令 handler 永不返回 → 主循环永久冻结.
- 规避: Pattern A (blocking) 下关闭必须走 panel `done()` (它触发 `close()` → `resolve`); Pattern B (fire-and-forget) 下 `handle.hide()` 足够, 无死锁.

### 4.3 [中, 实测] 非捕获 overlay 收不到键盘, 无法用 Esc 关闭

- 现象: 非聚焦时所有按键到主编辑器 (P4); overlay 自身 `handleInput` 不被调用 (`gotInput=0`).
- 规避: 关闭只能走外部句柄 (`handle.hide()`/`setHidden()`) 或 panel 内部定时/事件自触发 `done()`; 需 Esc 关闭的交互面板应临时 `focus()`.

### 4.4 [中, 实测] capturing overlay 会吞掉全部键盘输入

- 现象: P5 中 capturing overlay C 打开后, 键入 `/coex-close\r` 的每个字符都被 C 接收 (`INPUT name=C`), 命令从未执行.
- 规避: 不要在 capturing 浮层打开时依赖命令行输入; 先 Esc 关 capturing 再操作; Session Viewer 默认 nonCapturing, 只在显式交互时 focus.

### 4.5 [中, 源码] `pi.events` 收不到 session 事件

- 现象/机理见 §2 附注.
- 规避: 实时状态用 `pi.on("message_update")` 等 typed handler; `pi.events` 仅用于扩展间自定义消息.

### 4.6 [低, 源码] 嵌套 custom 的 `done()` 只弹栈顶

- 机理: `showExtensionCustom` 的 `close()` 调 `ui.hideOverlay()` (interactive-mode.js:1930), 只 pop 栈顶; 若顶层是别的 overlay, 会错杀.
- 规避: 多浮层并存时用 `onHandle` 拿到的 `OverlayHandle.hide()` 精确关闭 (实测 P5 用此法 8/8 通过); 保持 LIFO 关闭顺序亦可.

### 4.7 [低, 实测] 生命周期/dispose 幂等

- 现象: autoClose 触发时 `PANEL_A=disposed` 日志出现 2 次 (interval cleanup + `custom` close 的 `component.dispose()` 各一次).
- 规避: overlay 组件 `dispose()` 幂等 (interval 判空); Viewer 组件同理, 防重复释放定时器/订阅.

### 4.8 降级方案 (若后续发现不可用场景)

- 方案 1 (保 overlay): 非捕获角标/状态面板 (窄条, 不抢交互) + 全屏详情走 `ctx.ui.custom({overlay:false})` 非 overlay 全屏替换 (PRD risk-first-research.md:20 已列, 体验降级但可行, 该路径实测为 editorContainer 替换 + `setFocus`, 无主循环阻塞问题).
- 方案 2 (入口降级): 命令/快捷键 + keyHint 文案 (R2 已证伪工具卡交互, 入口本就走命令/快捷键, 见 risk-first-research.md:29-32).

---

## 5. 附: 关键源码证据位置

pi 包: `/var/home/bolo/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/`

| 事实 | 位置 |
|---|---|
| showOverlay 非捕获不抢焦点 | `node_modules/@earendil-works/pi-tui/dist/tui.js:299` |
| handle.hide() 精确移除/焦点转移 | 同上 `tui.js:306-321` |
| setHidden 焦点转移 | 同上 `tui.js:322-344` |
| focus() 置顶+抢焦点 | 同上 `tui.js:345-351` |
| unfocus() 归还焦点 | 同上 `tui.js:352-382` |
| hideOverlay() 弹栈顶 | 同上 `tui.js:387-402` |
| getTopmostVisibleOverlay 跳过 nonCapturing | 同上 `tui.js:417-424` |
| 输入只路由给 focusedComponent | 同上 `tui.js:613-618` |
| compositeOverlays 排序/合成/视口定位 | 同上 `tui.js:796-871` |
| doRender 先 render 再合成再 diff | 同上 `tui.js:1001-1003` |
| 全量重绘标记 (帧解析依据) | 同上 `tui.js:1006-1030` |
| custom() overlay 打开/close→hideOverlay | `dist/modes/interactive/interactive-mode.js:1920-1970` (close 在 1925, hideOverlay 在 1930) |
| 内置 dialog 是 inline 非 overlay | 同上 `interactive-mode.js:3378-3390` |
| 主交互循环 getUserInput→prompt | 同上 `interactive-mode.js:652-658` |
| shortcut 分发异步不阻塞 | 同上 `interactive-mode.js:1390-1402` |
| prompt await 扩展命令 handler | `dist/core/agent-session.js:800, 921-940` |
| session 事件走 pi.on 不走进 pi.events | `agent-session.js:351-353` + `dist/core/extensions/runner.js:569-598` + `loader.js:186-309` |
| ctx.isIdle 实现 | `agent-session.js:592-594` |

实验产物 (临时): `/tmp/pi-overlay-exp/out/screen-*.txt` (帧), `events.log` (事件时间线), `harness2.log` (26/26 断言汇总).
