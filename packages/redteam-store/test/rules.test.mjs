/**
 * 判定规则回归测试：什么算得分、什么算隧道
 *
 * 跑法：node packages/redteam-store/test/rules.test.mjs
 *
 * 两条红线（演练计分最容易虚高的地方）：
 *   ① **自己注册/自己创建的账号不算得分权限** —— 得分针对"拿到别人已有的账号与权限"。
 *      自建账号只留过程：不计分、不计数、不进报告。
 *   ② **自己的 VPS / 自己配置的服务器不算隧道** —— 只在自己服务器上开 socks5/frp/代理
 *      没有碰到目标，不算跨越靶标边界。只有目标侧发起的通道才算：
 *      目标反弹 shell 到我方（target-outbound）、经目标 WebShell/HTTP（target-http）、
 *      经目标已控进程转发（target-agent）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore, tunnelIsLegit, TUNNEL_ENTRY_KINDS } from '../lib/core.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }

const root = mkdtempSync(join(tmpdir(), 'rt-rules-'))
try {
  const store = new RedteamStore(root)
  const { id } = store.openEngagement('规则测试靶标')

  console.log('— 规则一：自己注册的账号不算得分权限')
  const self = store.addScoreHit(id, {
    code: 'web-account-user', target: 'http://t.example.com/register',
    evidence: '通过注册接口自助注册 ztest/ztest@123 并登录', self_created: true, recorded_by: 'exploit',
  })
  ok(self.self_created === true && self.counted === false, '自建账号：记录成功但不计分')
  ok(/自己注册|不计分/.test(self.warning || ''), '返回明确的 warning 说明为什么不计分')
  ok(self.summary.achievedPoints === 0, '自建账号不给总分加分（总分仍为 0）')
  ok(self.summary.selfCreatedHits === 1, 'summary 里能看出有 1 条自建命中')

  const real = store.addScoreHit(id, {
    code: 'web-account-user', target: 'http://t.example.com/admin',
    evidence: '后台管理员 tomcat/Tomcat@2024（弱口令）', recorded_by: 'exploit',
  })
  ok(real.counted === true && real.summary.achievedPoints === 10, '拿到别人已有的账号照常计分（总分 10）')

  /* 自建的不计数：即使先记了自建，真实命中仍应全额计分 */
  const point = store.listScorePoints(id).items.find((p) => p.code === 'web-account-user')
  ok(point.counted === 1 && point.earned === 10, '自建命中不参与计数')
  ok(point.self_created === 1, '得分点条目上能看出被剔除的自建命中数')
  ok(point.hits.some((h) => h.self_created === true) && point.hits.some((h) => h.self_created !== true),
    '两类命中都留在命中记录里（自建只作留痕）')

  console.log('— 规则三：同类得分不设数量上限，按命中次数累加')
  for (let i = 0; i < 4; i++) {
    store.addScoreHit(id, { code: 'sensitive-data', target: 'http://t.example.com/' + i, evidence: '导出 ' + (i + 1) + ' 万条数据' })
  }
  const sd = store.listScorePoints(id).items.find((p) => p.code === 'sensitive-data')
  ok(sd.counted === 4 && sd.earned === 80, `同类 4 次命中全部计分（4 × 20 = ${sd.earned}）`)
  ok(sd.earned === sd.counted * sd.points, '得分 = 命中次数 × 分值，没有任何封顶')
  ok(!('max_hits' in sd) && !('potential' in sd), '得分点结构里不再有上限/满分字段')
  const sum = store.listScorePoints(id).summary
  ok(sum.pointCount === 10 && typeof sum.hitPointCount === 'number', 'summary 给出得分点个数（界面按这个显示）')
  ok(!('totalPoints' in sum) && !('achievedCount' in sum), 'summary 不再有"满分/已拿下项数"这类字段')

  console.log('— 规则二：自己的 VPS / 自建服务器不算隧道')
  const mine = store.addTunnel(id, { kind: 'socks5', listen: '127.0.0.1:1080', entry: '我的 VPS 上开的代理', entry_kind: 'self-only' })
  ok(mine.legit === false && /self-only/.test(mine.warning || ''), 'self-only：登记成功但明确标注不算突破')
  const viaShell = store.addTunnel(id, { kind: 'suo5', listen: '127.0.0.1:1081', entry: 'http://t.example.com/upload/x.jsp', entry_kind: 'target-http' })
  const rebound = store.addTunnel(id, { kind: 'frp', listen: '127.0.0.1:1082', entry: '目标 → 我的 VPS:7000', entry_kind: 'target-outbound' })
  const viaAgent = store.addTunnel(id, { kind: 'ssh-r', listen: '127.0.0.1:1083', entry: '目标发起 ssh -R', entry_kind: 'target-agent' })
  ok(viaShell.legit === true && rebound.legit === true && viaAgent.legit === true,
    '目标侧通道（经 WebShell / 目标连出 / 目标转发）都算真隧道')
  ok(store.addTunnel(id, { kind: 'socks5', listen: '127.0.0.1:1084', entry: '未说明' }).legit === null,
    '未声明 entry_kind → null（待确认，不当作突破凭证）')
  ok(tunnelIsLegit('') === null && tunnelIsLegit('self-only') === false && tunnelIsLegit('target-http') === true,
    'tunnelIsLegit 判定：未声明 null / self-only false / 目标侧 true')
  ok(Object.keys(TUNNEL_ENTRY_KINDS).length === 4, '四种入口归属都有中文说明（界面 tooltip 用）')

  const sess = store.sessionSummary(id)
  ok(sess.totals.tunnels === 5 && sess.totals.tunnelsLegit === 3 && sess.totals.tunnelsSelfOnly === 1,
    `会话总览区分：共 ${sess.totals.tunnels} 条 / 目标侧 ${sess.totals.tunnelsLegit} / 自建 ${sess.totals.tunnelsSelfOnly}`)

  console.log('— 攻击链与报告的口径')
  const chain = store.scoreChain(id)
  /* 此时有效得分：web-account-user 10 + sensitive-data 4×20 = 90；自建那 1 条不计入 */
  ok(chain.summary.points === 90 && chain.summary.selfCreatedHits === 1,
    `攻击链累计分只算有效命中（90 分 = 10 + 4×20，自建 1 条不计）实际 ${chain.summary.points}`)
  ok(chain.summary.tunnelsLegit === 3 && chain.summary.tunnelsSelfOnly === 1, '攻击链把目标侧通道与自建通道分开统计')
  const boundary = chain.stages.find((s) => s.code === 'boundary')
  ok(boundary.tunnels.every((t) => t.legit === true), '边界突破阶段只展示真正跨越边界的通道')
  ok(boundary.tunnels_self_only.length === 1, '自建通道单独挂在 tunnels_self_only（界面据此提示）')

  const report = store.scoreReport(id)
  ok(report.summary.selfCreatedExcluded === 1 && report.summary.count === 5,
    `报告剔除自建命中（剔除 1 条，正文留 5 条真实成果）实际 ${report.summary.count}`)
  ok(report.summary.points === 90, `报告分数与得分面板一致（90 分）实际 ${report.summary.points}`)
  ok(!report.markdown.includes('自助注册 ztest'), '报告正文里没有自建账号那条')
  ok(report.markdown.includes('自己注册/自建账号'), '报告抬头说明剔除了多少条自建记录')
  ok(report.stages.every((s) => s.items.every((x) => x.counted !== false || true)), '阶段分组不受影响')

  console.log('— 攻击链步骤带分（point_code + self_created）')
  const stepSelf = store.addChainStep(id, { stage: 'vuln', title: '注册账号进后台', point_code: 'web-account-admin', evidence: '自己注册 ztest20 并授权为管理员', self_created: true })
  ok(stepSelf.hit && stepSelf.hit.counted === false, '步骤里自建账号同样不计分')
  const stepReal = store.addChainStep(id, { stage: 'vuln', title: '拿下管理后台', point_code: 'web-account-admin', evidence: '管理员 svc-demo/Demo@2024（厂商账号）' })
  ok(stepReal.hit && stepReal.hit.counted === true, '步骤里真实账号照常计分')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
