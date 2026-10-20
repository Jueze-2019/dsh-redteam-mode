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

  /* 攻击文件：报告复现必须给出可落到文件的相对路径，而不是只说"工具跑过" */
  const attackFile = store.addAttackFile(id, {
    target: 'oa.example.com:8080', name: 'shell.jsp', kind: 'exp',
    description: '文件上传验证脚本', evidence: '回显 uid=33(www-data)', content: '<% out.print("ok"); %>',
    asset_id: ext.id, vuln_id: vuln.id,
  })
  ok(attackFile.path.includes('/attack-files/'), '攻击文件落到 attack-files/<目标>/ 下')

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
  ok(shell.attack_files.length === 1 && shell.attack_files[0].path.startsWith('attack-files/'),
    '报告条目带攻击文件相对路径：' + JSON.stringify((shell.attack_files || []).map((x) => x.path)))
  ok(rep.markdown.includes('攻击文件（复现路径）') && rep.markdown.includes(attackFile.path.split('/attack-files/')[1]),
    '下载的 Markdown 也带攻击文件路径')
  ok(rep.markdown.includes('完整动作记录') && rep.markdown.includes('原始请求（'),
    '下载的 Markdown 含完整步骤与全部原始请求（不是只有最短复现入口）')
  const mdHttpBlocks = (rep.markdown.match(/```http/g) || []).length
  ok(mdHttpBlocks >= 1, 'markdown 里有可复制的 http 代码块（' + mdHttpBlocks + ' 个）')
  ok(rep.markdown.includes('POST /admin/upload HTTP/1.1'), 'markdown 里是完整报文首行')
  ok(rep.markdown.includes('Yakit'), 'markdown 里说明了怎么用 Yakit 重放')

  console.log('\n— 简洁：响应体截断并标注长度，不把整段响应堆进报告')
  ok(!rep.markdown.includes('x'.repeat(1500)), '响应体已截断（没有把 3000 字符原样塞进 markdown）')
  ok(rep.markdown.includes('预期回显'), '给出预期回显（截断后的响应摘要）')

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
  ok(rep.markdown.includes('真实抓包') || rep.markdown.includes('当日实际命令'),
    'markdown 里按档位给出如实措辞')

  console.log('\n— 报告结构与简洁性（四段式）')
  ok(rep.markdown.includes('## 一、靶标单位资产证明'), '第一段是靶标单位资产证明')
  ok(rep.markdown.includes('## 二、得分汇总表'), '第二段是得分汇总表')
  ok(rep.markdown.includes('## 三、账号密码凭据权限汇总表'), '第三段是账号密码凭据权限汇总表')
  ok(rep.markdown.includes('## 四、得分点复现'), '第四段是得分点复现')
  const order = ['### 2.1 互联网资产权限', '### 2.2 边界突破', '### 2.3 内网资产权限', '### 2.4 靶标权限']
  ok(order.every((h, i) => rep.markdown.includes(h) && (i === 0 || rep.markdown.indexOf(order[i - 1]) < rep.markdown.indexOf(h))),
    '四阶段按「互联网 → 边界 → 内网 → 靶标」排序')
  ok(/^#### 4\.\d+\.\d+ /m.test(rep.markdown), '得分点复现按 4.x.y 编号')
  ok(!rep.markdown.includes('#### 动作记录'), '不再把同资产动作整段重复进每条（动作记录已从正文移除）')
  const head = rep.markdown.split('\n').slice(0, 20).join('\n')
  ok(/计分项/.test(head) && /总分/.test(head), '抬头先给计分项与总分')
  ok(rep.markdown.length < 30000, '报告总长可控（' + rep.markdown.length + ' 字符）')
  const legacy = store.scoreReport(id, { layout: 'legacy' })
  ok(legacy.markdown.includes('摘要与对账') && legacy.markdown.includes('#### 复现'),
    'layout=legacy 仍能生成旧版长报告（回退路径可用）')

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

  console.log('\n— 记分漏填 vuln_id：只从与目标对得上的步骤补，不能张冠李戴')
  const inferredEng = store.openEngagement('步骤补漏洞').id
  store.importBundle(inferredEng, { assets: [{ ip: '198.51.100.50', scope: 'external' }] })
  const inferredAsset = store.listAssets(inferredEng, {}).items[0]
  const inferredVuln = store.addVuln(inferredEng, {
    asset_id: inferredAsset.id, title: 'SSH 弱口令', severity: 'high', status: 'exploited',
    target: '198.51.100.50:22', gained: 'root', evidence: 'uid=0',
  })
  store.addChainStep(inferredEng, {
    stage_code: 'internet', title: '198.51.100.50 SSH 登录验证', asset_id: inferredAsset.id,
    vuln_id: inferredVuln.id, tool: 'ssh root@198.51.100.50 id', result: 'uid=0(root)',
  })
  store.addScoreHit(inferredEng, { code: 'server-host', points: 50, asset_id: inferredAsset.id, target: '198.51.100.50:22', evidence: 'root' })
  const inferredItem = store.scoreReport(inferredEng).items[0]
  ok(inferredItem.vuln !== null && inferredItem.vuln.id === inferredVuln.id && inferredItem.vuln_source === 'step',
    '漏填 score_hit.vuln_id 时，从目标匹配的步骤补出漏洞并标注 source=step')
  ok((inferredItem.gaps || []).length === 0, '补齐后不再误报复现缺口')
  ok(inferredItem.replay_cmd_kind === 'from_step' && String(inferredItem.replay_cmd).includes('ssh root@198.51.100.50'),
    '非 curl 的真实步骤命令优先于通用模板')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('\n通过 ' + pass + '/' + (pass + fail))
process.exit(fail === 0 ? 0 : 1)
