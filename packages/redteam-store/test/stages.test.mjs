/**
 * 阶段表自愈回归测试（对应 v0.4.2 的线上故障）
 *
 * 跑法：node packages/redteam-store/test/stages.test.mjs
 *
 * 故障现象：靶标库里 stage 表只剩 4 行（⑤靶标权限 被上一版迁移误删），
 * 于是「攻击链 / 报告」只统计到 450 分，而得分面板是 490 分 —— 差的 40 分
 * 正是 ⑤靶标权限 的命中，因为没有阶段行可挂。
 *
 * 这里断言三件事：
 *   1) 阶段行缺失时，scoreChain / scoreReport / listStages 都会自动补回；
 *   2) 补回后 ⑤ 拿到自己的得分，累计分与得分面板一致；
 *   3) 迁移不再清掉显式 stage_code='target'（新版里 'target' 仍是合法阶段）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore, DEFAULT_STAGES } from '../lib/core.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }

const root = mkdtempSync(join(tmpdir(), 'rt-stage-test-'))
try {
  const store = new RedteamStore(root)
  const { id } = store.openEngagement('测试靶标', ['10.0.0.0/8'])

  /* 造数据：一条 ⑤ 靶标得分（core-system → 自动归到 target） */
  const db = store.db(id)
  const point = db.prepare("SELECT id FROM score_point WHERE code = 'core-system'").get()
  ok(point !== undefined, '默认得分点里有 core-system')
  db.prepare(`INSERT INTO score_hit(point_id, target, evidence, recorded_by, recorded_at)
    VALUES(?,?,?,?,?)`).run(point.id, 'https://target.example', '靶标平台 管理员 admin/Admin@123', 'test', new Date().toISOString())

  const codes = () => db.prepare('SELECT code FROM stage ORDER BY sort_order').all().map((r) => r.code)
  ok(DEFAULT_STAGES.length === 5, `默认阶段 5 个（实际 ${DEFAULT_STAGES.length}）`)

  /* 阶段表是懒播种的：先读一次让它补齐，再模拟线上故障删掉 ⑤ */
  store.listStages(id)
  ok(codes().length === 5, `读一次阶段表即补齐 5 行（实际 ${codes().length}）`)
  db.prepare("DELETE FROM stage WHERE code = 'target'").run()
  ok(codes().join(',') === 'recon,internet,boundary,internal', `故障复现：stage 表只剩 4 行（实际 ${codes().join(',')}）`)

  /* scoreChain 应自愈并把 40 分挂到 ⑤ */
  const chain = store.scoreChain(id)
  ok(chain.stages.length === 5, `scoreChain 自愈回 5 个阶段（实际 ${chain.stages.length}）`)
  ok(codes().length === 5, 'DB 里的阶段行已被补回')
  const target = chain.stages.find((s) => s.code === 'target')
  ok(target !== undefined && target.points > 0, `⑤靶标权限 拿到 +${target && target.points} 分`)
  ok(chain.summary.points === chain.stages[chain.stages.length - 1].cumulative,
    `累计分与得分面板一致（${chain.summary.points} = ${chain.stages[chain.stages.length - 1].cumulative}）`)

  /* 再删一次，report 也要自愈 */
  db.prepare("DELETE FROM stage WHERE code = 'target'").run()
  const report = store.scoreReport(id)
  /* 报告只保留有内容的阶段，但被删掉的阶段行必须已被补回 DB */
  ok(codes().length === 5, `scoreReport 也把阶段行补回（实际 ${codes().length} 行）`)
  ok(report.stages.length > 0 && report.stages.length <= 5, `报告只列有内容的阶段（${report.stages.length} 个）`)
  /* 空阶段会被报告跳过，但序号必须仍是完整链表里的真实位置 */
  const tSt = report.stages.find((s) => s.code === 'target')
  ok(tSt !== undefined && tSt.ordinal === 5, `报告里的⑤靶标权限序号是真实第 5 阶段（实际 ${tSt && tSt.ordinal}）`)
  ok(report.stages.every((s, i) => i === 0 || s.ordinal > report.stages[i - 1].ordinal), '报告阶段序号严格递增')
  ok(report.stages[report.stages.length - 1].cumulative === report.summary.points, '报告累计分 = 合计分')
  ok(/靶标权限/.test(report.markdown), '报告正文里出现「靶标权限」阶段')

  /* 迁移不应清掉显式 stage_code='target' */
  db.prepare("UPDATE score_hit SET stage_code = 'target'").run()
  store.db(id) /* 再开一次连接，跑一遍迁移 */
  const kept = store.scoreChain(id).items.filter((x) => x.stage_code === 'target').length
  ok(kept > 0, `重开靶标后显式 stage_code='target' 仍在（${kept} 条）`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
