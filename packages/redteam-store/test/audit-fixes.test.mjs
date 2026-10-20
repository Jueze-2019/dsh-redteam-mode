/**
 * P0 审计修复回归：
 *   ① 资产梳理可按 assessed=no / sort=unassessed / offset 翻页；
 *   ② 边界突破必须带 boundary_evidence，缺失时明确 warning，证据落进 note；
 *   ③ G5 data_scale=large 触发 ×2（工具 schema 已开放该参数）。
 *
 * 跑法：node packages/redteam-store/test/audit-fixes.test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore } from '../lib/core.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }

const root = mkdtempSync(join(tmpdir(), 'rt-audit-fixes-'))
try {
  const store = new RedteamStore(root)
  const { id } = store.openEngagement('审计修复测试靶标')
  const now = new Date().toISOString()
  const mk = (ip) => Number(store.db(id).prepare(`INSERT INTO asset(segment_cidr, ip, ip_int, state, confidence, first_seen, last_seen, scope)
    VALUES(?,?,?,?,?,?,?,?)`).run('10.20.30.0/24', ip, 0, 'live', 0.9, now, now, 'internal').lastInsertRowid)
  const a1 = mk('10.20.30.11')
  const a2 = mk('10.20.30.12')
  const a3 = mk('10.20.30.13')

  console.log('— 一、资产梳理的 assessed/offset 翻页')
  let page = store.listAssets(id, { assessed: 'no', sort: 'unassessed', limit: 2, offset: 0 })
  ok(page.total === 3 && page.items.length === 2, 'assessed=no 只返回未评估资产，limit=2 生效')
  const page2 = store.listAssets(id, { assessed: 'no', sort: 'unassessed', limit: 2, offset: 2 })
  ok(page2.items.length === 1 && !page.items.some((x) => x.id === page2.items[0].id), 'offset 能翻到下一页且不与第一页重复')
  store.assessAsset(id, { asset_id: a1, priority: 'high', potential: 'server-host', reason: '测试' })
  ok(store.listAssets(id, { assessed: 'yes' }).total === 1, 'assessAsset 后 assessed=yes 能查到')
  ok(store.listAssets(id, { assessed: 'no' }).total === 2, '已评估资产从 assessed=no 中移除')

  console.log('— 二、边界突破必须带 boundary_evidence')
  const bare = store.addScoreHit(id, { code: 'boundary-logical', asset_id: a2, target: '10.99.0.0/24', evidence: '隧道可达内网' })
  ok(/边界突破证据缺失/.test(bare.warning || ''), '缺 boundary_evidence 时返回明确 warning')
  const withEvidence = store.addScoreHit(id, {
    code: 'boundary-supply', asset_id: a3, target: '10.99.1.0/24', evidence: '经供应商运维通道进入主防单位内网',
    boundary_evidence: '入口：供应商 frp；落点：主防单位 10.99.1.0/24；跨网闸；访问 10.99.1.8:6379 返回 PONG',
  })
  ok(!/边界突破证据缺失/.test(withEvidence.warning || ''), '带 boundary_evidence 时不再报缺失')
  const point = store.listScorePoints(id).items.find((p) => p.code === 'boundary-supply')
  const hit = point.hits.find((h) => h.id === withEvidence.id)
  ok(/【边界证据】/.test(String(hit.note || '')), '边界证据写入命中 note，报告可复核')

  console.log('— 三、G5 data_scale 翻倍')
  const big = store.addScoreHit(id, {
    code: 'bigdata-system', asset_id: a1, target: 'http://10.20.30.11:8080', points: 1000,
    evidence: '导出 1.2 亿条用户数据', data_scale: 'large',
  })
  ok(big.multiplier === 2 && big.points === 2000, 'data_scale=large 时 1000 分 → 2000 分（×2）')
  ok(Array.isArray(big.multiplier_reasons) && big.multiplier_reasons.some((x) => x.includes('G5')), '返回倍率原因，报告能解释分值')

  console.log('— 四、资产归属证明进入报告（不再靠靶标关键词猜）')
  store.updateAssetTest(id, { asset_id: a1, test: '归属证明：ICP备20260001号；首页页脚单位名称与目标一致' })
  store.addScoreHit(id, { code: 'server-host', points: 50, asset_id: a1, target: '10.20.30.11:22', evidence: 'root 权限' })
  const rep = store.scoreReport(id, { limit: 20 })
  ok(/归属证明：ICP备20260001号/.test(rep.markdown), '报告第一节带上 test_notes 里的归属证明')
  ok(new RegExp('\\| `10\\.20\\.30\\.11`.*\\| 强 \\|').test(rep.markdown), '有 ICP/备案证明时资产行判“强”')


  console.log('— 五、得分点带判定标准/自证材料（SCORE_CONFIRM）')
  const sp = store.listScorePoints(id).items.find((p) => p.code === 'server-host')
  ok(sp && typeof sp.evidence_need === 'string' && sp.evidence_need.length > 5, 'server-host 带 evidence_need（判定标准）')
  ok(sp && typeof sp.evidence_proof === 'string' && sp.evidence_proof.length > 5, 'server-host 带 evidence_proof（自证材料）')

} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n通过 ${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
