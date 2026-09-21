/**
 * 前端渲染测试（零依赖）—— 补上"删图谱时连带删掉「发现时间」视图"那一类漏洞。
 *
 * 跑法：node packages/redteam-ui/test/tabs-render.test.mjs
 *
 * 为什么需要它：client-load.test.mjs 只验证"文件能加载、apply 能跑"，
 * 页签**渲染**出来会不会炸完全没人管 —— 而那正是本次审查里唯一无法靠静态检查
 * 发现的缺陷类型（删图谱误伤 DiscoveryView 就是被 bundle 里的字符串断言偶然抓到的）。
 *
 * 做法（不引入任何依赖）：
 *   ① React 的函数组件语义替身：按调用顺序记录 hooks，setState 标记脏、外层重渲染；
 *   ② 受控重渲染循环：渲染 → 跑 effect（含 await 的 api 调用）→ 有脏就再渲染；
 *   ③ fetch 替身按 op 返回预置数据；
 *   ④ 真正**逐个页签**渲染（点击页签 DOM 节点，面板会切 ui.tab），
 *      每种数据形态（有数据 / 空 / 报错）各走一遍。
 *
 * 它抓不到"渲染得好不好看"；它能抓到的是未定义变量、字段读错、空数据崩溃、
 * 组件契约变化 —— 都属于"打开就白屏"那一类。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log('  ✓ ' + msg) } else { fail += 1; console.log('  ✗ ' + msg) } }

/* ══════════════════════════════════════════════════════════════════════════
   ① React 替身（函数组件 + hooks）
   ══════════════════════════════════════════════════════════════════════════ */
let current = null
const DIRTY = []

const React = {
  createElement: (type, props, ...children) => {
    const flat = []
    const push = (c) => {
      if (Array.isArray(c)) { c.forEach(push); return }
      if (c === null || c === undefined || c === false || c === true) return
      flat.push(c)
    }
    push(children)
    const merged = Object.assign({}, props)
    if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat
    return { __el: true, type, props: merged || {} }
  },
  useState: (initial) => {
    const inst = current              /* 绑定到产生它的那个组件实例 */
    const i = inst.hookIndex++
    if (!(i in inst.hooks)) inst.hooks[i] = typeof initial === 'function' ? initial() : initial
    const set = (v) => {
      const next = typeof v === 'function' ? v(inst.hooks[i]) : v
      if (next !== inst.hooks[i]) { inst.hooks[i] = next; inst.dirty = true }
    }
    return [inst.hooks[i], set]
  },
  useReducer: (reducer, initial) => {
    const inst = current
    const i = inst.hookIndex++
    if (!(i in inst.hooks)) inst.hooks[i] = initial
    const dispatch = (action) => {
      inst.hooks[i] = reducer(inst.hooks[i], action)
      inst.dirty = true
    }
    return [inst.hooks[i], dispatch]
  },
  useRef: (initial) => {
    const inst = current
    const i = inst.hookIndex++
    if (!(i in inst.hooks)) inst.hooks[i] = { current: initial }
    return inst.hooks[i]
  },
  useEffect: (fn, deps) => {
    const i = current.hookIndex++
    const prev = current.hooks[i]
    const changed = prev === undefined || deps === undefined || prev.deps === undefined
      || prev.deps.length !== deps.length || deps.some((d, k) => d !== prev.deps[k])
    if (!changed) return
    if (prev && typeof prev.cleanup === 'function') current.effectCleanups.push(prev.cleanup)
    const slot = { deps, cleanup: undefined }
    current.hooks[i] = slot
    current.effects.push(() => {
      const cleanup = fn()
      if (typeof cleanup === 'function') slot.cleanup = cleanup
    })
  },
  useCallback: (fn, deps) => {
    const i = current.hookIndex++
    const prev = current.hooks[i]
    if (prev === undefined || deps === undefined || prev.deps === undefined
        || prev.deps.length !== deps.length || deps.some((d, k) => d !== prev.deps[k])) {
      current.hooks[i] = { fn, deps }
    }
    return current.hooks[i].fn
  },
  useMemo: (fn, deps) => {
    const i = current.hookIndex++
    const prev = current.hooks[i]
    if (prev === undefined || prev.deps === undefined || prev.deps.length !== deps.length
        || deps.some((d, k) => d !== prev.deps[k])) {
      current.hooks[i] = { value: fn(), deps }
    }
    return current.hooks[i].value
  },
  Component: class Component {
    constructor(props) { this.props = props || {}; this.state = {} }
    setState(patch) { this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch) }
    render() { return null }
  },
  Fragment: 'Fragment',
}

/* 组件实例表：类名 → 实例。带 hooks 的组件按"函数引用"做键，保证状态跨渲染保留。 */
const instances = new Map()
/** 本次渲染产生的全部 host 元素（供测试按文本找到可点击的页签）。 */
let hostSink = []

function renderTree(el, texts) {
  if (el === null || el === undefined || el === false || el === true) return
  if (typeof el === 'string' || typeof el === 'number') { texts.push(String(el)); return }
  if (Array.isArray(el)) { el.forEach((x) => renderTree(x, texts)); return }
  if (!el.__el) return
  const { type, props } = el
  if (typeof type === 'string') {
    const host = { tag: type, props, handlers: {} }
    for (const k of Object.keys(props || {})) if (k.startsWith('on') && typeof props[k] === 'function') host.handlers[k] = props[k]
    hostSink.push(host)
    if (props && props.children !== undefined) renderTree(props.children, texts)
    return
  }
  if (type === 'Fragment') { renderTree(props.children, texts); return }
  if (typeof type === 'function') {
    /* React.Component 子类（错误边界）：new 出来调 render */
    if (/^class\s/.test(String(type).slice(0, 6))) {
      const inst = new type(props)
      renderTree(inst.render(), texts)
      return
    }
    let inst = instances.get(type)
    if (inst === undefined) {
      inst = { hooks: [], hookIndex: 0, dirty: false, effects: [], effectCleanups: [], host: [] }
      instances.set(type, inst)
    }
    inst.hookIndex = 0
    inst.effects = []
    inst.effectCleanups = []
    inst.dirty = false
    inst.host = []
    const prev = current
    current = inst
    let out
    try { out = type(props) } finally { current = prev }
    renderTree(out, texts)
    return
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ② 浏览器替身
   ══════════════════════════════════════════════════════════════════════════ */
const ls = new Map()
const makeEl = (tag) => ({
  tagName: tag, textContent: '', value: '', style: {}, attributes: {},
  setAttribute(k, v) { this.attributes[k] = v },
  append() {}, remove() {}, select() {}, focus() {}, click() {},
  addEventListener() {}, removeEventListener() {},
})
const windowStub = {
  __ModuleLoader__: { load: (def) => { windowStub.__def = def } },
  location: { hash: '', href: 'http://127.0.0.1:3080/' },
  devicePixelRatio: 1,
  addEventListener() {}, removeEventListener() {},
  open: () => null,
  close() {},
  setInterval: () => 0,
  clearInterval() {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  localStorage: {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => ls.set(k, String(v)),
    removeItem: (k) => ls.delete(k),
  },
}
const documentStub = {
  head: { append() {} },
  body: { appendChild() {}, removeChild() {} },
  createElement: (tag) => makeEl(tag),
  execCommand: () => true,
}

let responses = {}
const fetchCalls = []
const fetchStub = (url, init) => {
  const body = JSON.parse(init.body)
  fetchCalls.push(body.op)
  const value = typeof responses[body.op] === 'function' ? responses[body.op](body) : responses[body.op]
  return Promise.resolve({ json: () => Promise.resolve(value === undefined ? { ok: true } : value) })
}

/* ══════════════════════════════════════════════════════════════════════════
   ③ 加载工厂并抓住 Panel
   ══════════════════════════════════════════════════════════════════════════ */
const source = readFileSync(clientPath, 'utf8')
const fn = new Function('window', 'document', 'require', 'navigator', 'fetch', 'setTimeout',
  'clearInterval', 'setInterval', 'URL', 'Blob', 'console', source)
fn(windowStub, documentStub, (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}, { clipboard: { writeText: () => Promise.resolve() } }, fetchStub, setTimeout, clearInterval,
setInterval, URL, Blob, console)

const mod = windowStub.__def.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
ok(typeof mod.apply === 'function', 'client.js 工厂可执行并导出 apply')

let panelRender = null
mod.apply({
  slots: {
    inject: (name, run) => run(),
    register: (meta, render) => { if (meta.id === 'redteam-console') panelRender = render },
  },
  effect: (f) => f(),
})
ok(typeof panelRender === 'function', '拿到 shell.overlay 的面板渲染函数')

/* ══════════════════════════════════════════════════════════════════════════
   ④ 预置响应
   ══════════════════════════════════════════════════════════════════════════ */
const ENGINE = '演示单位'
const ASSET = {
  id: 1, ip: '10.1.1.1', scope: 'internal', state: 'live', priority: 'high', potential: '服务器权限',
  primary_name: 'a.example.com', segment_cidr: '10.1.1.0/24', discovered_at: '2026-01-02T03:04:05Z',
  last_seen: '2026-01-03T03:04:05Z', first_seen: '2026-01-02T03:04:05Z', test_status: 'testing',
  blocked_count: 0, test_notes: '', test_surface: 'Web', open_ports: 1, passive: 0, active: 1,
  ports: [{ port: 80, proto: 'tcp', state: 'open', service: 'http', provenance: 'active', banner: 'nginx', url: 'http://10.1.1.1/', title: '首页' }],
  fingerprints: [{ category: 'web', vendor: 'nginx', product: 'nginx', version: '1.24', evidence: 'Server 头', provenance: 'active' }],
  names: [{ name: 'a.example.com', kind: 'domain', provenance: 'passive' }],
}
const VULN = {
  id: 1, title: '示例漏洞', cve: 'CVE-2026-1', severity: 'high', status: 'confirmed', confidence: 0.9,
  target: 'http://10.1.1.1/admin', asset_ip: '10.1.1.1', segment_cidr: '10.1.1.0/24', gained: '后台管理员',
  evidence: 'GET /admin HTTP/1.1\nHost: x', source: 'nuclei', found_by_agent: 'vuln-scan',
  found_at: '2026-01-02T03:04:05Z', http_evidence: [], note: '',
}
const ENG = { id: ENGINE, name: ENGINE, scope: [], status: 'active', created_at: '2026-01-01T00:00:00Z' }

function makeResponses(shape) {
  const broken = shape === 'error'
  const empty = shape === 'empty'
  const ERR = { ok: false, error: '模拟后端失败' }
  const w = (v) => (broken ? ERR : v)
  const arr = (items) => (empty ? [] : items)
  return {
    bootstrap: w({ ok: true, root: '/tmp/rt', engagements: [ENG], current: ENGINE }),
    snapshot: w({ ok: true, engagement: ENG,
      stats: { segments: 1, assets: 1, liveAssets: 1, openPorts: 1, fingerprints: 1, vulns: 1, passiveSignals: 0, activeSignals: 1 },
      tests: { untested: 0, testing: 1, tested: 0, blocked: 0, abandoned: 0, no_surface: 0 },
      segments: arr([{ cidr: '10.1.1.0/24', assets: 1, live: 1, org: '示例', scope: 'internal', ports: 1 }]) }),
    assets: w({ ok: true, total: empty ? 0 : 1, items: arr([ASSET]) }),
    asset: w({ ok: true, asset: ASSET }),
    domains: w({ ok: true, items: arr([{ domain: 'a.example.com', count: 1, assets: [{ id: 1, ip: '10.1.1.1', segment: '10.1.1.0/24', state: 'live', names: ['a.example.com'] }] }]) }),
    web: w({ ok: true, items: arr([{ port_id: 1, url: 'http://10.1.1.1/', title: '首页', ip: '10.1.1.1', port: 80, segment_cidr: '10.1.1.0/24', service: 'http', product: 'nginx', version: '1.24' }]) }),
    discoveryTimeline: w({ ok: true, span: { total: 1, first: '2026-01-02T03:04:05Z', last: '2026-01-02T03:04:05Z' },
      days: arr([{ day: '2026-01-02', assets: 1, internal: 1, external: 0 }]),
      recent: arr([{ id: 1, ip: '10.1.1.1', scope: 'internal', discovered_at: '2026-01-02T03:04:05Z', primary_name: 'a.example.com', open_ports: 1, priority: 'high' }]) }),
    activeTests: w({ ok: true, testing: arr([{ ...ASSET, vulns: 1, webshells: 0, tunnels: 0 }]),
      recent: arr([{ ...ASSET, test_status: 'tested' }]), queue: arr([{ ...ASSET, test_status: 'untested' }]), untested: 1,
      stats: { testing: 1, untested: 1, tested: 0, abandoned: 0, blocked: 0, no_surface: 0 } }),
    agentsStatus: w({ ok: true, max: 3, used: 1, free: 2, total_children: 1, running: [{ parent: 's1', label: '信息收集', activity: 'running', mode: 'child' }] }),
    prompts: w({ ok: true, roles: arr([
      { role: 'plan', title: '主会话', content: '# 指挥', updated_at: '2026-01-01T00:00:00Z', planner: true },
      { role: 'recon', title: '信息收集', content: '# 收集', updated_at: '2026-01-01T00:00:00Z' },
    ]) }),
    sessions: w({ ok: true, totals: { webshells: 1, tunnels: 1, tunnelsLegit: 1, tunnelsSelfOnly: 0 },
      webshells: arr([{ id: 1, url: 'http://10.1.1.1/s.jsp', shell_type: 'behinder', status: 'online', pass_key: 'e45', asset_ip: '10.1.1.1', privilege: 'root', last_check: '2026-01-02T03:04:05Z', latency_ms: 30, check_note: '', note: '', secret_ref: '' }]),
      tunnels: arr([{ id: 1, kind: 'suo5', listen: '127.0.0.1:1080', entry: 'http://10.1.1.1/s.jsp', reach: '10.1.1.0/24', entry_kind: 'target-http', entry_kind_label: '经目标 WebShell', legit: true, status: 'active', command: 'suo5 -t ... -l 1080' }]) }),
    vulns: w({ ok: true, total: empty ? 0 : 1, items: arr([VULN]),
      stats: { bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, byStatus: { confirmed: 1, exploited: 0 }, withGained: 1, targetGroups: empty ? 0 : 1 } }),
    credentials: w({ ok: true, items: arr([{ id: 1, host: '10.1.1.1', username: 'admin', secret_value: 'Admin@123', secret_type: 'password', privilege: '管理员', source: '注入拖库', tool: 'sqlmap', secret_ref: 'r1', found_by_agent: 'exploit', found_at: '2026-01-02T03:04:05Z', note: '' }]) }),
    access: w({ ok: true, items: arr([{ id: 1, host: '10.1.1.1', username: 'admin', method: 'webshell', privilege: 'root', session_ref: 's1' }]) }),
    scoreChain: w({ ok: true, summary: { points: 1000, hits: 1, selfCreatedHits: 0, serviceCappedHits: 0, tunnelsLegit: 1, tunnelsSelfOnly: 0 },
      stages: [
        { code: 'recon', name: '信息收集', color: '#6366f1', goal: '收全资产', ordinal: 1, points: 0, cumulative: 0, hits: 0, items: [], assets: [], assetCount: 0, tunnels: [], tunnels_self_only: [] },
        { code: 'boundary', name: '边界突破', color: '#f59e0b', goal: '进内网', ordinal: 3, points: 1000, cumulative: 1000, hits: 1, assetCount: 1, assets: [ASSET], tunnels: arr([{ id: 1, kind: 'suo5', listen: '127.0.0.1:1080', reach: '10.1.1.0/24', status: 'active' }]), tunnels_self_only: [],
          items: arr([{ id: 1, point_id: 1, point_name: '进入逻辑隔离业务内网', points: 1000, counted: true, nth_of_point: 1, target: '10.1.1.1', asset_ip: '10.1.1.1', capped: false, capped_reason: null, action: null, action_inferred: false, recorded_at: '2026-01-02T03:04:05Z', recorded_by: 'exploit', evidence: '可达内网' }]) },
      ] }),
    scoreReport: w({ ok: true, target: ENGINE, markdown: '# 报告',
      summary: { points: 1000, count: 1, withRequests: 1, missingRequests: 0, incomplete: 0, serviceCappedExcluded: 0, selfCreatedExcluded: 0 },
      stages: arr([{ code: 'boundary', name: '边界突破', color: '#f59e0b', ordinal: 3, points: 1000, cumulative: 1000,
        items: [{ id: 1, seq: 1, code: 'boundary-logical', point_name: '进入逻辑隔离业务内网', points: 1000, counted: true, nth_of_point: 1, target: '10.1.1.1', asset_ip: '10.1.1.1', gained: '内网可达', evidence: '可达 10.1.1.0/24', recorded_at: '2026-01-02T03:04:05Z', recorded_by: 'exploit', vuln: null, note: '', how: '靠 CVE-2026-1', incomplete: false, gaps: [], credentials: [], tunnels: [], webshells: [], accesses: [],
          requests: [{ label: 'r', method: 'GET', url: 'http://x/', status: 200, request: 'GET / HTTP/1.1', response: 'HTTP/1.1 200 OK', source: 'linked' }],
          steps: [{ id: 1, title: '建隧道', tool: 'suo5 -t', result: 'ok', agent: 'exploit', stage_code: 'boundary', recorded_at: '2026-01-02T03:04:05Z', inferred: false }] }] }]) }),
    scores: w({ ok: true,
      summary: { achievedPoints: 1000, pointCount: 25, hitPointCount: 1, hitCount: 1, countedHits: 1, selfCreatedHits: 0, serviceCappedHits: 0 },
      ruleGroups: arr([{ key: 'BOUNDARY', name: '突破网络边界', capSum: 3000, points: 1000, counted: 1, capped: 0,
        tiers: [{ id: 1, code: 'boundary-logical', name: '进入逻辑隔离业务内网', category: 'BOUNDARY', points: 1000, rule: 19, cap: 0, dedup_scope: 'target', builtin: true, src: 22, legacy: false, counted: 1, earned: 1000, self_created: 0, capped: 0, capped_hits: [], cap_used: 1000, scope_label: '整个目标只算一次', description: '说明', enabled: true, tier: '1000 分',
          hits: [{ id: 1, points: 1000, counted: true, capped: false, capped_reason: null, evidence: '可达', target: '10.1.1.1', recorded_at: '2026-01-02T03:04:05Z', recorded_by: 'exploit', service: null }] }] }]) }),
    attackFiles: w({ ok: true, items: arr([{ folder: '10.1.1.1', target: '10.1.1.1', count: 1, files: [{ id: 1, name: 'poc.py', kind: 'poc', description: '验证脚本', path: '/tmp/poc.py' }] }]) }),
    readAttackFile: w({ ok: true, id: 1, name: 'poc.py', kind: 'poc', content: 'print(1)', evidence: '生效', path: '/tmp/poc.py', created_at: '2026-01-02T03:04:05Z', created_by: 'exploit' }),
    pocSearch: w({ ok: true, stats: { total: 1, verified: 1, reused: 0, byKind: [], bySource: [] },
      templates: { dir: '/tmp/tpl', total: 0, items: [] },
      items: arr([{ id: 1, code: 'cve-2026-1', title: '示例 POC', kind: 'poc', category: 'rce', cve: 'CVE-2026-1', component: 'demo', verified: 1, source: 'web', hit_count: 0, engagement_name: ENGINE, asset_target: '10.1.1.1', created_at: '2026-01-02T03:04:05Z', description: '说明' }]) }),
    pocGet: w({ ok: true, id: 1, title: '示例 POC', kind: 'poc', category: 'rce', content: 'id: x', usage: 'nuclei -t x', description: 'd', cve: 'CVE-2026-1', component: 'demo', verified: 1, hit_count: 0, source: 'web' }),
    skillCatalog: w({ ok: true, total: 1, fromPlugin: 1, note: '',
      availability: { summary: { available: 1, broken: 0, unknown: 0 }, checked_at: '2026-01-01T00:00:00Z', cached: false, broken: [], note: '' },
      byDir: [{ key: '/tmp/skills', n: 1 }], bySource: [{ key: 'plugin', n: 1 }],
      items: arr([{ name: 'fofa-recon', description: 'FOFA 测绘', whenToUse: '信息收集', provider: 'redteam', source: 'plugin', dir: '/tmp/skills', fromPlugin: true, modelInvocable: true, userInvocable: true, availability: 'available', problems: [], needs_user: [] }]) }),
    skillRead: w({ ok: true, name: 'fofa-recon', description: 'FOFA 测绘', whenToUse: '信息收集', provider: 'redteam', source: 'plugin', path: '/tmp/skills/fofa.md', content: '# FOFA' }),
    consoleDigest: w({ ok: true, sections: {
      assets: { count: 1, at: '2026-01-02T03:04:05Z' }, findings: { count: 1, at: '2026-01-02T03:04:05Z' },
      scores: { count: 1, at: '2026-01-02T03:04:05Z' }, sessions: { count: 1, at: '2026-01-02T03:04:05Z' },
      chain: { count: 1, at: '2026-01-02T03:04:05Z' }, testing: { count: 1, at: '2026-01-02T03:04:05Z' },
      attackfiles: { count: 1, at: '2026-01-02T03:04:05Z' },
    } }),
    version: w({ ok: true, plugin: { name: 'dsh-redteam-mode', version: '0.11.0' }, install: { mode: 'dev', dir: '/tmp' }, latest: '0.11.0', updateAvailable: false, blockers: [], notes: [], running_agents: [] }),
    updateCheck: { ok: false, error: '开发态不查 registry' },
    probeSessions: w({ ok: true, webshells: [], tunnels: [] }),
    activateEngagement: w({ ok: true, current: ENGINE }),
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑤ 渲染循环：渲染 → 跑 effect（等 promise）→ 有脏再渲染
   ══════════════════════════════════════════════════════════════════════════ */
const flush = () => new Promise((r) => setTimeout(r, 0))

/** 换数据形态时清掉组件实例表（模拟'重新挂载整块面板'），
 *  否则上一轮 effect 发出的 setState 会把旧数据/旧错误带进这一轮，
 *  断言就会莫名其妙地红在'页面正确'的地方。 */
function resetInstances() { instances.clear() }

async function renderAll(rounds = 6) {
  let out = []
  let hosts = []
  for (let i = 0; i < rounds; i += 1) {
    out = []
    hostSink = []
    renderTree(panelRender(), out)
    /* renderTree 内部往 hostSink 收集本次渲染的宿主元素 */
    hosts = hostSink.slice()
    /* 跑本轮 effect（里面会发 api 调用） */
    for (const inst of instances.values()) for (const e of inst.effects) e()
    await flush()
    await flush()
  }
  return { texts: out.join(' '), hosts }
}

/** 点击文本匹配的页签，然后重渲染（面板用 useUI 的 reducer 驱动）。 */
async function switchTab(label) {
  const r = await renderAll()
  const hit = r.hosts.find((x) => {
    const kids = x.props && x.props.children
    const flat = Array.isArray(kids) ? kids.flat(9) : [kids]
    return flat.some((k) => k === label) && x.handlers.onClick
  })
  if (hit === undefined) return null
  hit.handlers.onClick()
  return renderAll()
}

const TAB_LABELS = ['资产测绘', '当前测试', '智能体', '会话隧道', '漏洞战果', '攻击链', '得分目标', '报告', '攻击文件', '知识库', '智能体提示词', '技能库']

/* ══════════════════════════════════════════════════════════════════════════
   ⑥ 断言
   ══════════════════════════════════════════════════════════════════════════ */
console.log('— 面板整体渲染（三种数据形态）')
for (const shape of ['data', 'empty', 'error']) {
  responses = makeResponses(shape)
  resetInstances()
  let err = null
  let out = ''
  try { out = (await renderAll()).texts } catch (error) { err = error }
  ok(err === null && out.length > 0, `[${shape}] 面板渲染不抛异常且有输出（输出 ${out.length} 字符）` + (err ? '：' + err.message : ''))
  if (shape === 'data') ok(TAB_LABELS.every((t) => out.includes(t)), '12 个页签标签都渲染出来')
}

console.log('\n— 12 个页签逐个渲染（有数据 / 空 / 报错）')
for (const shape of ['data', 'empty', 'error']) {
  responses = makeResponses(shape)
  resetInstances()
  await renderAll()
  for (const label of TAB_LABELS) {
    const r = await switchTab(label)
    if (r === null) { ok(false, `[${shape}] 找不到页签「${label}」的点击入口`); continue }
    ok(r.texts.length > 0 && r.texts.includes(label), `[${shape}] 「${label}」渲染成功`)
  }
}

console.log('\n— 有数据时的关键内容（渲染确实用了接口返回的数据）')
{
  responses = makeResponses('data')
  resetInstances()
  const r = await switchTab('资产测绘')
  ok(r.texts.includes('10.1.1.1'), '资产测绘：IP 渲染出来')
  ok(r.texts.includes('10.1.1.0/24'), '资产测绘：C 段渲染出来')
  ok(!r.texts.includes('图谱'), '资产测绘：不再有「图谱」入口（已移除）')
  ok(r.texts.includes('发现时间'), '资产测绘：「发现时间」视图仍在（删图谱时误伤过的那个）')
  const f = await switchTab('漏洞战果')
  /* 默认「按目标聚合」：顶层只显示目标，漏洞标题在展开后才出现 —— 断言按这个真实行为写，
     否则测试会因为'没找到标题'而红，但其实页面是对的。 */
  ok(f.texts.includes('http://10.1.1.1') && /1 个漏洞/.test(f.texts), '漏洞战果：按目标聚合出分组（目标 + 漏洞数）')
  ok(f.texts.includes("后台管理员"), "漏洞战果：分组右侧显示「拿到什么权限」")
  const s = await switchTab('智能体提示词')
  ok(s.texts.includes('主会话') || s.texts.includes('信息收集'), '智能体提示词：角色列表渲染出来')
  const k = await switchTab('技能库')
  ok(k.texts.includes('fofa-recon'), '技能库：技能名渲染出来')
  const rep = await switchTab('报告')
  ok(rep.texts.includes('进入逻辑隔离业务内网'), '报告：得分项渲染出来')
  const sc = await switchTab('得分目标')
  ok(sc.texts.includes('突破网络边界') || sc.texts.includes('进入逻辑隔离业务内网'), '得分目标：分组渲染出来')
}

console.log('\n— 空数据态给出"下一步怎么做"的引导（不是白屏）')
{
  responses = makeResponses('empty')
  resetInstances()
  await renderAll()
  const f = await switchTab('漏洞战果')
  ok(/暂无漏洞记录/.test(f.texts), '漏洞战果：空态文案渲染（' + (f.texts.match(/暂无[^ ]*/) || ['无'])[0] + '）')
  const a = await switchTab('攻击文件')
  ok(/暂无攻击文件/.test(a.texts), '攻击文件：空态文案渲染')
  const c = await switchTab('攻击链')
  ok(c.texts.length > 0, '攻击链：空数据不崩')
}

console.log('\n— 报错态显示错误而不是白屏')
{
  responses = makeResponses('error')
  resetInstances()
  const r = await switchTab('漏洞战果')
  ok(/模拟后端失败/.test(r.texts), '漏洞战果：后端报错时把错误文案显示出来（实际：' + JSON.stringify((r.texts.match(/模拟后端失败/) || ['未出现'])[0]) + '）')
}


console.log('\n— 键盘可达性（回归护栏：不要再往页面里塞没语义的可点击 div）')
{
  responses = makeResponses('data')
  resetInstances()
  const { hosts } = await switchTab('资产测绘')
  const clicky = hosts.filter((x) => x.handlers.onClick)
  /* 原生 <button> 自带全部语义；只检查 div/span 这类"伪按钮" */
  const fakeButtons = clicky.filter((x) => x.tag !== 'button' && x.tag !== 'a')
  const bad = fakeButtons.filter((x) => x.props.role === undefined && x.props.tabIndex === undefined)
  ok(bad.length === 0,
    '所有非原生按钮的可点击元素都有 role/tabIndex' + (bad.length ? '，缺语义的：' + bad.map((b) => b.tag + '.' + String(b.props.className || '')).join('、') : ''))
  ok(fakeButtons.length > 0, '确实存在伪按钮（否则上面那条断言是空转）')
  const withKeys = fakeButtons.filter((x) => typeof x.props.onKeyDown === 'function')
  ok(withKeys.length === fakeButtons.length,
    '所有伪按钮都处理了 Enter / Space 键（' + withKeys.length + '/' + fakeButtons.length + '）')
}

console.log('\n— 页签栏的 ARIA 语义')
{
  const { hosts } = await switchTab('技能库')
  const tabs = hosts.filter((x) => x.props.role === 'tab')
  const list = hosts.filter((x) => x.props.role === 'tablist')
  ok(list.length === 1, '页签栏有 role=tablist（1 个）')
  ok(tabs.length === 12, '12 个页签都是 role=tab（实际 ' + tabs.length + '）')
  ok(tabs.every((x) => x.props['aria-selected'] !== undefined), '每个页签都带 aria-selected（读屏软件据此播报选中态）')
  const selected = tabs.filter((x) => x.props['aria-selected'] === 'true')
  ok(selected.length === 1 && selected[0].props.title !== undefined, '同一时刻只有一个页签是选中态')
  const dot = hosts.find((x) => String(x.props.className || '').includes('rt-tab-dot'))
  ok(dot === undefined || dot.props['aria-label'] !== undefined, '未读红点带文字替代（纯视觉信息不能只靠颜色）')
}
console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
