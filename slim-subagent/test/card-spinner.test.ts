// RunCardSpinner 接口级 TDD (架构深化 候选伍): 原模块级三全局 (cardInvalidator/cardTimer/lastFrameIdx)
// 收进实例 — 覆盖实例隔离, stop 即停, 失效 invalidator 清理. 真实 90ms 定时器, 只断言快速面.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunCardSpinner } from "../card.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("实例隔离: 两个 spinner 各自驱动, 互不覆盖", async () => {
  const a = new RunCardSpinner();
  const b = new RunCardSpinner();
  let na = 0;
  let nb = 0;
  a.start(() => na++);
  b.start(() => nb++);
  await sleep(250);
  assert.ok(na >= 1, `spinner A 应有重绘, got ${na}`);
  assert.ok(nb >= 1, `spinner B 应有重绘, got ${nb}`);
  a.stop();
  b.stop();
  const fa = na;
  const fb = nb;
  await sleep(200);
  assert.equal(na, fa, "stop 后 A 不再重绘");
  assert.equal(nb, fb, "stop 后 B 不再重绘");
});

test("stop: 清 invalidator, active 标志翻转", async () => {
  const s = new RunCardSpinner();
  let n = 0;
  s.start(() => n++);
  assert.equal(s.active, true);
  await sleep(120);
  s.stop();
  assert.equal(s.active, false);
  const frozen = n;
  await sleep(200);
  assert.equal(n, frozen);
});

test("invalidator 抛错 → 失效清理, 下轮停表", async () => {
  const s = new RunCardSpinner();
  let n = 0;
  s.start(() => {
    n++;
    throw new Error("dead context");
  });
  await sleep(300);
  assert.equal(s.active, false, "抛错后 invalidator 应清空");
  const frozen = n;
  await sleep(150);
  assert.equal(n, frozen, "清理后不再尝试");
});
