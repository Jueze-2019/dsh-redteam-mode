#!/usr/bin/env bash
# 给 git tag 建/更新 GitHub Release（说明取自 docs/releases/<tag>.md）。
#
# 为什么要它：发版只推 tag 的话，GitHub 的 Releases 页面不会更新 —— 而 Releases 是别人
# 看"这个项目在动、每版改了什么"最直接的地方（也是市场/目录站抓版本的来源之一）。
# v0.9.0/0.9.1/0.9.2 就这样漏过一次，补了这个脚本 + 明确步骤，避免再漏。
#
# 跑法（需要 GitHub API 凭据：`gh auth login` 或环境变量 GH_TOKEN/GITHUB_TOKEN）：
#   bash scripts/release-notes.sh                 # 建/更新所有缺说明的 tag
#   bash scripts/release-notes.sh v0.9.2          # 只处理指定 tag
#   bash scripts/release-notes.sh --check         # 只列出哪些 tag 还没有 Release（不发请求改东西）
#
# 说明文件：docs/releases/<tag>.md（没有该文件时会用仓库 CHANGELOG 风格的一句话占位，
# 并提示你补写 —— 宁可先占位，也不要让 Releases 页面缺版本）。
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NOTES_DIR="$REPO_DIR/docs/releases"
CHECK_ONLY=0
WANTED=()
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) WANTED+=("$arg") ;;
  esac
done

cd "$REPO_DIR"

# 已建过 Release 的 tag（没 gh / 没登录时不报错退出：先让下面把"缺哪些"打出来，
# 退出码 2 表示"需要先登录"，这样 CI/人工都能一眼看出卡在哪）
HAVE=""
GH_READY=0
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  GH_READY=1
  HAVE="$(gh release list --limit 500 --json tagName --jq '.[].tagName' 2>/dev/null || true)"
  # 远端也查一遍：本地 tag 有 Release 但远端没有的情况（本地缓存/权限）不该漏
  HAVE="$(printf '%s\n%s' "$HAVE" "$(gh api "repos/{owner}/{repo}/releases?per_page=100" --jq '.[].tag_name' 2>/dev/null || true)" | sed '/^$/d' | sort -u)"
fi
# 全部 tag（倒序：新的在前）
ALL="$(git tag --sort=-v:refname)"

todo=()
if [ "${#WANTED[@]}" -gt 0 ]; then
  todo=("${WANTED[@]}")
else
  while IFS= read -r tag; do
    [ -z "$tag" ] && continue
    printf '%s\n' "$HAVE" | grep -qx "$tag" || todo+=("$tag")
  done <<< "$ALL"
fi

if [ "${#todo[@]}" -eq 0 ]; then
  echo "✓ 所有 tag 都已有 Release"
  exit 0
fi

if [ "$GH_READY" != "1" ]; then
  echo "待处理的 tag（顺序与上面一致）：${todo[*]}"
  echo
  echo "✗ 需要 GitHub API 凭据：gh 未登录（或没装 gh）。"
  if [ "$CHECK_ONLY" = "1" ]; then
    echo "  注意：未登录时 --check 只能按本地 tag 倒序列出，无法确认远端到底建过哪些 Release。"
  else
    echo "  跑一次：gh auth login --hostname github.com --git-protocol ssh"
    echo "  或：    GH_TOKEN=<有 repo 权限的 PAT> bash scripts/release-notes.sh ${todo[*]}"
  fi
  exit 2
fi
echo "缺少 Release 的 tag：${todo[*]}"
if [ "$CHECK_ONLY" = "1" ]; then exit 1; fi

failed=()
for tag in "${todo[@]}"; do
  notes_file="$NOTES_DIR/$tag.md"
  if [ -f "$notes_file" ]; then
    notes="$notes_file"
  else
    # 占位说明：先让 Releases 页面有这一版，再补写正文
    tmp="$(mktemp)"
    {
      echo "$tag"
      echo
      echo "（**待补写发布说明**：把正文写到 \`docs/releases/$tag.md\` 后重跑 \`bash scripts/release-notes.sh $tag\`）"
      echo
      echo "\`\`\`sh"
      echo "dsh plugin --profile web add dsh-redteam-mode@${tag#v}"
      echo "\`\`\`"
    } > "$tmp"
    notes="$tmp"
    echo "  ! $tag 没有 docs/releases/$tag.md，先用占位说明建 Release"
  fi

  # 标题 = "vX.Y.Z " + 说明首行（去掉 markdown 记号），与历史 Release 风格一致
  first_line="$(sed -n '1p' "$notes" | sed -E 's/^#+ +//; s/\*\*//g; s/[。.]$//' | cut -c1-90)"
  title="$tag"
  [ -n "$first_line" ] && [ "$first_line" != "$tag" ] && title="$tag $first_line"

  if printf '%s\n' "$HAVE" | grep -qx "$tag"; then
    if gh release edit "$tag" --title "$title" --notes-file "$notes" >/dev/null 2>&1; then
      echo "  ✓ $tag 标题与说明已更新"
    else
      echo "  ✗ $tag 更新失败"; failed+=("$tag")
    fi
  else
    if gh release create "$tag" --title "$title" --notes-file "$notes" >/dev/null 2>&1; then
      echo "  ✓ $tag Release 已创建"
    else
      echo "  ✗ $tag 创建失败（检查 tag 是否已推到远端、token 是否有 repo 权限）"; failed+=("$tag")
    fi
  fi
  [ "$notes" != "$notes_file" ] && rm -f "$notes"
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "✗ 失败：${failed[*]}"
  exit 1
fi
echo
echo "✓ 完成。检查：https://github.com/$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo '<owner>/<repo>')/releases"
