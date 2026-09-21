/**
 * 判定规则回归测试：什么算得分、什么算隧道
 *
 * 跑法：node packages/redteam-store/test/rules.test.mjs
 *
 * 四条红线（演练计分最容易虚高的地方）：
 *   ① **自己注册/自己创建的账号不算得分权限** —— 得分针对"拿到别人已有的账号与权限"。
 *      自建账号只留过程：不计分、不计数、不进报告。
 *   ② **自己的 VPS / 自己配置的服务器不算隧道** —— 只在自己服务器上开 socks5/frp/代理
 *      没有碰到目标，不算跨越靶标边界。只有目标侧发起的通道才算：
 *      目标反弹 shell 到我方（target-outbound）、经目标 WebShell/HTTP（target-http）、
 *      经目标已控进程转发（target-agent）。
 *   ③ **账号权限按「同一资产 + 同一端口」封顶** —— 拿到最高权限账号即该服务拿满：
 *      普通账号与管理员争同一个名额（只算分值最高的那条），同服务再刷账号不再累加。
 *   ④ **数据库权限同口径** —— 一个库（资产 + 端口）拿到权限即拿满，换端口才另算。
 *      其它得分点（webshell / rce / sensitive-data / boundary …）仍按命中次数累加。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore, tunnelIsLegit, TUNNEL_ENTRY_KINDS, scoreServiceKey, DEFAULT_SCORE_POINTS } from '../lib/core.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }

const root = mkdtempSync(join(tmpdir(), 'rt-rules-'))
try {
  const store = new RedteamStore(root)
  const { id } = store.openEngagement('规则测试靶标')

  console.log('— 规则零：按 code 记分（回归：曾经把 code 查找整段删掉，只剩 point_name，导致用 code 记分全部报错）')
  const byCode = store.addScoreHit(id, { code: 'server-host', points: 50, target: '10.9.9.9:22', evidence: '按 code 记分回归用例' })
  ok(byCode.counted === true && byCode.points === 50, 'addScoreHit 能按 code 找到得分点并采用 points 档位分值')
  ok(store.listScorePoints(id).items.find((p) => p.code === 'server-host') !== undefined, '得分点 code 可被读取到')

  console.log('— 规则一：自己注册的账号不算得分权限')
  const self = store.addScoreHit(id, {
    code: 'web-app', target: 'http://t.example.com/register',
    evidence: '通过注册接口自助注册 ztest/ztest@123 并登录', self_created: true, recorded_by: 'exploit',
  })
  ok(self.self_created === true && self.counted === false, '自建账号：记录成功但不计分')
  ok(/自己注册|不计分/.test(self.warning || ''), '返回明确的 warning 说明为什么不计分')
  ok(self.summary.achievedPoints === byCode.points, '自建账号不给总分加分（总分保持在上一条真实得分）')
  ok(self.summary.selfCreatedHits === 1, 'summary 里能看出有 1 条自建命中')

  const real = store.addScoreHit(id, {
    code: 'web-app', points: 50, target: 'http://t.example.com/admin', port: 443,
    evidence: '后台普通用户 tomcat/Tomcat@2024（弱口令，普通档 50 分）', recorded_by: 'exploit',
  })
  ok(real.counted === true && real.summary.achievedPoints === byCode.points + 50,
    '拿到别人已有的账号照常计分（业务系统普通账号档 50 分，在基线之上累加）')

  /* 自建的不计数：即使先记了自建，真实命中仍应全额计分 */
  const point = store.listScorePoints(id).items.find((p) => p.code === 'web-app')
  ok(point.counted === 1 && point.earned === 50, '自建命中不参与计数')
  ok(point.self_created === 1, '得分点条目上能看出被剔除的自建命中数')
  ok(point.hits.some((h) => h.self_created === true) && point.hits.some((h) => h.self_created !== true),
    '两类命中都留在命中记录里（自建只作留痕）')

  /* ── 规则四：账号权限 / 数据库权限按「同一资产 + 同一端口」封顶 ─────────────
     拿到最高权限账号即该服务拿满：同一服务上再刷账号不再累加（只算分值最高的那条）。 */
  console.log('— 规则四：同资产同端口的账号权限只算一次（最高权限拿满即封顶）')
  const assetId = (() => {
    const now = new Date().toISOString()
    const r = store.db(id).prepare(`INSERT INTO asset(segment_cidr, ip, ip_int, state, confidence, first_seen, last_seen, scope)
      VALUES(?,?,?,?,?,?,?,?)`).run('10.7.7.0/24', '10.7.7.7', 174556935, 'live', 0.9, now, now, 'internal')
    return Number(r.lastInsertRowid)
  })()
  /* 第二台资产：给"跨资产/多台"的用例留位置（G4 按台累加、G6 只与地址形态有关） */
  const a2 = (() => {
    const now = new Date().toISOString()
    const r = store.db(id).prepare(`INSERT INTO asset(segment_cidr, ip, ip_int, state, confidence, first_seen, last_seen, scope)
      VALUES(?,?,?,?,?,?,?,?)`).run('10.7.7.0/24', '10.7.7.9', 174556937, 'live', 0.9, now, now, 'external')
    return { id: Number(r.lastInsertRowid), ip: '10.7.7.9' }
  })()
  const svc = 'http://10.7.7.7:8080'
  const acc1 = store.addScoreHit(id, { code: 'web-app', points: 50, asset_id: assetId, target: svc + '/login', evidence: '普通账号 user1/111（普通档 50 分）' })
  ok(acc1.counted === true && acc1.service === '10.7.7.7:8080', '第一条账号命中计分，并识别出服务（10.7.7.7:8080）')
  ok(real.counted === true, '（前一条 443 服务上的真实账号命中已计分：不同服务互不影响）')
  const acc2 = store.addScoreHit(id, { code: 'web-app', points: 50, asset_id: assetId, target: svc + '/login', evidence: '普通账号 user2/222（普通档 50 分）' })
  ok(acc2.counted === false && acc2.capped_by_service === true, '同服务刷第二个账号不计分（服务已拿满）')
  ok(/已经拿满|只算一次/.test(acc2.warning || ''), '返回明确的封顶 warning（告诉智能体别再刷）')
  ok(acc2.summary.achievedPoints === acc1.summary.achievedPoints, '刷第二个账号不会让总分增加')
  const acc3 = store.addScoreHit(id, { code: 'web-app', points: 100, asset_id: assetId, target: svc + '/admin', evidence: '管理员 admin/Admin@2024（管理员档 100 分）' })
  ok(acc3.counted === true, '同服务拿到更高权限账号（管理员）时这条计分')
  ok(acc3.demoted_hits.length === 2 && acc3.demoted_hits.every((h) => h.evidence.includes('user')),
    '先记的两个普通账号被顶掉（转为不计分），总分按最高权限那条算')
  const acc4 = store.addScoreHit(id, { code: 'web-app', points: 50, asset_id: assetId, target: svc + '/x', evidence: '普通账号 user3/333（普通档 50 分）' })
  ok(acc4.counted === false, '拿到管理员后再补普通账号：依然不计分（同服务只算最高权限那条）')
  const acc5 = store.addScoreHit(id, { code: 'web-app', asset_id: assetId, target: 'http://10.7.7.7:9090/login', evidence: '另一个端口的普通账号 user9/999' })
  ok(acc5.counted === true && acc5.service === '10.7.7.7:9090', '换一个端口（另一个服务）照常计分')
  const accBoard = store.listScorePoints(id)
  const accItems = accBoard.items.filter((p) => p.code === 'web-app' || p.code === 'web-app')
  ok(accItems.reduce((n, p) => n + p.counted, 0) === 3, '三个服务（443/8080/9090）= 三笔账号分（同一服务上的多条只算一条）')
  ok(accItems.reduce((n, p) => n + p.capped, 0) === 3, '被封顶的重复命中在得分点条目上单独计数')
  ok(accBoard.summary.serviceCappedHits === 3, 'summary 给出被封顶命中数（界面与工具据此提示）')
  const cappedHit = accItems.flatMap((p) => p.hits).find((h) => h.capped === true)
  ok(cappedHit.service === '10.7.7.7:8080' && typeof cappedHit.capped_reason === 'string',
    '每条被封顶的命中都带服务标签与原因')

  console.log('— 规则四之二：服务键的推导（同服务的不同写法要归到一起）')
  ok(scoreServiceKey({ target: 'nk.example.gov.cn' }) === scoreServiceKey({ target: 'nk.example.gov.cn' }),
    '只写了域名（没有端口）：同域名 = 同一个服务')
  ok(scoreServiceKey({ target: 'http://h/x' }) === scoreServiceKey({ target: 'http://h:80/y' }),
    'http 未写端口与 :80 视为同一个服务（https→443 同理）')
  ok(scoreServiceKey({ target: 'http://h:8080/a' }) !== scoreServiceKey({ target: 'http://h:9090/a' }),
    '不同端口 = 不同服务')
  ok(scoreServiceKey({ target: 'http://h:8080/a/b?c=1' }) === scoreServiceKey({ target: 'http://h:8080/other' }),
    '路径/参数不参与服务判定（http://h:8080/a/b?c=1 与 /other 同服务）')
  ok(scoreServiceKey({ asset_id: 7, target: 'http://10.0.0.5:8080/x' }) === scoreServiceKey({ target: '10.0.0.5:8080' }),
    '同一个服务由不同人记分（一个带 asset_id、一个只写 target）也归到一起')
  ok(scoreServiceKey({ asset_id: 7, port: 3306 }) === 'a7:3306' && scoreServiceKey({ asset_id: 7 }) === 'a7:0',
    '完全没有 target 时退到资产 + 端口（没有端口记 0）')

  console.log('— 规则四之三：面板与报告的总分必须一致（曾经报告用旧封顶函数，两边对不上）')
  {
    const boardNow = store.listScorePoints(id)
    const reportNow = store.scoreReport(id)
    ok(boardNow.summary.achievedPoints === reportNow.summary.points,
      'score_list 与 score_report 总分一致（面板 ' + boardNow.summary.achievedPoints + ' = 报告 ' + reportNow.summary.points + '）')
    ok(boardNow.summary.countedHits === reportNow.summary.count,
      '计分命中数一致（面板 ' + boardNow.summary.countedHits + ' = 报告 ' + reportNow.summary.count + '）')
  }

  console.log('— 排序与分组：已得分的排前面、其余按分值升序；类别分组不重复')
  {
    const sorted = store.listScorePoints(id)
    ok(sorted.ruleGroups.length === 8, '按合并版的 8 个类别分组（实际 ' + sorted.ruleGroups.length + '）')
    ok(new Set(sorted.items.map((x) => x.category)).size === 8,
      '每个类别只有一组（category 无中英混用导致的重复分组）')
    let achievedFirst = true
    let ascInBucket = true
    for (const g of sorted.ruleGroups) {
      let seenUnachieved = false
      for (const item of g.tiers) {
        const achieved = item.hits.length > 0
        if (!achieved) seenUnachieved = true
        else if (seenUnachieved) achievedFirst = false
      }
      /* 同桶内按分值升序：分别检查"已得分"与"未得分"两段 */
      for (const bucket of [g.tiers.filter((x) => x.hits.length > 0), g.tiers.filter((x) => x.hits.length === 0)]) {
        for (let i = 1; i < bucket.length; i += 1) {
          if (Number(bucket[i].points) < Number(bucket[i - 1].points)) ascInBucket = false
        }
      }
    }
    ok(achievedFirst, '组内：已得分的条目排在未得分之前')
    ok(ascInBucket, '同组同段内按分值从低到高')
  }

  console.log('— 规则五：数据库权限同口径（同服务只算一次）')
  const db1 = store.addScoreHit(id, { code: 'db-credential', asset_id: assetId, target: '10.7.7.7:3306', evidence: 'MySQL root/root（拖库）' })
  const db2 = store.addScoreHit(id, { code: 'db-credential', asset_id: assetId, target: '10.7.7.7:3306', evidence: 'MySQL 第二个库账号 app/app' })
  ok(db1.counted === true && db2.counted === false, '同一个库（10.7.7.7:3306）刷第二个账号不计分')
  ok(db2.summary.achievedPoints === db1.summary.achievedPoints, '刷第二个库账号不会让总分增加')
  const db3 = store.addScoreHit(id, { code: 'db-credential', asset_id: assetId, target: '10.7.7.7:6379', evidence: 'Redis 未授权 6379' })
  ok(db3.counted === true, '换一个数据库服务（端口不同）照常计分')

  console.log('— 规则六：规则 3「同一主机只算最高权限一次」（新口径）')
  const u1 = store.addScoreHit(id, { code: 'server-host', points: 10, asset_id: assetId, target: svc + '/upload/x.jsp', evidence: '冰蝎马 x.jsp（普通权限档 10 分）' })
  const u2 = store.addScoreHit(id, { code: 'server-host', points: 10, asset_id: assetId, target: svc + '/upload/y.jsp', evidence: '哥斯拉马 y.jsp（同一主机第二个马，同为普通档 10 分）' })
  ok(u1.counted === true, '第一条服务器权限命中计分')
  ok(u2.counted === false && u2.capped_by_service === true,
    '同一主机上的第二条（同档位同系统）不计分 —— 按「同一系统只算最高权限一次」（换马不重复计分）')
  const adm = store.addScoreHit(id, { code: 'server-host', points: 50, asset_id: assetId, target: svc, evidence: '提权到 root（管理员档 50 分）' })
  ok(adm.counted === true, '同一主机拿到更高权限（root）时这条计分、并顶掉普通权限那条')
  ok(adm.demoted_hits.length >= 1, '被顶掉的普通权限命中转为不计分（总分按最高权限算）')
  const otherHost = store.addScoreHit(id, { code: 'server-host', points: 50, asset_id: assetId, target: 'http://10.7.7.8:8080', evidence: '另一台主机 root（管理员档 50 分）' })
  ok(otherHost.counted === true, '换一台主机照常计分（上限按规则 3 的 600 分累计）')

  console.log('— 规则三：上限内按档位分值累加，到顶后不再累计（G3 各项上限独立）')
  /* 用一条 cap=600 的规则（规则 2 终端权限）验证"上限内累加、超出不计分"。
     命中不带 asset_id / target → 拿不到服务键 → 不参与计分口径去重，
     于是这条规则上的命中是纯粹的"次数 × 分值"，可以把 cap 行为单独隔离出来看。 */
  {
    const size = store.addScoreHit(id, { code: 'terminal-access', points: 10, evidence: '批量控下 62 台终端' })
    for (let i = 1; i < 62; i++) store.addScoreHit(id, { code: 'terminal-access', points: 10, evidence: '终端 #' + i })
    const sd = store.listScorePoints(id).items.find((p) => p.code === 'terminal-access')
    ok(sd !== undefined, '得分点 code 可被读取到（terminal-access）')
    ok(sd.cap === 600 && sd.rule === 2, "该条上限来自规则文档（600 分，rule=2）实际 cap=" + sd.cap + " rule=" + sd.rule)
    ok(sd.counted === 60 && sd.earned === 600,
      `上限内 60 次命中全部计分（60 × 10 = ${sd.earned}，上限 ${sd.cap}）`)
    ok(sd.capped === 2, `超出上限的 2 次标为不计分（实际 ${sd.capped}）`)
    ok(sd.cap_used === 600, `上限用量回给界面（cap_used=${sd.cap_used}）`)
    const capHit = sd.hits.find((h) => h.capped === true)
    ok(capHit !== undefined && capHit.capped_reason_kind === 'cap' && /上限/.test(capHit.capped_reason || ''),
      '超上限的命中带 kind=cap 与可读原因（界面据此提示"别再刷了"）')
    ok(sd.earned === sd.counted * sd.points, '上限内：得分 = 计入次数 × 分值')
    ok(!('max_hits' in sd) && !('potential' in sd), '得分点结构里不再有上限/满分字段')
    ok(size.summary.achievedPoints === sd.earned + size.summary.achievedPoints - sd.earned, '（记分不抛异常）')
  }
  const sum = store.listScorePoints(id).summary
  ok(sum.pointCount === DEFAULT_SCORE_POINTS.length && typeof sum.hitPointCount === 'number',
    `summary 给出得分点个数（= 规则文档展开后的 ${DEFAULT_SCORE_POINTS.length} 个得分点）`)
  ok(!('totalPoints' in sum) && !('achievedCount' in sum), 'summary 不再有"满分/已拿下项数"这类字段')
  ok(DEFAULT_SCORE_POINTS.length === 25,
    '默认得分点数 = 25（《合并版》一、获取权限 18 条 + 二、突破网络边界 4 条 + 3 条附加成果加成：'
    + '网络设备重定向 +200 / 植入远控 +1000 / 物联网核心网 +5000）')
  ok(DEFAULT_SCORE_POINTS.filter((p) => ['netdev-redirect', 'netdev-implant', 'iot-corenet'].includes(p.code)).length === 3,
    '三条"加成"是独立得分点（压在基础条目里会共用它的 rule 上限、被基础分吃掉）')
  ok(DEFAULT_SCORE_POINTS.find((p) => p.code === 'iot-corenet').cap === 5000,
    '物联网核心网 +5000 不被基础条目的 2000 分上限吃掉（文档写"单独加 5000 分"）')
  ok(DEFAULT_SCORE_POINTS.find((p) => p.code === 'terminal-access').dedup_scope === 'system',
    '终端权限按台计分（G4）：用 system 口径，同一台设备只算一次、不同设备累加')
  ok(new Set(DEFAULT_SCORE_POINTS.map((p) => p.rule)).size === DEFAULT_SCORE_POINTS.length,
    '每条默认得分点的 rule 编号唯一（不再出现两条都编号 19）')

  console.log('— 规则七：points 边界校验（分值由调用方按档位指定，不接受越界值）')
  {
    let negativeRejected = false
    try { store.addScoreHit(id, { code: 'terminal-access', points: -500, evidence: '负数分值' }) } catch { negativeRejected = true }
    ok(negativeRejected, '负分值被拒绝（不允许把总分拉低）')
    let hugeRejected = false
    try { store.addScoreHit(id, { code: 'terminal-access', points: 999999999, evidence: '超大分值' }) } catch { hugeRejected = true }
    ok(hugeRejected, '超出该条上限的量级被拒绝（不允许把总分刷到 9 位数）')
    const okHit = store.addScoreHit(id, { code: 'terminal-access', points: 5, evidence: '5 分/台的 wifi 路由器' })
    ok(okHit.points === 5, '规则内的档位分值（5 分）正常入库')
    /* 该条规则的 600 分额度已在上面用满，所以这条按"超上限"不计分 —— 顺带验证上限是对
       整条规则累计的，而不是对单次命中：第 61、62 条各 10 分已超，这条 5 分同样超。 */
    ok(okHit.counted === false && /上限/.test(okHit.warning || ''),
      '上限用满后即使是很小的档位分值也不再累计（规则上限对整条规则生效）')
  }

  console.log('— G5 / G6 倍率：数据规模翻倍、IPv6 ×3（作用在权限分上，不突破原上限）')
  {
    const v6 = store.addScoreHit(id, {
      code: 'web-app', points: 100, asset_id: a2.id,
      target: 'http://[2001:db8::10]:8080/site', evidence: 'IPv6 可达的办公系统（管理员档）',
    })
    ok(v6.base_points === 100 && v6.multiplier === 3 && v6.points === 300,
      `IPv6 成果 ×3（base ${v6.base_points} × ${v6.multiplier} = ${v6.points}）`)
    ok((v6.multiplier_reasons || []).some((x) => x.includes('IPv6')),
      '返回值说明倍率来源（界面与模型都能看懂"为什么这条是 300 分"）')
    const v4 = store.addScoreHit(id, {
      code: 'web-app', points: 100, asset_id: a2.id,
      target: 'http://10.7.7.9:8080/site', evidence: '同一系统走 IPv4（不该有倍率）',
    })
    ok(v4.multiplier === 1 && v4.points === 100, 'IPv4 命中不放大（×1）')
    const big = store.addScoreHit(id, {
      code: 'bigdata-system', points: 1000, asset_id: a2.id,
      target: 'http://10.7.7.9:9200/es', evidence: '大数据平台管理员', data_scale: 'large',
    })
    ok(big.multiplier === 2 && big.points === 2000, 'G5 数据规模超 1 亿条 / 10TB → 翻倍')
    const kb = store.addScoreHit(id, {
      code: 'model-compute', points: 500, asset_id: a2.id,
      target: 'http://10.7.7.9:8081/train', evidence: '训练数据/知识库系统管理员', data_scale: 'knowledge-base',
    })
    ok(kb.multiplier === 2 && kb.points === 1000, 'G5 控制知识库相关系统 → 翻倍')
    /* 倍率**不突破原上限**：G6 的 ×3 也要被 cap 约束（文档明确要求） */
    const capProbe = store.addScoreHit(id, {
      code: 'boundary-logical', points: 1000, asset_id: a2.id,
      target: 'http://[2001:db8::11]/vpn', evidence: 'IPv6 侧进入逻辑隔离内网',
    })
    ok(capProbe.points === 3000, '边界突破 1000 分在 IPv6 下计 3000（×3 生效）')
    const boundaryPoint = store.listScorePoints(id).items.find((p) => p.code === 'boundary-logical')
    ok(boundaryPoint.cap === 0, '边界突破这条本身不设上限（target 口径保证整目标只算一次）')
  }

  console.log('— 终端权限按台累加（G4）：不同设备各自计分，同一台不重复')
  {
    /* ⚠️ 必须换一个**干净靶标**：本文件前面的"规则三"已经把 terminal-access 的 600 分上限
       在 `id` 上用满，在同一个靶标里再记终端只会得到"已超上限"，验不出按台累加 —
       那样测试会变成假绿（看起来通过，实际测的是 cap 而不是 G4）。 */
    const fresh = store.openEngagement('G4 按台累加').id
    store.importBundle(fresh, { assets: [{ ip: '10.7.7.9', scope: 'external' }] })
    const fa = store.listAssets(fresh, {}).items[0]
    const t1 = store.addScoreHit(fresh, { code: 'terminal-access', points: 10, asset_id: fa.id, target: 'pc-001', evidence: '办公 PC pc-001' })
    const t2 = store.addScoreHit(fresh, { code: 'terminal-access', points: 10, asset_id: fa.id, target: 'pc-002', evidence: '办公 PC pc-002' })
    const t3 = store.addScoreHit(fresh, { code: 'terminal-access', points: 5, asset_id: fa.id, target: 'printer-1', evidence: '打印机 printer-1（5 分档）' })
    const t2again = store.addScoreHit(fresh, { code: 'terminal-access', points: 10, asset_id: fa.id, target: 'pc-002', evidence: '同一台重复登记' })
    ok(t1.counted === true && t2.counted === true,
      '不同终端各自计分（按台累加，不再被"同一服务只算一条"吃掉）')
    ok(t3.counted === true && t3.points === 5, '5 分档设备（打印机）同样计入')
    ok(t2again.counted === false, '同一台终端重复登记不计分（system 口径按设备去重）')
    const board = store.listScorePoints(fresh).items.find((p) => p.code === 'terminal-access')
    ok(board.earned === 25 && board.counted === 3,
      `三台设备累计 25 分（10 + 10 + 5，实际 ${board.earned} 分 / ${board.counted} 条）`)
  }

  console.log('— 附加成果加成是独立得分点（不再被基础条目的上限吃掉）')
  {
    const redirect = store.addScoreHit(id, {
      code: 'netdev-redirect', asset_id: a2.id, target: '10.7.7.9:443',
      evidence: '改路由把办公网流量引到我方可控节点', points: 200,
    })
    ok(redirect.counted === true && redirect.points === 200,
      '网络设备重定向 +200 单独计分（曾与"管理员 200 分"争同一口径、被顶掉）')
    const corenet = store.addScoreHit(id, {
      code: 'iot-corenet', asset_id: a2.id, target: '10.7.7.9:8888',
      evidence: '从摄像头端点打入核心网，控下生产调度系统', points: 5000,
    })
    ok(corenet.counted === true && corenet.points === 5000,
      '物联网核心网 +5000 单独计分（曾压在 cap=2000 的条目下，earned=0 还被标不计分）')
  }

  console.log('— 控制台未读摘要（每个页签一个轻量指针）')
  const digest = store.consoleDigest(id)
  ok(digest.sections && digest.sections.assets.count >= 1 && typeof digest.sections.assets.at === 'string',
    '资产页签给出条数与最近发现时间')
  ok(digest.sections.scores.count === store.listScorePoints(id).summary.hitCount,
    '得分页签的条数与得分面板一致（面板据此点未读红点）')
  ok(digest.sections.prompts.count === 0 && digest.sections.skills.count === 0,
    '随包分发的静态页签（提示词/技能库）不产生未读')
  const before = digest.sections.findings.count
  store.addScoreHit(id, { code: 'boundary-logical', target: 'http://t.x/vpn', evidence: 'VPN 网关拿下，可达内网 10.0.0.0/8' })
  ok(store.consoleDigest(id).sections.scores.count === digest.sections.scores.count + 1,
    '新记一次得分 → 得分页签条数 +1（红点条件）')

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
  /* 此时有效得分（v0.11 合并版口径）：
     账号/业务系统 50（443 普通档）+ 50（8080 普通档）+ 100（8080 管理员档）+ 50（9090 普通档）= 250
     数据库 50×2（两个库服务）                                                 = 100
     服务器主机 50（规则零那条 10.9.9.9:22）
     终端权限 60×10 = 600（上限 600 正好用满）
     边界突破 1000（boundary-logical）
     自建命中与同服务重复命中都不计入 */
  /* 期望值不写死数字：本用例的命中条数会随上面各段一起变，写死只会制造脆断言。
     真正要守住的是**三处口径必须一致** —— 面板 / 攻击链 / 报告。 */
  const board = store.listScorePoints(id)
  const EXPECTED_POINTS = board.summary.achievedPoints
  ok(EXPECTED_POINTS > 0, `面板给出有效总分（${EXPECTED_POINTS} 分）`)
  ok(chain.summary.points === EXPECTED_POINTS && chain.summary.selfCreatedHits === 1,
    `攻击链累计分只算有效命中（${EXPECTED_POINTS} 分，与面板一致；自建与同服务重复命中不计）实际 ${chain.summary.points}`)
  /* 被封顶的命中分两类，都只作过程留痕：dedup（服务已拿满）与 cap（规则达上限） */
  ok(chain.summary.serviceCappedHits === board.summary.serviceCappedHits,
    `攻击链与面板的被封顶/超上限命中数一致（${chain.summary.serviceCappedHits} = ${board.summary.serviceCappedHits}）`)
  ok(chain.summary.serviceCappedHits > 0, '确有命中被封顶/超上限（否则上面这条断言没有意义）')
  ok(chain.items.some((x) => x.capped === true && x.counted === false), '被封顶的命中在链路里标为不计分')
  ok(chain.summary.tunnelsLegit === 3 && chain.summary.tunnelsSelfOnly === 1, '攻击链把目标侧通道与自建通道分开统计')
  /* 阶段 code 是"攻击面位置"（recon/internet/boundary/internal/target），
     不是得分点 code —— 边界突破的得分点（boundary-logical）落在 boundary 阶段 */
  const boundary = chain.stages.find((s) => s.code === 'boundary')
  ok(boundary !== undefined && boundary.tunnels.every((t) => t.legit === true),
    '边界突破阶段只展示真正跨越边界的通道')
  ok(boundary.tunnels_self_only.length === 1, '自建通道单独挂在 tunnels_self_only（界面据此提示）')
  /* 阶段序号必须是**链路里的真实位置**（界面画 ①②③ 与报告排序都用它） */
  const realOrder = store.listStages(id).map((s) => s.code)
  ok(chain.stages.every((s) => s.ordinal === realOrder.indexOf(s.code) + 1),
    '攻击链阶段序号 = 链路里的真实位置（' + chain.stages.map((s) => s.ordinal + ':' + s.code).join(' ') + '）')
  /* 链路条目必须显示**本条命中的实际档位分值**，不是得分点默认值：
     默认值参与计分竞争会让'哪条计分'判反（普通档 10 分被当成 50 分参赛）。 */
  ok(chain.items.some((x) => x.code === 'server-host' && Number(x.points) === 50),
    '链路条目带的是本条实际档位分值（server-host 管理员档 50），不是默认值')
  ok(chain.summary.points === chain.stages.reduce((n, s) => n + s.points, 0),
    '链路各阶段分之和 = 总分（阶段分与 items 用同一套分值）')

  const report = store.scoreReport(id)
  ok(report.summary.selfCreatedExcluded === board.summary.selfCreatedHits,
    `报告与面板剔除了同样多的自建命中（${report.summary.selfCreatedExcluded} 条）`)
  const totalHits = store.db(id).prepare('SELECT COUNT(*) AS n FROM score_hit').get().n
  ok(report.summary.count === totalHits - board.summary.selfCreatedHits - board.summary.serviceCappedHits,
    `报告正文条数 = 命中总数 - 自建 - 被封顶（${totalHits} - ${board.summary.selfCreatedHits} - `
    + `${board.summary.serviceCappedHits} = ${report.summary.count}）`)
  ok(report.summary.serviceCappedExcluded === board.summary.serviceCappedHits,
    `报告也剔除被封顶/超上限的命中（剔除 ${report.summary.serviceCappedExcluded} 条）`)
  ok(report.summary.points === EXPECTED_POINTS,
    `报告分数与得分面板一致（${EXPECTED_POINTS} 分）实际 ${report.summary.points}`)
  ok(!report.markdown.includes('自助注册 ztest'), '报告正文里没有自建账号那条')
  ok(report.markdown.includes('自己注册/自建账号'), '报告抬头说明剔除了多少条自建记录')
  /* 措辞在报告重写时变过（「抬头」改成「先补这些」上方的一行说明），但**要求没变**：
     报告必须写明有多少条同服务重复命中被剔除。 */
  ok(report.markdown.includes('同资产同端口重复的账号/数据库权限'),
    '报告说明剔除了多少条同服务重复命中')
  /* 报告阶段编号必须是真实位置：过滤掉空阶段**不能**重新编号，
     否则"边界突破"会被标成 ②（实际是第 3 阶段），攻击链图与 markdown 一起错。 */
  ok(report.stages.every((s) => s.ordinal === realOrder.indexOf(s.code) + 1),
    '报告阶段编号保留真实位置（不因过滤空阶段而重排）：'
    + report.stages.map((s) => s.ordinal + ':' + s.code).join(' '))
  for (const s of report.stages) {
    const circled = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'][s.ordinal - 1]
    ok(report.markdown.includes('## ' + circled + ' ' + s.name),
      `报告 markdown 的阶段标题用真实序号（${circled} ${s.name}）`)
  }

  console.log('— 攻击链步骤带分（point_code + self_created + 服务封顶）')
  const stepSelf = store.addChainStep(id, { stage: 'vuln', title: '注册账号进后台', point_code: 'web-app', evidence: '自己注册 ztest20 并授权为管理员', self_created: true })
  ok(stepSelf.hit && stepSelf.hit.counted === false, '步骤里自建账号同样不计分')
  const stepReal = store.addChainStep(id, {
    stage: 'vuln', title: '拿下管理后台', point_code: 'web-app',
    asset_id: assetId, target: 'http://10.7.7.7:8443/admin', evidence: '管理员 svc-demo/Demo@2024（厂商账号）',
  })
  ok(stepReal.hit && stepReal.hit.counted === true, '步骤里真实账号照常计分')
  const stepDup = store.addChainStep(id, {
    stage: 'vuln', title: '再刷一个同服务账号', point_code: 'web-app',
    asset_id: assetId, target: 'http://10.7.7.7:8443/admin2', evidence: '管理员 svc-2/Demo@2024',
  })
  ok(stepDup.hit && stepDup.hit.counted === false && /已经拿满|只算一次/.test(stepDup.score_hint || ''),
    '步骤里同服务重复账号：不计分，并把封顶原因回给模型（score_hint）')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
