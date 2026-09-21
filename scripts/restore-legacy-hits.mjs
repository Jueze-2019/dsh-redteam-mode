#!/usr/bin/env node
/**
 * 从「旧得分口径清理存档」恢复历史命中，并按《突破入侵类得分规则（合并版）》重新归类。
 *
 * 背景：v0.11.1 把旧得分项整套作废时，为可追溯把每个靶标的历史命中原样导出到
 * `runs/legacy-score-<时间>.json`，然后连点带命中一起删掉 —— 于是靶标的报告变空。
 * 本脚本把这些命中按新规则**重新归类后写回**，报告即可恢复。
 *
 * 用法：
 *   node scripts/restore-legacy-hits.mjs <靶标目录或靶标名> [--apply]
 *     · 不带 --apply 只打印将要写入的内容（dry-run，先看清楚再决定）
 *     · 带 --apply 真正写回（幂等：同一存档重复跑不会重复写入）
 *
 * 归类依据：旧 code → 新 code 的映射 + 证据文本里的系统类型关键词。
 * **映射表就在下面，改起来很直接**；逐条结果会打印出来供人工核对。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { RedteamStore } from '../packages/redteam-store/lib/core.js'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const target = args.find((a) => !a.startsWith('--'))
if (!target) {
  console.error('用法：node scripts/restore-legacy-hits.mjs <靶标目录或靶标名> [--apply]')
  process.exit(2)
}

import { classifyHit } from './lib/legacy-score-map.mjs'

/* ── 定位靶标 ────────────────────────────────────────────────────────────── */
const engagementsRoot = join(DSH_HOME, 'redteam', 'engagements')
const dir = resolve(
  existsSync(target) && target.includes('/') ? target
    : existsSync(target) ? target
      : join(engagementsRoot, target),
)
if (!existsSync(dir)) {
  console.error('找不到靶标目录：' + dir)
  process.exit(2)
}
const archives = readdirSync(dir).filter((f) => f.startsWith('legacy-score-') && f.endsWith('.json'))
  .concat(existsSync(join(dir, 'runs'))
    ? readdirSync(join(dir, 'runs')).filter((f) => f.startsWith('legacy-score-')).map((f) => join('runs', f))
    : [])
if (archives.length === 0) {
  console.error('该靶标没有 legacy-score-*.json 存档，无法恢复（可能当初没有历史命中）')
  process.exit(2)
}
const archivePath = join(dir, archives[archives.length - 1])
const archive = JSON.parse(readFileSync(archivePath, 'utf8'))
const pointById = new Map((archive.points || []).map((p) => [p.id, p]))

/* ── 归类 ────────────────────────────────────────────────────────────────── */
const planned = []
for (const h of archive.hits || []) {
  const old = pointById.get(h.point_id)
  if (old === undefined) continue
  const cls = classifyHit(old.code, h.evidence, h.target)
  if (cls === null) {
    planned.push({ h, old, skip: '旧 code 无映射：' + old.code })
    continue
  }
  planned.push({ h, old, ...cls })
}

console.log('靶标目录 :', dir)
console.log('存档文件 :', archivePath)
console.log('归档时间 :', archive.archived_at)
console.log('历史命中 :', (archive.hits || []).length, '条')
console.log('')
console.log('将按新规则归类为：')
console.log('  #  旧 code              新 code            分值  归属依据')
for (const [i, p] of planned.entries()) {
  if (p.skip !== undefined) {
    console.log(`  ${String(i + 1).padStart(2)}  ${String(p.old.code).padEnd(20)} ——                 ——    ⚠️ ${p.skip}`)
    continue
  }
  console.log(`  ${String(i + 1).padStart(2)}  ${String(p.old.code).padEnd(20)} ${String(p.code).padEnd(18)} ${String(p.points).padStart(4)}  ${p.why}`)
}

if (!APPLY) {
  console.log('')
  console.log('（dry-run，未写库。确认无误后加 --apply 执行）')
  process.exit(0)
}

/* ── 写回 ────────────────────────────────────────────────────────────────── */
const store = new RedteamStore(DSH_HOME + '/redteam')
const id = dir.split('/').pop()
/* 幂等标记：同一条存档只恢复一次 */
const MARK = '【恢复·旧口径重归类】'
let written = 0
let skipped = 0
const existing = store.listScorePoints(id).items.flatMap((p) => p.hits.map((x) => String(x.note || '') + '|' + String(x.evidence || '').slice(0, 60)))
for (const p of planned) {
  if (p.skip !== undefined) { skipped += 1; continue }
  const note = MARK + p.old.code + ' → ' + p.code
  const key = note + '|' + String(p.h.evidence || '').slice(0, 60)
  if (existing.includes(key)) { skipped += 1; continue }
  try {
    store.addScoreHit(id, {
      code: p.code,
      points: p.points,
      target: p.h.target || null,
      asset_id: p.h.asset_id ?? null,
      evidence: String(p.h.evidence || ''),
      note,
      recorded_by: p.h.recorded_by || null,
    })
    written += 1
  } catch (error) {
    console.log('  ✗ 写入失败：' + (error && error.message ? error.message : String(error)))
    skipped += 1
  }
}
const board = store.listScorePoints(id)
console.log('')
console.log('已恢复 ' + written + ' 条，跳过 ' + skipped + ' 条')
console.log('当前总分：' + board.summary.achievedPoints + ' 分 · 计入命中 ' + board.summary.countedHits + ' 次')
console.log('提示：同一系统/主机按最高权限只计一次，重复的会被标为"不计分"（属正常，规则 G1）。')
