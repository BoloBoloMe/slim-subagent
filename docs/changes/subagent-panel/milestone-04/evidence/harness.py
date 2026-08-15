#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
M04: subagent-panel-proto Inline Run Card 验证 (pty 驱动真实 pi TUI, 沿用 M03 方法)

Phase A: /subagent-proto single 命令回放 - 7 步时序 (M03 断言)
Phase B: /subagent-proto parallel 命令回放 - 5 步时序 (M03 断言)
Phase C: /subagent-proto storm - 40 步 @~50ms, 间隔 tol 放宽
Phase D: /subagent-proto parallel-pending - 6 child 并发槽 4, pending→active 转换在快照可见
Phase E: variant a + 真实 agent 调 subagent_proto(single) - renderResult 活动/终态卡帧
Phase F: variant a/b (render 命令确定性帧) - A 全字段 + B 单行 (110 列)
Phase F2: COLS=80 截断帧 - B §4.0 省略
Phase G: variant c (render 命令) - parallel-pending 活动 pending 行 + final 分段结构
Phase H: /reload 热载 (marker v1→v2) + 新代码命令可用
"""
import os, pty, select, time, fcntl, termios, struct, re, json, signal, sys

COLS, ROWS = 110, 36
EXP = "/tmp/subagent-panel-proto"
EVID = os.path.dirname(os.path.abspath(__file__))
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
            session.drain(0.3)  # 防 pty 缓冲满阻塞 pi 事件循环 (M01/M03 已知点)
        time.sleep(0.05)
    return read_replay_log()

CARD_TOKENS = ("subagent_proto", "⠿", "◐", "✓", "✗", "◌", "task ", "→ ", "last:", "[Open", "pending 等待并发槽", "[proto render]")

def card_lines(scr):
    """从清理后的屏幕全量文本中提取卡片行 (去重连续重复的流式帧)."""
    lines = [ln.rstrip() for ln in scr.split("\n")]
    out = []
    for ln in lines:
        if any(t in ln for t in CARD_TOKENS):
            out.append(ln)
    dedup = []
    for ln in out:
        if dedup and dedup[-1] == ln:
            continue
        dedup.append(ln)
    return dedup

def extract_render_card(scr, tag):
    """提取最后一个含 tag 的 render 卡块 (tag 行 + 其后卡片行, 到下一个 [proto render] 前)."""
    idx = scr.rfind(tag)
    if idx < 0:
        return None
    block = scr[idx:]
    nxt = block.find("[proto render]", len(tag))
    if nxt >= 0:
        block = block[:nxt]
    return card_lines(block)

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
        self.resize(COLS, ROWS)
        self.buf = b""

    def resize(self, cols, rows):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

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

    def wait_needle(self, needle, timeout=20):
        """轮询全量 buffer 直到 needle 出现 (持续 drain)."""
        end = time.time() + timeout
        while time.time() < end:
            if needle in self.screen():
                return True
            self.drain(0.3)
            time.sleep(0.05)
        return False

    def save_card_frame(self, name, needle, after_render_tag=None, settle=0.8):
        """提取含 needle 的卡片块并保存. after_render_tag 指定时取该 tag 之后的最后一块."""
        time.sleep(settle)
        self.drain(1.0)
        scr = self.screen()
        if after_render_tag:
            block = extract_render_card(scr, after_render_tag)
            if block is None:
                return None
            with open(os.path.join(EVID, name), "w") as f:
                f.write("\n".join(block) + "\n")
            return block
        idx = scr.rfind(needle)
        if idx < 0:
            return None
        block = scr[idx:idx + 8000]
        lines = card_lines(block)
        with open(os.path.join(EVID, name), "w") as f:
            f.write("\n".join(lines) + "\n")
        return lines

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
STORM_COUNT = 40
PENDING_SCHEDULE = [0, 1500, 2300, 3200, 4000, 4700, 5400]
PENDING_KINDS = ["initial", "child_done", "child_failed", "child_done", "child_done", "child_done", "close"]

def steps_of(lines, source, mode, scenario=None):
    out = [l for l in lines if l.get("event") == "replay.step" and l.get("source") == source and l.get("mode") == mode]
    if scenario is not None:
        out = [l for l in out if l.get("scenario") == scenario]
    return sorted(out, key=lambda l: l.get("stepIndex", 0))

def check_pacing(steps, schedule, kinds, label, tol_ms=450):
    at = [s["atMs"] for s in steps]
    ts = [s["ts"] for s in steps]
    got_kinds = [s["kind"] for s in steps]
    check(f"{label}: atMs 时序 == {schedule}", at == schedule, f"actual={at}")
    check(f"{label}: step kind 序列", got_kinds == kinds, f"actual={got_kinds}")
    if len(ts) >= 2:
        deltas = [ts[i + 1] - ts[i] for i in range(len(ts) - 1)]
        expect = [schedule[i + 1] - schedule[i] for i in range(len(schedule) - 1)]
        bad = [(i, d, e) for i, (d, e) in enumerate(zip(deltas, expect)) if abs(d - e) > tol_ms]
        check(f"{label}: 实际步间隔≈计划 (tol {tol_ms}ms)", not bad, f"deltas={deltas} expect={expect}")
        total = ts[-1] - ts[0]
        check(f"{label}: 总时长≈{schedule[-1]}ms", abs(total - schedule[-1]) <= tol_ms * 1.5, f"total={total}")

def agent_run(s, prompt, mode, base_n, timeout_per_attempt=60, max_attempts=5, catchup=30):
    """发送提示词, 等待该 mode 新增 tool 步骤 (>base_n). 返回 (lines, started)."""
    pred = lambda ls: len(steps_of(ls, "tool", mode)) > base_n
    for attempt in range(1, max_attempts + 1):
        tlog({"event": "agent.call", "attempt": attempt, "mode": mode, "prompt": prompt[:60]})
        s.send(prompt)
        lines = wait_log(s, pred, timeout_per_attempt, f"tool-{mode}-new")
        if pred(lines):
            return lines, True
        s.drain(3.0)
    # catch-up: 提示词可能被排队, 最后再等一轮
    lines = wait_log(s, pred, catchup, f"tool-{mode}-catchup")
    return lines, pred(lines)

def wait_new_steps(s, mode, base_n, n, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        lines = read_replay_log()
        if len(steps_of(lines, "tool", mode)) >= base_n + n:
            return lines
        s.drain(0.3)
        time.sleep(0.05)
    return read_replay_log()

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
        if len(steps_of(lines, "command", "single", "success")) >= 7:
            break
        time.sleep(0.2)
    s.drain(1.0)
    lines = read_replay_log()
    steps = steps_of(lines, "command", "single", "success")
    check("A: single 命令回放 7 步", len(steps) == 7, f"count={len(steps)}")
    if len(steps) == 7:
        check_pacing(steps, SINGLE_SCHEDULE, SINGLE_KINDS, "A: single")
    scr = s.screen()
    check("A: TUI notify 可见", "replay done" in scr, "")

    # ---- Phase B: command parallel ----
    print("== Phase B: /subagent-proto parallel ==", flush=True)
    tlog({"event": "phase.B.start", "ts": time.time()})
    s.send("/subagent-proto parallel\r")
    end = time.time() + 8
    while time.time() < end:
        lines = read_replay_log()
        if len(steps_of(lines, "command", "parallel", "success")) >= 5:
            break
        time.sleep(0.2)
    s.drain(1.0)
    lines = read_replay_log()
    steps = steps_of(lines, "command", "parallel", "success")
    check("B: parallel 命令回放 5 步", len(steps) == 5, f"count={len(steps)}")
    if len(steps) == 5:
        check_pacing(steps, PARALLEL_SCHEDULE, PARALLEL_KINDS, "B: parallel")
    scr = s.screen()
    check("B: TUI notify 可见", "replay done" in scr, "")

    # ---- Phase C: command storm ----
    print("== Phase C: /subagent-proto storm (40 步 @~50ms) ==", flush=True)
    tlog({"event": "phase.C.start", "ts": time.time()})
    s.send("/subagent-proto storm\r")
    end = time.time() + 8
    while time.time() < end:
        lines = read_replay_log()
        if len(steps_of(lines, "command", "single", "storm")) >= STORM_COUNT:
            break
        time.sleep(0.2)
    s.drain(1.0)
    lines = read_replay_log()
    steps = steps_of(lines, "command", "single", "storm")
    check("C: storm 命令回放 40 步", len(steps) == STORM_COUNT, f"count={len(steps)}")
    if len(steps) == STORM_COUNT:
        at = [x["atMs"] for x in steps]
        check("C: storm atMs 步进 50ms", at == [i * 50 for i in range(STORM_COUNT)], f"first={at[:3]} last={at[-1]}")
        ts = [x["ts"] for x in steps]
        deltas = [ts[i + 1] - ts[i] for i in range(len(ts) - 1)]
        bad = [d for d in deltas if not (0 < d <= 140)]
        check("C: storm 实际间隔 ~50ms (tol 放宽)", not bad,
              f"min={min(deltas)} max={max(deltas)} mean={sum(deltas)/len(deltas):.0f}")
        kinds = [x["kind"] for x in steps]
        check("C: storm kind 序列 (initial + update×39)", kinds[0] == "initial" and all(k == "update" for k in kinds[1:]),
              f"{kinds[0]}...{kinds[-1]}")

    # ---- Phase D: command parallel-pending ----
    print("== Phase D: /subagent-proto parallel-pending (pending→active) ==", flush=True)
    tlog({"event": "phase.D.start", "ts": time.time()})
    s.send("/subagent-proto parallel-pending\r")
    end = time.time() + 9
    while time.time() < end:
        lines = read_replay_log()
        if len(steps_of(lines, "command", "parallel", "parallel-pending")) >= 7:
            break
        time.sleep(0.2)
    s.drain(1.0)
    lines = read_replay_log()
    steps = steps_of(lines, "command", "parallel", "parallel-pending")
    check("D: parallel-pending 命令回放 7 步", len(steps) == 7, f"count={len(steps)}")
    if len(steps) == 7:
        check_pacing(steps, PENDING_SCHEDULE, PENDING_KINDS, "D: parallel-pending", tol_ms=500)
        statuses = [st.get("statuses") for st in steps]
        if all(isinstance(x, list) and len(x) >= 7 for x in statuses):
            # nodes = [root, c0..c5]; c4 在 index 5, c5 在 index 6
            check("D: 初始 2 个 child pending (c4,c5)", statuses[0][5] == "pending" and statuses[0][6] == "pending", f"step0={statuses[0]}")
            check("D: c4 pending→active (step1)", statuses[1][5] == "active" and statuses[1][6] == "pending", f"step1={statuses[1]}")
            check("D: c5 pending→active (step2)", statuses[2][5] == "active" and statuses[2][6] == "active", f"step2={statuses[2]}")
            check("D: 末步 root done + 全部 child 终态", statuses[6][0] == "done" and statuses[6][5] == "done" and statuses[6][6] == "done", f"step6={statuses[6]}")
            transitions = 0
            for ci in (5, 6):
                for i in range(1, 7):
                    if statuses[i - 1][ci] == "pending" and statuses[i][ci] == "active":
                        transitions += 1
            check("D: pending→active 转换共 2 次", transitions == 2, f"transitions={transitions}")
        else:
            check("D: statuses 快照字段完整", False, "statuses 缺失")

    # ---- Phase E: variant a + real agent single (含 1 次外层重试) ----
    print("== Phase E: variant a, 真实 agent 调 subagent_proto(single) ==", flush=True)
    tlog({"event": "phase.E.start", "ts": time.time()})
    s.send("/subagent-proto variant a\r")
    time.sleep(1.0)
    s.drain(0.5)
    prompt_single = "请立即调用 subagent_proto 工具, 参数 mode=single, 调用完就结束, 不要回复文字, 不要调用其他工具."
    e_ok = False
    for e_try in (1, 2):
        base_tool_single = len(steps_of(read_replay_log(), "tool", "single"))
        lines, started = agent_run(s, prompt_single, "single", base_tool_single,
                                   timeout_per_attempt=50, max_attempts=3, catchup=20)
        n_new = len(steps_of(read_replay_log(), "tool", "single")) - base_tool_single
        if started:
            e_ok = True
            break
        tlog({"event": "phase.E.retry", "try": e_try, "new": n_new})
        s.drain(2.0)
    check("E: agent 调用 single (tool 新步骤出现)", e_ok, f"new={n_new}")
    if e_ok:
        wait_new_steps(s, "single", base_tool_single, 4, 20)
        time.sleep(0.4)
        s.drain(1.0)
        scr = s.screen()
        cl = card_lines(scr)
        active_found = any(re.search(r"⠿ [a-z]+ · active 00:0\d", ln) for ln in cl)
        check("E: 活动卡帧可见 (⠿ · active 00:0x)", active_found, "")
        with open(os.path.join(EVID, "frame-variant-a-active.txt"), "w") as f:
            f.write("\n".join(cl[-12:]) + "\n")
        wait_new_steps(s, "single", base_tool_single, 7, 25)
        time.sleep(1.0)
        s.drain(1.0)
        cl = card_lines(s.screen())
        idx = None
        for i in range(len(cl) - 1, -1, -1):
            if re.search(r"[✓✗] [a-z]+ · (done|failed|timeout)", cl[i]):
                idx = i
                break
        block = cl[max(0, idx - 3):idx + 9] if idx is not None else None
        check("E: final 卡帧可见 (终态 status 行)", block is not None, "")
        check("E: A 卡含 task 行与操作提示", block is not None and any("task " in ln for ln in block) and any("[Open session]" in ln for ln in block), "")
        with open(os.path.join(EVID, "frame-variant-a.txt"), "w") as f:
            if block is not None:
                f.write("\n".join(block) + "\n")
            else:
                f.write("(no card found)\n")
    else:
        # 诊断: 保存 agent 回应尾部, 记录为已知限制 (帧由 F-A render 命令兜底)
        s.drain(2.0)
        scr = s.screen()
        tail_scr = "\n".join([ln.rstrip() for ln in scr.split("\n")][-30:])
        with open(os.path.join(EVID, "phase-E-agent-tail.txt"), "w") as f:
            f.write(tail_scr)
        for d in ("frame-variant-a-active.txt", "frame-variant-a.txt"):
            check(f"E: {d}", False, "agent 未调用工具 (已知限制, 帧由 render 命令兜底)")

    # ---- Phase F: variant a/b 参考帧 (render 命令) ----
    print("== Phase F: variant a/b 参考帧 (render 命令) ==", flush=True)
    tlog({"event": "phase.F.start", "ts": time.time()})
    s.send("/subagent-proto render a single success 6\r")
    ok = s.wait_needle("[proto render] a single/success step=6", 15)
    block = s.save_card_frame("frame-variant-a-full.txt", None, after_render_tag="[proto render] a single/success step=6")
    check("F-A: A 卡 render 帧出现", ok and block is not None, "")
    if block:
        joined = "\n".join(block)
        check("F-A: A 卡 110 列全字段 (cap/timeout/cost/task 均在)", "cap 50k" in joined and "timeout 300s" in joined and "$0.0412" in joined and "task 搜索当前目录结构" in joined, "")
        check("F-A: A 卡含操作提示", "[Open session]" in joined and "[Copy runId]" in joined, "")

    s.send("/subagent-proto render b single success 6\r")
    ok = s.wait_needle("[proto render] b single/success step=6", 15)
    block = s.save_card_frame("frame-variant-b.txt", None, after_render_tag="[proto render] b single/success step=6")
    check("F: B 单行致密卡 render 帧出现", ok and block is not None, "")
    if block:
        joined = "\n".join(block)
        m = re.search(r"✓ explorer · done[^\n]*", joined)
        check("F: B 卡为一行含 status/model/ctx/usage/task", bool(m) and "model openai/x" in m.group(0) and "ctx 18%" in m.group(0) and "↑" in m.group(0) and "task " in m.group(0), m.group(0)[:90] if m else "")
        if m:
            check("F: B 行宽 ≤110", len(m.group(0)) <= 110, f"len={len(m.group(0))}")

    # ---- F2: COLS=80 截断帧 ----
    print("== Phase F2: 缩到 80 列 (render 命令) ==", flush=True)
    tlog({"event": "phase.F2.start", "ts": time.time()})
    s.resize(80, 36)
    time.sleep(1.0)
    s.drain(1.0)
    s.send("/subagent-proto render b single success 6\r")
    ok = s.wait_needle("[proto render] b single/success step=6", 15)
    # 取最后一块 b render 卡 (80 列那次)
    time.sleep(0.8)
    s.drain(1.0)
    scr = s.screen()
    block = extract_render_card(scr, "[proto render] b single/success step=6")
    check("F2: 80 列 B 卡 render 帧出现", ok and block is not None, "")
    if block:
        joined = "\n".join(block)
        m = re.search(r"✓ explorer · done[^\n]*", joined)
        check("F2: 80 列 B 行可见", bool(m), "")
        if m:
            line = m.group(0)
            check("F2: 80 列下行宽 ≤80", len(line) <= 80, f"len={len(line)}")
            check("F2: §4.0 省略生效 (task 已丢, 保留 status/model/ctx/usage)", "task " not in line and "ctx 18%" in line and "model openai/x" in line and "↑" in line, f"{line[:70]}...")
        with open(os.path.join(EVID, "frame-variant-b-80.txt"), "w") as f:
            f.write("\n".join(block) + "\n")
    s.resize(COLS, ROWS)
    time.sleep(0.5)
    s.drain(1.0)

    # ---- Phase G: variant c (render 命令, parallel-pending) ----
    print("== Phase G: variant c, render 命令帧 (parallel-pending) ==", flush=True)
    tlog({"event": "phase.G.start", "ts": time.time()})
    s.send("/subagent-proto render c parallel parallel-pending 0\r")
    ok = s.wait_needle("[proto render] c parallel/parallel-pending step=0", 15)
    block = s.save_card_frame("frame-variant-c-active.txt", None, after_render_tag="[proto render] c parallel/parallel-pending step=0")
    check("G: 活动帧 render 出现", ok and block is not None, "")
    if block:
        joined = "\n".join(block)
        check("G: 活动帧含聚合行 (◐ parallel)", "◐ parallel" in joined, "")
        check("G: 活动帧含 pending 预建行 (◌ · pending 等待并发槽)", "pending 等待并发槽" in joined, "")
        check("G: 活动帧含 task 预建 (task 审查登录模块)", "task 审查登录模块" in joined, "")

    s.send("/subagent-proto render c parallel parallel-pending 6\r")
    ok = s.wait_needle("[proto render] c parallel/parallel-pending step=6", 15)
    block = s.save_card_frame("frame-variant-c.txt", None, after_render_tag="[proto render] c parallel/parallel-pending step=6")
    check("G: final 帧 render 出现", ok and block is not None, "")
    if block:
        joined = "\n".join(block)
        check("G: final 帧含 C 分段结构 (→ recentTools 行)", any(x in joined for x in ("→ read", "→ grep", "→ edit", "→ bash", "→ find")), "")
        check("G: final 帧 child 状态可见", "✓ worker" in joined and "✗ reviewer" in joined, "")

    # ---- Phase H: hot reload ----
    print("== Phase H: /reload 热载 (marker v1→v2) ==", flush=True)
    tlog({"event": "phase.H.start", "ts": time.time()})
    time.sleep(3.0)   # 等 settle, 避免 reload 卡在流式
    s.drain(2.0)
    with open(REPLAY_TS) as f:
        src = f.read()
    assert 'MARKER = "proto-v1"' in src, "unexpected marker line"
    with open(REPLAY_TS, "w") as f:
        f.write(src.replace('MARKER = "proto-v1"', 'MARKER = "proto-v2"'))
    t0 = time.time()
    s.send("/reload\r")
    t1 = None
    end = time.time() + 45
    while time.time() < end:
        s.drain(0.3)
        lines = read_replay_log()
        if any(l.get("event") == "ext.loaded" and l.get("marker") == "proto-v2" for l in lines):
            t1 = time.time()
            break
        time.sleep(0.05)
    if t1 is None:
        check("H: /reload 后 ext.loaded(proto-v2) 出现", False, "45s 超时")
        s.kill()
        finish()
        return
    latency = (t1 - t0) * 1000
    tlog({"event": "phase.H.loaded", "latencyMs": latency})
    check("H: /reload 生效 (marker v2)", True, f"latency={latency:.0f}ms")
    check("H: 秒级热载 (<5s)", latency < 5000, f"latency={latency:.0f}ms")
    s.drain(1.0)

    s.send("/subagent-proto single\r")
    end = time.time() + 10
    while time.time() < end:
        s.drain(0.3)
        lines = read_replay_log()
        v2 = [l for l in steps_of(lines, "command", "single", "success") if l.get("marker") == "proto-v2"]
        if len(v2) >= 7:
            break
        time.sleep(0.05)
    s.drain(1.0)
    v2 = [l for l in steps_of(read_replay_log(), "command", "single", "success") if l.get("marker") == "proto-v2"]
    check("H: reload 后命令仍可用 (7 步, v2)", len(v2) == 7, f"count={len(v2)}")
    s.kill()

    finish()

def finish():
    passed = sum(1 for _, ok in RESULTS if ok)
    total = len(RESULTS)
    print(f"\n==== 断言汇总: {passed}/{total} PASS ====", flush=True)
    tlog({"event": "summary", "passed": passed, "total": total})
    import shutil
    for src, dst in ((REPLAY_LOG, os.path.join(EVID, "replay.log")),
                     (TEST_LOG, os.path.join(EVID, "test.log"))):
        try:
            shutil.copy(src, dst)
        except Exception:
            pass
    sys.exit(0 if passed == total else 1)

if __name__ == "__main__":
    main()
