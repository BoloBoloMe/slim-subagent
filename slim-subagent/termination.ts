// termination.ts — 中止排空调度 (架构深化 候选壹: 从 runProcess 闭包拆出的深模块).
// 职责: 一个所有者管 4 套定时器 — timeout 定时器 / 三阶段终止序列 (SIGINT→SIGTERM→SIGKILL, timeout 与
// usageBudget 触顶共用) / final drain 状态机 (terminal stop/agent_settled → 1s grace → SIGTERM → 3s SIGKILL)
// / failProtocol 强杀 + AbortSignal 取消监听. dispose() 一处清全部 (settle 收口调用).
// 不拥有运行态判定 (cleanStop/agentSettled/assistantError) — 经回调向调用方查询, 语义归 runProcess.
// 日志: L20 signal.abort_requested / L21 process.signal.sent / L22 final_drain.start / L23 final_drain.forced 随模块走.
// 行为不变: M1-D005 三阶段时序与 M3-01 考察点 2/3/4 常量原样保留.

import { logEvent } from "./log.ts";

// M3-01 考察点 3: timeout 三阶段终止信号延迟常量.
const TIMEOUT_SIGTERM_DELAY_MS = 1000;
const TIMEOUT_SIGKILL_DELAY_MS = 4000;
// M3-01 考察点 2/4: drain 三阶段常量 (terminal stop/agent_settled → 1s grace → SIGTERM → 3s SIGKILL) + 取消 SIGKILL 延迟.
export const FINAL_STOP_GRACE_MS = 1000;
const HARD_KILL_MS = 3000;
const CANCEL_SIGKILL_DELAY_MS = 3000;

/** 可被信号终止的子进程最小面 (spawn 的 ChildProcess 满足). */
export interface SignalableProcess {
  kill(signal: NodeJS.Signals): boolean;
  readonly killed: boolean;
}

export interface TerminationSupervisor {
  /** timeout 定时器 (父进程定时, 子进程无感知); 触发时回调 onTimeout (守卫/置标记/记日志归调用方). */
  armTimeout(ms: number): void;
  /** 三阶段终止序列: SIGINT @0ms → SIGTERM @+1000ms → SIGKILL @+4000ms (timeout/usageBudget 触顶同款). */
  startAbortSequence(): void;
  /** drain 状态机: terminal stop/agent_settled 后 1s grace 强制收尾 (守卫: 已退出/已收口/已启动 不重入). */
  startFinalDrain(): void;
  /** agent_end + willRetry → cancel-drain (slim 无 fallback, 防御保留). */
  cancelFinalDrain(): void;
  /** failProtocol 强杀: 子进程未退 → 立即 SIGTERM, HARD_KILL_MS 后 SIGKILL. */
  protocolKill(): void;
  /** 子进程 exit 事件: 清 drain/protocol 定时器. */
  notifyChildExited(): void;
  /** 取消监听 (AbortSignal → SIGTERM → CANCEL_SIGKILL_DELAY_MS 后 SIGKILL; 兜底定时器非 unref). */
  watchCancel(signal: AbortSignal): void;
  /** settle 收口: 清全部定时器 + 移除取消监听 (取消 SIGKILL 兜底例外, 由 proc.killed 守卫 — 原码同款). */
  dispose(): void;
  /** drain 曾强制发信号 (settle 的 forcedDrainAfterFinalSuccess 判据). */
  readonly forcedTerminationSignal: boolean;
}

export function createTerminationSupervisor(opts: {
  proc: SignalableProcess;
  isSettled(): boolean;
  isChildExited(): boolean;
  /** timeout 触发回调: 守卫 (budget 先触顶则忽略) + 置 timedOut/error + L19 + startAbortSequence 归调用方. */
  onTimeout(): void;
  /** drain SIGTERM 成功发出后回调: 条件补 result.error 归调用方 (运行态判定在 runProcess). */
  onDrainForced(): void;
  logCtx: { mode: "single" | "parallel" | "resume"; agent: string };
}): TerminationSupervisor {
  const { proc, logCtx } = opts;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let sigtermTimer: ReturnType<typeof setTimeout> | undefined;
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  let finalDrainTimer: ReturnType<typeof setTimeout> | undefined;
  let finalHardKillTimer: ReturnType<typeof setTimeout> | undefined;
  let protocolHardKillTimer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  let forced = false;

  const clearTimeoutTimers = (): void => {
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = undefined; }
    if (sigtermTimer) { clearTimeout(sigtermTimer); sigtermTimer = undefined; }
    if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = undefined; }
  };

  const clearFinalDrainTimers = (): void => {
    if (finalDrainTimer) { clearTimeout(finalDrainTimer); finalDrainTimer = undefined; }
    if (finalHardKillTimer) { clearTimeout(finalHardKillTimer); finalHardKillTimer = undefined; }
  };

  const clearProtocolHardKillTimer = (): void => {
    if (protocolHardKillTimer) { clearTimeout(protocolHardKillTimer); protocolHardKillTimer = undefined; }
  };

  // M3-01 考察点 3: 进程可能已退出, kill 抛错时 catch 返回 false.
  // L21 (warn): 每次发信号记日志 (ok=返回), 行为等价.
  const signalChild = (sig: NodeJS.Signals): boolean => {
    let ok: boolean;
    try {
      ok = proc.kill(sig);
    } catch {
      ok = false;
    }
    logEvent({ level: "warn", event: "process.signal.sent", ...logCtx, data: { signal: sig, ok } });
    return ok;
  };

  return {
    armTimeout(ms: number): void {
      timeoutTimer = setTimeout(() => opts.onTimeout(), ms);
    },

    startAbortSequence(): void {
      signalChild("SIGINT"); // 阶段 1: 立即 SIGINT
      sigtermTimer = setTimeout(() => { // 阶段 2: +1000ms → SIGTERM
        signalChild("SIGTERM");
      }, TIMEOUT_SIGTERM_DELAY_MS);
      sigkillTimer = setTimeout(() => { // 阶段 3: +4000ms → SIGKILL
        signalChild("SIGKILL");
      }, TIMEOUT_SIGKILL_DELAY_MS);
    },

    // M3-01 考察点 2 逻辑步骤: 1s grace → SIGTERM → 3s SIGKILL; 守卫防重复启动;
    // 两 timer 均 unref (不独占事件循环). 与 timeout 三阶段管线 (考察点 3) 独立共存.
    startFinalDrain(): void {
      if (opts.isChildExited() || opts.isSettled() || finalDrainTimer) return;
      // L22 (info): final drain 启动 (terminal stop/agent_settled 后 1s grace 强制收尾).
      logEvent({ level: "info", event: "final_drain.start", ...logCtx, data: { graceMs: FINAL_STOP_GRACE_MS } });
      finalDrainTimer = setTimeout(() => {
        if (opts.isSettled()) return;
        const termSent = signalChild("SIGTERM");
        if (!termSent) return;
        forced = true;
        // L23 (warn): drain 强制阶段 — SIGTERM 置真处.
        logEvent({ level: "warn", event: "final_drain.forced", ...logCtx, data: { signal: "SIGTERM" } });
        opts.onDrainForced();
        finalHardKillTimer = setTimeout(() => {
          if (opts.isSettled()) return;
          forced = signalChild("SIGKILL") || forced;
          // L23 (warn): drain 强制阶段 — SIGKILL 处.
          logEvent({ level: "warn", event: "final_drain.forced", ...logCtx, data: { signal: "SIGKILL" } });
        }, HARD_KILL_MS);
        finalHardKillTimer.unref?.();
      }, FINAL_STOP_GRACE_MS);
      finalDrainTimer.unref?.();
    },

    cancelFinalDrain(): void {
      clearFinalDrainTimers();
    },

    protocolKill(): void {
      if (opts.isChildExited()) return;
      signalChild("SIGTERM");
      protocolHardKillTimer = setTimeout(() => {
        if (!opts.isChildExited()) signalChild("SIGKILL");
      }, HARD_KILL_MS);
      protocolHardKillTimer.unref?.();
    },

    notifyChildExited(): void {
      clearFinalDrainTimers();
      clearProtocolHardKillTimer();
    },

    // M3-01 考察点 4: 取消 (AbortSignal → SIGTERM → CANCEL_SIGKILL_DELAY_MS 后 SIGKILL).
    // 取消不走独立 "aborted" 结果类型 — 走通用错误路径: close 后 signal 非空 →
    // "Subagent process terminated by signal SIGTERM." + exitCode 1 (除非 forcedDrainAfterFinalSuccess).
    watchCancel(signal: AbortSignal): void {
      const kill = (): void => {
        if (opts.isSettled()) return;
        // L20 (warn): abort 信号取消请求 (signal.aborted 或 addEventListener 触发时).
        logEvent({ level: "warn", event: "signal.abort_requested", ...logCtx, data: { aborted: signal.aborted } });
        signalChild("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) {
            signalChild("SIGKILL");
          }
        }, CANCEL_SIGKILL_DELAY_MS); // 非 unref (原码同款: 兜底必须触发)
      };
      if (signal.aborted) {
        kill();
      } else {
        signal.addEventListener("abort", kill, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", kill);
      }
    },

    dispose(): void {
      clearTimeoutTimers(); // 进程自然退出时清理所有定时器
      clearFinalDrainTimers(); // drain 定时器同清 (exit/close 均收束)
      clearProtocolHardKillTimer();
      removeAbortListener?.(); // 取消监听清理 (考察点 4: finish 时 removeEventListener)
    },

    get forcedTerminationSignal() {
      return forced;
    },
  };
}
