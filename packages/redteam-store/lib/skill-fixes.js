/**
 * 技能不可用提示（零依赖，纯 ESM）
 *
 * 本插件不提供工具下载、安装脚本、安装链接或安装教程；工具由用户自行准备。
 * 技能库只说明缺什么、影响是什么，具体怎么装由用户自己决定。
 */

const FIX = '工具由用户自行准备；本插件不提供下载、安装脚本、安装链接或教程。'

/** 兼容旧导出：不再提供逐工具安装步骤。 */
export const TOOL_FIXES = {}

/** 兼容旧导出：不再提供逐技能安装步骤。 */
export const SKILL_FIXES = {}

/** 统一的修复提示：只说明缺口，不提供下载/安装方式。 */
export function fixesForIssue (issue) {
  const detail = issue && typeof issue === 'object'
    ? String(issue.detail || issue.problem || issue.reason || '').trim()
    : ''
  return detail === '' ? FIX : FIX + '（' + detail + '）'
}
