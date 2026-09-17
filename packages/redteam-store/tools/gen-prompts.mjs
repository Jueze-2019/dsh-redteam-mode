/**
 * 生成 core.js 里的提示词段落。
 *
 * 提示词改成两个源文件维护，避免"几百行模板字符串塞在 3600 行代码里"：
 *   · prompts.src.js    —— 公共段落（授权 / 记分 / 查库 / 落库溯源 / 交付口径）
 *   · prompts.roles.md  —— 六个角色正文（`<!-- role:xxx -->` 分段）
 *
 * 本脚本把它们拼成 core.js 中间那段（const COMMON_* + export const DEFAULT_PROMPTS），
 * 前后从现有 core.js 原样保留 —— 也就是说 **core.js 仍是最终产物**，
 * 运行时没有任何额外文件依赖。
 *
 *   node packages/redteam-store/tools/gen-prompts.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')
const corePath = join(libDir, 'core.js')
const srcPath = join(libDir, 'prompts.src.js')
const rolesPath = join(libDir, 'prompts.roles.md')

/** core.js 里提示词区段的哨兵标记：生成器只认它，重复生成因此天然幂等。 */
const SENTINEL = '// __REDTEAM_PROMPTS_BLOCK__'
/** 首次接管时的区段边界（此后区段由哨兵标记定位）。 */
const START_RE = /^const COMMON_SCORE_RULES = /
const END_RE = /^\/\* -+ 统一操作分发 \*\/$/

/** 每个角色拼接哪些公共段落。顺序即正文里的出现顺序。 */
const ROLE_COMMONS = {
  plan: ['AUTH'],
  recon: ['AUTH', 'DB_LOOKUP', 'EVIDENCE', 'HANDOFF'],
  assess: ['AUTH', 'DB_LOOKUP', 'EVIDENCE', 'HANDOFF'],
  'vuln-scan': ['AUTH', 'SCORE_RULES', 'DB_LOOKUP', 'EVIDENCE', 'HANDOFF'],
  exploit: ['AUTH', 'SCORE_RULES', 'DB_LOOKUP', 'EVIDENCE', 'HANDOFF'],
  internal: ['AUTH', 'SCORE_RULES', 'DB_LOOKUP', 'EVIDENCE', 'HANDOFF'],
}

/** 从 prompts.roles.md 解析出 `role -> 正文`。 */
function parseRoles(markdown) {
  const roles = new Map()
  let current = null
  const push = (line) => {
    if (current === null) return
    roles.get(current).push(line)
  }
  for (const line of markdown.split('\n')) {
    const marker = /^<!--\s*role:([a-z-]+)\s*-->$/.exec(line.trim())
    if (marker !== null) {
      current = marker[1]
      roles.set(current, [])
      continue
    }
    push(line)
  }
  const out = {}
  for (const [role, lines] of roles) {
    /* 去掉首尾空行，正文里不留多余空行 */
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    out[role] = lines.join('\n')
  }
  return out
}

/**
 * 把一段正文塞进 JS 模板字符串：只转义反引号与反斜杠。
 *
 * ⚠️ **不要转义 `${`**：公共段落是按 `${COMMON_X}` 的形式拼在角色正文末尾的，
 * 生成物里必须留下可插值的 `${...}`（v0.9.0 第一版生成器把 `${` 转义成了 `\${`，
 * 结果六个角色一个公共段落都没注入 —— 生成日志还显示"5 个公共段落"，很能骗人）。
 * 因此角色正文里不允许出现字面量 `${`（下面有断言挡住）。
 */
function toTemplateLiteral(body) {
  if (body.includes('${')) {
    throw new Error('角色正文里不能出现字面量 ${（会与公共段落插值冲突）；请改写这段文字')
  }
  return body
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
}

/** 解析 prompts.src.js 里的 `const NAME = \`...\`` 段落。 */
function parseCommonSections(source) {
  const out = {}
  const re = /^const (COMMON_[A-Z_]+) = `([\s\S]*?)^`$/gm
  let m
  while ((m = re.exec(source)) !== null) {
    const key = m[1].replace(/^COMMON_/, '')
    out[key] = { raw: m[2], key: m[1] }
  }
  if (Object.keys(out).length === 0) throw new Error('prompts.src.js 里没解析到任何 COMMON_* 段落')
  return out
}

function main() {
  if (!existsSync(corePath)) throw new Error('找不到 core.js：' + corePath)
  const core = readFileSync(corePath, 'utf8')
  const lines = core.split('\n')
  /* 区段定位：
       终点 = 唯一且稳定的「统一操作分发」注释头（它一定在提示词块之后）；
       起点 = 该终点之前**最后一处**哨兵标记，没有哨兵就退到最后一处
              `const COMMON_AUTH = ` 或「角色公共段落」注释头。
     为什么要"最后一处"而不是第一处：v0.9.0 生成器第一版把新块插在旧块**前面**，
     于是产物里同时存在新旧两份；按第一处切会把旧的那份留在 tail 里，
     再次生成再叠一层（real bug：产物里两个 `const COMMON_AUTH` → import 直接 SyntaxError）。
     按"最后一处"切可以把历史重复一并清掉，重复生成恒定幂等。 */
  const endIdx = lines.findIndex((l) => END_RE.test(l))
  if (endIdx < 0) throw new Error('在 core.js 里找不到提示词区段终点（统一操作分发）')
  const lastIndexOf = (pred) => {
    for (let i = endIdx - 1; i >= 0; i -= 1) if (pred(lines[i], i)) return i
    return -1
  }
  let startIdx = lastIndexOf((l) => l.trim() === SENTINEL)
  if (startIdx < 0) startIdx = lastIndexOf((l) => l.startsWith('const COMMON_AUTH = '))
  if (startIdx < 0) startIdx = lastIndexOf((l) => l.includes('角色公共段落'))
  if (startIdx < 0) {
    throw new Error('既找不到 ' + SENTINEL + '，也找不到 COMMON_AUTH / 「角色公共段落」注释头')
  }
  /* 起点往上吃掉紧邻的注释头（属于本区段） */
  while (startIdx > 0 && /^\s*(\*|\/\*)/.test(lines[startIdx - 1])) startIdx -= 1
  const head = lines.slice(0, startIdx).join('\n')
  const tail = lines.slice(endIdx).join('\n')

  const src = readFileSync(srcPath, 'utf8')
  const commons = parseCommonSections(src)
  const roles = parseRoles(readFileSync(rolesPath, 'utf8'))

  const missing = Object.keys(ROLE_COMMONS).filter((r) => roles[r] === undefined)
  if (missing.length > 0) throw new Error('prompts.roles.md 缺少角色段落：' + missing.join(', '))
  for (const [role, wanted] of Object.entries(ROLE_COMMONS)) {
    for (const key of wanted) {
      if (commons[key] === undefined) throw new Error(`prompts.src.js 缺少 COMMON_${key}（角色 ${role} 需要）`)
    }
  }

  const parts = []
  parts.push('/* ------------------------------------------------------------------ 角色公共段落')
  parts.push('')
  parts.push('   由 packages/redteam-store/tools/gen-prompts.mjs 生成，**不要直接改这一段**：')
  parts.push('   改 prompts.src.js（公共段落）与 prompts.roles.md（角色正文）后重新生成。')
  parts.push('   现在 core.js 是唯一运行时产物，运行时不读那两个源文件。 */')
  parts.push('')
  for (const key of ['AUTH', 'SCORE_RULES', 'DB_LOOKUP', 'EVIDENCE', 'HANDOFF']) {
    const section = commons[key]
    if (section === undefined) continue
    parts.push('const ' + section.key + ' = `' + section.raw + '`')
    parts.push('')
  }

  parts.push('/* ------------------------------------------------------------------ 角色提示词')
  parts.push('')
  parts.push('   六个角色 = 主会话（指挥）+ 五个执行角色。每个角色正文末尾按固定顺序')
  parts.push('   拼接公共段落（授权 → 记分 → 查库 → 落库溯源 → 交付口径）。')
  parts.push('   角色的 code 同时是提示词文件名（agents/<code>.md）与库里的 agent 列取值。 */')
  parts.push('')
  parts.push('export const DEFAULT_PROMPTS = {')
  const order = ['plan', 'recon', 'assess', 'vuln-scan', 'exploit', 'internal']
  order.forEach((role, i) => {
    const pieces = [toTemplateLiteral(roles[role])]
    /* 公共段落按固定顺序拼在正文末尾：插入的是常量引用（生成物里是 ${COMMON_X}），
       运行时不读源文件，但拼出来的正文是完整的。 */
    for (const key of ROLE_COMMONS[role]) pieces.push('${' + commons[key].key + '}')
    const body = pieces.join('\\n\\n')
    parts.push('  ' + (role.includes('-') ? `'${role}'` : role) + ': `' + body + '`,')
    if (i === order.length - 1) parts.push('')
  })
  parts.push('}')
  parts.push('/* 角色清单（工具、面板、提示词刷新脚本共用）：顺序即推荐执行顺序。 */')
  parts.push("export const ROLE_ORDER = ['recon', 'assess', 'vuln-scan', 'exploit', 'internal']")
  parts.push("export const PLANNER_ROLE = 'plan'")
  parts.push('')

  const out = head + '\n' + SENTINEL + '\n' + parts.join('\n') + '\n' + tail
  writeFileSync(corePath, out, 'utf8')
  const total = order.reduce((n, r) => n + roles[r].length, 0)
  console.log(`✓ 提示词已生成：${order.length} 个角色（${Object.keys(commons).length} 个公共段落），正文合计 ${total} 字符`)
}

main()
