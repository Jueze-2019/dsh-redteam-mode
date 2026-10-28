/**
 * npm 发行版的组成契约 —— **单一事实来源**。
 *
 * npm 包包含全部原生技能（含隧道/凭据/WebShell/反弹 Shell/横向移动等操作手册），
 * 但**不包含**自动下载/安装安全工具的脚本与任何工具二进制，也不提供安装链接或教程。
 * 工具由用户自行准备；`redteam_preflight` 只报告缺失，不代为下载或安装。
 *
 * 这份声明被三处消费：
 *   1. `tools/build.mjs` —— 打包时按它排除脚本；
 *   2. `packages/redteam-tools` 的预检 —— 按它告诉用户"工具自行准备"；
 *   3. `test/bundle.test.mjs` —— 断言 npm 产物里不出现安装脚本/二进制。
 */

/** npm 包里不含的技能（当前为空：全部原生技能随包）。 */
export const OMITTED_SKILLS = []

/** npm 包里不含的脚本（自动下载并安装渗透二进制 = 自动审查眼中的恶意行为特征）。 */
export const OMITTED_SCRIPTS = [
  'redteam-setup.sh',
]

/** 技能是否随 npm 包分发。 */
export function isSkillShipped (fileName) {
  return !OMITTED_SKILLS.includes(fileName)
}

/** 脚本是否随 npm 包分发。 */
export function isScriptShipped (fileName) {
  return !OMITTED_SCRIPTS.includes(fileName)
}
