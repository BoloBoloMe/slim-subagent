#!/usr/bin/env python3
# M05 最小冒烟: pi 启动 → 扩展加载 → widget/footer 命令有响应 → /subagent-proto single 7 步
# 断言: 扩展加载 / widget above 有响应 / footer on 有响应 / single 回放 7 步 / status 显示 widget/footer 状态
import os, pty, select, time, fcntl, termios, struct, re, json, signal, sys

EVID = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(EVID, "replay.log")
CMD = ["pi", "--no-session", "--provider", "deepseek", "--model", "deepseek/deepseek-v4-flash",
       "--thinking", "off", "-ns", "-np", "-nc"]
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]|\x1b\?[0-9;]*[hl]")

if os.path.exists(LOG):
    os.remove(LOG)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(EVID)
    os.environ["TERM"] = "xterm-256color"
    os.environ["PI_SUBAGENT_PROTO_LOG"] = LOG
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

def screen():
    return ANSI.sub("", buf.decode("utf-8", "replace")).replace("\r", "")

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

# 2. widget above 命令有响应 (notify 应出现在屏上)
os.write(fd, b"/subagent-proto widget above\r")
drain(2)
s = screen()
print("PASS widget above 命令有响应" if "Widget 面板" in s and "above" in s else "FAIL widget above 命令无响应"); ok &= ("Widget 面板" in s and "above" in s)

# 3. widget-height 5 + footer on
os.write(fd, b"/subagent-proto widget-height 5\r")
drain(1.5)
s = screen()
print("PASS widget-height 5 有响应" if "Widget 高度" in s else "FAIL widget-height 无响应"); ok &= ("Widget 高度" in s)
os.write(fd, b"/subagent-proto footer on\r")
drain(1.5)
s = screen()
print("PASS footer on 有响应" if "Footer 摘要" in s and "自定义" in s else "FAIL footer on 无响应"); ok &= ("Footer 摘要" in s and "自定义" in s)

# 4. single 回放 7 步
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

# 5. status 显示 widget/footer 状态
os.write(fd, b"/subagent-proto status\r")
drain(2)
s = screen()
print("PASS status 含 widget/footer 状态" if ("widget=aboveEditor" in s and "footer=on" in s) else "FAIL status 不含 widget/footer 状态"); ok &= ("widget=aboveEditor" in s and "footer=on" in s)

os.kill(pid, signal.SIGKILL)
sys.exit(0 if ok else 1)
