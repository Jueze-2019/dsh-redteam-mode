#!/usr/bin/env node
/**
 * 把仓库技能的分类元数据同步到用户技能根（默认 $DSH_HOME/skills）的同名副本。
 *
 * 为什么需要：红队预设的技能根顺序是 `$DSH_HOME/skills` → 包内 `skills/`，
 * **同名技能取先出现的那份**。早期部署在用户根留下的副本会遮住包内新版：
 * 表现是“包内技能有分类，面板里却显示未分类/旧描述”，而且升级后也不会自动更新。
 *
 * 本脚本只补 frontmatter 的 `category` / `tags` 和 description 的 `【分类】` 前缀，
 * **正文原样保留**（用户自己配的 VPS 地址、密钥、命令都不动）。
 *
 * 跑法：
 *   node scripts/sync-skill-metadata.mjs            # 同步 $DSH_HOME/skills
 *   node scripts/sync-skill-metadata.mjs --dry-run  # 只看会改哪些
 *   node scripts/sync-skill-metadata.mjs <dir>      # 指定技能根
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const dryRun = process.argv.includes('--dry-run')
const targetArg = process.argv.find((x, i) => i >= 2 && !x.startsWith('--'))
const target = targetArg || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'skills')

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  return m === null ? null : { match: m, body: m[1] }
}

/** 从仓库技能读 canonical category/tags。 */
function readRepoMeta() {
  const dir = join(repo, 'skills')
  const meta = new Map()
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const fm = frontmatter(readFileSync(join(dir, file), 'utf8'))
    if (fm === null) continue
    const category = /^category: (.+)$/m.exec(fm.body)
    const tags = /^tags: \[(.+)\]$/m.exec(fm.body)
    if (category !== null && tags !== null) {
      meta.set(file, { category: category[1].trim(), tags: tags[1].trim() })
    }
  }
  return meta
}

function applyMeta(text, { category, tags }) {
  const fm = frontmatter(text)
  if (fm === null) return null
  let body = fm.body
  let changed = false
  const hasCategory = /^category:/m.test(body)
  const hasTags = /^tags:/m.test(body)

  if (!hasCategory) {
    if (/^role:/m.test(body)) body = body.replace(/^role:.*$/m, (line) => `${line}\ncategory: ${category}`)
    else if (/^whenToUse:/m.test(body)) body = body.replace(/^whenToUse:.*$/m, (line) => `${line}\ncategory: ${category}`)
    else body = body.replace(/^description:.*$/m, (line) => `${line}\ncategory: ${category}`)
    changed = true
  }
  if (!hasTags) {
    body = body.replace(/^category:.*$/m, (line) => `${line}\ntags: [${tags}]`)
    changed = true
  }
  const desc = /^description: (.*)$/m.exec(body)
  if (desc !== null && !desc[1].startsWith(`【${category}】`)) {
    body = body.replace(/^description: (.*)$/m, (line, value) => `description: 【${category}】${value.replace(/^【[^】]+】/, '')}`)
    changed = true
  }
  if (!changed) return null
  return text.slice(0, fm.match.index) + `---\n${body}\n---` + text.slice(fm.match.index + fm.match[0].length)
}

if (!existsSync(target)) {
  console.error(`找不到技能目录：${target}`)
  process.exit(1)
}
const meta = readRepoMeta()
let changed = 0
let skipped = 0
for (const file of readdirSync(target).filter((f) => f.endsWith('.md'))) {
  const canonical = meta.get(file)
  if (canonical === undefined) { skipped += 1; continue }
  const path = join(target, file)
  const text = readFileSync(path, 'utf8')
  const next = applyMeta(text, canonical)
  if (next === null) continue
  changed += 1
  console.log(`${dryRun ? '待同步' : '已同步'} ${file} → ${canonical.category}`)
  if (!dryRun) writeFileSync(path, next, 'utf8')
}
console.log(`\n目标：${target}`)
console.log(`${dryRun ? '将同步' : '已同步'} ${changed} 个；无对应仓库技能 / 无需改动 ${skipped} 个`)
