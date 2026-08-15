#!/usr/bin/env python3
# M06 最小冒烟: pi 启动 → 扩展加载 → /subagent-proto view 打开 capturing overlay
#   → 屏显 5 tab 名 → Tab 切 tab (Tools 内容出现) → 3 跳 Events/Raw (#00 JSON 行)
#   → r 启动 single 回放 (Events/Raw 计数增长, follow 不崩) → Esc 关闭回主界面
# 依据 M01 结论: 打开必须 fire-and-forget (命令 handler 内 await custom 会冻结主循环);
# capturing 吞全部键盘 (命令无法在打开时输入); Esc=done(null).
# pty 持续 drain (防 pi 事件循环被 pty 缓冲阻塞, M01/M03 已知坑).
import os, pty, select, time, fcntl, termios, struct, re, json, signal, sys

EVID = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(EVID, "replay.log")
FRAMES = os.path.join(EVID, "frames.txt")
CMD = ["pi", "--no-session", "--provider", "deepseek", "--model", "deepseek/deepseek-v4-flash",
       "--thinking", "off", "-ns", "-np", "-nc"]
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]|\x1b\?[0-9;]*[hl]")

for f in (LOG, FRAMES):
    if os.path.exists(f):
        os.remove(f)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(EVID)
    os.environ["TERM"] = "xterm-256color"
    os.environ["PI_SUBAGENT_PROTO_LOG"] = LOG
    os.execvp(CMD[0], CMD)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 110, 0, 0))
buf = b""

def drain(t=0.3):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                buf += os.read(fd, 65536)
            except OSError:
                return

def steps():
    if not os.path.exists(LOG):
        return []
    out = []
    try:
        for line in open(LOG):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    except Exception:
        pass
    return out

def screen():
    s = ANSI.sub("", buf.decode("utf-8", "replace")).replace("\r", "")
    with open(FRAMES, "a") as f:
        f.write("=" * 60 + "\n" + s + "\n")
    return s

def last_screen(n=45):
    """只取最近 n 行 (当前视口), 避免累积缓冲里的旧帧误匹配."""
    s = ANSI.sub("", buf.decode("utf-8", "replace")).replace("\r", "")
    lines = [l for l in s.split("\n") if l]
    with open(FRAMES, "a") as f:
        f.write("=" * 60 + "\n[TAIL]\n" + "\n".join(lines[-n:]) + "\n")
    return "\n".join(lines[-n:])

ok = True

# 1. 启动 + 扩展加载
end = time.time() + 120
loaded = False
while time.time() < end:
    drain(0.5)
    if any(l.get("event") == "ext.loaded" for l in steps()) and b"\x1b[?2026l" in buf and len(buf) > 8000:
        loaded = True
        break
print("PASS 扩展加载" if loaded else "FAIL 扩展加载"); ok &= loaded
time.sleep(2); drain(1)

# 2. /subagent-proto view 打开 overlay → 屏显 5 tab 名
os.write(fd, b"/subagent-proto view\r")
drain(2.5)
s = last_screen()
tabs = ["Conversation", "Tools", "Events/Raw", "Logs", "Diagnostics"]
missing = [t for t in tabs if t not in s]
print(f"PASS view 打开后 5 tab 名齐 ({missing} 缺失)" if not missing else f"FAIL view 打开后 tab 名缺失: {missing}"); ok &= not missing
print("PASS footer 含 Esc 关闭提示" if "[Esc] 关闭" in s else "FAIL footer 无 Esc 提示"); ok &= "[Esc] 关闭" in s

# 3. Tab 键 → 当前 tab 切到 Tools (内容出现 recentTools 行)
os.write(fd, b"\t")
drain(1.5)
s = last_screen()
print("PASS Tab 切 tab 后 Tools 内容出现" if "→ edit src/utils.ts" in s else "FAIL Tab 后未见 Tools 内容")
ok &= "→ edit src/utils.ts" in s

# 4. 数字 3 直跳 Events/Raw → JSON 原始行出现
os.write(fd, b"3")
drain(1.5)
s = last_screen()
print("PASS 3 跳 Events/Raw 出 JSON 行" if "#00 {" in s else "FAIL Events/Raw 无 #00 JSON 行"); ok &= "#00 {" in s

# 5. r 启动 single 回放 → Events/Raw 计数增长 (live 追加 + follow 不崩)
os.write(fd, b"r")
end = time.time() + 15
grew = False
last_count = 0
while time.time() < end:
    drain(0.5)
    m = re.search(r"Events/Raw\s+(\d+)", last_screen())
    if m:
        last_count = int(m.group(1))
        if last_count >= 20:
            grew = True
            break
print(f"PASS r 回放后 Events/Raw 计数增长到 {last_count}" if grew else f"FAIL Events/Raw 计数未增长 (last={last_count})"); ok &= grew
drain(1)

# 6. Esc → overlay 关闭回主界面 (tab 栏消失)
os.write(fd, b"\x1b")
drain(2)
s = last_screen()
closed = ("Conversation" not in s) and ("[Esc] 关闭" not in s)
print("PASS Esc 后 overlay 消失回主界面" if closed else "FAIL Esc 后 overlay 未消失"); ok &= closed

os.kill(pid, signal.SIGKILL)
print("SMOKE_RESULT:", "ALL PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
