/**
 * 阶段表回归：四阶段 + 靶标系统从得分阶段移除
 *
 * 跑法：node packages/redteam-store/test/stages.test.mjs
 *
 * 规则变更：靶标系统不再单独计分，也不再有独立阶段。
 * 进入内网后拿到的系统权限按「内网资产权限」累计；老库里的 target 阶段与
 * stage_code='target' 命中在打开靶标时自动迁回 internal（外网资产则回 internet）。
 *
 * 这里断言：
 *   1) 默认阶段只有 4 个，target 不再出现；
 *   2) 集权系统等得分按资产内外网归属落阶段，不再被强制归到 target；
 *   3) 阶段行缺失时 scoreChain / scoreReport / listStages 仍会自愈；
 *   4) 老库 target 阶段与 stage_code='target' 会被迁移掉。
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
  const db = store.db(id)

  /* 内网资产 + 集权系统得分：旧版会强制归 target，新版应按 asset.scope 归 internal */
  const now = new Date().toISOString()
  const assetId = Number(db.prepare(`INSERT INTO asset(segment_cidr, ip, ip_int, state, confidence, first_seen, last_seen, scope)
    VALUES(?,?,?,?,?,?,?,?)`).run('10.0.0.0/24', '10.0.0.5', 167772165, 'live', 0.9, now, now, 'internal').lastInsertRowid)
  const point = db.prepare("SELECT id FROM score_point WHERE code = 'central-system'").get()
  ok(point !== undefined, '默认得分点里有 central-system（集权系统，规则 7）')
  db.prepare(`INSERT INTO score_hit(point_id, asset_id, target, evidence, recorded_by, recorded_at)
    VALUES(?,?,?,?,?,?)`).run(point.id, assetId, 'https://10.0.0.5:8443/admin', '集权平台管理员 admin/Admin@123', 'test', now)

  const codes = () => db.prepare('SELECT code FROM stage ORDER BY sort_order').all().map((r) => r.code)
  ok(DEFAULT_STAGES.length === 4 && DEFAULT_STAGES.every((s) => s.code !== 'target'),
    `默认阶段 4 个且不含 target（实际 ${DEFAULT_STAGES.map((s) => s.code).join(',')}）`)

  store.listStages(id)
  ok(codes().join(',') === 'recon,internet,boundary,internal',
    `读一次阶段表即四阶段（实际 ${codes().join(',')}）`)

  const chain = store.scoreChain(id)
  const internal = chain.stages.find((s) => s.code === 'internal')
  ok(internal !== undefined && internal.points > 0,
    `集权系统得分归入④内网资产权限 +${internal && internal.points} 分`)
  ok(!chain.stages.some((s) => s.code === 'target'), '攻击链不再出现⑤靶标权限阶段')
  ok(chain.summary.points === chain.stages[chain.stages.length - 1].cumulative,
    `累计分与得分面板一致（${chain.summary.points} = ${chain.stages[chain.stages.length - 1].cumulative}）`)

  const report = store.scoreReport(id)
  ok(report.report && report.report.stage_summary.length === 3
    && report.report.stage_summary.every((s) => s.code !== 'target'),
  '报告汇总只有互联网 / 边界 / 内网三个阶段')
  ok(report.report.stage_tables.target === undefined && report.report.repro.target === undefined,
    '报告模型不再生成 target 得分表 / 复现分组')
  ok(!report.markdown.includes('靶标权限') && !report.markdown.includes('### 2.4') && !report.markdown.includes('### 3.4'),
    '报告正文不再出现靶标权限 / 2.4 / 3.4')
  ok(report.markdown.includes('### 2.3 内网资产权限'), '报告仍保留 2.3 内网资产权限')
  const realOrder = store.listStages(id).map((s) => s.code)
  ok(report.stages.every((s) => s.ordinal === realOrder.indexOf(s.code) + 1),
    '报告阶段序号保留真实位置：' + report.stages.map((s) => s.ordinal + ':' + s.code).join(' '))
  ok(report.stages[report.stages.length - 1].cumulative === report.summary.points, '报告累计分 = 合计分')

  /* 自愈：删掉一个默认阶段，再读应补回；target 仍然不能回来 */
  db.prepare("DELETE FROM stage WHERE code = 'internal'").run()
  const healed = store.listStages(id)
  ok(healed.length === 4 && healed.some((s) => s.code === 'internal'), '阶段行缺失时自动补回（仍为 4 个）')
  ok(!healed.some((s) => s.code === 'target'), '自愈不会把 target 阶段补回来')

  /* 老库迁移：显式 stage_code='target' + target 阶段行 → 重开连接后迁回 internal 并删阶段 */
  const targetStageSql = `INSERT INTO stage(code, name, subtitle, color, goal, sections, tools, transition, sort_order, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`
  db.prepare("UPDATE score_hit SET stage_code = 'target'").run()
  db.prepare(targetStageSql).run('target', '靶标权限', 'TARGET', '#10b981', '旧阶段', '[]', '', '', 99, now)
  store.close() /* 关闭连接；重开时才会跑 migrate */
  const db2 = store.db(id)
  const migrated = db2.prepare("SELECT stage_code FROM score_hit WHERE point_id = ?").get(point.id)
  ok(migrated !== undefined && migrated.stage_code === 'internal',
    `老数据 stage_code='target' 迁移为 internal（实际 ${migrated && migrated.stage_code}）`)
  ok(db2.prepare("SELECT code FROM stage WHERE code = 'target'").get() === undefined,
    '老库 target 阶段行被删除')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
