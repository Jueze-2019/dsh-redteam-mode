/**
 * npm 发行版的组成契约 —— **单一事实来源**。
 *
 * 为什么要有这个文件：npm 的发布期自动审查对本包的判定是"包在安装后会自动下载渗透工具
 * （`scripts/redteam-setup.sh` 从 GitHub 拉 11 个二进制并 chmod +x）"，加上 9 份攻击操作手册型
 * 技能（隧道/凭据/WebShell/反弹 Shell/横向移动）。这两类内容的**行为特征与真实供应链攻击、
 * 恶意工具包无法区分**，因此 0.11.x 全部卡在自动审查（`Blocked: ... failed automated review`）。
 *
 * 发行策略（0.12.0 起）：
 *   · npm 包 = **编排与事实库**：角色编排、预检、SQLite 库、得分规则、报告、Web 控制台、
 *     侦察/检测向技能。**不含**任何"自动下载/安装安全工具"的代码，也不含攻击操作手册。
 *   · 完整工具箱（下载器 + 那 9 份技能）= 走 GitHub Release 附件按需获取，由用户显式执行。
 *
 * 这份声明被三处消费：
 *   1. `tools/build.mjs` —— 打包时按它排除文件；
 *   2. `packages/redteam-tools` 的预检 —— 按它告诉用户"缺的能力去哪拿"，而不是自己去装；
 *   3. `test/bundle.test.mjs` —— 断言 npm 产物里**不得出现**这些文件（防止改回去）。
 *
 * 改这里就等于改发行形态，请连带更新 README / DISCLOSURE / Release 说明。
 */

/** npm 包里**不含**的技能（攻击操作手册型）。仍留在仓库，随 Release 附件分发。 */
export const OMITTED_SKILLS = [
  'chisel-tunnel.md',
  'credential-attack.md',
  'frp-tunnel.md',
  'lateral-movement.md',
  'shell-handler.md',
  'suo5-tunnel.md',
  'unauth-exploit.md',
  'vps-reverse-shell.md',
  'webshell-toolkit.md',
]

/** npm 包里**不含**的脚本（自动下载并安装渗透二进制 = 自动审查眼中的恶意行为特征）。 */
export const OMITTED_SCRIPTS = [
  'redteam-setup.sh',
]

/** 完整工具箱附件的文件名（Release 附件），给人看的说明用。 */
export const EXTRA_TOOLKIT_NAME = 'dsh-redteam-mode-<版本>-toolkit.tar.gz'

/** 附件里给用户看的说明（`redteam_preflight` 与文档共用同一段口径）。 */
export const EXTRA_TOOLKIT_HINT =
  '完整工具箱（工具自动安装脚本 + 9 份攻击链技能）不随 npm 包分发：'
  + '从 GitHub Release 附件 ' + EXTRA_TOOLKIT_NAME + ' 取值，解压后按其中的 README 手动执行。'
  + '本包不会替用户下载或安装任何安全工具。'

/** 技能是否随 npm 包分发。 */
export function isSkillShipped (fileName) {
  return !OMITTED_SKILLS.includes(fileName)
}

/** 脚本是否随 npm 包分发。 */
export function isScriptShipped (fileName) {
  return !OMITTED_SCRIPTS.includes(fileName)
}
