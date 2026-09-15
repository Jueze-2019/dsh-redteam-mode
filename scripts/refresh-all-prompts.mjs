#!/usr/bin/env node
/**
 * 批量把各靶标的角色提示词升级到当前内置默认版本。
 *
 * 跑法：
 *   node scripts/refresh-all-prompts.mjs            # 升级（等价于依次打开每个靶标的「提示词」面板）
 *   node scripts/refresh-all-prompts.mjs --dry-run  # 只报告会改哪些，不落盘
 *
 * 为什么需要它：角色提示词是**按靶标**存的文件（`$DSH_HOME/redteam/engagements/<靶标>/agents/*.md`），
 * 只在读提示词（面板打开 / `redteam_role_prompt`）时才比对指纹并升级。于是改完提示词后，老靶标要
 * 一个个打开面板才会跟上。本脚本把这步批量化。
 *
 * 判定逻辑**不在这里重写**，直接调服务端的 `store.refreshDefaultPrompts(id)`，因此保证同样的语义：
 *   · 内容 == 本靶标上次写入默认的指纹（`agents/.defaults.json`）或任一历史默认指纹（`LEGACY_PROMPT_HASHES`）
 *     → 判定为内置默认，换成新版；
 *   · 两者都不匹配 → 判定为**用户自己写的，原样保留**；
 *   · 覆盖前自动写 `.bak-<时间戳>` 备份，并刷新 manifest。
 *
 * 只读写 `agents/` 下的 md 与 manifest，**不碰 assets.db**。
 *
 * ⚠️ 若打印出「用户自写(保留)」，说明那个角色确实被人工改过——不要用 rm 硬覆盖，先在备份里比对。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { RedteamStore, DEFAULT_PROMPTS } from '../packages/redteam-store/lib/core.js'

const ROLES = ['recon', 'vuln-scan', 'exploit', 'internal']
const dryRun = process.argv.includes('--dry-run')
const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'redteam')
const engDir = join(root, 'engagements')

if (!existsSync(engDir)) {
  console.error(`找不到靶标目录：${engDir}`)
  process.exit(1)
}

const store = new RedteamStore(root)
const names = readdirSync(engDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(engDir, d.name, 'agents')))
  .map((d) => d.name)
  .sort()

let up = 0
let kept = 0
let already = 0
const rows = []

for (const name of names) {
  const dir = join(engDir, name, 'agents')
  const read = (role) => {
    const f = join(dir, `${role}.md`)
    return existsSync(f) ? readFileSync(f, 'utf8').trim() : ''
  }
  const before = Object.fromEntries(ROLES.map((r) => [r, read(r)]))

  const result = dryRun ? { changed: 0, kept: [] } : store.refreshDefaultPrompts(name)

  const states = []
  for (const role of ROLES) {
    const after = read(role)
    const isNew = after === (DEFAULT_PROMPTS[role] || '').trim()
    const wasNew = before[role] === (DEFAULT_PROMPTS[role] || '').trim()
    if (isNew && !wasNew && !dryRun) { states.push(`${role}:升级`); up++ }
    else if (isNew && !wasNew) { states.push(`${role}:待升级`); up++ }
    else if (isNew) { states.push(`${role}:已最新`); already++ }
    else { states.push(`${role}:用户自写(保留)`); kept++ }
  }
  rows.push({ name, changed: result.changed, states: states.join('  ') })
}

const width = Math.max(...rows.map((r) => r.name.length), 4)
for (const r of rows) {
  console.log(`${r.name.padEnd(width)} | 替换 ${r.changed} | ${r.states}`)
}
console.log(
  `\n靶标 ${rows.length} 个${dryRun ? '（dry-run，未落盘）' : ''}：`
  + `升级 ${up} 个角色文件；已是新版 ${already} 个；用户自写保留 ${kept} 个`,
)
if (kept > 0) {
  console.log('提示：被保留的角色是人工改过的——升级不会覆盖它们，请人工决定是否要跟进新版。')
}
