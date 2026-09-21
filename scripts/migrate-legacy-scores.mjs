#!/usr/bin/env node
/**
 * 把"还没迁移过"的靶标批量迁到《突破入侵类得分规则（合并版）》口径。
 *
 * 两种输入：
 *   ① 有 `runs/legacy-score-*.json` 存档（旧点已删）→ 按存档恢复；
 *   ② 库内仍是旧口径（10 个旧得分点 + 历史命中）→ 就地重新归类后写回。
 * 归类规则与 scripts/restore-legacy-hits.mjs **共用同一份映射表**（按系统名判定）。
 *
 * 用法：
 *   node scripts/migrate-legacy-scores.mjs            # dry-run：列出每个靶标将迁移多少条
 *   node scripts/migrate-legacy-scores.mjs --apply     # 真正执行
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore } from '../packages/redteam-store/lib/core.js'
import { classifyHit } from './lib/legacy-score-map.mjs'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const APPLY = process.argv.includes('--apply')
const root = join(DSH_HOME, 'redteam', 'engagements')
const store = new RedteamStore(join(DSH_HOME, 'redteam'))

let totalHits = 0
let totalWritten = 0
let totalSkipped = 0
console.log('靶标'.padEnd(42) + '存档命中  恢复  备注')
console.log('-'.repeat(76))
for (const name of readdirSync(root)) {
  const dir = join(root, name)
  const runsDir = join(dir, 'runs')
  if (!existsSync(join(dir, 'assets.db'))) continue
  const archives = existsSync(runsDir)
    ? readdirSync(runsDir).filter((f) => f.startsWith('legacy-score-') && f.endsWith('.json'))
    : []
  if (archives.length === 0) continue
  /* 取最新那份存档（重复跑会生成多份，以最后一次为准） */
  const archivePath = join(runsDir, archives.sort().pop())
  const archive = JSON.parse(readFileSync(archivePath, 'utf8'))
  const pointById = new Map((archive.points || []).map((p) => [p.id, p]))
  const hits = archive.hits || []
  totalHits += hits.length

  if (!APPLY) {
    console.log(name.padEnd(42) + String(hits.length).padStart(6) + '     -  dry-run')
    continue
  }

  /* 幂等：库里已经有的（按 note 前缀 + 证据前 60 字判定）不再重复写 */
  const store2 = store
  let board
  try { board = store2.listScorePoints(name) } catch { board = null }
  const existing = new Set(board === null ? [] : board.items
    .flatMap((p) => p.hits.map((x) => String(x.evidence || '').slice(0, 60))))

  let written = 0; let skipped = 0
  for (const h of hits) {
    const old = pointById.get(h.point_id)
    if (old === undefined) { skipped += 1; continue }
    const cls = classifyHit(old.code, h.evidence, h.target)
    if (cls === null) { skipped += 1; continue }
    const key = String(h.evidence || '').slice(0, 60)
    if (existing.has(key)) { skipped += 1; continue }
    try {
      store2.addScoreHit(name, {
        code: cls.code, points: cls.points, target: h.target || null,
        asset_id: h.asset_id ?? null, evidence: String(h.evidence || ''),
        note: '【迁移·旧口径重归类】' + old.code + ' → ' + cls.code,
        recorded_by: h.recorded_by || null,
      })
      existing.add(key)
      written += 1
    } catch (e) {
      skipped += 1
    }
  }
  totalWritten += written
  totalSkipped += skipped
  const after = store2.listScorePoints(name)
  console.log(name.padEnd(42) + String(hits.length).padStart(6) + String(written).padStart(6)
    + '   总分 ' + after.summary.achievedPoints + ' 分 / 计分 ' + after.summary.countedHits + ' 次'
    + (skipped > 0 ? '（跳过 ' + skipped + '）' : ''))
}
console.log('-'.repeat(72))
console.log('存档命中合计 ' + totalHits + ' 条' + (APPLY ? '，已恢复 ' + totalWritten + ' 条（跳过 ' + totalSkipped + ' 条）' : ''))
console.log(APPLY ? '已执行。' : '（dry-run，未写库。加 --apply 执行）')
