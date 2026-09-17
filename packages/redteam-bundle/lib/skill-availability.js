/**
 * 技能可用性自检（零依赖，tools 与 UI 共用的**唯一一份**判定逻辑）
 *
 * 为什么要有它：技能正文里写着"本机路径 / 环境变量 / VPS 地址"，但**技能能列出来 ≠ 能跑**。
 * 缺 `FOFA_KEY`、工具没落到 `$DSH_HOME/redteam/toolkit/`、VPS 还是占位符，都要等真正动手
 * 才发现，那时候人已经在靶场里了。这里把判定收成一份：
 *   · 智能体侧 —— `redteam_preflight` 开工前跑一次，缺什么直接找用户要；
 *   · 面板侧 —— 「技能库」页签给每个技能标出可用性状态。
 *
 * 判定维度（都是能从技能正文里客观读出来的）：
 *   ① 技能文件是否存在、正文能否加载；
 *   ② 必需环境变量（`os.environ["X"]` / `process.env.X`；带默认值的 `os.environ.get("X", "…")` 不算必需）；
 *   ③ 正文里引用的本机路径（toolkit / bin / local 下的绝对路径、`$DSH_HOME`、`~/`）；
 *   ④ 外部基础设施占位符（如 `<你的VPS_IP>` 没填）。
 *
 * 不判定：语义正确性、权限、目标可达性 —— 那些只有真打一次才知道。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** 解析 $DSH_HOME / ${DSH_HOME} / ~（技能正文里几种写法都有）。 */
export function expandSkillPath(p, env = process.env) {
  const dshHome = env.DSH_HOME || resolve(homedir(), '.dsh')
  let out = String(p).trim()
  out = out.replace(/\$\{DSH_HOME\}/g, dshHome).replace(/\$DSH_HOME/g, dshHome)
  if (out.startsWith('~/')) out = resolve(homedir(), out.slice(2))
  return out
}

/** 从技能正文里抽出"必需但没有设"的环境变量名。 */
export function requiredEnvOf(content) {
  const names = new Set()
  const body = String(content || '')
  /* Node 侧：process.env.X（没有默认值这一说） */
  for (const m of body.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) names.add(m[1])
  /* Python 侧：os.environ["X"] 必需；os.environ.get("X", "默认") 有兜底，不算必需 */
  for (const m of body.matchAll(/os\.environ(?:\.get)?[\[(]\s*["']([A-Z][A-Z0-9_]{2,})["']\s*(,)?/g)) {
    if (m[2] === undefined) names.add(m[1])
  }
  /* shell 侧：${X:?必填} 是显式必需；裸 $X 不判定（技能里大量出现 $TARGET 这类占位） */
  for (const m of body.matchAll(/\$\{([A-Z][A-Z0-9_]{2,}):\?/g)) names.add(m[1])
  return Array.from(names)
}

/** 正文里引用的、可判定存在性的本机路径（toolkit / bin / local 下的绝对路径）。 */
export function referencedPathsOf(content) {
  const out = new Set()
  for (const m of String(content || '').matchAll(/(?:~|\$DSH_HOME|\/home\/[^\s"'`,)]+?)\/[\w./\u4e00-\u9fa5-]+/g)) {
    const raw = m[0].replace(/[，。；、：)）\]]+$/, '')
    if (!/\/(toolkit|bin|local)\//.test(raw)) continue
    if (/[<>{}*|]/.test(raw)) continue
    out.add(raw)
  }
  return Array.from(out)
}

/**
 * 检查一个技能的可用性。
 * @param skill - `{ name, description?, content?, path? }`（content 是技能正文）。
 * @param options - `{ env?: NodeJS.ProcessEnv, extraNeeds?: string[] }`。
 * @returns `{ name, status: 'available'|'broken'|'unknown', problems, needs_user, checked }`
 *   status='unknown' 表示"正文读不到，判不了"（例如只有元数据、正文加载失败的远端技能）。
 */
export function checkSkill(skill, options = {}) {
  const env = options.env || process.env
  const name = skill && skill.name ? String(skill.name) : '(未命名)'
  const content = skill && typeof skill.content === 'string' ? skill.content : ''
  const file = skill && typeof skill.path === 'string' ? skill.path : null
  const problems = []
  const needsUser = []

  if (content.trim() === '') {
    return {
      name,
      status: 'unknown',
      problems: ['技能正文读不到（只有元数据）：无法判断可用性，需要时用 `skill` 工具实际加载一次'],
      needs_user: [],
      checked: { file, env: [], paths: [] },
    }
  }
  if (file !== null && !existsSync(file)) problems.push('技能文件不存在：' + file)

  const envNames = requiredEnvOf(content)
  const missingEnv = envNames.filter((n) => !env[n])
  for (const n of missingEnv) problems.push('缺环境变量 ' + n + '（export ' + n + '=… 后重启 dsh web）')

  const paths = referencedPathsOf(content)
  const missingPaths = paths.filter((p) => !existsSync(expandSkillPath(p, env)))
  if (missingPaths.length > 0) {
    problems.push('引用的本机路径不存在：' + missingPaths.slice(0, 6).join('、')
      + (missingPaths.length > 6 ? ' 等 ' + missingPaths.length + ' 处' : ''))
  }

  /* 外部基础设施占位符：技能里出现 `<你的VPS_IP>` 这类说明还没配 */
  const placeholders = []
  if (content.includes('<你的VPS_IP>') || content.includes('<VPS_IP>')) placeholders.push('VPS 地址')
  if (content.includes('<你的VPS_主机名>') || content.includes('<VPS 主机名>')) placeholders.push('VPS 主机名')
  for (const p of placeholders) {
    problems.push(p + '还是占位符（技能里写的是占位符，说明本机/本环境还没配）')
    needsUser.push(p)
  }
  for (const n of missingEnv) needsUser.push('环境变量 ' + n)

  return {
    name,
    status: problems.length === 0 ? 'available' : 'broken',
    problems,
    needs_user: Array.from(new Set(needsUser)),
    checked: { file, env: envNames, missing_env: missingEnv, paths, missing_paths: missingPaths },
  }
}

/** 汇总一批技能的状态（面板顶部标签与 preflight 的返回值都用它）。 */
export function summarizeSkills(results) {
  const out = { total: results.length, available: 0, broken: 0, unknown: 0 }
  for (const r of results) out[r.status] = (out[r.status] || 0) + 1
  return out
}
