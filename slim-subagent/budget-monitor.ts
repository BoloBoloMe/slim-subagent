// budget-monitor.ts — 预算监视 (架构深化 候选壹: 从 runProcess 闭包拆出的深模块).
// 职责: message_end usage 累加后立即比对 (M3-02 考察点 5 选项 B 挂点: 累加之后 fireUpdate 之前, 同步无异步间隙);
// used = input + output + cacheWrite (M2-D003, cacheRead 不计); 触顶与 80% 提示每 run 各只发一次.
// 纯计算, 无 I/O: 触顶/提示动作 (置标记/记日志/启动终止序列) 经回调归调用方, 接口即测试面.

export interface BudgetUsageSlice {
  input: number;
  output: number;
  cacheWrite: number;
}

export interface BudgetMonitor {
  /** usage 累加后同步调用; 触顶判定与 80% 提示在此发生. */
  observe(usage: BudgetUsageSlice): void;
  /** 已触顶 (与调用方 result.budgetExceeded 同步置真, 一处判断一处记录). */
  readonly exceeded: boolean;
}

export function createBudgetMonitor(opts: {
  budget: number | undefined; // 生效预算 (已强制解析): undefined = 不监视
  /** 守卫: 调用方运行态 — 已 timeout / 已收到 terminal stop 后不再触发 (结果已干净完成). */
  mayAbort(): boolean;
  /** 触顶回调 (每 run 一次, 同步无异步间隙): L17 日志 + 置中止标记 + 启动终止序列归调用方. */
  onExceeded(used: number): void;
  /** 80% 提示回调 (每 run 一次): L16 日志归调用方. */
  onWarn80(used: number): void;
}): BudgetMonitor {
  const budget = opts.budget;
  let exceeded = false;
  let warned80 = false;
  return {
    observe(usage: BudgetUsageSlice): void {
      if (budget === undefined || exceeded || !opts.mayAbort()) return;
      const used = usage.input + usage.output + usage.cacheWrite;
      if (used >= budget) {
        exceeded = true;
        opts.onExceeded(used);
      } else if (used >= 0.8 * budget && !warned80) {
        warned80 = true;
        opts.onWarn80(used);
      }
    },
    get exceeded() {
      return exceeded;
    },
  };
}
