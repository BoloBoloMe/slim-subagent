#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
M03: subagent-panel-proto 骨架验证 (pty 驱动真实 pi TUI, 复用 M01 方法)

Phase A: /subagent-proto single 命令回放 - 7 步, 时序对照 single.ts:811-904
Phase B: /subagent-proto parallel 命令回放 - 5 步, 时序对照 index.ts:265-285
Phase C: 真实 agent 调用 subagent_proto 工具 - onUpdate 走真实管线 + renderResult 帧
Phase D: /reload 热载 - replay.ts MARKER proto-v1→v2, 测耗时 + 验证新代码生效

断言与时间线全部落盘 /tmp/subagent-panel-proto/{replay,test}.log
"""
import os, pty, select, time, fcntl, termios, struct, re, json, signal, sys

COLS, ROWS = 110, 36
EXP = "/tmp/subagent-panel-proto"
os.makedirs(EXP, exist_ok=True)
REPLAY_LOG = os.path.join(EXP, "replay.log")
TEST_LOG = os.path.join(EXP, "test.log")
REPLAY_TS = "/home/bolo/.pi/agent/extensions/subagent-panel-proto/replay.ts"

CMD = ["pi", "--no-session", "--provider", "deepseek", "--model", "deepseek/deepseek-v4-flash",
       "--thinking", "off", "-ns", "-np", "-nc"]

ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]|\x1b\?[0-9;]*[hl]")
def clean(s): return ANSI.sub("", s).replace("\r", "")
END_SYNC = b"\x1b[?2026l"

RESULTS = []
def check(desc, cond, ev=""):
    RESULTS.append((desc, bool(cond)))
    print(f"  [{'PASS' if cond else 'FAIL'}] {desc}" + (f"  ({ev})" if ev else ""), flush=True)

def tlog(obj):
    with open(TEST_LOG, "a") as f:
        f.write(json.dumps(obj) + "\n")

def read_replay_log():
    if not os.path.exists(REPLAY_LOG):
        return []
    out = []
    with open(REPLAY_LOG) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                out.append({"_raw": line})
    return out

def wait_log(session, pred, timeout, what):
    end = time.time() + timeout
    while time.time() < end:
        lines = read_replay_log()
        if pred(lines):
            return lines
        if session is not None:
            session.drain(0.3)  # 防 pty 缓冲满阻塞 pi 事件循环 (M01 已知点)
        time.sleep(0.05)
    return read_replay_log()

class Session:
    def __init__(self):
        for p in (REPLAY_LOG, TEST_LOG):
            if os.path.exists(p):
                os.remove(p)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(EXP)
            os.environ["TERM"] = "xterm-256color"
            os.environ["COLORTERM"] = "truecolor"
            os.execvp(CMD[0], CMD)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        self.buf = b""

    def drain(self, t=0.15):
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    c = os.read(self.fd, 65536)
                    if not c:
                        return
                    self.buf += c
                    if len(self.buf) > 3_000_000:
                        self.buf = self.buf[-2_500_000:]
                except OSError:
                    return

    def send(self, s, wait=0.3):
        os.write(self.fd, s.encode() if isinstance(s, str) else s)
        time.sleep(wait)
        self.drain(0.3)

    def wait_ready(self):
        end = time.time() + 90
        while time.time() < end:
            self.drain(0.5)
            if END_SYNC in self.buf and len(self.buf) > 5000:
                time.sleep(2.0)
                self.drain(1.0)
                return True
        return False

    def screen(self):
        return clean(self.buf.decode("utf-8", "replace"))

    def kill(self):
        try:
            os.kill(self.pid, signal.SIGTERM)
        except Exception:
            pass
        time.sleep(1)
        try:
            os.kill(self.pid, signal.SIGKILL)
        except Exception:
            pass

# ---------------------------------------------------------------------------
SINGLE_SCHEDULE = [0, 700, 1400, 1900, 2500, 3100, 3800]
SINGLE_KINDS = ["initial", "message_end", "tool_start", "tool_end", "tool_result_end", "message_end", "close"]
PARALLEL_SCHEDULE = [0, 1500, 2300, 3200, 4000]
PARALLEL_KINDS = ["initial", "message_end", "message_end", "message_end", "close"]

def steps_of(lines, source, mode):
    return [l for l in lines if l.get("event") == "replay.step" and l.get("source") == source and l.get("mode") == mode]

def check_pacing(steps, schedule, label, tol_ms=450):
    ts = [s["ts"] for s in steps]
    at = [s["atMs"] for s in steps]
    kinds = [s["kind"] for s in steps]
    ok_at = at == schedule
    check(f"{label}: atMs 时序 == {schedule}", ok_at, f"actual={at}")
    ok_kind = kinds == (SINGLE_KINDS if label.endswith("single") else PARALLEL_KINDS)
    check(f"{label}: step kind 序列", ok_kind, f"actual={kinds}")
    if len(ts) >= 2:
        deltas = [ts[i + 1] - ts[i] for i in range(len(ts) - 1)]
        expect = [schedule[i + 1] - schedule[i] for i in range(len(schedule) - 1)]
        bad = [(i, d, e) for i, (d, e) in enumerate(zip(deltas, expect)) if abs(d - e) > tol_ms]
        check(f"{label}: 实际步间隔≈计划 (tol {tol_ms}ms)", not bad, f"deltas={deltas} expect={expect}")
        total = ts[-1] - ts[0]
        check(f"{label}: 总时长≈{schedule[-1]}ms", abs(total - schedule[-1]) <= tol_ms * 1.5, f"total={total}")

# ---------------------------------------------------------------------------
def main():
    print("== Phase 0: 启动 pi (全局扩展发现) ==", flush=True)
    s = Session()
    if not s.wait_ready():
        print("  [FAIL] pi 未就绪", flush=True)
        s.kill()
        sys.exit(1)
    print("  pi ready", flush=True)
    time.sleep(1.0)
    s.drain(0.5)

    lines = read_replay_log()
    loaded = [l for l in lines if l.get("event") == "ext.loaded"]
    check("启动: ext.loaded 出现 (marker proto-v1)", any(l.get("marker") == "proto-v1" for l in loaded),
          f"count={len(loaded)} markers={[l.get('marker') for l in loaded]}")

    # ---- Phase A: command single ----
    print("== Phase A: /subagent-proto single ==", flush=True)
    tlog({"event": "phase.A.start", "ts": time.time()})
    s.send("/subagent-proto single\r")
    end = time.time() + 8
    while time.time() < end:
        lines = read_replay_log()
        if len(steps_of(lines, "command", "single")) >= 7:
            break
        time.sleep(0.2)
    s.drain(1.0)
    lines = read_replay_log()
    steps = steps_of(lines, "command", "single")
    check("A: single 命令回放 7 步", len(steps) == 7, f"count={len(steps)}")
    if len(steps) == 7:
        check_pacing(steps, SINGLE_SCHEDULE, "A: single")
        last = steps[-1]
        check("A: 末步 close", last["kind"] == "close", f"kind={last['kind']}")
    scr = s.screen()
    check("A: TUI notify 可见", "replay done" in scr, "")

    # ---- Phase B: command parallel ----
    print("== Phase B: /subagent-proto parallel ==", flush=True)
    tlog({"event": "phase.B.start", "ts": time.time()})
    s.send("/subagent-proto parallel\r")
    end = time.time() + 8
    while time.time() < end:
        lines = read_replay_log()
        if len(steps_of(lines, "command", "parallel")) >= 5:
            break
        time.sleep(0.2)
    s.drain(1.0)
    lines = read_replay_log()
    steps = steps_of(lines, "command", "parallel")
    check("B: parallel 命令回放 5 步", len(steps) == 5, f"count={len(steps)}")
    if len(steps) == 5:
        check_pacing(steps, PARALLEL_SCHEDULE, "B: parallel")
        check("B: 末步 close", steps[-1]["kind"] == "close", f"kind={steps[-1]['kind']}")
    scr = s.screen()
    check("B: TUI notify 可见", "replay done" in scr, "")

    # ---- Phase C: real agent tool call ----
    print("== Phase C: 真实 agent 调用 subagent_proto (onUpdate 走真实管线) ==", flush=True)
    tlog({"event": "phase.C.start", "ts": time.time()})
    s.send("请调用 subagent_proto 工具, 参数 mode=single, 调用完就结束, 不要调用其他工具.\r")
    lines = wait_log(s, lambda ls: len(steps_of(ls, "tool", "single")) >= 7, 150, "tool-single-steps")
    steps = steps_of(lines, "tool", "single")
    check("C: 工具回放 7 步 (onUpdate 到达)", len(steps) == 7, f"count={len(steps)}")
    if len(steps) == 7:
        check_pacing(steps, SINGLE_SCHEDULE, "C: tool-single", tol_ms=600)
    s.drain(2.0)
    scr = s.screen()
    check("C: renderResult 卡帧可见 [proto] mode=single", "[proto] mode=single" in scr, "")
    tlog({"event": "phase.C.end", "ts": time.time()})

    # ---- Phase D: hot reload ----
    print("== Phase D: /reload 热载 (marker v1→v2) ==", flush=True)
    tlog({"event": "phase.D.start", "ts": time.time()})
    with open(REPLAY_TS) as f:
        src = f.read()
    assert 'MARKER = "proto-v1"' in src, "unexpected marker line"
    with open(REPLAY_TS, "w") as f:
        f.write(src.replace('MARKER = "proto-v1"', 'MARKER = "proto-v2"'))
    before = len([l for l in read_replay_log() if l.get("event") == "ext.loaded"])
    t0 = time.time()
    s.send("/reload\r")
    t1 = None
    end = time.time() + 30
    while time.time() < end:
        s.drain(0.3)
        lines = read_replay_log()
        loaded = [l for l in lines if l.get("event") == "ext.loaded" and l.get("marker") == "proto-v2"]
        if loaded:
            t1 = time.time()
            break
        time.sleep(0.05)
    if t1 is None:
        check("D: /reload 后 ext.loaded(proto-v2) 出现", False, "30s 超时")
        s.kill()
        finish()
        return
    latency = (t1 - t0) * 1000
    tlog({"event": "phase.D.loaded", "latencyMs": latency, "t0": t0, "t1": t1})
    check("D: /reload 生效 (marker v2)", True, f"latency={latency:.0f}ms")
    check("D: 秒级热载 (<5s)", latency < 5000, f"latency={latency:.0f}ms")
    s.drain(1.0)

    # reload 后命令仍可用 + 新 marker (按 marker 过滤, 避免与 Phase A 旧步混计)
    s.send("/subagent-proto single\r")
    end = time.time() + 10
    while time.time() < end:
        s.drain(0.3)
        lines = read_replay_log()
        if len(steps_of(lines, "command", "single")) >= 14 and \
           len([l for l in steps_of(lines, "command", "single") if l.get("marker") == "proto-v2"]) >= 7:
            break
        time.sleep(0.05)
    s.drain(1.0)
    lines = read_replay_log()
    steps = [l for l in steps_of(lines, "command", "single") if l.get("marker") == "proto-v2"]
    newmarker = [l for l in steps if l.get("marker") == "proto-v2"]
    check("D: reload 后命令仍可用 (7 步, v2)", len(steps) == 7, f"count={len(steps)}")
    check("D: reload 后步骤带 proto-v2 marker", len(newmarker) == 7, f"v2={len(newmarker)}")
    s.kill()

    finish()

def finish():
    passed = sum(1 for _, ok in RESULTS if ok)
    total = len(RESULTS)
    print(f"\n==== 断言汇总: {passed}/{total} PASS ====", flush=True)
    tlog({"event": "summary", "passed": passed, "total": total})
    sys.exit(0 if passed == total else 1)

if __name__ == "__main__":
    main()
