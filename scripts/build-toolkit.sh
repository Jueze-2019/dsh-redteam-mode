#!/usr/bin/env bash
# 打「完整工具箱」附件 —— npm 包**有意不包含**的那部分。
#
#   bash scripts/build-toolkit.sh [版本] [输出目录]
#
# 产出：dsh-redteam-mode-<版本>-toolkit.tar.gz（+ .sha256）
#
# 里面装什么（与 packages/redteam-bundle/tools/distribution.mjs 的发行契约互补）：
#   · scripts/redteam-setup.sh   —— 环境安装脚本（会自动下载安全工具二进制，所以不进 npm 包）
#   · skills/<9 份攻击链技能>     —— 凭据/WebShell/反射 Shell/横向/隧道/未授权利用
#   · README.md                  —— 给用户看的用法（本脚本生成，不落仓库）
#
# 为什么产物不提交进仓库：它内含"自动下载一批渗透工具"的脚本，静态托管在 Git 仓库里
# 与放到 npm 包里一样容易被误判；放 Release 附件里由用户按需取用才是这里的设计。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(node -p "require('$REPO/packages/redteam-bundle/package.json').version")}"
OUT_DIR="${2:-/tmp}"
NAME="dsh-redteam-mode-${VERSION}-toolkit"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# 与 distribution.mjs 的 OMITTED_SKILLS 保持一致；这里再校验一次，避免两处漂移
SKILLS=(
  credential-attack.md webshell-toolkit.md vps-reverse-shell.md
  shell-handler.md unauth-exploit.md lateral-movement.md
  suo5-tunnel.md chisel-tunnel.md frp-tunnel.md
)

echo "== 打工具箱 $NAME =="
mkdir -p "$STAGE/$NAME/scripts" "$STAGE/$NAME/skills"

for f in "${SKILLS[@]}"; do
  src="$REPO/skills/$f"
  [ -f "$src" ] || { echo "✗ 缺技能文件：skills/$f"; exit 1; }
  cp "$src" "$STAGE/$NAME/skills/$f"
done
cp "$REPO/scripts/redteam-setup.sh" "$STAGE/$NAME/scripts/redteam-setup.sh"
chmod 755 "$STAGE/$NAME/scripts/redteam-setup.sh"

# 校验：这些文件确实**不在** npm 包里（发行契约的另一半）
for f in "${SKILLS[@]}"; do
  [ -f "$REPO/packages/redteam-bundle/skills/$f" ] && { echo "✗ skills/$f 竟然在 npm 包里了，发行契约被破坏"; exit 1; }
done
[ -f "$REPO/packages/redteam-bundle/scripts/redteam-setup.sh" ] && { echo "✗ redteam-setup.sh 竟然在 npm 包里了"; exit 1; }

cat > "$STAGE/$NAME/README.md" <<EOF
# dsh-redteam-mode 工具箱（v${VERSION}）

这个压缩包装着 **npm 包里有意没有**的那部分能力。npm 版只含编排与事实库
（六个角色、SQLite 事实库、得分规则、报告、右侧控制台、14 个侦察/检测向技能）；
本工具箱补上工具链与攻击链技能。

## 里面有什么

| 路径 | 说明 |
| --- | --- |
| \`scripts/redteam-setup.sh\` | 环境安装脚本：把技能用到的安全工具二进制装到 \`\$DSH_HOME/redteam/toolkit/\`，并引导配置 \`FOFA_KEY\` 与 VPS；**幂等、可重跑、不用 sudo** |
| \`skills/\` | 9 份攻击链技能：\`credential-attack\` \`webshell-toolkit\` \`vps-reverse-shell\` \`shell-handler\` \`unauth-exploit\` \`lateral-movement\` \`suo5-tunnel\` \`chisel-tunnel\` \`frp-tunnel\` |

## 怎么用（就是两条命令，**由你自己执行**）

\`\`\`sh
# 1) 安装脚本放到插件约定的位置
mkdir -p "\$DSH_HOME/redteam"
cp scripts/redteam-setup.sh "\$DSH_HOME/redteam/setup.sh"
chmod +x "\$DSH_HOME/redteam/setup.sh"

# 2) 体检 → 装齐（--check 只看不装；--yes 全自动；裸跑是交互式引导）
bash "\$DSH_HOME/redteam/setup.sh" --check
bash "\$DSH_HOME/redteam/setup.sh" --yes
\`\`\`

脚本做四件事：① 把技能用到的二进制装到 \`\$DSH_HOME/redteam/toolkit/\`（`nmap` 这类
系统工具只提示、不擅自 sudo）；② 体检 nuclei 模板库；③ 引导你粘贴 \`FOFA_KEY\` 与 VPS
登录方式（写进 \`\$DSH_HOME/.env\`，权限 600）；④ 实测通道可用并写完成标记
\`\$DSH_HOME/redteam/.setup-complete\`。

特性：**幂等**（随时重跑，已装不重装，\`--force\` 才强制重下）；**不猜 URL**（走 GitHub
\`releases/latest\` API 取真实资产）；**不动系统**（只写 \`\$DSH_HOME/redteam/\` 与
\`\$DSH_HOME/.env\`，不装系统包、不改网络配置）；日志在 \`\$DSH_HOME/redteam/setup.log\`。

需要 apt 装的系统工具（脚本只提示，不擅自 sudo）：\`nmap masscan nuclei sqlmap ffuf
feroxbuster gobuster hydra john hashcat wpscan nikto whatweb msfconsole\` ——
**要装的话由你自己执行**。

### 装完的验证（逐项实测，别只看"文件存在"）

\`\`\`bash
\$DSH_HOME/redteam/toolkit/fscan/fscan -h 2>&1 | head -3
\$DSH_HOME/redteam/toolkit/gogo/gogo -h 2>&1 | head -3
\$DSH_HOME/redteam/toolkit/chisel/chisel --version
\$DSH_HOME/redteam/toolkit/frp/frpc -v
\$DSH_HOME/redteam/toolkit/suo5/suo5-linux-amd64 --help 2>&1 | head -3
nuclei -tl 2>/dev/null | wc -l      # 模板库应有上万条
\`\`\`

技能目录：把 \`skills/*.md\` 拷进 \`\$DSH_HOME/skills/\`（DSH 的用户技能目录，优先级高于包内技能）：

\`\`\`sh
mkdir -p "\$DSH_HOME/skills" && cp skills/*.md "\$DSH_HOME/skills/"
\`\`\`

装完重启一次 \`dsh web\`，再跑 \`redteam_preflight\` 应看到这些技能可用。

## 为什么不在 npm 包里

npm 的发布期自动审查会把"包在安装后自动下载安全工具二进制"判定为恶意行为特征
（这类行为与真实供应链攻击无法区分），整包会被 Blocked。所以这部分改成由用户
**显式获取、显式执行**：npm 包本身不下载、不安装任何安全工具。

## 合规

仅用于**已获书面授权**的攻防演练 / 渗透测试。工具箱里的脚本与技能都假设你已取得授权；
使用者须自行确保对目标拥有合法测试权限。
EOF

OUT="$OUT_DIR/$NAME.tar.gz"
tar czf "$OUT" -C "$STAGE" "$NAME"
( cd "$OUT_DIR" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )

echo "✓ 产出：$OUT"
echo "  内含：$(tar tzf "$OUT" | grep -c '\.md$\|\.sh$') 个文件"
ls -lh "$OUT"
