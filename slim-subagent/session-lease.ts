// slim-subagent 并发 resume 锁 — ISSUE-06 TS-002 切片 (M3-03 考察点 3 移植规格 1-4 最小锁).
// 粒度: session 文件 canonical (realpath) → sha256; 锁目录 <tmp>/slim-subagent-leases/<hash>/owner.json (调和 15).
// 原子 rename 抢占; 活冲突报错 (含 "already running", M2-D005 不排队); owner pid 死 → 墓碑回收重试 ≤2;
// 生命周期: spawn 前 acquire / 子进程 exit 后 finally release / process.once("exit") 兜底 (resume.ts 承担).
// 不移植: writerState 三态/runner 握手/process-terminal 证明链 (D003 async 删).

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LeaseOwner {
  token: string;
  runId: string;
  pid: number;
  hostname: string;
  acquiredAtMs: number;
}

// 锁根目录 (M3-03 规格 1: os.tmpdir()/slim-subagent-leases, 调和 15);
// 惰性读取 + env 覆盖缝 (测试用临时目录隔离, 同 SLIM_SUBAGENT_PENDING_LINE_BYTES 注入模式).
function leaseRoot(): string {
  const fromEnv = process.env.SLIM_SUBAGENT_LEASE_DIR?.trim();
  return fromEnv || path.join(os.tmpdir(), "slim-subagent-leases");
}

export function leaseDirFor(sessionFile: string): string {
  const canonical = fs.realpathSync.native(path.resolve(sessionFile));
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(leaseRoot(), hash);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"; // ESRCH → 死; 其他 (EPERM) → 活
  }
}

function readOwner(leaseDir: string): LeaseOwner | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(leaseDir, "owner.json"), "utf-8")) as Partial<LeaseOwner>;
    if (typeof raw.token !== "string" || typeof raw.runId !== "string" || typeof raw.pid !== "number" || typeof raw.hostname !== "string") {
      return undefined;
    }
    return { token: raw.token, runId: raw.runId, pid: raw.pid, hostname: raw.hostname, acquiredAtMs: raw.acquiredAtMs ?? 0 };
  } catch {
    return undefined;
  }
}

// 原子 rename 抢占; 冲突时 owner pid 死 → 墓碑回收重试 (≤3 次总尝试 = 1 次抢占 + ≤2 次 stale 重试); 活 → 报错.
export function acquireSessionLease(sessionFile: string, runId: string): LeaseOwner {
  const leaseDir = leaseDirFor(sessionFile);
  const owner: LeaseOwner = {
    token: crypto.randomUUID(),
    runId,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAtMs: Date.now(),
  };
  fs.mkdirSync(path.dirname(leaseDir), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = `${leaseDir}.candidate-${owner.token}`;
    fs.rmSync(candidate, { recursive: true, force: true });
    fs.mkdirSync(candidate, { mode: 0o700 });
    fs.writeFileSync(path.join(candidate, "owner.json"), JSON.stringify(owner, null, 2), { encoding: "utf-8", mode: 0o600 });
    try {
      fs.renameSync(candidate, leaseDir); // 原子抢占
      return owner;
    } catch {
      fs.rmSync(candidate, { recursive: true, force: true });
      const existing = readOwner(leaseDir);
      if (existing && !processIsAlive(existing.pid)) {
        // stale 回收: rename 墓碑, 防后续竞争者误移后继新锁 (旧码同款手法).
        const tombstone = `${leaseDir}.stale-${existing.token.replace(/[^A-Za-z0-9._-]/g, "-")}`;
        try {
          fs.renameSync(leaseDir, tombstone);
          continue; // 重试抢占
        } catch {
          // ENOENT (他人已回收)/其他: 落入下一轮或报冲突
        }
      }
      throw new Error(
        `Resume blocked: session for run '${runId}' is already running ` +
          `(acquired by run '${existing?.runId ?? "unknown"}', pid ${existing?.pid ?? "?"} on ${existing?.hostname ?? "?"}). ` +
          `Wait for it to finish before resuming again.`,
      );
    }
  }
  throw new Error(`Resume blocked: session for run '${runId}' is already running (could not acquire lease after stale retries).`);
}

// token 校验防误删 (旧码 release 同款): 只有本人锁可删.
export function releaseSessionLease(sessionFile: string, owner: LeaseOwner): void {
  const leaseDir = leaseDirFor(sessionFile);
  try {
    const current = readOwner(leaseDir);
    if (current && current.token === owner.token) {
      fs.rmSync(leaseDir, { recursive: true, force: true });
    }
  } catch {
    // 释放失败不致命 (下次抢占回收)
  }
}

// GC 锁豁免判定 (TS-003): owner pid 活 → 有活跃锁.
// 修复: session 文件缺失时 leaseDirFor 的 realpath 抛 ENOENT — 文件不存在即锁从未可能被 acquire
// (acquire 前置条件是文件存在), 应视为无活跃锁; 否则 runSessionGc 的外层 catch 会吞掉异常导致
// 超龄孤儿目录 (有 run.json 无 session 文件) 永不删除.
export function isLeaseActive(sessionFile: string): boolean {
  let leaseDir: string;
  try {
    leaseDir = leaseDirFor(sessionFile);
  } catch {
    return false;
  }
  const owner = readOwner(leaseDir);
  return owner ? processIsAlive(owner.pid) : false;
}
