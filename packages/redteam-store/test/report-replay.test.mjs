/**
 * 报告复现能力回归测试（零依赖）。
 *
 * 跑法：node packages/redteam-store/test/report-replay.test.mjs
 *
 * 用户反馈："报告里的得分点没讲明白得分过程、难以复现，还要有 Yakit 的数据报重放。"
 * 这个文件把那次修复的**每一条要求**钉成断言，防止以后改报告时又退化回去：
 *   ① 每条得分都要有"凭什么算拿到 / 要附什么材料"（得分过程）；
 *   ② 复现入口必须给出（Yakit 报文 / 终端命令 / 动作模板，至少一个）；
 *   ③ 抓到真实请求时，Yakit 报文必须是**原文**（不许截断，否则重放不了）；
 *   ④ 合成的东西必须标注来源，不能与真实抓包混为一谈；
 *   ⑤ 不相干的凭据/会话不许挂到条目上（曾经一条"终端权限"下面挂着 MySQL 凭据）；
 *   ⑥ 报告要简洁：响应体截断、条目里不重复堆凭据清单。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore, SCORE_CONFIRM, DEFAULT_SCORE_POINTS } from '../lib/core.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log('  ✓ ' + msg) } else { fail += 1; console.log('  ✗ ' + msg) } }

const root = mkdtempSync(join(tmpdir(), 'rt-reptest-'))
try {
  const store = new RedteamStore(root)
  const id = store.openEngagement('报告复现测试').id
  store.importBundle(id, {
    assets: [
      { ip: '203.0.113.10', scope: 'external', primary_name: 'oa.example.com', ports: [{ port: 8080, state: 'open', service: 'http', url: 'http://oa.example.com:8080/', title: 'OA' }] },
      { ip: '10.20.30.40', scope: 'internal' },
    ],
  })
  const [ext, int] = store.listAssets(id, {}).items

  console.log('— 得分过程说明：每个得分点都要有"凭什么算拿到 / 要附什么材料"')
  ok(Object.keys(SCORE_CONFIRM).length >= DEFAULT_SCORE_POINTS.length,
    '交付口径表覆盖全部 ' + DEFAULT_SCORE_POINTS.length + ' 个得分点（实际 ' + Object.keys(SCORE_CONFIRM).length + ' 条）')
  const missingConfirm = DEFAULT_SCORE_POINTS.filter((p) => SCORE_CONFIRM[p.code] === undefined)
  ok(missingConfirm.length === 0, '没有缺交付口径的得分点' + (missingConfirm.length ? '：' + missingConfirm.map((x) => x.code).join(',') : ''))
  ok(Object.values(SCORE_CONFIRM).every((c) => c.need && c.proof),
    '每条交付口径都有 need（判定标准）与 proof（自证材料）')

  /* ── 场景一：有真实抓包（最理想）────────────────────────────────────────── */
  const vuln = store.addVuln(id, {
    asset_id: ext.id, title: '后台文件上传 getshell', cve: 'CVE-2020-1938', severity: 'critical',
    status: 'exploited', target: 'http://oa.example.com:8080/admin/upload',
    gained: '服务器权限（www-data）', evidence: '上传 shell.jsp 返回 200', source: '手工验证',
  })
  const REQ = 'POST /admin/upload HTTP/1.1\r\nHost: oa.example.com:8080\r\nCookie: JSESSIONID=ABC\r\n\r\nbody'
  const RESP = 'HTTP/1.1 200 OK\r\n\r\n' + 'x'.repeat(3000)
  store.addHttpEvidence(id, { vuln_id: vuln.id, asset_id: ext.id, label: '上传请求', method: 'POST', url: 'http://oa.example.com:8080/admin/upload', status: 200, request: REQ, response: RESP })
  const step = store.addChainStep(id, {
    stage_code: 'internet', title: '上传并验证', agent: 'exploit',
    tool: 'curl -F "file=@shell.jsp" http://oa.example.com:8080/admin/upload',
    result: 'uid=33(www-data)', vuln_id: vuln.id, asset_id: ext.id,
  })
  store.addScoreHit(id, { code: 'server-host', points: 50, asset_id: ext.id, vuln_id: vuln.id, step_id: step.id, target: 'http://oa.example.com:8080/', evidence: '冰蝎马可连接' })

  /* 隧道 + 边界突破（target 写的是"可达网段"，不是入口主机） */
  store.addTunnel(id, { asset_id: ext.id, kind: 'suo5', listen: '127.0.0.1:1080', entry: 'http://oa.example.com:8080/shell.jsp', reach: '10.20.30.0/24', entry_kind: 'target-http', command: 'suo5 -t http://oa.example.com:8080/shell.jsp -l 1080' })
  store.addScoreHit(id, { code: 'boundary-logical', points: 1000, asset_id: ext.id, target: '10.20.30.0/24', evidence: 'suo5 隧道可达 10.20.30.0/24' })

  /* 内网：凭据 + 终端（**故意**让终端条目的 target 与凭据资产不同，验证不会误挂） */
  store.addCredential(id, { asset_id: int.id, host: '10.20.30.40', username: 'root', secret_value: 'R00t@2024', secret_type: 'password', privilege: '管理员', source: '配置文件泄露', tool: 'cat config.php' })
  store.addScoreHit(id, { code: 'db-credential', points: 50, asset_id: int.id, target: '10.20.30.40:3306', evidence: 'MySQL root 登录成功' })
  store.addScoreHit(id, { code: 'terminal-access', points: 10, asset_id: ext.id, target: 'pc-001', evidence: '控下办公 PC' })

  const rep = store.scoreReport(id)
  const byCode = new Map(rep.items.map((x) => [x.code, x]))

  console.log('\n— 复现入口：每条都得给出可照做的入口')
  ok(rep.items.every((x) => x.replay_cmd !== null || x.replay_http !== null),
    '每条得分都至少有一个复现入口（命令 / 报文）')
  ok(rep.items.every((x) => x.confirm !== null),
    '每条得分都带"凭什么算拿到 / 要附什么材料"')

  console.log('\n— Yakit 报文：真实抓包必须是原文（截断就重放不了）')
  const shell = byCode.get('server-host')
  ok(shell.replay_http === REQ, 'Yakit 报文 = 抓包原文（未被截断/改写）')
  ok(shell.replay_source === 'linked', '标注为 linked（显式关联的真实证据）')
  ok(shell.replay_http_synthesized === false, '真实抓包不算"合成"')
  const mdHttpBlocks = (rep.markdown.match(/```http/g) || []).length
  ok(mdHttpBlocks >= 1, 'markdown 里有可复制的 http 代码块（' + mdHttpBlocks + ' 个）')
  ok(rep.markdown.includes('POST /admin/upload HTTP/1.1'), 'markdown 里是完整报文首行')
  ok(rep.markdown.includes('Yakit'), 'markdown 里说明了怎么用 Yakit 重放')

  console.log('\n— 简洁：响应体截断并标注长度，不把整段响应堆进报告')
  ok(!rep.markdown.includes('x'.repeat(1500)), '响应体已截断（没有把 3000 字符原样塞进 markdown）')
  ok(/响应共 \d+ 字符/.test(rep.markdown), '截断处标明原始长度')

  console.log('\n— 不相干的凭据不许挂到条目上（曾经"终端权限"下挂着 MySQL 凭据）')
  const terminal = byCode.get('terminal-access')
  ok(terminal.credentials.length === 0,
    '终端权限（ext 资产、target=pc-001）不再挂 int 资产的 MySQL 凭据（实际 ' + terminal.credentials.length + ' 条）')
  const db = byCode.get('db-credential')
  ok(db.credentials.length === 1, '数据库条目挂上了自己的凭据（target 主机与资产 IP 一致）')

  console.log('\n— 边界突破：隧道要挂上，且复现命令用隧道监听端口填好')
  const boundary = byCode.get('boundary-logical')
  ok(boundary.tunnels.length === 1,
    '边界突破条目挂上了隧道（target 是可达到网段，属资产级成果）实际 ' + boundary.tunnels.length + ' 条')
  ok(boundary.replay_cmd !== null && boundary.replay_cmd.includes('1080'),
    '复现命令用隧道监听端口 1080 填好：' + JSON.stringify(boundary.replay_cmd))
  ok((boundary.replay_cmd_unfilled || []).length === 0, '边界突破的复现命令没有剩余占位符')

  console.log('\n— 数据库条目：模板用本条记录的 host 填好')
  ok(db.replay_cmd !== null && db.replay_cmd.includes('10.20.30.40'),
    '复现命令含记录的主机：' + JSON.stringify(db.replay_cmd))
  ok(db.replay_cmd_kind === 'template', '标注为 template（动作模板，不是可直接跑的真实命令）')

  console.log('\n— 命令分档：不许把"扫描命令"冒充成"本步的动作"')
  const kinds = new Set(rep.items.map((x) => x.replay_cmd_kind).filter(Boolean))
  ok(Array.from(kinds).every((k) => ['real', 'synthesized', 'from_step', 'template'].includes(k)),
    '命令档位只有 real / synthesized / from_step / template（实际 ' + Array.from(kinds).join(',') + '）')
  ok(shell.replay_cmd_kind === 'real' || shell.replay_cmd_kind === 'synthesized',
    '有真实抓包的条目优先用报文/真实命令，不用扫描命令顶替（实际 ' + shell.replay_cmd_kind + '）')
  ok(rep.markdown.includes('命令行等价形式') || rep.markdown.includes('实际执行的命令'),
    'markdown 里按档位给出如实措辞')

  console.log('\n— 报告结构与简洁性')
  ok(rep.markdown.includes('#### 复现'), '每条有独立的「复现」小节')
  ok(rep.markdown.indexOf('#### 复现') < rep.markdown.indexOf('#### 怎么拿到的'),
    '「复现」排在「怎么拿到的」之前（用户要照做的东西放最前）')
  const head = rep.markdown.split('\n').slice(0, 30).join('\n')
  ok(/先补这些|合计得分/.test(head), '抬头先给总分与需要补录的条目')
  ok(rep.markdown.length < 30000, '报告总长可控（' + rep.markdown.length + ' 字符）')

  console.log('\n— 反例：什么都记的条目也要能用（不给假命令）')
  const bare = store.openEngagement('只有 evidence 的靶标').id
  store.importBundle(bare, { assets: [{ ip: '198.51.100.5', scope: 'external' }] })
  const bareAsset = store.listAssets(bare, {}).items[0]
  store.addScoreHit(bare, { code: 'db-credential', points: 50, asset_id: bareAsset.id, target: '198.51.100.5:6379', evidence: 'Redis 未授权' })
  const bareItem = store.scoreReport(bare).items[0]
  ok(bareItem.replay_http === null,
    '数据库端口不会被合成成 HTTP 报文（曾经产出 curl http://198.51.100.5:6379/）')
  ok(bareItem.replay_cmd !== null, '仍然给出该得分项的动作模板作为兜底')
  ok(!/curl -i -s 'http:\/\/198\.51\.100\.5:6379/.test(String(bareItem.replay_cmd)),
    '兜底命令不是那条假 curl')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('\n通过 ' + pass + '/' + (pass + fail))
process.exit(fail === 0 ? 0 : 1)
