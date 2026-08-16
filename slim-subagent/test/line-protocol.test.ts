// line-protocol 接口级 TDD (架构深化 候选壹): 此前零直调测试, 只能经 fake-pi 罐头流间接观察.
// 覆盖: 切段/残段 flush, 单行超限 onLimit 诊断 (只发一次, 后续块忽略), turn_end/agent_end 聚合投影合成,
// 投影失败回退 onLimit, env 注入缝. 日志 (L13/L14) 由 issue02-logpoints e2e 断言, 此处不重复 (withHome 隔离落盘).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createLineProtocol, readPendingLineLimit, MAX_PENDING_LINE_BYTES } from "../line-protocol.ts";
import { makeTempHome, withHome } from "./helpers.ts";

function harness(limit: number) {
  const lines: string[] = [];
  const limits: { limitBytes: number; observedBytes: number; prefix: string; tail: string }[] = [];
  const proto = createLineProtocol(
    { maxPendingLineBytes: limit, logCtx: { mode: "single", agent: "t" } },
    { onLine: (l) => lines.push(l), onLimit: (d) => limits.push(d) },
  );
  return { proto, lines, limits };
}

test("complete lines pass through; chunk split mid-line; end() flushes tail", async () => {
  await withHome(makeTempHome(), async () => {
    const { proto, lines, limits } = harness(1024);
    proto.push('{"a":1}\n{"b":');
    assert.deepEqual(lines, ['{"a":1}']);
    proto.push('2}\n{"c":3}'); // 无尾换行
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
    proto.end();
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
    assert.equal(limits.length, 0);
    assert.equal(proto.limitExceeded, false);
  });
});

test("over-limit plain line → onLimit once with diagnostics; later chunks ignored", async () => {
  await withHome(makeTempHome(), async () => {
    const { proto, lines, limits } = harness(64);
    proto.push("x".repeat(100) + "\n");
    assert.equal(proto.limitExceeded, true);
    assert.equal(limits.length, 1);
    assert.equal(limits[0].limitBytes, 64);
    assert.ok(limits[0].observedBytes >= 100);
    assert.ok(limits[0].prefix.startsWith("xxxx"));
    assert.equal(lines.length, 0); // 超限行不抛出
    proto.push('{"ok":true}\n'); // 超限后忽略
    proto.end();
    assert.equal(limits.length, 1);
    assert.equal(lines.length, 0);
  });
});

test("huge turn_end aggregate line is projected, not failed", async () => {
  await withHome(makeTempHome(), async () => {
    const { proto, lines, limits } = harness(128);
    proto.push('{"type":"turn_end","payload":"' + "x".repeat(500) + '"}\n');
    assert.deepEqual(lines, ['{"type":"turn_end"}']);
    assert.equal(limits.length, 0);
    assert.equal(proto.limitExceeded, false);
  });
});

test("huge agent_end aggregate line keeps willRetry", async () => {
  await withHome(makeTempHome(), async () => {
    const { proto, lines, limits } = harness(128);
    proto.push('{"type":"agent_end","willRetry":false,"big":"' + "y".repeat(500) + '"}\n');
    assert.deepEqual(lines, ['{"type":"agent_end","willRetry":false}']);
    assert.equal(limits.length, 0);
  });
});

test("aggregate prefix but malformed JSON → onLimit", async () => {
  await withHome(makeTempHome(), async () => {
    const { proto, lines, limits } = harness(128);
    proto.push('{"type":"turn_end","x":"' + "y".repeat(500) + '",BAD}\n');
    assert.equal(proto.limitExceeded, true);
    assert.equal(limits.length, 1);
    assert.equal(lines.length, 0);
  });
});

test("end() flushes projecting line without trailing newline", async () => {
  await withHome(makeTempHome(), async () => {
    const { proto, lines, limits } = harness(128);
    proto.push('{"type":"turn_end","p":"' + "z".repeat(300) + '"}'); // 无尾换行, close 收束
    proto.end();
    assert.deepEqual(lines, ['{"type":"turn_end"}']);
    assert.equal(limits.length, 0);
  });
});

test("readPendingLineLimit env seam: positive int overrides, invalid falls back", () => {
  const prev = process.env.SLIM_SUBAGENT_PENDING_LINE_BYTES;
  try {
    process.env.SLIM_SUBAGENT_PENDING_LINE_BYTES = "1234";
    assert.equal(readPendingLineLimit(), 1234);
    process.env.SLIM_SUBAGENT_PENDING_LINE_BYTES = "-5";
    assert.equal(readPendingLineLimit(), MAX_PENDING_LINE_BYTES);
    process.env.SLIM_SUBAGENT_PENDING_LINE_BYTES = "abc";
    assert.equal(readPendingLineLimit(), MAX_PENDING_LINE_BYTES);
    delete process.env.SLIM_SUBAGENT_PENDING_LINE_BYTES;
    assert.equal(readPendingLineLimit(), MAX_PENDING_LINE_BYTES);
  } finally {
    if (prev === undefined) delete process.env.SLIM_SUBAGENT_PENDING_LINE_BYTES;
    else process.env.SLIM_SUBAGENT_PENDING_LINE_BYTES = prev;
  }
});
