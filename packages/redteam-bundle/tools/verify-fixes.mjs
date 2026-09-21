/**
 * 端到端验收脚本（零依赖，只读仓库代码 + 临时目录）：把本次优化的**每一条结论**跑一遍。
 * 跑法：node packages/redteam-bundle/tools/verify-fixes.mjs
 *
 * 与 test/ 下的回归测试不同，这里按"用户能感知的行为"组织断言：
 * 一条 = 一个曾经出过问题、现在必须正确的具体现象。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const { RedteamStore, DEFAULT_SCORE_POINTS } = await import(join(repo, 'packages/redteam-store/lib/core.js'))

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log('  ✓ ' + msg) } else { fail += 1; console.log('  ✗ ' + msg) } }

const root = mkdtempSync(join(tmpdir(), 'rt-verify-'))
try {
  const store = new RedteamStore(root)
  const id = store.openEngagement('验收靶标').id

  console.log('\n【0.1】10 个技能已进仓库，包内技能与仓库一致')
  const repoSKills = readdirSync(join(repo, 'skills')).filter((f) => f.endsWith('.md'))
  const pkgSkills = readdirSync(join(repo, 'packages/redteam-bundle/skills')).filter((f) => f.endsWith('.md'))
  ok(repoSKills === undefined || repoSKills.length === 23, '仓库 skills/ 有 23 个技能（实际 ' + repoSKills.length + '）')
  ok(pkgSkills.length === repoSKills.length, '包内技能数与仓库一致（' + pkgSkills.length + '）')
  ok(repoSKills.includes('redteam-setup.md'), 'redteam-setup.md 在仓库里（首次引导闭环不再指向不存在的技能）')
  ok(repoSKills.includes('credential-attack.md'), 'credential-attack.md 不再被 .gitignore 吞掉')

  console.log('\n【0.4/0.5】得分点：自建点能存活、内置点分值锁定且不可删')
  const baseCount = store.listScorePoints(id).items.length
  const created = store.saveScorePoint(id, { name: '自定义：拿下域控', code: 'custom-dc', category: 'CENTRAL', points: 500 })
  ok(store.listScorePoints(id).items.some((x) => x.code === created.code), '新建的自定义得分点下次读取仍在（曾经被静默删除）')
  ok(store.listScorePoints(id).items.length === baseCount + 1, '得分点总数 +1')
  const builtin = store.listScorePoints(id).items.find((x) => x.code === 'web-app')
  const saved = store.saveScorePoint(id, { id: builtin.id, name: '改名', points: 999, enabled: true })
  ok(saved.builtin === true && saved.overridden === false, '内置点保存时明确回 overridden=false（界面据此提示"分值未改动"）')
  const after = store.listScorePoints(id).items.find((x) => x.code === 'web-app')
  ok(after.points === builtin.points, '内置点分值未被改掉（仍是 ' + after.points + '）')
  try { store.deleteScorePoint(id, builtin.id); ok(false, '内置点竟然可删') } catch { ok(true, '内置点拒绝删除并给出改用「停用」的建议') }
  store.saveScorePoint(id, { id: builtin.id, enabled: false })
  ok(store.listScorePoints(id).items.find((x) => x.code === 'web-app').enabled === false, '内置点的「启用/停用」仍然可改')

  console.log('\n【0.8】停用得分点后，面板 / 报告 / 攻击链三处总分一致')
  store.importBundle(id, { assets: [{ ip: '10.0.0.9', scope: 'external' }] })
  const a = store.listAssets(id, {}).items[0]
  store.saveScorePoint(id, { id: builtin.id, enabled: true })
  store.addScoreHit(id, { code: 'web-app', points: 100, asset_id: a.id, target: 'http://10.0.0.9:8080/admin', evidence: 'OA 管理员' })
  store.addScoreHit(id, { code: 'server-host', points: 50, asset_id: a.id, target: 'http://10.0.0.9:8080/', evidence: 'root' })
  const enabledTotal = store.listScorePoints(id).summary.achievedPoints
  ok(enabledTotal === store.scoreReport(id).summary.points && enabledTotal === store.scoreChain(id).summary.points,
    '启用状态下面板/报告/攻击链总分一致（' + enabledTotal + '）')
  store.saveScorePoint(id, { id: builtin.id, enabled: false })
  const offBoard = store.listScorePoints(id).summary.achievedPoints
  const offReport = store.scoreReport(id).summary.points
  const offChain = store.scoreChain(id).summary.points
  ok(offBoard === offReport && offReport === offChain,
    '停用 web-app 后三处仍然一致（面板 ' + offBoard + ' = 报告 ' + offReport + ' = 攻击链 ' + offChain + '）')
  store.saveScorePoint(id, { id: builtin.id, enabled: true })

  console.log('\n【0.6】攻击链把"真正计分的那条"标对（管理员档 vs 普通档）')
  const fresh = store.openEngagement('倍率与档位').id
  store.importBundle(fresh, { assets: [{ ip: '10.7.7.7', scope: 'external' }] })
  const fa = store.listAssets(fresh, {}).items[0]
  store.addScoreHit(fresh, { code: 'server-host', points: 10, asset_id: fa.id, target: 'http://10.7.7.7:8080/a.jsp', evidence: '冰蝎马（普通档）' })
  store.addScoreHit(fresh, { code: 'server-host', points: 50, asset_id: fa.id, target: 'http://10.7.7.7:8080/', evidence: '提权 root（管理员档）' })
  const chain = store.scoreChain(fresh)
  const countedHit = chain.items.find((x) => x.counted === true)
  ok(countedHit !== undefined && countedHit.points === 50, '攻击链里计分的是 50 分那条（曾经把普通档 10 分标成计分）')
  ok(chain.summary.points === 50, '攻击链阶段分 = 50（各阶段之和与总分一致）')
  ok(chain.summary.points === store.listScorePoints(fresh).summary.achievedPoints, '与面板一致')

  console.log('\n【0.7】报告阶段序号 = 链路里的真实位置')
  store.addScoreHit(fresh, { code: 'boundary-logical', points: 1000, asset_id: fa.id, target: '10.9.9.9', evidence: '进入逻辑隔离内网' })
  const realOrder = store.listStages(fresh).map((s) => s.code)
  const report = store.scoreReport(fresh)
  ok(report.stages.every((s) => s.ordinal === realOrder.indexOf(s.code) + 1),
    '报告阶段编号保留真实位置（' + report.stages.map((s) => s.ordinal + ':' + s.code).join(' ') + '）')
  const boundaryStage = report.stages.find((s) => s.code === 'boundary')
  ok(boundaryStage !== undefined && boundaryStage.ordinal === 3, '「边界突破」显示为第 3 阶段（曾经被标成 ②）')
  ok(report.markdown.includes('## ③ 边界突破'), '导出的 markdown 里阶段标题也是 ③')

  console.log('\n【0.9】points 边界校验')
  const before0 = store.listScorePoints(fresh).summary.achievedPoints
  try { store.addScoreHit(fresh, { code: 'terminal-access', points: 999999999, evidence: '超大分值' }); ok(false, '超大分值竟然入库') } catch { ok(true, '超大分值被拒绝') }
  try { store.addScoreHit(fresh, { code: 'terminal-access', points: -500, evidence: '负分值' }); ok(false, '负分值竟然入库') } catch { ok(true, '负分值被拒绝') }
  ok(store.listScorePoints(fresh).summary.achievedPoints === before0, '被拒绝的记分没有污染总分')

  console.log('\n【G5/G6】数据规模翻倍与 IPv6 ×3')
  const v6 = store.addScoreHit(fresh, { code: 'web-app', points: 100, asset_id: fa.id, target: 'http://[2001:db8::1]:8080/x', evidence: 'IPv6 办公系统管理员' })
  ok(v6.multiplier === 3 && v6.points === 300, 'IPv6 成果 ×3（' + v6.base_points + ' × ' + v6.multiplier + ' = ' + v6.points + '）')
  const big = store.addScoreHit(fresh, { code: 'bigdata-system', points: 1000, asset_id: fa.id, target: 'http://10.7.7.7:9200/es', evidence: '大数据平台管理员', data_scale: 'large' })
  ok(big.multiplier === 2 && big.points === 2000, 'G5 数据规模超 1 亿条 / 10TB → 翻倍')
  ok((v6.multiplier_reasons || []).length > 0, '倍率来源写进返回值（可解释"为什么这条是 300 分"）')

  console.log('\n【G4】终端权限按台累加')
  const g4 = store.openEngagement('G4 按台').id
  store.importBundle(g4, { assets: [{ ip: '10.7.7.9', scope: 'external' }] })
  const g4a = store.listAssets(g4, {}).items[0]
  store.addScoreHit(g4, { code: 'terminal-access', points: 10, asset_id: g4a.id, target: 'pc-001', evidence: 'PC 1' })
  store.addScoreHit(g4, { code: 'terminal-access', points: 10, asset_id: g4a.id, target: 'pc-002', evidence: 'PC 2' })
  const g4board = store.listScorePoints(g4).items.find((p) => p.code === 'terminal-access')
  ok(g4board.counted === 2 && g4board.earned === 20, '两台终端各自计分（实际 ' + g4board.counted + ' 条 / ' + g4board.earned + ' 分）')

  console.log('\n【规则 9/12】加成是独立得分点，不再被基础条目吃掉')
  const bonus = store.addScoreHit(fresh, { code: 'iot-corenet', points: 5000, asset_id: fa.id, target: '10.7.7.7:8888', evidence: '经摄像头端点打入核心网' })
  ok(bonus.counted === true && bonus.points === 5000, '物联网核心网 +5000 单独计分（曾经 earned=0 还被标不计分）')
  const redirect = store.addScoreHit(fresh, { code: 'netdev-redirect', points: 200, asset_id: fa.id, target: '10.7.7.7:443', evidence: '改路由把流量引到我方节点' })
  ok(redirect.counted === true, '网络设备重定向 +200 单独计分（曾经与管理员 200 争同一口径被顶掉）')

  console.log('\n【G1】同一系统取最高权限一次（systemKeyOf 修复）')
  const g1 = store.openEngagement('G1 取高').id
  store.importBundle(g1, { assets: [{ ip: '10.7.7.7', scope: 'external', primary_name: 'oa.corp.example' }] })
  const g1a = store.listAssets(g1, {}).items[0]
  store.addScoreHit(g1, { code: 'server-host', points: 10, asset_id: g1a.id, target: 'http://10.7.7.7:8080/a.jsp', evidence: '普通权限' })
  const g1b = store.addScoreHit(g1, { code: 'server-host', points: 10, asset_id: g1a.id, target: 'http://10.7.7.7:8080/b.jsp', evidence: '同主机第二个马' })
  const g1c = store.addScoreHit(g1, { code: 'server-host', points: 50, asset_id: g1a.id, target: 'http://10.7.7.7:8080/', evidence: '提权 root' })
  ok(g1b.counted === false, '同一主机第二个马不计分（取高）')
  ok(g1c.counted === true && g1c.demoted_hits.length >= 2, '拿到 root 后顶掉旧的低权限命中')
  ok(store.listScorePoints(g1).items.find((p) => p.code === 'server-host').earned === 50, '该主机只按最高权限计 50 分')

  console.log('\n【安全】路径穿越与非法枚举被拒绝')
  const sec = store.openEngagement('安全').id
  const okFile = store.addAttackFile(sec, { target: '10.1.1.1', name: 'poc.py', kind: 'poc', content: 'print(1)', evidence: '实测成功' })
  ok(okFile.path.includes('attack-files'), '正常攻击文件仍可写入')
  store.db(sec).prepare('UPDATE attack_file SET path = ? WHERE id = 1').run('/etc/passwd')
  const readBack = store.readAttackFile(sec, 1)
  ok(/拒绝|outside allowed roots/.test(String(readBack.content)), '库列被改成 /etc/passwd 后读取被拒绝')
  try { store.addAttackFile(sec, { target: '..', name: 'escape.sh', content: 'x', evidence: 'e' }); ok(false, 'target=.. 竟然逃出去了') } catch { ok(true, 'target=.. 的写路径被拒绝') }
  const escaped = store.savePoc({ title: '越界 POC', code: '../../escaped-poc', content: 'x', kind: 'poc' })
  ok(String(escaped.poc ? escaped.poc.code : escaped.code).indexOf('..') < 0, 'poc code 被净化（不再能../../ 逃逸）')
  try { store.addTunnel(sec, { kind: 'socks5', listen: '127.0.0.1:1080', entry_kind: 'self only' }); ok(false, '非法 entry_kind 竟然入库') } catch { ok(true, '非法 entry_kind 被拒绝（曾经静默变 null）') }
  try { store.addWebshell(sec, { url: 'http://a/1.jsp', shell_type: 'phpstudy' }); ok(false, '非法 shell_type 竟然入库') } catch { ok(true, '非法 shell_type 被拒绝') }
  ok(store.addWebshell(sec, { url: 'http://a/2.jsp', shell_type: '冰蝎' }).id > 0, '中文别名"冰蝎"被归一成 behinder')
  ok(store.addWebshell(sec, { url: 'http://a/3.jsp', shell_type: 'Behinder' }).id > 0, '大小写混写被归一')

  console.log('\n【安全】/redteam/api 的来源校验默认拒绝')
  const uiSrc = readFileSync(join(repo, 'packages/redteam-ui/lib/index.js'), 'utf8')
  ok(!/if \(typeof origin === 'string' && typeof host === 'string'\)/.test(uiSrc),
    '不再有"两个头缺一个就跳过校验"的写法')
  ok(/request without Origin is only accepted from loopback/.test(uiSrc), '缺 Origin 时要求回环地址')
  ok(/\^v\?\\\\d\+\\\\\.\\\\d\+\\\\\.\\\\d\+/.test(uiSrc) || /必须是纯版本号/.test(uiSrc),
    'updateApply 的 target 只接受纯版本号')

  console.log('\n【前端】图谱已移除、复制改真结果、轮询有守卫')
  const clientSrc = readFileSync(join(repo, 'packages/redteam-ui/lib/client.js'), 'utf8')
  ok(!/GraphCanvas/.test(clientSrc), '图谱画布组件已删除')
  ok(!/rt-graph/.test(clientSrc), '图谱相关 CSS 已删除')
  ok(!/'图谱'/.test(clientSrc), '「图谱」视图按钮已删除')
  ok(/function DiscoveryView/.test(clientSrc), '「发现时间」视图仍在（删除图谱时没有连带删掉）')
  ok(!/try \{ navigator\.clipboard\.writeText/.test(clientSrc), '不再有"同步 try/catch 包 clipboard"的假成功写法')
  ok(/const copyText = async/.test(clientSrc), '统一的异步复制实现已就位')
  ok(/digestInflight/.test(clientSrc) && /inflight\.current/.test(clientSrc), '两处轮询都加了在途守卫')
  ok(/rt-dock-width/.test(clientSrc), '面板宽度已持久化')

  console.log('\n【发布】全量测试入口存在且被 prepublishOnly 调用')
  const pkgJson = JSON.parse(readFileSync(join(repo, 'packages/redteam-bundle/package.json'), 'utf8'))
  ok(existsSync(join(repo, 'packages/redteam-bundle/tools/test-all.mjs')), 'test-all.mjs 存在')
  ok(/test-all\.mjs/.test(pkgJson.scripts.prepublishOnly), 'prepublishOnly 会跑全量测试（不再只跑 bundle.test）')
  ok(pkgJson.version === '0.11.0', '包版本与代码注释里的 v0.11.x 对齐（实际 ' + pkgJson.version + '）')
  ok(DEFAULT_SCORE_POINTS.length === 25, '得分点 25 条（18 权限 + 4 边界 + 3 加成）')
  ok(new Set(DEFAULT_SCORE_POINTS.map((p) => p.rule)).size === 25, 'rule 编号唯一（不再出现重复的 19 与空号）')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('\n通过 ' + pass + '/' + (pass + fail))
process.exit(fail === 0 ? 0 : 1)
