#!/usr/bin/env python3
# M06b 最小冒烟: pi 启动 → 扩展加载 → /subagent-proto view 打开 capturing overlay
#   → tab 栏 = Conversation + 默认批次 (batch-3: worker/reviewer/linter) 子代理
#   → Conversation tab 3 个批次时间线行 (#1-#3)
#   → ↑ 移到 #2 + Enter 确认 → tab 栏切换为 batch-2 的 4 个子代理 (含 explorer)
#   → 数字 2 跳 worker tab → 会话 transcript (user/assistant/tool 块) 显示
#   → Esc 关闭 → 重开 → alt+v 再按关闭 (toggle 语义)
# 依据 M01 结论: 打开必须 fire-and-forget (命令 handler 内 await custom 会冻结主循环);
# capturing 吞全部键盘 (命令无法在打开时输入); Esc=done(null).
# pty 持续 drain (防 pi 事件循环被 pty 缓冲阻塞, M01/M03 已知坑).
import os, pty, select, time, fcntl, termios, struct, re, json, signal, sys

EVID = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(EVID, "m06b-smoke.log")
FRAMES = os.path.join(EVID, "m06b-frames.txt")
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

def last_screen(n=45):
    """只取最近 n 行 (当前视口), 避免累积缓冲里的旧帧误匹配."""
    s = ANSI.sub("", buf.decode("utf-8", "replace")).replace("\r", "")
    lines = [l for l in s.split("\n") if l]
    with open(FRAMES, "a") as f:
        f.write("=" * 60 + "\n[TAIL]\n" + "\n".join(lines[-n:]) + "\n")
    return "\n".join(lines[-n:])

def tab_bar(s, name):
    """tab 栏里是否出现 [..name..] (agent tab 带括号; 会话行 agent 列表无括号)."""
    return bool(re.search(r"\[[^\]]*" + re.escape(name) + r"[^\]]*\]", s))

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

# 2. /subagent-proto view 打开 → tab 栏 = Conversation + 默认批次 (batch-3) 子代理
os.write(fd, b"/subagent-proto view\r")
drain(2.5)
s = last_screen()
need_tabs = ["Conversation", "worker", "reviewer", "linter"]
missing = [t for t in need_tabs if not tab_bar(s, t)]
print(f"PASS view 打开后 tab 栏含 Conversation+子代理 ({missing} 缺失)" if not missing else f"FAIL tab 栏缺失: {missing}"); ok &= not missing
print("PASS footer 含 Esc 关闭提示" if "[Esc] 关闭" in s else "FAIL footer 无 Esc 提示"); ok &= "[Esc] 关闭" in s

# 3. Conversation tab 显示 3 个批次时间线行 (#1 #2 #3) + 状态摘要
s = last_screen()
need_rows = ["#1", "#2", "#3"]
missing_r = [r for r in need_rows if r not in s]
print(f"PASS Conversation 显示 3 批次行 ({missing_r} 缺失)" if not missing_r else f"FAIL 批次行缺失: {missing_r}"); ok &= not missing_r
print("PASS 批次行含状态摘要 2/4 done" if "2/4 done" in s else "FAIL 未见 2/4 done"); ok &= "2/4 done" in s
print("PASS 批次行含 single 模式" if "single" in s else "FAIL 未见 single"); ok &= "single" in s
# 默认选中最新批次: #3 行反显 (▸ 光标)
print("PASS 默认选中最新批次 (#3 ▸)" if re.search(r"▸.*#3|#3.*▸", s) else "FAIL 未默认选中 #3"); ok &= bool(re.search(r"▸.*#3|#3.*▸", s))

# 4. ↑ 移到 #2 + Enter 确认 → tab 栏切换为 batch-2 子代理 (worker/reviewer/explorer/linter)
os.write(fd, b"\x1b[A")
drain(1.0)
os.write(fd, b"\r")
drain(1.5)
s = last_screen()
need_b2 = ["worker", "reviewer", "explorer", "linter"]
missing_b2 = [t for t in need_b2 if not tab_bar(s, t)]
print(f"PASS Enter 确认后 tab 栏切换为 batch-2 4 子代理 ({missing_b2} 缺失)" if not missing_b2 else f"FAIL 确认后 tab 栏缺失: {missing_b2}"); ok &= not missing_b2

# 5. 数字 2 跳 worker tab → 会话 transcript 显示 (user/assistant/tool 块)
os.write(fd, b"2")
drain(1.5)
s = last_screen()
need_content = ["重构 utils 模块", "[assistant]", "→ edit src/utils.ts", "pnpm lint"]
missing_c = [c for c in need_content if c not in s]
print(f"PASS worker tab 显示 transcript (user/assistant/tool) ({missing_c} 缺失)" if not missing_c else f"FAIL transcript 缺失: {missing_c}"); ok &= not missing_c

# 6. Esc → overlay 关闭回主界面 (用 status 探针: capturing 释放后命令可输入 + viewer=closed)
os.write(fd, b"\x1b")
drain(1.5)
os.write(fd, b"/subagent-proto status\r")
drain(2.5)
s = last_screen()
closed = "viewer=closed" in s
print("PASS Esc 后 overlay 关闭 (viewer=closed)" if closed else "FAIL Esc 后 overlay 未关闭"); ok &= closed

# 7. 重开 + alt+v 再按关闭 (toggle 语义)
os.write(fd, b"/subagent-proto view\r")
drain(2.5)
s = last_screen()
reopen = "Conversation" in s and tab_bar(s, "worker")
print("PASS 重开 overlay 正常" if reopen else "FAIL 重开 overlay 失败"); ok &= reopen
os.write(fd, b"\x1bv")  # alt+v
drain(1.5)
os.write(fd, b"/subagent-proto status\r")
drain(2.5)
s = last_screen()
closed2 = "viewer=closed" in s
print("PASS alt+v 再按关闭 (toggle)" if closed2 else "FAIL alt+v 未关闭 overlay"); ok &= closed2

# 8. 关后再开一次确认 toggle 状态复位 (view 可再次打开)
os.write(fd, b"/subagent-proto view\r")
drain(2.5)
s = last_screen()
reopen2 = "Conversation" in s and tab_bar(s, "linter")
print("PASS 关闭后 view 可再次打开" if reopen2 else "FAIL 关闭后无法重开"); ok &= reopen2
os.write(fd, b"\x1b")
drain(1.5)

os.kill(pid, signal.SIGKILL)
print("SMOKE_RESULT:", "ALL PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
