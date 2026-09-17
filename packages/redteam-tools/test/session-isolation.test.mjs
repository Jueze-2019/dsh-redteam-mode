/**
 * v0.9.0 新能力的回归测试（零依赖）
 *
 * 跑法：node packages/redteam-tools/test/session-isolation.test.mjs
 *
 * 覆盖这轮大改动的四件事：
 *   ① **会话隔离**：靶标绑定按"根会话"走，子智能体继承父会话的靶标；
 *      另一个会话 open 别的靶标不会影响它；未绑定的会话不会被静默塞进别人的靶标。
 *   ② **资产发现时间**：第一次入库记 discovered_at，重复采集不覆盖，时间线能按天聚合。
 *   ③ **报告溯源**：每条得分给出"怎么拿到的"（步骤 + 实际命令 + 回显 + 凭据 + 隧道），
 *      缺步骤/缺命令的标 incomplete 并列 gaps。
 *   ④ **知识库归类**：category / 来源靶标 / 发现资产 / 建立时间都落库，统计按归类聚合。
 *   ⑤ **并发闸门**：没有智能体在跑时能占位，占满上限后被拒绝。
 */
import { register } from 'node:module'
register(new URL('data:text/javascript,export function resolve(s,c,n){if(s==="@deepseek-ai/dsh-tools")return{shortCircuit:true,url:"data:text/javascript,export const defineTool=(t)=>t"};return n(s,c)}'), import.meta.url)
const { apply } = await import('../lib/index.js')
const { RedteamStore, POC_CATEGORIES } = await import('../../redteam-store/lib/core.js')
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }

/** 造一个带 store 的假会话（parentSession 指父会话，用于验证父链继承）。 */
function makeSession(store, id, parentSession) {
  return {
    id,
    header: parentSession === undefined ? { id } : { id, parentSession },
    store: { get: (sid) => store.get(sid) },
  }
}

delete process.env.FOFA_KEY
const root = mkdtempSync(join(tmpdir(), 'rt-v09-'))
const store = new RedteamStore(join(root, 'redteam'))
/* 会话注册表：main1 → recon1（子）；main2 是另一个主会话 */
const registry = new Map()
const main1 = makeSession(registry, 'main1')
const recon1 = makeSession(registry, 'recon1', 'main1')
const main2 = makeSession(registry, 'main2')
for (const s of [main1, recon1, main2]) registry.set(s.id, s)

const tools = new Map()
apply({
  redteam: store,
  tools: { register: (t) => tools.set(t.name, t) },
  /* 第一套上下文故意不给 skills：验证"注册表不可用时如实说明、不假装能跑" */
  get: (name) => (name === 'subagents' ? { listChildren: async () => [] } : undefined),
  on: () => {},
})
const call = async (n, a, session) => JSON.parse(await tools.get(n).execute(a || {}, { agent: { session: session || main1 } }))

console.log('— 会话隔离')
const opened1 = await call('redteam_engagement_open', { target: '甲公司' }, main1)
ok(opened1.engagement.id === (await call('redteam_session_info', {}, main1)).session.bound_engagement,
  '主会话 A：open 后绑定到本会话')
const inherited = await call('redteam_session_info', {}, recon1)
ok(inherited.session.root_session === 'main1' && inherited.session.bound_engagement === opened1.engagement.id,
  '子智能体：沿父链继承同一个靶标（root_session = 父会话）')
const opened2 = await call('redteam_engagement_open', { target: '乙公司' }, main2)
ok(opened2.engagement.id !== opened1.engagement.id, '主会话 B：可以同时开另一个靶标')
const stillA = await call('redteam_session_info', {}, main1)
const stillChild = await call('redteam_session_info', {}, recon1)
ok(stillA.session.bound_engagement === opened1.engagement.id && stillChild.session.bound_engagement === opened1.engagement.id,
  '主会话 B open 之后，A 与其子智能体的绑定不受影响（不串写）')
/* 未绑定的第三个会话：全局指针被别人占用时必须报错，而不是静默写进别人的库 */
const stranger = makeSession(registry, 'main3')
registry.set('main3', stranger)
store.setActiveEngagement(opened1.engagement.id)
let strangerErr = null
try { await call('redteam_asset_query', {}, stranger) } catch (error) { strangerErr = error && error.message ? error.message : String(error) }
ok(strangerErr !== null && /尚未绑定靶标|已被另一个会话占用/.test(strangerErr),
  '未绑定的会话不会被静默塞进别人的靶标（明确报错并要求显式绑定）')
const bound = await call('redteam_session_bind', { engagement: '乙公司' }, stranger)
ok(bound.ok === true && bound.engagement.id === opened2.engagement.id, 'session_bind：可以把已有靶标绑到本会话')

console.log('— 资产发现时间')
await call('redteam_asset_add', {
  ip: '10.9.9.9', state: 'live', provenance: 'active', tool: 'nmap', primary_name: 'oa.jia.com',
  ports: [{ port: 8080, service: 'http', title: 'OA 登录', url: 'http://10.9.9.9:8080/' }],
}, main1)
const first = store.listAssets(opened1.engagement.id, { ip: '10.9.9.9' }).items[0]
ok(typeof first.discovered_at === 'string' && first.discovered_at.length > 10, 'asset_add：自动记录发现时间')
ok(first.discovered_at === first.first_seen, 'asset_add：首次入库时发现时间 = 数据源首见')
await new Promise((r) => setTimeout(r, 8))
await call('redteam_asset_add', {
  ip: '10.9.9.9', state: 'live', provenance: 'passive', tool: 'fofa',
  ports: [{ port: 443, service: 'https', title: 'OA 门户' }],
}, main1)
const second = store.listAssets(opened1.engagement.id, { ip: '10.9.9.9' }).items[0]
ok(second.discovered_at === first.discovered_at, '重复采集不覆盖发现时间（只刷新最近采集）')
ok(second.last_seen !== first.last_seen, '重复采集刷新 last_seen')
const tl = await call('redteam_asset_timeline', {}, main1)
ok(tl.days.length === 1 && tl.days[0].assets === 1, 'asset_timeline：按天聚合（内网 1 台）')
ok(tl.days[0].internal === 1 && tl.days[0].external === 0, 'asset_timeline：区分内网/外网')
ok(tl.recent[0].discovered_at === first.discovered_at, 'asset_timeline：最近资产带发现时间')

console.log('— 报告溯源（账号密码怎么来的 / 隧道怎么搭的）')
const asset = store.listAssets(opened1.engagement.id, { ip: '10.9.9.9' }).items[0]
const vuln = store.addVuln(opened1.engagement.id, {
  asset_id: asset.id, cve: 'CVE-2021-22205', title: '致远OA 文件上传 RCE', severity: 'critical',
  status: 'exploited', target: 'http://10.9.9.9:8080/', evidence: '上传返回 200', gained: '服务器权限', agent: 'vuln-scan',
})
store.addHttpEvidence(opened1.engagement.id, {
  vuln_id: vuln.id, asset_id: asset.id, label: '上传 POC', method: 'POST', url: 'http://10.9.9.9:8080/upload',
  status: 200, request: 'POST /upload HTTP/1.1\nHost: 10.9.9.9:8080\n\n--payload--', response: 'ok',
})
store.addCredential(opened1.engagement.id, {
  asset_id: asset.id, host: '10.9.9.9', username: 'admin', secret_value: 'Admin@123',
  source: '注入拖库', tool: 'sqlmap -u "http://10.9.9.9:8080/api?id=1" --dump', privilege: '管理员', agent: 'exploit',
})
const step = store.addChainStep(opened1.engagement.id, {
  stage_code: 'internet', title: '上传冰蝎马并验证连接', detail: '后台模板上传点绕过 → 冰蝎马落地',
  tool: 'curl -F "file=@shell.jsp" http://10.9.9.9:8080/upload', result: 'uid=0(root)', agent: 'exploit', vuln_id: vuln.id,
})
store.addChainStep(opened1.engagement.id, {
  stage_code: 'boundary', title: 'suo5 建 socks5 隧道',
  tool: 'suo5-linux-amd64 -t http://10.9.9.9:8080/shell.jsp -l 1080', result: 'socks5 127.0.0.1:1080 通内网', agent: 'exploit',
  asset_id: asset.id,
})
store.addTunnel(opened1.engagement.id, {
  asset_id: asset.id, kind: 'suo5', listen: '127.0.0.1:1080', entry: 'http://10.9.9.9:8080/shell.jsp',
  reach: '10.9.9.0/24', entry_kind: 'target-http', command: 'suo5-linux-amd64 -t ... -l 1080', agent: 'exploit',
})
store.addWebshell(opened1.engagement.id, { asset_id: asset.id, url: 'http://10.9.9.9:8080/shell.jsp', shell_type: 'behinder', pass_key: 'e45', agent: 'exploit' })
await call('redteam_score_hit', {
  code: 'webshell', asset_id: asset.id, vuln_id: vuln.id, step_id: step.id,
  target: 'http://10.9.9.9:8080/', evidence: '10.9.9.9｜冰蝎马可用（behinder e45）',
}, main1)
await call('redteam_score_hit', { code: 'boundary', asset_id: asset.id, target: '10.9.9.9', evidence: '10.9.9.9｜suo5 隧道可达 10.9.9.0/24' }, main1)
const report = store.scoreReport(opened1.engagement.id)
ok(report.summary.withSteps === 2 && report.summary.withCommands === 2,
  '报告：两项成果都关联到了动作步骤与实际命令（' + report.summary.withSteps + '/' + report.summary.withCommands + '）')
ok(report.summary.incomplete === 1, '报告：缺步骤/缺 vuln_id 的得分被标为复现链不完整')
const withStep = report.items.find((x) => x.point_name.includes('WebShell'))
ok(withStep.steps.length === 1 && withStep.steps[0].tool.includes('curl -F'),
  '报告：这一步带上了实际命令原文')
ok(withStep.steps[0].inferred !== true && withStep.trace.step_source === 'linked',
  '报告：靠 step_id/vuln_id 精确归因，不掺同资产的无关步骤（step_source=' + withStep.trace.step_source + '）')
const withFallback = report.items.find((x) => x.point_name.includes('边界突破'))
ok(withFallback.trace.step_source === 'asset' && withFallback.steps.every((x) => x.inferred === true),
  '报告：只能靠"同资产"兜底时明确标注为推断（step_source=asset）')
ok(withStep.credentials.length === 1 && withStep.credentials[0].source === '注入拖库',
  '报告：账号类成果带出凭据来源（账号密码从哪来的）')
ok(withStep.tunnels.length === 1 && withStep.tunnels[0].command.includes('suo5-linux-amd64'),
  '报告：隧道带出搭建命令与监听地址')
ok(withStep.how.includes('CVE-2021-22205'), '报告：how 一句话说清靠什么漏洞拿到')
ok(/怎么来的/.test(report.markdown) && /这一步怎么来的/.test(report.markdown), '报告 markdown：包含「怎么来的」小节')
ok(/steps|执行/.test(report.markdown) && report.markdown.includes('curl -F'), '报告 markdown：把命令写进正文（可复制复现）')
ok(report.markdown.includes('附录：本报告涉及的资产') && report.markdown.includes('发现时间'),
  '报告 markdown：附录列出资产与发现时间')
const boundary = report.items.find((x) => x.point_name.includes('边界突破'))
ok(boundary.incomplete === true && boundary.gaps.some((g) => g.includes('vuln_id')),
  '报告：缺 vuln_id / 步骤的条目会列出复现缺口')

console.log('— 知识库归类与溯源')
const poc = await call('redteam_poc_add', {
  title: '致远OA 文件上传 RCE', kind: 'exp', category: 'file-upload', cve: 'CVE-2021-22205',
  component: '致远OA', versions: 'A8 <= 8.1', source: 'self', content: 'print("poc")',
  verified: true, verified_note: '10.9.9.9:8080 上传成功，回显 uid=0',
  engagement: opened1.engagement.id, asset_target: '10.9.9.9:8080', found_by_agent: 'exploit',
})
ok(poc.category === 'file-upload', 'poc_add：归类落库')
ok(poc.engagement === '甲公司' || poc.engagement === opened1.engagement.id, 'poc_add：来源靶标落库')
ok(poc.asset_target === '10.9.9.9:8080' && typeof poc.created_at === 'string', 'poc_add：发现资产与建立时间落库')
const searched = await call('redteam_poc_search', { category: 'file-upload' }, main1)
ok(searched.items.length === 1 && searched.items[0].engagement && searched.items[0].created_at,
  'poc_search：按归类筛选，并返回来源靶标与建立时间')
const byAsset = await call('redteam_poc_search', { asset_target: '10.9.9.9' }, main1)
ok(byAsset.items.length === 1, 'poc_search：可按发现资产检索')
const stats = store.pocStats()
ok(stats.byCategory.length === POC_CATEGORIES.length, 'pocStats：内置归类表完整（' + POC_CATEGORIES.length + ' 类）')
ok(stats.byCategory.find((c) => c.code === 'file-upload').n === 1, 'pocStats：按归类计数')
ok(stats.byEngagement.some((e) => e.n === 1), 'pocStats：按来源靶标计数')
ok(stats.byCategory.every((c) => typeof c.name === 'string' && c.name !== ''), 'pocStats：每个归类都有中文名（面板才能分组显示）')

console.log('— 并发闸门')
const st = await call('redteam_agent_slot', { action: 'status' }, main1)
ok(st.max === 3 && st.used === 0 && st.free === 3, 'agent_slot：默认上限 3、空闲 3')
const a1 = await call('redteam_agent_slot', { action: 'acquire', label: '信息收集' }, main1)
const a2 = await call('redteam_agent_slot', { action: 'acquire', label: '资产梳理' }, main1)
const a3 = await call('redteam_agent_slot', { action: 'acquire', label: '漏洞发现' }, main1)
ok(a1.ok === true && a2.ok === true && a3.ok === true, 'agent_slot：三次占位都成功')
const a4 = await call('redteam_agent_slot', { action: 'acquire', label: '第四个' }, main1)
ok(a4.ok === false && /并发已满/.test(a4.error), 'agent_slot：第 4 个被拒（硬约束生效）')
const rel = await call('redteam_agent_slot', { action: 'release', key: a1.slot }, main1)
const a5 = await call('redteam_agent_slot', { action: 'acquire', label: '补位' }, main1)
ok(rel.released === true && a5.ok === true, 'agent_slot：释放后可以再占位')
/* 另一个会话的额度互不影响（按根会话隔离） */
const other = await call('redteam_agent_slot', { action: 'status' }, main2)
ok(other.used === 0 && other.free === 3, 'agent_slot：并发计数按会话隔离（另一个会话不受影响）')

console.log('— 技能与资源预检')
const preMissing = await call('redteam_preflight', {}, main1)
ok(preMissing.ok === false && /技能注册表不可用/.test(preMissing.error), 'preflight：技能注册表缺失时如实说明（不假装能跑）')
/* 注册表可用时：检查每个技能的正文、必需环境变量、引用的本机路径，并给出"要用户补什么" */
const skillsDir = join(root, 'skills')
mkdirSync(skillsDir, { recursive: true })
writeFileSync(join(skillsDir, 'fofa-recon.md'), '# FOFA\nKEY = os.environ["FOFA_KEY"]\n', 'utf8')
writeFileSync(join(skillsDir, 'good-skill.md'), '# 不需要外部资源\n', 'utf8')
const skillsStub = {
  list: async () => [
    { name: 'fofa-recon', description: 'FOFA 测绘', resourceBase: { kind: 'directory', path: join(root, 'skills') } },
    { name: 'good-skill', description: '可用的技能', resourceBase: { kind: 'directory', path: join(root, 'skills') } },
  ],
  get: async (name) => (name === 'fofa-recon'
    ? { name, description: 'FOFA 测绘', path: join(root, 'skills', 'fofa-recon.md'), content: 'KEY = os.environ["FOFA_KEY"]\n' }
    : { name, description: '可用的技能', path: join(root, 'skills', 'good-skill.md'), content: '# 不需要外部资源\n' }),
}
const toolsWithSkills = new Map()
apply({
  redteam: store,
  tools: { register: (t) => toolsWithSkills.set(t.name, t) },
  get: (name) => (name === 'subagents' ? { listChildren: async () => [] } : name === 'skills' ? skillsStub : undefined),
  on: () => {},
})
const pre = JSON.parse(await toolsWithSkills.get('redteam_preflight').execute({}, { agent: { session: main1 } }))
ok(pre.ok === false && pre.broken.length === 1 && pre.broken[0].name === 'fofa-recon',
  'preflight：缺 key 的技能被判为 broken（' + (pre.broken[0] && pre.broken[0].problems.join('；')) + '）')
ok(pre.broken[0].needs_user.some((x) => x.includes('FOFA_KEY')), 'preflight：明确写出"要向用户要什么"')
ok(pre.available.includes('good-skill'), 'preflight：可用的技能照常列出')
ok(/替代方案/.test(pre.next || ''), 'preflight：给出补不齐时的替代方案指引')

rmSync(root, { recursive: true, force: true })
console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
