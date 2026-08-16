// ISSUE-07 Diagnose 切片测试 (TS-001/002/003).
// 接缝: resolveTarget (target 解析纯函数) / analyzeLogs (启发式分析) / 证据脱敏.
// 造 fixtures 用临时 HOME 隔离 (withHome) + 手工写 sessions 目录与 run.json/session.jsonl.
// 本文件不触 index.ts (schema/action 注册归 ISSUE-08).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempHome, withHome, cleanup } from "./helpers.ts";
import { resolveTarget, analyzeLogs, type ResolvedTarget, type DiagnoseLogLine } from "../diagnose.ts";

function dateStampOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// 造一个含 run.json + run-0/session.jsonl 的会话目录 (single 形态).
function makeSession(sessionsRoot: string, runId: string): void {
  const dir = path.join(sessionsRoot, runId);
  fs.mkdirSync(path.join(dir, "run-0"), { recursive: true });
  fs.writeFileSync(path.join(dir, "run-0", "session.jsonl"), "{}\n");
  fs.writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({ runId, agent: "Alpha", startedAt: new Date().toISOString(), sessionFile: "run-0/session.jsonl" }, null, 2) + "\n",
  );
}

// 造 parallel 批次目录 (批次 run.json + per-child run-<idx>/session.jsonl).
function makeParallelSession(sessionsRoot: string, batchRunId: string, childCount: number): void {
  const dir = path.join(sessionsRoot, batchRunId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({ runId: batchRunId, mode: "parallel", startedAt: new Date().toISOString(), tasks: [] }, null, 2) + "\n",
  );
  for (let i = 0; i < childCount; i++) {
    fs.mkdirSync(path.join(dir, `run-${i}`), { recursive: true });
    fs.writeFileSync(path.join(dir, `run-${i}`, "session.jsonl"), "{}\n");
  }
}

// ---- TS-001: target 解析 (前缀唯一/歧义/随机尾段/batchRunId#index/today 各形态). ----

test("TS-001 target resolution: unique prefix / tail / batch#index / today", async () => {
  const home = makeTempHome();
  try {
    await withHome(home, async () => {
      const sessionsRoot = path.join(home, ".pi", "agent", "slim-subagent", "sessions");
      const runA = `run-${dateStampOf(new Date())}-101010-aaaaaa`;
      const runB = `run-${dateStampOf(new Date())}-202020-bbbbbb`;
      makeSession(sessionsRoot, runA);
      makeSession(sessionsRoot, runB);
      makeParallelSession(sessionsRoot, `run-${dateStampOf(new Date())}-303030-cccccc`, 3);

      // (a) 完整 runId 前缀唯一命中.
      const full = resolveTarget(runA, sessionsRoot) as ResolvedTarget & { kind: "run" };
      assert.equal(full.kind, "run");
      assert.deepEqual(full.runIds, [runA]);

      // (b) 短前缀唯一命中.
      const prefix = resolveTarget(runA.slice(0, 20), sessionsRoot) as ResolvedTarget & { kind: "run" };
      assert.deepEqual(prefix.runIds, [runA]);

      // (c) 随机尾段命中.
      const tail = resolveTarget("aaaaaa", sessionsRoot) as ResolvedTarget & { kind: "run" };
      assert.deepEqual(tail.runIds, [runA]);

      // (d) batchRunId#index → batch-child target + child session 存在.
      const batchRunId = `run-${dateStampOf(new Date())}-303030-cccccc`;
      const child = resolveTarget(`${batchRunId}#1`, sessionsRoot) as ResolvedTarget & { kind: "batch-child" };
      assert.equal(child.kind, "batch-child");
      assert.equal(child.batchRunId, batchRunId);
      assert.equal(child.childIndex, 1);
      assert.ok(child.childSession, "child session path 应解析出");
      assert.ok(child.childSession!.endsWith(`${batchRunId}/run-1/session.jsonl`));

      // (e) today → 全部当日 run (含 batch 根目录).
      const today = resolveTarget("today", sessionsRoot) as ResolvedTarget & { kind: "run" };
      assert.ok(today.runIds.includes(runA), "today 应包含 runA");
      assert.ok(today.runIds.includes(runB), "today 应包含 runB");
      assert.ok(today.runIds.includes(batchRunId), "today 应包含批次根");
    });
  } finally {
    cleanup(home);
  }
});

test("TS-001 target resolution: ambiguous lists candidates, missing throws", async () => {
  const home = makeTempHome();
  try {
    await withHome(home, async () => {
      const sessionsRoot = path.join(home, ".pi", "agent", "slim-subagent", "sessions");
      const day = dateStampOf(new Date());
      makeSession(sessionsRoot, `run-${day}-101010-aaaaaa`);
      makeSession(sessionsRoot, `run-${day}-202020-aaaabb`);
      // 前缀同时命中两个 → 歧义报错列候选.
      assert.throws(
        () => resolveTarget("aaaa", sessionsRoot),
        /Ambiguous/,
      );
      assert.throws(
        () => resolveTarget(`run-${day}`, sessionsRoot),
        /run-.*run-/, // 错误文案列出候选 runId
      );
      // 无命中 → 抛 Run not found.
      assert.throws(() => resolveTarget("zzz", sessionsRoot), /not found|未找到/);
      // batch#index 缺批次 → 抛错.
      assert.throws(() => resolveTarget("doesnotexist#0", sessionsRoot), /not found|未找到/);
    });
  } finally {
    cleanup(home);
  }
});

// ---- TS-002: 启发式分析 — timeout 区分显式/自动, budget 区分显式 cap 与自动 70%. ----

function makeLine(partial: Partial<DiagnoseLogLine>): DiagnoseLogLine {
  return {
    ts: new Date().toISOString(),
    level: "error",
    event: "unknown",
    eventId: `evt-${Math.random().toString(36).slice(2, 10)}`,
    file: "subagent-test.log",
    lineNumber: 1,
    ...partial,
  };
}

test("TS-002 timeout finding distinguishes explicit cap from auto budget; budget finding distinguishes explicit vs auto 70%", async () => {
  const home = makeTempHome();
  try {
    await withHome(home, async () => {
      const sessionsRoot = path.join(home, ".pi", "agent", "slim-subagent", "sessions");
      const runTimeout = "run-t-1";
      const runBudgetExplicit = "run-b-e";
      const runBudgetAuto = "run-b-a";
      makeSession(sessionsRoot, runTimeout);
      makeSession(sessionsRoot, runBudgetExplicit);
      makeSession(sessionsRoot, runBudgetAuto);

      const now = new Date().toISOString();
      const lines: DiagnoseLogLine[] = [
        // cluster A: 显式 timeout (timeout.armed explicit:true) + timeout.fired.
        makeLine({ level: "info", event: "timeout.armed", runId: runTimeout, ts: now, timeoutMsExplicit: 5000, data: { timeoutMs: 5000, explicit: true } }),
        makeLine({ level: "error", event: "timeout.fired", runId: runTimeout, agent: "Alpha", ts: now, data: { timeoutMs: 5000 } }),
        // cluster B: 显式 usageBudget 触顶 (budgetAuto:false).
        makeLine({ level: "error", event: "usage_budget.abort", runId: runBudgetExplicit, agent: "Alpha", ts: now, data: { used: 500, budget: 500, budgetAuto: false } }),
        // cluster C: 自动 70% 预算触顶 (budgetAuto:true).
        makeLine({ level: "error", event: "usage_budget.abort", runId: runBudgetAuto, agent: "Alpha", ts: now, data: { used: 700, budget: 1000, budgetAuto: true } }),
      ];

      const { findings } = analyzeLogs(lines, { sessionsRoot });

      // timeout 类别存在, 且 runTimeout 有会话关联.
      const timeoutFindings = findings.filter((f) => f.category === "timeout");
      assert.ok(timeoutFindings.length >= 1, "应有 timeout finding");
      const tf = timeoutFindings[0]!;
      assert.ok(tf.runIds.includes(runTimeout));
      assert.ok((tf.evidence.sessionFiles?.length ?? 0) > 0, "timeout finding 应按 runId 关联到会话文件");
      assert.ok(tf.evidence.logEventIds.length >= 2, "timeout finding 证据含 armed+fired 两 eventId");
      assert.match(tf.title, /显式|timeout/i);
      assert.equal(typeof tf.suspectedCause, "string");
      assert.equal(typeof tf.recommendedFix, "string");
      assert.equal(typeof tf.confidence, "string");
      assert.equal(typeof tf.needsCodeChange, "boolean");

      // budget: 显式与自动两类 finding, 标题区分.
      const budgetFindings = findings.filter((f) => f.category === "budget");
      assert.ok(budgetFindings.length >= 2, "应有显式+自动两条 budget finding");
      const byRun = new Map(budgetFindings.map((f) => [f.runIds[0]!, f]));
      const explicitF = byRun.get(runBudgetExplicit);
      const autoF = byRun.get(runBudgetAuto);
      assert.ok(explicitF && autoF, "两条 budget finding 各归其 run");
      assert.match(explicitF!.title, /显式/, "显式 cap 标题应含 显式");
      assert.match(autoF!.title, /自动|70%/, "自动 70% 标题应含 自动/70%");
      assert.ok(!explicitF!.title.includes("自动"), "显式 cap 不应误标 自动");
    });
  } finally {
    cleanup(home);
  }
});

// ---- TS-003: 证据默认脱敏 (不含原文 secret). ----

test("TS-003 evidence redacted by default (no raw secret in findings/content)", async () => {
  const home = makeTempHome();
  try {
    await withHome(home, async () => {
      const sessionsRoot = path.join(home, ".pi", "agent", "slim-subagent", "sessions");
      const runId = "run-s-1";
      makeSession(sessionsRoot, runId);
      const secret = "sk-proj-C0NT4IN3R-S3CR3T-v3ry-5ecret";
      const lines: DiagnoseLogLine[] = [
        // 含敏感 data + error.message 含 secret + agent 名含可疑令牌形态.
        makeLine({
          level: "fatal",
          event: "single.spawn.failed",
          runId,
          agent: "sk-fake-secret-agent",
          error: { message: `spawn ENOENT token=${secret}` },
          data: { exitCode: 1, rawPayload: secret, note: `authorization: ${secret}` },
        }),
      ];

      const { findings, evidenceRefs } = analyzeLogs(lines, { sessionsRoot });
      assert.ok(findings.length >= 1);
      // 序列化一切可见输出, 断言不含 secret 原文.
      const blob = JSON.stringify({ findings, evidenceRefs });
      assert.ok(!blob.includes(secret), "findings/evidence 不得含 secret 原文");
      // 敏感令牌形态 (sk-xxxx) 应被遮蔽.
      assert.ok(!blob.includes("sk-proj-"), "sk- 令牌应被 redact");
      const causes = findings.map((f) => f.suspectedCause + f.recommendedFix + (f.evidence.lineHints ?? []).join(",")).join(" ");
      assert.ok(!causes.includes("C0NT4IN3R"), "suspectedCause/recommendedFix/lineHints 不得含 secret 原文");
    });
  } finally {
    cleanup(home);
  }
});