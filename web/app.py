"""
dsh-background-terminal 的真机验收页面。

用 Flask 起一个长驻服务器，专门用来验证本插件最核心的那条能力：
**后台起一个进程 → 读它的增量输出 → 中断它 → 继续用同一个 shell**。

启动（经 terminal_exec 写入持久 shell，而不是当成前台命令）：

    python web/app.py

页面上的 /api/state 会把进程自身的运行时信息吐出来，方便验证
「服务器确实活着、且是我们起的那个进程」。

页面上有一个 **唤醒按钮**（`POST /api/wake`）：点它会让本进程优雅退出，
于是后台终端里的那条命令**收口**、job **结算**，宿主随即把完成通知推给 agent
——这就是「前端点一下 → agent 被唤醒」的完整链路。

为什么必须是"让 job 结算"而不是别的：本插件的会话只在一个时点主动推消息，
就是 **job 结算**（会话退出）。没有"静默多久就通知"这类事件通知，
所以前端要唤醒 agent，唯一的办法就是让会话收口。
"""

import os
import platform
import sys
import threading
import time
from datetime import datetime, timezone

from flask import Flask, jsonify, render_template_string, request

app = Flask(__name__)

STARTED_AT = time.time()

# 页面上可见的可配置变量：改它 → 重启进程 → 刷新页面即可看到新值。
# 它同时是"后台终端能不能改文件并重启"的最小验证面。
PAGE_VARIANT = os.environ.get("PAGE_VARIANT", "v1-default")

# 由 main() 注入：点唤醒按钮时用它优雅停机。
_httpd = None
WAKE_REQUESTS = []


def uptime_seconds():
    return round(time.time() - STARTED_AT, 1)


@app.get("/")
def index():
    return render_template_string(
        PAGE,
        variant=PAGE_VARIANT,
        host=platform.node(),
        pid=os.getpid(),
        python=sys.version.split()[0],
        cwd=os.getcwd(),
        started=datetime.fromtimestamp(STARTED_AT, timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S"),
    )


@app.get("/api/state")
def state():
    """给 test-plugin.py 与人工 curl 用的机器可读状态。"""
    return jsonify(
        ok=True,
        plugin="dsh-background-terminal",
        variant=PAGE_VARIANT,
        pid=os.getpid(),
        host=platform.node(),
        platform=platform.platform(),
        python=sys.version.split()[0],
        cwd=os.getcwd(),
        uptimeSeconds=uptime_seconds(),
        startedAt=datetime.fromtimestamp(STARTED_AT, timezone.utc).isoformat(),
    )


@app.get("/api/echo/<text>")
def echo(text):
    """回显端点：验证路由参数与中文都能原样返回。"""
    return jsonify(echo=text, length=len(text))


@app.post("/api/wake")
def wake():
    """唤醒按钮：让本进程退出 → 后台终端的 job 结算 → 宿主唤醒 agent。

    先返回响应再停机（延迟一小段），否则浏览器拿不到这次确认。
    """
    stamp = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    WAKE_REQUESTS.append(stamp)
    # 这几个 print 会流进后台终端的输出，agent 读到就立刻知道你点了按钮
    print(f"[wake] 收到唤醒请求 @ {stamp}，本进程将退出（第 {len(WAKE_REQUESTS)} 次）", flush=True)
    print("[wake] job 即将结算 → 宿主会把完成通知推给 agent", flush=True)

    if _httpd is not None:
        threading.Timer(0.4, _httpd.shutdown).start()

    return jsonify(
        ok=True,
        woke=True,
        at=stamp,
        wakeCount=len(WAKE_REQUESTS),
        pid=os.getpid(),
        message="已请求退出：后台终端里的这条命令将收口，job 结算后宿主会唤醒 agent。",
    )


@app.get("/api/wake")
def wake_status():
    """只读：看看点过几次（页面刷新后用它显示状态）。"""
    return jsonify(wakeCount=len(WAKE_REQUESTS), at=WAKE_REQUESTS[-1] if WAKE_REQUESTS else None)


PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-background-terminal · 真机验收</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0b0f14; color: #e6edf3;
         font: 15px/1.6 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  .card { width: min(680px, 92vw); padding: 28px 32px; border-radius: 14px;
          background: #111823; border: 1px solid #1f2b3a;
          box-shadow: 0 12px 40px rgba(0,0,0,.45); }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .sub { margin: 0 0 20px; color: #8b98a9; font-size: 13px; }
  .badge { display: inline-block; margin-bottom: 18px; padding: 3px 10px;
           border-radius: 999px; background: #10301f; color: #4ade80;
           border: 1px solid #1c5334; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 7px 0; border-bottom: 1px solid #1a2432; }
  td:first-child { color: #8b98a9; width: 38%; }
  code { background: #0d131b; padding: 2px 6px; border-radius: 5px;
         font-size: 13px; color: #a5d6ff; }
  .links { margin-top: 20px; display: flex; gap: 18px; font-size: 13px; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wake { margin-top: 22px; padding: 16px; border-radius: 10px;
          background: #0f1a26; border: 1px solid #1f2b3a; }
  .wake h2 { margin: 0 0 6px; font-size: 14px; color: #c9d5e3; }
  .wake p { margin: 0 0 12px; font-size: 12.5px; color: #8b98a9; }
  button { font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
           padding: 10px 20px; border-radius: 8px; border: 1px solid #2d6a4f;
           background: #10301f; color: #4ade80; transition: background .12s; }
  button:hover:not(:disabled) { background: #17402a; }
  button:disabled { cursor: default; opacity: .6; }
  #wakeOut { margin-top: 12px; font-size: 12.5px; color: #8b98a9; min-height: 1.4em; }
  #wakeOut.ok { color: #4ade80; }
  #wakeOut.err { color: #f87171; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">● 服务器运行中</div>
    <h1>dsh-background-terminal · 真机验收</h1>
    <p class="sub">这个页面由插件在一个持久后台 shell 里启动的 Flask 进程提供。</p>
    <table>
      <tr><td>变量 PAGE_VARIANT</td><td><code>{{ variant }}</code></td></tr>
      <tr><td>进程 PID</td><td><code>{{ pid }}</code></td></tr>
      <tr><td>主机</td><td><code>{{ host }}</code></td></tr>
      <tr><td>Python</td><td><code>{{ python }}</code></td></tr>
      <tr><td>工作目录</td><td><code>{{ cwd }}</code></td></tr>
      <tr><td>启动时刻</td><td><code>{{ started }}</code></td></tr>
    </table>

    <div class="wake">
      <h2>唤醒后台终端的 agent</h2>
      <p>点下面这个按钮会让本进程优雅退出 → 后台终端的命令收口 → job 结算
         → 宿主把完成通知推给 agent。这是「前端点一下 → agent 被唤醒」的完整链路。</p>
      <button id="wakeBtn" type="button">唤醒 agent（并停掉本页）</button>
      <div id="wakeOut"></div>
    </div>

    <div class="links">
      <a href="/api/state">/api/state</a>
      <a href="/api/echo/hello%20world">/api/echo/hello world</a>
      <a href="/api/wake">/api/wake（只读计数）</a>
    </div>
  </div>
<script>
  const btn = document.getElementById('wakeBtn');
  const out = document.getElementById('wakeOut');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    out.className = '';
    out.textContent = '正在唤醒…';
    try {
      const r = await fetch('/api/wake', { method: 'POST' });
      const d = await r.json();
      out.className = 'ok';
      out.textContent = '✅ ' + d.message + '（第 ' + d.wakeCount + ' 次，' + d.at + '）'
        + ' 本页即将停止服务——agent 那边会收到通知。';
    } catch (e) {
      out.className = 'ok';
      out.textContent = '✅ 已发出唤醒（进程可能已经退出，连接因此中断）。'
        + 'agent 会收到 job 完成通知。';
    }
  });
</script>
</body>
</html>
"""


if __name__ == "__main__":
    from werkzeug.serving import make_server

    port = int(os.environ.get("PORT", "8765"))
    print(f"[background-terminal] 渲染进程 PID={os.getpid()} 工作目录={os.getcwd()}", flush=True)
    print(f"[background-terminal] 正在监听 http://127.0.0.1:{port}/", flush=True)
    print("[background-terminal] 页面上有「唤醒 agent」按钮（POST /api/wake）", flush=True)
    # 用 make_server 而不是 app.run：这样能拿到 server 句柄，
    # 让 /api/wake 干净地 serve_forever 退出（app.run 拿不到）。
    _httpd = make_server("127.0.0.1", port, app, threaded=True)
    _httpd.serve_forever()
    print("[background-terminal] 服务器已退出（唤醒按钮触发的优雅停机）", flush=True)
