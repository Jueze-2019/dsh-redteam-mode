/**
 * 迁移：清掉预发布期（≤0.7.0）用「开发版」安装留下的 profile 补丁行。
 *
 * 为什么需要它：那些机器在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里手写过
 *   - insert:
 *       - id: redteam-store
 *         name: dsh-redteam-store
 *         config: {…}
 *       - id: redteam-ui
 *         name: dsh-redteam-ui
 * bundle 补丁在**更早**的层里挂自己的行，改不动后面这一层，于是两套一起挂：
 *   service "redteam" has been registered at <redteam-store>
 * `dsh web` 起不来（0.7.0 之前报的是 duplicate loader entry id）。
 *
 * 做法：按行扫描，删掉这两条**条目本身及其子行**（缩进更深的部分），其它内容原样保留；
 * 若某个 `- insert:` 的子项被删空，连同那一行一起删。先备份再写回；幂等；支持 --dry-run。
 *
 * 用法：
 *   node node_modules/hermes-dsh-redteam-mode/lib/migrate-legacy-rows.mjs [--profile web] [--dry-run]
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LEGACY_IDS = ['redteam-store', 'redteam-ui']

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const profileArg = args.indexOf('--profile')
const profile = profileArg >= 0 ? args[profileArg + 1] : 'web'
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const patchPath = join(dshHome, 'profiles', profile, 'cordis.patch.yml')

if (!existsSync(patchPath)) {
  console.log(`没有找到 profile 补丁：${patchPath}（无事可做）`)
  process.exit(0)
}

const indentOf = (line) => (/^[ \t]*/.exec(line) || [''])[0].length
const isBlank = (line) => line.trim() === ''

/**
 * 删掉一个条目：从 `- id: <legacyId>` 那行开始，连带删除后续**缩进更深**的行
 * （它自己的 name/config/…），遇到缩进不更深且非空的行就停。
 */
function removeEntry(lines, legacyId) {
  const out = []
  const removed = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^[ \t]*-[ \t]+id:[ \t]*(\S+)[ \t]*$/.exec(line)
    if (m === null || m[1] !== legacyId) { out.push(line); continue }
    const base = indentOf(line)
    removed.push(line.trim())
    let j = i + 1
    while (j < lines.length) {
      const next = lines[j]
      if (isBlank(next)) { j++; continue }            /* 条目内的空行也一并吃掉 */
      if (indentOf(next) <= base) break
      j++
    }
    i = j - 1
  }
  return { lines: out, removed }
}

/** 删掉子项已被删空的 `- insert:` 行。 */
function dropEmptyInserts(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^[ \t]*-[ \t]*insert:[ \t]*$/.test(line)) {
      let j = i + 1
      let hasChild = false
      while (j < lines.length) {
        const next = lines[j]
        if (isBlank(next)) { j++; continue }
        if (indentOf(next) <= indentOf(line)) break
        hasChild = true
        break
      }
      if (!hasChild) continue
    }
    out.push(line)
  }
  return out
}

const original = readFileSync(patchPath, 'utf8')
let lines = original.split('\n')
const removed = []
for (const id of LEGACY_IDS) {
  const res = removeEntry(lines, id)
  lines = res.lines
  removed.push(...res.removed)
}
lines = dropEmptyInserts(lines)
/* 补丁文件必须是顶层 YAML 数组：整份被删空时要写回 `[]`，不能留空文件
   （空文件会让 boot 报 "must be a top-level YAML array of loader patch entries"）。 */
let text = lines.join('\n')
if (text.split('\n').every((l) => l.trim() === '' || l.trim().startsWith('#'))) text = '[]\n'

if (removed.length === 0) {
  console.log(`✓ ${patchPath} 里没有预发布期的遗留行（无需迁移）`)
  process.exit(0)
}

const before = original.split('\n').filter((l) => l.trim() !== '').length
const after = text.split('\n').filter((l) => l.trim() !== '').length
if (dryRun) {
  console.log(`[dry-run] 将删除 ${removed.length} 条遗留行，有效行 ${before} → ${after}（文件未改动）`)
  process.exit(0)
}

const backup = `${patchPath}.bak-${Date.now()}`
copyFileSync(patchPath, backup)
writeFileSync(patchPath, text, 'utf8')
console.log(`✓ 已删除 ${removed.length} 条遗留行（有效行 ${before} → ${after}）`)
console.log(`  备份：${backup}`)
console.log('  重启 dsh web 即可。')
