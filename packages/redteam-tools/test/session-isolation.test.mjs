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
 *   ⑥ **落盘绑定**：绑定同时写 `sessions.json`（键 = 根会话），控制台面板据此"跟随会话"。
 */
import { register } from 'node:module'
register(new URL('data:text/javascript,export function resolve(s,c,n){if(s==="@deepseek-ai/dsh-tools")return{shortCircuit:true,url:"data:text/javascript,export const defineTool=(t)=>t"};return n(s,c)}'), import.meta.url)
const { apply } = await import('../lib/index.js')
const { RedteamStore, POC_CATEGORIES, dispatch } = await import('../../redteam-store/lib/core.js')
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
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
/* 报错形态已统一：store 层抛出的异常会被 withStructuredErrors 收敛成 {ok:false,error}，
   所以这里既能拿到结构化返回、也能兼容仍然抛异常的路径 —— 关键是**必须明确报错**，
   不能静默把未绑定的会话塞进别人的靶标库。 */
let strangerErr = null
try {
  const r = await call('redteam_asset_query', {}, stranger)
  if (r && r.ok === false) strangerErr = String(r.error || '')
} catch (error) { strangerErr = error && error.message ? error.message : String(error) }
ok(strangerErr !== null && /尚未绑定靶标|已被另一个会话占用/.test(strangerErr),
  '未绑定的会话不会被静默塞进别人的靶标（明确报错并要求显式绑定）')
const bound = await call('redteam_session_bind', { engagement: '乙公司' }, stranger)
ok(bound.ok === true && bound.engagement.id === opened2.engagement.id, 'session_bind：可以把已有靶标绑到本会话')

/* ── 落盘绑定：面板「跟随会话」读的那份账 ─────────────────────────────
   工具侧 bindings 是进程内 Map，浏览器面板读不到；所以每次绑定都要写进
   $DSH_HOME/redteam/sessions.json（键 = **根会话 id**），面板在新会话被选中时
   才能切到它绑定的靶标。 */
console.log('— 落盘绑定（面板跟随会话的数据源）')
const bindFile = store.sessionBindingsPath()
ok(existsSync(bindFile), 'open/bind 之后写出 sessions.json')
const onDisk = JSON.parse(readFileSync(bindFile, 'utf8'))
ok(onDisk.agents.main1 && onDisk.agents.main1.engagement === opened1.engagement.id,
  '落盘键是根会话：main1 → 甲公司')
ok(onDisk.agents.recon1 === undefined, '子智能体不单独落盘（沿父链继承，只记根会话）')
ok(store.sessionBinding('main1') === opened1.engagement.id, 'sessionBinding(根会话) 读出绑定靶标')
ok(store.sessionBinding('main3') === opened2.engagement.id, 'session_bind 也会落盘（main3 → 乙公司）')
/* 面板的读法：dispatch 的 sessionBinding op（HTTP 桥接走同一条路径） */
const viewChild = dispatch(store, { op: 'sessionBinding', session: 'recon1' })
ok(viewChild.bound === null,
  '子会话 id 问绑定（没给解析器）：返回 null，面板回落到"最后绑定的靶标"')
/* 宿主会注入 resolveRoot（沿 parentSession 走到根）：子智能体会话也能对上父会话的靶标 */
const viewChildRoot = dispatch(store, {
  op: 'sessionBinding', session: 'recon1',
  resolveRoot: (sid) => (sid === 'recon1' ? 'main1' : sid),
})
ok(viewChildRoot.bound === opened1.engagement.id && viewChildRoot.root_session === 'main1',
  '子会话经 resolveRoot 解析到根会话：读到父会话的靶标（用户点开子智能体也对得上）')
const viewRoot = dispatch(store, { op: 'sessionBinding', session: 'main1' })
ok(viewRoot.bound === opened1.engagement.id && viewRoot.name === '甲公司',
  'sessionBinding op：返回绑定靶标 id 与展示名')
/* 指向已删靶标的绑定要被清掉：留着只会让面板切到一个打不开的库 */
const doomed = store.openEngagement('待删靶标', [], { bindCurrent: false })
store.setSessionBinding('ghost', doomed.id, '待删靶标')
ok(store.sessionBinding('ghost') === doomed.id, '指向存在靶标的绑定可读出')
rmSync(store.dirOf(doomed.id), { recursive: true, force: true })
store.setSessionBinding('main1', opened1.engagement.id, '甲公司')
ok(store.sessionBinding('ghost') === undefined, '靶标目录删掉后，指向它的绑定在下一次写入时被清理')
ok(store.sessionBinding('main1') === opened1.engagement.id, '清理不影响其它会话的绑定')
/* 手动切靶标（面板下拉）走 bindSessionEngagement：只改本会话绑定 */
const switched = dispatch(store, { op: 'bindSessionEngagement', session: 'main1', engagement: opened2.engagement.id, name: '乙公司' })
ok(switched.ok === true && store.sessionBinding('main1') === opened2.engagement.id,
  'bindSessionEngagement：界面手选靶标只改本会话绑定')
store.setSessionBinding('main1', opened1.engagement.id, '甲公司')

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
  stage_code: 'boundary-logical', title: 'suo5 建 socks5 隧道',
  tool: 'suo5-linux-amd64 -t http://10.9.9.9:8080/shell.jsp -l 1080', result: 'socks5 127.0.0.1:1080 通内网', agent: 'exploit',
  asset_id: asset.id,
})
store.addTunnel(opened1.engagement.id, {
  asset_id: asset.id, kind: 'suo5', listen: '127.0.0.1:1080', entry: 'http://10.9.9.9:8080/shell.jsp',
  reach: '10.9.9.0/24', entry_kind: 'target-http', command: 'suo5-linux-amd64 -t ... -l 1080', agent: 'exploit',
})
store.addWebshell(opened1.engagement.id, { asset_id: asset.id, url: 'http://10.9.9.9:8080/shell.jsp', shell_type: 'behinder', pass_key: 'e45', agent: 'exploit' })
await call('redteam_score_hit', {
  code: 'server-host', asset_id: asset.id, vuln_id: vuln.id, step_id: step.id,
  target: 'http://10.9.9.9:8080/', evidence: '10.9.9.9｜冰蝎马可用（behinder e45）',
}, main1)
const boundaryDenied = await call('redteam_score_hit', { code: 'boundary-logical', asset_id: asset.id, target: '10.9.9.9', evidence: '10.9.9.9｜suo5 隧道可达 10.9.9.0/24' }, main1)
ok(boundaryDenied.ok === false && /boundary/.test(boundaryDenied.error || ''),
  '边界硬门槛：缺 boundary 对象时拒绝记 boundary-*（同区隧道只能记 internal）')
const sameZone = await call('redteam_score_hit', {
  code: 'boundary-logical', asset_id: asset.id, target: '10.9.9.9', evidence: '同区隧道',
  boundary: { entry_zone: 'DMZ', target_zone: 'dmz', isolation: 'firewall', target_asset: '10.9.9.9:22' },
}, main1)
ok(sameZone.ok === false && /相同/.test(sameZone.error || ''), '边界硬门槛：入口区=落点区时拒绝记 boundary-*')
const supplyNoScope = await call('redteam_score_hit', {
  code: 'boundary-supply', asset_id: asset.id, target: '10.9.9.9', evidence: '供应商通道',
  boundary: { entry_zone: '供应商', target_zone: '主防单位', isolation: 'supply', target_asset: '10.9.9.9:22' },
}, main1)
ok(supplyNoScope.ok === false && /scope_confirmed/.test(supplyNoScope.error || ''), '边界硬门槛：boundary-supply 未确认授权范围时拒绝')
await call('redteam_score_hit', {
  code: 'boundary-logical', asset_id: asset.id, target: '10.9.9.9', evidence: '10.9.9.9｜suo5 隧道可达 10.9.9.0/24',
  boundary: { entry_zone: '互联网', target_zone: '办公网', isolation: 'firewall', target_asset: '10.9.9.9:22（SSH banner 实测）' },
}, main1)
const report = store.scoreReport(opened1.engagement.id)
ok(report.summary.withSteps === 2 && report.summary.withCommands === 2,
  '报告：两项成果都关联到了动作步骤与实际命令（' + report.summary.withSteps + '/' + report.summary.withCommands + '）')
ok(report.summary.incomplete === 1, '报告：缺步骤/缺 vuln_id 的得分被标为复现链不完整')
/* 得分点按合并版重构后用于精确匹配 code —— 用 point_name.includes('WebShell') 会因为
   新名字里是**小写** webshell 而匹配不到，取值步骤先崩，后面 20 多条断言全部跑不到。 */
 const withStep = report.items.find((x) => x.code === 'server-host')
 ok(withStep !== undefined, '报告：找到 server-host 那条成果（找不到时后续断言不应崩在取值上）')
ok(withStep.steps.length === 1 && withStep.steps[0].tool.includes('curl -F'),
  '报告：这一步带上了实际命令原文')
ok(withStep.steps[0].inferred !== true && withStep.trace.step_source === 'linked',
  '报告：靠 step_id/vuln_id 精确归因，不掺同资产的无关步骤（step_source=' + withStep.trace.step_source + '）')
const withFallback = report.items.find((x) => x.code === 'boundary-logical')
 ok(withFallback !== undefined, '报告：找到边界突破那条成果（找不到时后续断言不应崩在取值上）')
ok(/【边界证据】/.test(String(withFallback.note || '')), '报告：结构化 boundary 对象被写进命中 note，可供复核')
ok(withFallback.trace.step_source === 'asset' && withFallback.steps.every((x) => x.inferred === true),
  '报告：只能靠"同资产"兜底时明确标注为推断（step_source=asset）')
ok(withStep.credentials.length === 1 && withStep.credentials[0].source === '注入拖库',
  '报告：账号类成果带出凭据来源（账号密码从哪来的）')
ok(withStep.tunnels.length === 1 && withStep.tunnels[0].command.includes('suo5-linux-amd64'),
  '报告：隧道带出搭建命令与监听地址')
ok(withStep.how.includes('CVE-2021-22205'), '报告：how 一句话说清靠什么漏洞拿到')
/* 四段式改版后，每条成果的"这一步怎么做的"落在「结果 / 复现」，
   不再单列「动作记录」。要求不变：必须有可照着做的复现入口。 */
ok(report.markdown.includes('## 三、得分点复现') && /\*\*结果\*\*：/.test(report.markdown),
  '报告 markdown：包含得分点复现与结果说明')
ok(/```(http|bash)/.test(report.markdown)
  && (report.markdown.includes('curl -F') || report.markdown.includes('POST /')),
  '报告 markdown：给出可复制的报文或命令')
/* 四段式第一段是资产证明，列出得分资产；发现时间不再单列（控制台资产测绘仍保留）。 */
ok(report.markdown.includes('## 一、资产归属证明')
  && report.markdown.includes('10.9.9.9'),
  '报告 markdown：资产证明列出得分资产')
const boundary = report.items.find((x) => x.code === 'boundary-logical')
ok(boundary.repro_kind === 'cli' || boundary.repro_kind === 'http',
  '报告：边界突破条目给出可执行的复现入口（repro_kind=' + boundary.repro_kind + '）')
ok(!/没有关联的攻击步骤|说不清这一步|站不住/.test(report.markdown),
  '报告 markdown 里不出现内部口径/致歉式措辞')

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
/* 预检会额外读 `$DSH_HOME/.env`（用户把 FOFA_KEY 写在那里时不该误报"缺 key"）。
   本用例要验证的是"确实没有 key 时判 broken"，所以必须让 DSH_HOME 指向沙箱，
   否则会用开发机上真实的 ~/.dsh/.env 把这条断言变成假阳性。 */
const savedDshHome = process.env.DSH_HOME
process.env.DSH_HOME = root
apply({
  redteam: store,
  tools: { register: (t) => toolsWithSkills.set(t.name, t) },
  get: (name) => (name === 'subagents' ? { listChildren: async () => [] } : name === 'skills' ? skillsStub : undefined),
  on: () => {},
})
const pre = JSON.parse(await toolsWithSkills.get('redteam_preflight').execute({}, { agent: { session: main1 } }))
if (savedDshHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedDshHome
ok(pre.ok === false && pre.broken.length === 1 && pre.broken[0].name === 'fofa-recon',
  'preflight：缺 key 的技能被判为 broken（' + (pre.broken[0] && pre.broken[0].problems.join('；')) + '）')
ok(pre.broken[0].needs_user.some((x) => x.includes('FOFA_KEY')), 'preflight：明确写出"要向用户要什么"')
ok(pre.available.includes('good-skill'), 'preflight：可用的技能照常列出')
ok(/替代方案/.test(pre.next || ''), 'preflight：给出补不齐时的替代方案指引')
ok(pre.prompts && pre.prompts.stale_count === 0, 'preflight：返回当前靶标的提示词新鲜度（新靶标 stale_count=0）')
/* 首次引导：没装过（无完成标记）时必须显式报出来，并要求一次性向用户要齐 */
ok(pre.onboarding && pre.onboarding.complete === false, 'preflight：未完成首次引导时 onboarding.complete=false')
ok(pre.onboarding.first_run === true, 'preflight：没有完成标记时标记为首次使用')
ok(Array.isArray(pre.onboarding.missing)
  && pre.onboarding.missing.some((x) => x.startsWith('FOFA_KEY'))
  && pre.onboarding.missing.some((x) => x.startsWith('VPS')),
  'preflight：首次引导一次性列出缺的 FOFA_KEY 与 VPS')
ok(/redteam-setup/.test(pre.next || ''), 'preflight：首次使用指引指向 redteam-setup 技能')
/* 完成标记存在 + 无缺口时，onboarding 应该判为 complete */
mkdirSync(join(root, 'redteam'), { recursive: true })
writeFileSync(join(root, 'redteam', '.setup-complete'), 'completed_at=test\n', 'utf8')
writeFileSync(join(root, '.env'), 'FOFA_KEY=test-key-1234\n', 'utf8')
process.env.DSH_HOME = root
delete process.env.FOFA_KEY
const pre2 = JSON.parse(await toolsWithSkills.get('redteam_preflight').execute({}, { agent: { session: main1 } }))
if (savedDshHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedDshHome
ok(pre2.onboarding.first_run === false && pre2.onboarding.configured.fofa_key.startsWith('configured'),
  'preflight：读 $DSH_HOME/.env 里的 FOFA_KEY（不误报缺 key）')

rmSync(root, { recursive: true, force: true })
console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
