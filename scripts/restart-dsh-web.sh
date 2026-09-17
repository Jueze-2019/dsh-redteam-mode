#!/usr/bin/env bash
# 重启 dsh web（红队控制台），让新的 host 侧代码 / 工具描述 / 预设生效。
#
# 用法（务必脱离当前会话，否则调用方被重启中断后脚本也会被杀）：
#   setsid nohup bash scripts/restart-dsh-web.sh >> runs/restart-dsh-web.log 2>&1 &
#   FORCE_PRESET=1 setsid nohup bash runs/restart-dsh-web.sh [旧PID] >> ... &
#
# 说明：
#   · 旧 PID 不给就只等端口释放后启动（适用于已经手动停掉的场景）；
#   · **默认不动** $DSH_HOME/.agent-presets/redteam/（用户可能就地改过预设）；
#     要强制用包内预设覆盖它，加 FORCE_PRESET=1（插件首启自举读的就是这个变量）。
set -u
export DSH_HOME="${DSH_HOME:-/home/jz/.dsh}"
export PATH="/usr/local/bin:/usr/bin:/bin:/home/jz/.local/bin:$PATH"
OLD_PID="${1:-}"
LOG="$DSH_HOME/restart-dsh-web.log"
WEB_URL="http://127.0.0.1:3080/"
PORT=3080
# 仓库根：本脚本在 scripts/ 下（受版本管理）；runs/ 下那份是转发用的副本
cd "$(dirname "$0")/.." || exit 1

# 没给 PID 就自己找：**不找就会再起一个端口冲突的实例** —— 新进程 EADDRINUSE 直接死，
# 旧进程继续跑，日志里却写着"重启完成"，看起来成功了其实代码一点没换（v0.9.0 踩过）。
if [ -z "$OLD_PID" ]; then
  OLD_PID="$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"
fi
if [ -z "$OLD_PID" ]; then
  OLD_PID="$(pgrep -f '\.bin/dsh --profile' | head -1 || true)"
fi

{
  echo "[$(date '+%F %T')] 开始重启 dsh web（旧 PID=${OLD_PID:-无}，FORCE_PRESET=${FORCE_PRESET:-0}）"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill -TERM "$OLD_PID" 2>/dev/null
    for _ in $(seq 1 30); do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 1; done
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "[$(date '+%F %T')] 优雅退出超时，强制结束"
      kill -KILL "$OLD_PID" 2>/dev/null; sleep 2
    fi
  else
    echo "[$(date '+%F %T')] 旧进程已不在，直接启动"
  fi

  # 等端口释放
  for _ in $(seq 1 20); do
    ss -lnt 2>/dev/null | grep -q ":$PORT " || break
    sleep 1
  done
  if ss -lnt 2>/dev/null | grep -q ":$PORT "; then
    echo "[$(date '+%F %T')] ✗ 端口 $PORT 仍被占用，放弃启动（避免再起一个冲突实例）。占用者："
    ss -ltnp 2>/dev/null | grep ":$PORT " >> "$LOG"
    exit 1
  fi

  echo "[$(date '+%F %T')] 启动新进程"
  if [ "${FORCE_PRESET:-0}" = "1" ]; then
    # 用包内预设覆盖用户预设（会把 {{REDTEAM_SKILLS_DIR}} 重新替换成真实路径）
    REDTEAM_PRESET_REFRESH=1 setsid nohup \
      /home/jz/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh --profile web \
      >> "$DSH_HOME/dsh-web.log" 2>&1 < /dev/null &
  else
    setsid nohup \
      /home/jz/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh --profile web \
      >> "$DSH_HOME/dsh-web.log" 2>&1 < /dev/null &
  fi
  echo "[$(date '+%F %T')] 新 PID=$!"

  # 健康检查：HTTP 有响应（401 也算"活着"，因为要带 token）且不是连接失败（000）
  for i in $(seq 1 60); do
    sleep 2
    CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$WEB_URL" || true)
    if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then
      echo "[$(date '+%F %T')] 重启完成：$WEB_URL 响应 $CODE（等待 $((i*2)) 秒）"
      exit 0
    fi
  done
  echo "[$(date '+%F %T')] 警告：120 秒内 3080 未响应，请看 $DSH_HOME/dsh-web.log"
  exit 1
} >> "$LOG" 2>&1
