#!/usr/bin/env node
// fake-pi: 罐头 JSONL 事件流 + 退出码 + session 文件写盘 + argv 回显 (EXECUTION.md 测试策略接缝 2).
// 开关 (env):
//   FAKE_PI_SCENARIO  = assistant-stop | two-assistant | error-stop | noisy-ok | non-json-fail | stderr-fail | empty-ok
//                     | tool-result-end (onUpdate 触发点: user message_end + tool_result_end + assistant stop)
//                     | slow (ISSUE-03: 每 200ms 发一条 assistant, 不主动退出, 接住 SIGINT/SIGTERM 继续跑)
//                     | graceful-sigint-exit (ISSUE-03: 发一条后等待, 接住 SIGINT 优雅 exit 0)
//                     | drain-stop (TS-004: terminal stop 后不退出, 接住 SIGTERM 继续跑 + heartbeat, 由 SIGKILL 杀死)
//                     | settled (TS-004: 非 terminal assistant + agent_settled 后不退出, 接住 SIGTERM 继续跑)
//                     | abort-raw (TS-004: 发一条非 terminal assistant 后不退出, 移除信号 handler — SIGTERM 走 OS 默认杀死)
//                     | tool-progress / tool-progress-many (ISSUE-07: tool_execution_start/end 进度累积, many=12 对事件+6 条多行 assistant 测有界截断)
//                     | big-output (ISSUE-07: assistant 输出 60KB, parallel 汇总 per-task 截断测试)
//                     | budget (ISSUE-04: FAKE_PI_USAGE 控制每条 usage, FAKE_PI_MESSAGES 条数, FAKE_PI_HANG=1 触顶后不退)
//                      (缺省 assistant-stop)
//   FAKE_PI_EXIT      = 退出码 (缺省 0)
//   FAKE_PI_STDERR    = stderr 文本 (缺省空; TC-010 配错模型场景注入)
//   FAKE_PI_ECHO_ARGV = argv 数组 JSON 写入路径 (TS-002 argv 契约断言用)
//   FAKE_PI_SIGNAL_FILE = 信号时序记录 (JSONL: start/SIGINT/SIGTERM/heartbeat 行 {signal,ts}; ISSUE-03 TC-002)
// --session <path> argv: 模拟 pi 写盘 (session 头 + 事件), 父进程只 mkdir 不写 session.jsonl.
// 信号时序记录 (ISSUE-03 收口): SIGINT/SIGTERM 可捕获, 到点写时间戳; SIGKILL 不可捕获 (内核直接杀死),
// slow 场景以 heartbeat 时间戳推断 SIGKILL 时刻 (最后一条 heartbeat ≈ SIGKILL, 误差 ≤ 200ms 心跳间隔).
// TS-002 bundle 回显: FAKE_PI_ECHO_BUNDLE = 写入 {argv, cwd, prompt 快照(内容+权限), @file task 快照}.
import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
const scenario = process.env.FAKE_PI_SCENARIO ?? "assistant-stop";
const exitCode = Number(process.env.FAKE_PI_EXIT ?? "0");
const stderrText = process.env.FAKE_PI_STDERR ?? "";
const signalFile = process.env.FAKE_PI_SIGNAL_FILE;

function message(role, text, extra = {}) {
  return { role, content: [{ type: "text", text }], ...extra };
}

function jsonEvent(m) {
  return JSON.stringify({ type: "message_end", message: m });
}

// 信号时序记录: SIGINT/SIGTERM 可捕获写时间戳; 写失败不致命 (信号路径不应因 IO 抛错).
function recordSignal(signal) {
  if (!signalFile) return;
  try {
    fs.appendFileSync(signalFile, JSON.stringify({ signal, ts: Date.now() }) + "\n");
  } catch {
    // 忽略
  }
}

// session 目标路径 (--session <path>).
function sessionTarget() {
  const idx = args.indexOf("--session");
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

// session 增量写 (模拟 pi session-manager): 首条事件带 session header, 后续追加.
let sessionHeaderWritten = false;
function appendSessionEvent(evt) {
  const sf = sessionTarget();
  if (!sf) return;
  fs.mkdirSync(path.dirname(sf), { recursive: true });
  const line = JSON.stringify(evt);
  if (!sessionHeaderWritten) {
    sessionHeaderWritten = true;
    fs.writeFileSync(sf, JSON.stringify({ type: "session", sessionId: "fake-session-1", timestamp: Date.now() }) + "\n" + line + "\n");
  } else {
    fs.appendFileSync(sf, line + "\n");
  }
}

// 全部场景安装信号 handler (同步场景退出太快, 记录通常不落盘; slow/graceful/drain/settled 场景依赖它;
// abort-raw 场景显式移除 — SIGTERM 走 OS 默认动作, 供取消路径 close signal=SIGTERM 断言).
const onSigint = () => recordSignal("SIGINT");
const onSigterm = () => recordSignal("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
recordSignal("start");

// ISSUE-05 TC-006: per-child argv 回显 — 并发 child 各写独立文件 (按 pid 区分, 防覆盖串扰).
const echoDir = process.env.FAKE_PI_ECHO_ARGV_DIR;
if (echoDir) {
  try {
    fs.mkdirSync(echoDir, { recursive: true });
    fs.writeFileSync(path.join(echoDir, `argv-${process.pid}.json`), JSON.stringify(args, null, 2) + "\n");
  } catch {
    // 回显失败不致命 (只影响 TC-006 断言面)
  }
}

// ---- ISSUE-03 异步场景 ----

// slow: 每 200ms 发一条 assistant (stopReason "stop" 供中止标记优先断言), 永不主动退出;
// SIGINT/SIGTERM 被接住继续跑, 心跳与消息同频写文件 → 最后一条 heartbeat ≈ SIGKILL 时刻 (TC-002 时序推断源).
if (scenario === "slow") {
  let tick = 0;
  const emit = () => {
    tick += 1;
    const m = message("assistant", `slow partial ${tick}`, {
      model: "fake-model-1",
      stopReason: "stop",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 }, totalTokens: 15 + tick },
    });
    console.log(jsonEvent(m));
    appendSessionEvent({ type: "message_end", message: m });
    recordSignal("heartbeat");
  };
  emit();
  setInterval(emit, 200);
  // 事件循环由 interval 保持; 进程在 SIGKILL (timeout 序列末段) 处被内核杀死.
} else if (scenario === "drain-stop") {
  // TS-004 TC-012/TC-013: terminal stop 后不主动退出 → 父进程 1s grace 后 SIGTERM, 再 3s SIGKILL.
  // SIGTERM 被顶层 handler 记录后继续跑 (SIGTERM 后仍不退) → 由 SIGKILL (内核) 杀死;
  // heartbeat 每 200ms 一条, 最后一条 ≈ SIGKILL 时刻 (误差 ≤ 200ms, 同 slow 场景 TC-002 手法).
  const m = message("assistant", "drain final text", {
    model: "fake-model-1",
    stopReason: "stop",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 }, totalTokens: 15 },
  });
  console.log(jsonEvent(m));
  appendSessionEvent({ type: "message_end", message: m });
  setInterval(() => recordSignal("heartbeat"), 200);
} else if (scenario === "settled") {
  // TS-004 TC-014: 非 terminal assistant (stopReason "toolCall", 无 toolCall content) + agent_settled 后不退出;
  // drain 由 agent_settled 事件兜底触发 (非 terminal stop 路径不触发 drain).
  const m = message("assistant", "settled partial text", {
    model: "fake-model-1",
    stopReason: "toolCall",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 }, totalTokens: 15 },
  });
  console.log(jsonEvent(m));
  appendSessionEvent({ type: "message_end", message: m });
  console.log(JSON.stringify({ type: "agent_settled" }));
  setInterval(() => recordSignal("heartbeat"), 200);
} else if (scenario === "abort-raw") {
  // TS-004 TC-015: 移除信号 handler → SIGTERM 走 OS 默认动作 (进程被杀, close signal=SIGTERM),
  // 父进程走 "Subagent process terminated by signal SIGTERM." 错误路径 (考察点 4).
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  const m = message("assistant", "aborted partial", {
    model: "fake-model-1",
    stopReason: "toolCall",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 }, totalTokens: 15 },
  });
  console.log(jsonEvent(m));
  appendSessionEvent({ type: "message_end", message: m });
  setInterval(() => {}, 1000); // keep alive 等待信号; SIGTERM 默认动作杀死进程.
} else if (scenario === "huge-line" || scenario === "huge-line-ignore" || scenario === "huge-turn-end" || scenario === "huge-agent-end" || scenario === "huge-garbage") {
  // ISSUE-02 防御项收口 (M3-01 考察点 5): 单行超限 / 聚合行投影 fake 场景.
  // 公共: 先发粒度 user + assistant(stop) 事件, 随后 3 段写一条巨型行 (间隔 50ms, 逼中段超限);
  //   huge-line / huge-garbage: 超限触发 failProtocol → SIGTERM, 接住记录后 exit 1;
  //   huge-line-ignore: 接住 SIGTERM 继续跑 (heartbeat), 由 3s 后 SIGKILL 杀死;
  //   huge-turn-end / huge-agent-end: 投影成功 (不触发 failProtocol), 写完后延迟 100ms exit 0 (防 stdout 截断).
  const bigAssistant = message("assistant", "Hello from fake assistant", {
    model: "fake-model-1",
    stopReason: "stop",
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 }, totalTokens: 18 },
  });
  console.log(jsonEvent(message("user", "Task: ...")));
  console.log(jsonEvent(bigAssistant));

  // SIGTERM 处理器须在写巨型行前安装 (failProtocol 的 SIGTERM 可能先到, 防默认动作/未记录竞态).
  process.on("SIGTERM", () => {
    recordSignal("SIGTERM");
    if (scenario !== "huge-line-ignore") process.exit(1);
  });
  if (scenario === "huge-line-ignore") setInterval(() => recordSignal("heartbeat"), 200);

  const LINE_SPECS = {
    "huge-line": { prefix: '{"type":"huge_payload","data":"', suffix: '"}' },
    "huge-line-ignore": { prefix: '{"type":"huge_payload","data":"', suffix: '"}' },
    "huge-turn-end": { prefix: '{"type":"turn_end","message":{"data":"', suffix: '"}}' },
    "huge-agent-end": { prefix: '{"type":"agent_end","willRetry":false,"agent":{"data":"', suffix: '"}}' },
    // 打开对象永不闭合 + 悬空引号 → 投影校验失败 → failProtocol.
    "huge-garbage": { prefix: '{"type":"turn_end","message":{', suffix: '"' },
  };
  const spec = LINE_SPECS[scenario];
  const payload = "x".repeat(4000);
  process.stdout.write(spec.prefix);
  setTimeout(() => {
    process.stdout.write(payload);
    setTimeout(() => {
      process.stdout.write(spec.suffix + "\n");
      if (scenario === "huge-turn-end" || scenario === "huge-agent-end") {
        setTimeout(() => process.exit(0), 100);
      } else {
        setInterval(() => {}, 1000); // 保持存活等 SIGTERM/SIGKILL
      }
    }, 50);
  }, 50);
} else if (scenario === "budget") {
  // ISSUE-04: budget 场景 — FAKE_PI_USAGE (JSON, 每条消息 usage) + FAKE_PI_MESSAGES (条数, 默认 2)
  // + FAKE_PI_INTERVAL_MS (hang 模式消息间隔, 默认 200) + FAKE_PI_HANG=1 (触顶后不退, 由 SIGKILL 杀死;
  // 缺省接住 SIGINT/SIGTERM 优雅 exit 0). stopReason "toolCall" (非 terminal): 不触发 drain,
  // budget 管线信号时序断言干净 (无 drain SIGTERM 干扰).
  let usageRaw = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
  try {
    usageRaw = JSON.parse(process.env.FAKE_PI_USAGE ?? "");
  } catch {
    // FAKE_PI_USAGE 未设/坏 JSON → 默认 usage
  }
  const messageCount = Number(process.env.FAKE_PI_MESSAGES ?? "2");
  const intervalMs = Number(process.env.FAKE_PI_INTERVAL_MS ?? "200");
  const hang = process.env.FAKE_PI_HANG === "1";
  const input = usageRaw.input ?? 0;
  const output = usageRaw.output ?? 0;
  const cacheRead = usageRaw.cacheRead ?? 0;
  const cacheWrite = usageRaw.cacheWrite ?? 0;
  let tick = 0;
  const emit = () => {
    tick += 1;
    const m = message("assistant", `budget partial ${tick}`, {
      model: "fake-model-1",
      stopReason: "toolCall",
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        cost: { total: 0.01 * tick },
        totalTokens: input + output + cacheRead + cacheWrite,
      },
    });
    console.log(jsonEvent(m));
    appendSessionEvent({ type: "message_end", message: m });
    recordSignal("heartbeat");
  };
  if (hang) {
    // 触顶后不退: 顶层 SIGINT/SIGTERM handler 记录后继续跑, 由 budget 管线 SIGKILL 杀死;
    // 心跳与消息同频写文件 → 最后一条 heartbeat ≈ SIGKILL 时刻 (TC-002 时序推断源).
    emit();
    setInterval(emit, intervalMs);
  } else {
    for (let i = 0; i < messageCount; i++) emit();
    // 接住 SIGINT/SIGTERM 优雅 exit 0 (顶层 handler 已先记录信号); 50ms 防 stdout 截断.
    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));
    setTimeout(() => process.exit(0), 50);
  }
} else if (scenario === "graceful-sigint-exit") {
  // graceful: 发一条 assistant 后等待; SIGINT → 记录 + 模拟 pi 收尾写盘后 exit 0.
  // 父进程须把该结果判定为 timeout (stopReason=timeout / exitCode 1 / isError) — 修复项 2 回归场景.
  const m = message("assistant", "graceful partial text", {
    model: "fake-model-1",
    stopReason: "stop",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 }, totalTokens: 15 },
  });
  console.log(jsonEvent(m));
  appendSessionEvent({ type: "message_end", message: m });
  process.on("SIGINT", () => {
    recordSignal("SIGINT");
    process.exit(0); // 优雅退出 (模拟 pi 接住 SIGINT 写盘后干净退出)
  });
  process.on("SIGTERM", () => {
    recordSignal("SIGTERM");
    process.exit(0);
  });
  setInterval(() => {}, 1000); // keep alive 等待信号
} else if (scenario === "parallel-sleep") {
  // ISSUE-05 TC-004: 并发观察 — start (顶层) 后 sleep FAKE_PI_SLEEP_MS (默认 300), 记录 end,
  // 再按 assistant-stop 输出并退出; 并发窗口 = [start, end] 重叠数 (同文件 append, 小写原子).
  const sleepMs = Number(process.env.FAKE_PI_SLEEP_MS ?? "300");
  setTimeout(() => {
    recordSignal("end");
    const m = message("assistant", "Hello from fake assistant", {
      model: "fake-model-1",
      stopReason: "stop",
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 }, totalTokens: 18 },
    });
    appendSessionEvent({ type: "message_end", message: m });
    console.log(jsonEvent(m));
    process.exit(0);
  }, sleepMs);
} else if (scenario === "error-if-marked") {
  // ISSUE-05 TC-003: 按 argv 任务标记区分 child 行为 (env 共享, 只能经 argv 区分):
  // 任务含 __FAIL__ → error-stop (exit 1); 否则 assistant-stop 快速完成.
  const taskArg = args[args.length - 1] ?? "";
  if (taskArg.includes("__FAIL__")) {
    const m = message("assistant", "partial text", {
      model: "fake-model-1",
      stopReason: "error",
      errorMessage: "model error: boom",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 }, totalTokens: 15 },
    });
    console.log(jsonEvent(m));
    appendSessionEvent({ type: "message_end", message: m });
    process.exit(1);
  }
  const ok = message("assistant", "Hello from fake assistant", {
    model: "fake-model-1",
    stopReason: "stop",
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 }, totalTokens: 18 },
  });
  console.log(jsonEvent(ok));
  appendSessionEvent({ type: "message_end", message: ok });
  process.exit(0);
} else if (scenario === "slow-if-marked") {
  // ISSUE-05 TC-005: 任务含 __SLOW__ → slow 行为 (每 200ms 一条, 不主动退出;
  // FAKE_PI_SLOW_EXIT_MS > 0 时到点自退 0 — RED 阶段无超时也不会挂死测试), 否则 assistant-stop 快速完成.
  const taskArg = args[args.length - 1] ?? "";
  if (taskArg.includes("__SLOW__")) {
    let tick = 0;
    const emit = () => {
      tick += 1;
      const m = message("assistant", `slow partial ${tick}`, {
        model: "fake-model-1",
        stopReason: "stop",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 }, totalTokens: 15 + tick },
      });
      console.log(jsonEvent(m));
      appendSessionEvent({ type: "message_end", message: m });
      recordSignal("heartbeat");
    };
    emit();
    const interval = setInterval(emit, 200);
    const slowExitMs = Number(process.env.FAKE_PI_SLOW_EXIT_MS ?? "0");
    if (slowExitMs > 0) setTimeout(() => { clearInterval(interval); process.exit(0); }, slowExitMs);
  } else {
    const ok = message("assistant", "Hello from fake assistant", {
      model: "fake-model-1",
      stopReason: "stop",
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 }, totalTokens: 18 },
    });
    console.log(jsonEvent(ok));
    appendSessionEvent({ type: "message_end", message: ok });
    process.exit(0);
  }
} else {
  // 每个 scenario 返回 stdout 行数组 (JSON 事件行 + 非 JSON 噪声行均可; 非 JSON 行供 TS-003 容忍/诊断测试).
  // stderr 诊断由 FAKE_PI_STDERR env 注入 (TC-010 配错模型场景: Model "..." not found).
  const SCENARIOS = {
    "assistant-stop": () => [
      jsonEvent(message("user", "Task: ...")),
      jsonEvent(message("assistant", "Hello from fake assistant", {
        model: "fake-model-1",
        stopReason: "stop",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 }, totalTokens: 18 },
      })),
    ],
    "two-assistant": () => [
      jsonEvent(message("user", "Task: ...")),
      jsonEvent(message("assistant", "first reply", {
        model: "first-model",
        stopReason: "stop",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.125 }, totalTokens: 15 },
      })),
      jsonEvent(message("assistant", "second reply", {
        model: "second-model",
        stopReason: "stop",
        usage: { input: 20, output: 7, cacheRead: 3, cacheWrite: 2, cost: { total: 0.25 }, totalTokens: 32 },
      })),
    ],
    "error-stop": () => [
      jsonEvent(message("user", "Task: ...")),
      jsonEvent(message("assistant", "partial text", {
        model: "fake-model-1",
        stopReason: "error",
        errorMessage: "model error: boom",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 }, totalTokens: 15 },
      })),
    ],
    // TS-003 TC-008: 非 JSON 行穿插 JSON 事件, exit 0 → 完全无害.
    // onUpdate 切片 (M3-02 考察点 6): tool_result_end 触发点 (防御分支) — user 与 assistant 之间插一条 toolResult.
    "tool-result-end": () => [
      jsonEvent(message("user", "Task: ...")),
      JSON.stringify({ type: "tool_result_end", message: message("toolResult", "tool result text") }),
      jsonEvent(message("assistant", "Hello after tool", {
        model: "fake-model-1",
        stopReason: "stop",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 }, totalTokens: 18 },
      })),
    ],
    "noisy-ok": () => [
      "=== fake noise line ==",
      jsonEvent(message("user", "Task: ...")),
      "progress: 50%",
      jsonEvent(message("assistant", "Hello from fake assistant", {
        model: "fake-model-1",
        stopReason: "stop",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 }, totalTokens: 18 },
      })),
      "tail noise line",
    ],
    // ISSUE-07 deferred (a): tool_execution_start/end 进度累积 (progress 快照填值).
    "tool-progress": () => [
      JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { file_path: "src/a.ts", offset: 1, limit: 20 } }),
      JSON.stringify({ type: "tool_execution_end", toolName: "read", args: { file_path: "src/a.ts", offset: 1, limit: 20 } }),
      jsonEvent(message("user", "Task: ...")),
      JSON.stringify({ type: "tool_execution_start", toolName: "grep", args: { pattern: "TODO", path: "src" } }),
      JSON.stringify({ type: "tool_execution_end", toolName: "grep", args: { pattern: "TODO", path: "src" } }),
      jsonEvent(message("assistant", "found it\nline two\nline three", {
        model: "fake-model-1",
        stopReason: "stop",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 }, totalTokens: 18 },
      })),
    ],
    // ISSUE-07 deferred (a): 有界截断 — 12 对 tool 事件 + 6 条 12 行 assistant (recentTools 超 10 / recentOutput 超 50).
    "tool-progress-many": () => {
      const lines = [];
      for (let i = 0; i < 12; i++) {
        lines.push(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { file_path: `src/f${i}.ts` } }));
        lines.push(JSON.stringify({ type: "tool_execution_end", toolName: "read", args: { file_path: `src/f${i}.ts` } }));
      }
      lines.push(jsonEvent(message("user", "Task: ...")));
      for (let i = 0; i < 6; i++) {
        lines.push(jsonEvent(message("assistant", Array.from({ length: 12 }, (_, j) => `out-${i}-${j}`).join("\n"), {
          model: "fake-model-1",
          stopReason: "stop",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 }, totalTokens: 15 },
        })));
      }
      return lines;
    },
    // ISSUE-07 deferred (c): 单任务输出超 PER_TASK_OUTPUT_CAP (60KB), parallel 汇总须截断.
    "big-output": () => [
      jsonEvent(message("user", "Task: ...")),
      jsonEvent(message("assistant", "y".repeat(60000), {
        model: "fake-model-1",
        stopReason: "stop",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 }, totalTokens: 18 },
      })),
    ],
    // TS-003 TC-009: 仅非 JSON stdout, exit 1 → rawStdout 整段当错误.
    "non-json-fail": () => [
      "Starting pipeline for task...",
      "Error: something exploded",
      "  at fake line 12",
    ],
    // TS-003 TC-010: 合法 JSON (user) + stderr 诊断, exit 1 → error=stderr 文本.
    "stderr-fail": () => [
      jsonEvent(message("user", "Task: ...")),
    ],
    // TS-003 TC-011: exit 0 但无 assistant 文本 → 空输出判定.
    "empty-ok": () => [
      jsonEvent(message("user", "Task: ...")),
    ],
  };

  const build = SCENARIOS[scenario];
  if (!build) {
    console.error(`fake-pi: unknown FAKE_PI_SCENARIO "${scenario}"`);
    process.exit(2);
  }
  const lines = build();
  // session 写盘只取其中的 JSON message_end 事件 (与既有行为一致, 非 JSON 行不落 session).
  const events = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.type === "message_end" && e.message);

  // argv 回显 (TS-002).
  const echoPath = process.env.FAKE_PI_ECHO_ARGV;
  if (echoPath) {
    fs.mkdirSync(path.dirname(echoPath), { recursive: true });
    fs.writeFileSync(echoPath, JSON.stringify(args, null, 2) + "\n");
  }

  // TS-002 bundle 回显: argv + 进程 cwd + --append-system-prompt 文件快照 + 末参 @file 快照.
  const bundlePath = process.env.FAKE_PI_ECHO_BUNDLE;
  if (bundlePath) {
    const bundle = { argv: args, cwd: process.cwd() };
    const promptIdx = args.indexOf("--append-system-prompt");
    if (promptIdx !== -1 && args[promptIdx + 1]) {
      const p = args[promptIdx + 1];
      // path 字段供 TC-001 精确记录本次运行创建的 temp 目录名 (残留断言用, 不做 /tmp 全量对比).
      bundle.prompt = { path: p, content: fs.readFileSync(p, "utf-8"), mode: fs.statSync(p).mode & 0o777 };
    }
    const last = args[args.length - 1];
    if (typeof last === "string" && last.startsWith("@")) {
      const p = last.slice(1);
      bundle.taskFile = { path: p, content: fs.readFileSync(p, "utf-8") };
    }
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + "\n");
  }

  // --session 写盘 (模拟 pi session-manager 增量写).
  const sessionIdx = args.indexOf("--session");
  if (sessionIdx !== -1 && args[sessionIdx + 1]) {
    const sessionFile = args[sessionIdx + 1];
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const sessionLines = [JSON.stringify({ type: "session", sessionId: "fake-session-1", timestamp: Date.now() })];
    for (const evt of events) sessionLines.push(JSON.stringify(evt));
    fs.writeFileSync(sessionFile, sessionLines.join("\n") + "\n");
  }

  for (const line of lines) console.log(line);
  if (stderrText) console.error(stderrText);
  process.exit(exitCode);
}
