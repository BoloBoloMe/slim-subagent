// ISSUE-01 日志骨架切片测试 (TS-001/002/003 + smoke).
// 接缝: 直接调 log.ts 公开 API (writer/redaction/taskHash/GC); withHome 隔离 logRootDir (= $HOME/.pi/subagent_log);
// 环境变量 PI_SUBAGENT_LOG_LEVEL 涉及处自行保存/恢复 (withHome 不碰该 env).
// 除 smoke (fake pi 跑一次 single) 外全部为纯函数/文件系统级测试, 无 TUI.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  makeTempHome, withHome, withFakePi, captureTool, cleanup,
} from "./helpers.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  logRootDir,
  currentLogFile,
  logEvent,
  levelEnabled,
  taskHashOf,
  taskPreviewOf,
  runLogGc,
} from "../log.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function dateStampOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// 读 logRootDir() 下全部 subagent-*.log 行 (按行 JSON 解析, 坏行跳过).
function readAllLogLines(home: string): Record<string, unknown>[] {
  const dir = path.join(home, ".pi", "subagent_log");
  if (!fs.existsSync(dir)) return [];
  const lines: Record<string, unknown>[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".log")) continue;
    for (const line of fs.readFileSync(path.join(dir, f), "utf-8").trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // 坏行跳过 (容错)
      }
    }
  }
  return lines;
}

// 保存/恢复 PI_SUBAGENT_LOG_LEVEL (该 env 由 withHome 不隔离, 测试须自管).
async function withLogLevelEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PI_SUBAGENT_LOG_LEVEL;
  if (value === undefined) delete process.env.PI_SUBAGENT_LOG_LEVEL;
  else process.env.PI_SUBAGENT_LOG_LEVEL = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PI_SUBAGENT_LOG_LEVEL;
    else process.env.PI_SUBAGENT_LOG_LEVEL = prev;
  }
}

// ---- TS-001: writer API (按日 JSONL + 字段齐 + level 过滤). ----

test("TS-001 log writer appends daily jsonl with required fields", async () => {
  const home = makeTempHome();
  try {
    await withHome(home, async () => {
      logEvent({ level: "info", event: "single.test", runId: "run-1", task: "do the thing" });

      const file = path.join(home, ".pi", "subagent_log", `subagent-${dateStampOf(new Date())}.log`);
      assert.ok(fs.existsSync(file), "当日日志文件应存在");
      const raw = fs.readFileSync(file, "utf-8").trim();
      const entries = raw.split("\n").filter((l) => l.trim() !== "");
      assert.equal(entries.length, 1, "一次写入应恰一行");

      const parsed = JSON.parse(entries[0]!) as Record<string, unknown>;
      assert.ok(typeof parsed.ts === "string" && parsed.ts.length > 0, "ts 应为 ISO 字符串");
      assert.equal(parsed.level, "info");
      assert.equal(parsed.event, "single.test");
      assert.equal(parsed.runId, "run-1");
      assert.equal(parsed.pid, process.pid);
      assert.ok(typeof parsed.eventId === "string" && parsed.eventId.length > 0, "eventId 应为 uuid");
      assert.equal(parsed.taskHash, taskHashOf("do the thing"), "taskHash 应稳定");
      assert.ok(typeof parsed.taskPreview === "string", "taskPreview 应存在 (脱敏预览)");
    });
  } finally {
    cleanup(home);
  }
});

test("TS-001b level filter: debug omitted at default info, error always written", async () => {
  const home = makeTempHome();
  try {
    await withLogLevelEnv(undefined, () =>
      withHome(home, async () => {
        assert.ok(!levelEnabled("debug"), "默认 info 下 debug 应关闭");
        assert.ok(levelEnabled("info"), "默认 info 下 info 应开启");
        logEvent({ level: "debug", event: "single.debug" });
        logEvent({ level: "error", event: "single.error" }); // error/fatal 恒写
        const events = readAllLogLines(home).map((l) => l.event);
        assert.ok(!events.includes("single.debug"), "debug 默认不落盘");
        assert.ok(events.includes("single.error"), "error 恒写");
      }),
    );
  } finally {
    cleanup(home);
  }
});

test("TS-001c level filter: PI_SUBAGENT_LOG_LEVEL=trace enables debug", async () => {
  const home = makeTempHome();
  try {
    await withLogLevelEnv("trace", () =>
      withHome(home, async () => {
        assert.ok(levelEnabled("debug"), "trace 下 debug 应开启");
        logEvent({ level: "debug", event: "single.debug2" });
        const events = readAllLogLines(home).map((l) => l.event);
        assert.ok(events.includes("single.debug2"), "trace 下 debug 应落盘");
      }),
    );
  } finally {
    cleanup(home);
  }
});

// ---- TS-002: 脱敏 + taskHash. ----

test("TS-002 redaction masks task, keeps taskHash", async () => {
  const home = makeTempHome();
  try {
    await withHome(home, async () => {
      const secretTask =
        'fix login: sk-live-abcdefghijklmnop, token=ghp_12345678, secret=supersecret, ' +
        'api_key=ak-9999999999, password=hunter2, Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
      // 函数级断言: 预览不含原文 secret, 含 [REDACTED], hash 稳定.
      const preview = taskPreviewOf(secretTask);
      assert.ok(!preview.includes("sk-live-abcdefghijklmnop"), "sk- 前缀 secret 应被遮蔽");
      assert.ok(!preview.includes("ghp_12345678"), "token= 值应被遮蔽");
      assert.ok(!preview.includes("supersecret"), "secret= 值应被遮蔽");
      assert.ok(!preview.includes("ak-9999999999"), "api_key= 值应被遮蔽");
      assert.ok(!preview.includes("hunter2"), "password= 值应被遮蔽");
      assert.ok(!preview.includes("eyJhbGciOiJIUzI1NiJ9"), "Bearer token 应被遮蔽");
      assert.ok(preview.includes("[REDACTED]"), "遮蔽后应替换为 [REDACTED]");
      assert.ok(preview.length <= 120, "preview 应 ≤120 字符");

      const h1 = taskHashOf(secretTask);
      const h2 = taskHashOf(secretTask);
      assert.equal(h1, h2, "taskHash 应稳定 (同一原文两次同值)");
      assert.match(h1, /^[0-9a-f]{12}$/, "taskHash 应为 sha256 前 12 位 hex");

      // 日志行断言: 不落原文, 带 taskHash + 脱敏后 preview.
      logEvent({ level: "info", event: "single.test", task: secretTask });
      const file = currentLogFile();
      const raw = fs.readFileSync(file, "utf-8");
      assert.ok(!raw.includes("sk-live-abcdefghijklmnop"), "日志行不得含原文 secret");
      assert.ok(!raw.includes("supersecret"), "日志行不得含原文 secret 值");
      const last = raw.trim().split("\n").pop()!;
      const parsed = JSON.parse(last) as Record<string, unknown>;
      assert.equal(parsed.taskHash, h1, "日志行 taskHash 应与函数一致");
      assert.equal(parsed.taskPreview, preview, "日志行 taskPreview 应与函数一致");
    });
  } finally {
    cleanup(home);
  }
});

test("TS-002b single-line preview: newlines folded to spaces, truncation at 120", async () => {
  const home = makeTempHome();
  try {
    await withHome(home, async () => {
      const multi = `line one\n\nline two\nline three - ${"x".repeat(300)}`;
      const preview = taskPreviewOf(multi);
      assert.ok(!preview.includes("\n"), "换行应折叠为空格");
      assert.ok(preview.length <= 120, "preview 应截断到 120 字符");
      const long = taskPreviewOf("y".repeat(500));
      assert.ok(long.length === 120, "超长 task 应恰好截到 120");
    });
  } finally {
    cleanup(home);
  }
});

// ---- TS-003: 7 日 GC (按文件名日期算龄 + mtime 的 diagnose md + protectedFiles 跳过记 L42). ----

test("TS-003 gc removes >7d log files, keeps recent and protected, records L41/L42", async () => {
  const home = makeTempHome();
  try {
    await withHome(home, async () => {
      const root = logRootDir();
      fs.mkdirSync(root, { recursive: true });

      const dOld = new Date(Date.now() - 8 * DAY_MS);
      const dProtected = new Date(Date.now() - 9 * DAY_MS);
      const dRecent = new Date();
      const oldFile = path.join(root, `subagent-${dateStampOf(dOld)}.log`);
      const recentFile = path.join(root, `subagent-${dateStampOf(dRecent)}.log`);
      const protectedOld = path.join(root, `subagent-${dateStampOf(dProtected)}.log`);
      fs.writeFileSync(oldFile, '{"x":1}\n');
      fs.writeFileSync(recentFile, '{"x":2}\n');
      fs.writeFileSync(protectedOld, '{"x":3}\n');

      // diagnose/*.md 按 mtime 算龄.
      const diagDir = path.join(root, "diagnose");
      fs.mkdirSync(diagDir, { recursive: true });
      const oldMd = path.join(diagDir, "old.md");
      fs.writeFileSync(oldMd, "report");
      const oldMtime = new Date(Date.now() - 9 * DAY_MS);
      fs.utimesSync(oldMd, oldMtime, oldMtime); // 9 天前 → 删
      const newMd = path.join(diagDir, "new.md");
      fs.writeFileSync(newMd, "report");
      fs.utimesSync(newMd, new Date(), new Date()); // 今日 → 留

      // 基线记录 L41/L42 前的行数 (runLogGc 自身记日志, 断言用相对增量).
      const before = readAllLogLines(home);

      runLogGc(new Set([protectedOld]));

      assert.ok(!fs.existsSync(oldFile), "8 天前日志应被删");
      assert.ok(!fs.existsSync(oldMd), "9 天前 diagnose md 应被删");
      assert.ok(fs.existsSync(recentFile), "今日日志应保留");
      assert.ok(fs.existsSync(protectedOld), "protectedFiles 内文件应跳过不删");
      assert.ok(fs.existsSync(newMd), "今日 diagnose md 应保留");

      const after = readAllLogLines(home);
      const del = after.filter((l) => l.event === "gc.delete.ok" && !before.includes(l));
      const skip = after.filter((l) => l.event === "gc.skip.active_lease" && !before.includes(l));
      assert.ok(del.length >= 2, "删了两个对象应至少记 2 条 L41");
      assert.ok(skip.length >= 1, "protectedFiles 跳过应记 L42");
      const skipPath = skip.map((l) => (l.data as { path?: string })?.path);
      assert.ok(skipPath.includes(protectedOld), "L42 应带被跳过文件路径");
    });
  } finally {
    cleanup(home);
  }
});

// ---- Smoke: fake pi 跑一次 single, 当日日志含 L01/L05/L09/L25/L27 (L08 debug 默认不出现). ----

test("TS-SMOKE single run produces L01/L05/L09/L25/L27 log events", async () => {
  const home = makeTempHome();
  try {
    await withFakePi(home, "assistant-stop", {}, async () => {
      // 用内置 worker agent (扩展目录 agents/) + 临时 HOME 隔离 logRootDir.
      const tool = captureTool();
      const ctx = { cwd: home } as ExtensionContext;
      const result = await tool.execute("call-1", { agent: "worker", task: "hello world" }, undefined, undefined, ctx);
      assert.ok(result, "execute 应返回 (内容是否成功非本测试关注点)");
      const events = readAllLogLines(home).map((l) => l.event);
      assert.ok(events.includes("tool.execute.start"), "应含 L01");
      assert.ok(events.includes("run.id.created"), "应含 L05");
      assert.ok(events.includes("single.spawn.start"), "应含 L09");
      assert.ok(events.includes("process.close.settled"), "应含 L25");
      assert.ok(events.includes("single.result.final"), "应含 L27");
      assert.ok(!events.includes("pi.invocation.resolved"), "L08 debug 默认不应落盘");
    });
  } finally {
    cleanup(home);
  }
});