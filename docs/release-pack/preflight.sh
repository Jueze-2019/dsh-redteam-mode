#!/usr/bin/env bash
# 发布前自检（Mac 上跑）：环境、版本号、仓库状态、验收测试，一次全查。
#
#   bash docs/release-pack/preflight.sh
#
# 只读检查，不会改任何东西；全绿再执行 npm publish。
set -uo pipefail

WANT_VERSION="${1:-$(node -p "require(\"./packages/redteam-bundle/package.json\").version" 2>/dev/null || echo 0.12.0)}"
PKG_DIR="packages/redteam-bundle"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
info() { printf '    %s\n' "$1"; }

echo "== 1/4 运行时 =="
NODE_V="$(node -v 2>/dev/null | sed 's/^v//')"
NPM_V="$(npm -v 2>/dev/null)"
if [ -n "$NODE_V" ]; then ok "node v$NODE_V"; else bad "node 未安装"; fi
# 实测要求：Node >= 22.14（其余按 npm 版本决定）
if [ -n "$NODE_V" ] && [ "$(printf '%s\n22.14.0\n' "$NODE_V" | sort -V | head -1)" = "22.14.0" ]; then
  ok "node 满足 >= 22.14"
else
  bad "node 低于 22.14（当前 v$NODE_V）"
fi
# 关键：受信发布/新 CLI 能力要求 npm >= 11.5.1；npm@12 还需要 Node >= 22.22.2
if [ -n "$NPM_V" ] && [ "$(printf '%s\n11.5.1\n' "$NPM_V" | sort -V | head -1)" = "11.5.1" ]; then
  ok "npm $NPM_V 满足 >= 11.5.1"
else
  bad "npm $NPM_V 低于 11.5.1 —— npm 10 做不了 OIDC/暂存，请 npm i -g npm@12（需 Node >= 22.22.2）"
fi

echo "== 2/4 npm 身份 =="
WHO="$(npm whoami 2>/dev/null)"
if [ "$WHO" = "jueze" ]; then ok "已登录：$WHO"; else bad "未登录或身份不对（当前：${WHO:-空}）—— 跑 npm login --auth-type=web"; fi

echo "== 3/4 仓库状态 =="
VER="$(node -p "require('./$PKG_DIR/package.json').version" 2>/dev/null)"
if [ "$VER" = "$WANT_VERSION" ]; then ok "$PKG_DIR 版本号 = $VER"; else bad "版本号是 $VER，期望 $WANT_VERSION"; fi
if git rev-parse --git-dir >/dev/null 2>&1; then
  if [ -z "$(git status --porcelain)" ]; then ok "工作区干净"; else bad "工作区有未提交改动（先 commit 或 stash）"; git status --short | head -5; fi
  HEAD_MSG="$(git log --oneline -1)"
  ok "HEAD：$HEAD_MSG"
  git fetch -q origin main 2>/dev/null || true
  if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main 2>/dev/null || echo x)" ]; then
    ok "与 origin/main 同步"
  else
    bad "本地 HEAD 与 origin/main 不一致（先 git pull）"
  fi
else
  bad "不在 git 仓库里"
fi

echo "== 4/4 验收测试（prepublishOnly 会再跑一遍）=="
if (cd "$PKG_DIR" && node tools/build.mjs --check >/tmp/preflight-build.log 2>&1); then
  ok "build --check：$(tail -1 /tmp/preflight-build.log)"
else
  bad "build --check 失败：$(tail -3 /tmp/preflight-build.log)"
fi
if (cd "$PKG_DIR" && node tools/test-all.mjs >/tmp/preflight-test.log 2>&1); then
  ok "全量回归：$(grep -E '^✓ 全部' /tmp/preflight-test.log | tail -1)"
else
  bad "测试未全绿，看 /tmp/preflight-test.log"; grep -E '✗|失败' /tmp/preflight-test.log | head -5
fi

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32m全部通过（%d 项）\033[0m —— 可以执行：\n\n    cd %s && npm publish --access public\n\n' "$pass" "$PKG_DIR"
  echo "提醒：浏览器弹出人工验证后请立刻完成（鉴权会话约 4–5 分钟失效）。"
  exit 0
else
  printf '\033[31m有 %d 项没过（通过 %d 项）\033[0m —— 修完再发。\n' "$fail" "$pass"
  exit 1
fi
