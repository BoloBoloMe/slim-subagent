// budget-monitor 接口级 TDD (架构深化 候选壹): 触顶/80% 提示每 run 各一次, 守卫语义, 口径 input+output+cacheWrite.
// 纯计算无 I/O, 直打接口; 日志载荷 (L16/L17) 由 issue02-logpoints e2e 断言, 此处不重复.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createBudgetMonitor } from "../budget-monitor.ts";

function harness(budget: number | undefined, mayAbort: () => boolean = () => true) {
  const exceeded: number[] = [];
  const warned: number[] = [];
  const mon = createBudgetMonitor({ budget, mayAbort, onExceeded: (u) => exceeded.push(u), onWarn80: (u) => warned.push(u) });
  return { mon, exceeded, warned };
}

test("below 80%: silence", () => {
  const { mon, exceeded, warned } = harness(1000);
  mon.observe({ input: 100, output: 50, cacheWrite: 10 });
  assert.deepEqual(exceeded, []);
  assert.deepEqual(warned, []);
  assert.equal(mon.exceeded, false);
});

test("80% warn once, then exceeded once (latch)", () => {
  const { mon, exceeded, warned } = harness(100);
  mon.observe({ input: 85, output: 0, cacheWrite: 0 }); // 85 ≥ 80 → warn
  assert.deepEqual(warned, [85]);
  mon.observe({ input: 90, output: 0, cacheWrite: 0 }); // 不再二次 warn
  assert.deepEqual(warned, [85]);
  mon.observe({ input: 100, output: 0, cacheWrite: 0 }); // 触顶
  assert.deepEqual(exceeded, [100]);
  assert.equal(mon.exceeded, true);
  mon.observe({ input: 120, output: 0, cacheWrite: 0 }); // 已触顶闩锁, 不再发
  assert.deepEqual(exceeded, [100]);
});

test("used = input + output + cacheWrite (cacheRead 不计入口径)", () => {
  const { mon, exceeded, warned } = harness(100);
  // cacheRead 不在 slice 类型中; input+output+cacheWrite=79 < 80 不 warn
  mon.observe({ input: 40, output: 30, cacheWrite: 9 });
  assert.deepEqual(warned, []);
  mon.observe({ input: 40, output: 30, cacheWrite: 10 }); // = 80 → warn
  assert.deepEqual(warned, [80]);
  assert.deepEqual(exceeded, []);
});

test("mayAbort false (已 timeout / terminal stop 已收) 阻断一切", () => {
  const { mon, exceeded, warned } = harness(100, () => false);
  mon.observe({ input: 500, output: 0, cacheWrite: 0 });
  assert.deepEqual(exceeded, []);
  assert.deepEqual(warned, []);
  assert.equal(mon.exceeded, false);
});

test("budget undefined: 不监视", () => {
  const { mon, exceeded, warned } = harness(undefined);
  mon.observe({ input: 10_000_000, output: 0, cacheWrite: 0 });
  assert.deepEqual(exceeded, []);
  assert.deepEqual(warned, []);
});
