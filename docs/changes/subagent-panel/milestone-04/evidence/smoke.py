#!/usr/bin/env python3
# M04 最小冒烟: pi 启动 → 扩展加载 → /subagent-proto single 7 步 → 屏上可见卡标记
import os, pty, select, time, fcntl, termios, struct, re, json, signal, sys

EXP = "/tmp/subagent-panel-proto"
os.makedirs(EXP, exist_ok=True)
LOG = os.path.join(EXP, "replay.log")
CMD = ["pi", "--no-session", "--provider", "deepseek", "--model", "deepseek/deepseek-v4-flash",
       "--thinking", "off", "-ns", "-np", "-nc"]
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]|\x1b\?[0-9;]*[hl]")

if os.path.exists(LOG):
    os.remove(LOG)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(EXP)
    os.environ["TERM"] = "xterm-256color"
    os.execvp(CMD[0], CMD)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 110, 0, 0))
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
    for line in open(LOG):
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out

ok = True
# 1. 启动 + 扩展加载
end = time.time() + 90
loaded = False
while time.time() < end:
    drain(0.5)
    if any(l.get("event") == "ext.loaded" for l in steps()) and b"\x1b[?2026l" in buf and len(buf) > 5000:
        loaded = True
        break
print("PASS 扩展加载" if loaded else "FAIL 扩展加载"); ok &= loaded
time.sleep(2); drain(1)

# 2. single 回放 7 步
os.write(fd, b"/subagent-proto single\r")
end = time.time() + 15
n = 0
while time.time() < end:
    drain(0.3)
    n = len([l for l in steps() if l.get("event") == "replay.step" and l.get("mode") == "single"])
    if n >= 7:
        break
print(f"PASS single 7 步 (n={n})" if n >= 7 else f"FAIL single 步数 n={n}"); ok &= n >= 7
drain(2)

# 3. 变体切换命令
os.write(fd, b"/subagent-proto variant b\r")
drain(2)
scr = ANSI.sub("", buf.decode("utf-8", "replace")).replace("\r", "")
v = "variant" in scr.lower()
print("PASS variant 命令有响应" if v else "FAIL variant 命令无响应"); ok &= v

os.kill(pid, signal.SIGKILL)
sys.exit(0 if ok else 1)
