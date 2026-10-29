/**
 * RedTeam 智能体工具集（preset 平面）
 *
 * 这些行只向 `tools` 注册模型可见工具，自身不发布任何服务，因此不需要 isolate realm；
 * 它们解析的是 host 平面的 `ctx.redteam`（dsh-redteam-store 发布的进程级实例）。
 *
 * 设计约定：
 *   · 写入一律走 redteam_asset_add / redteam_asset_link，智能体不直接碰 SQL；
 *   · 每次发现都带 provenance（passive|active）与 tool，保证界面上的来源标注可信；
 *   · **靶标按根会话隔离**：绑定键是会话的根祖先 id，子智能体顺着
 *     `session.header.parentSession` 继承父会话的靶标 —— 多会话并行时互不串写，
 *     报告不会再被别的靶标的成果污染（v0.9.0 之前的全局「当前靶标」指针正是串写的根源）；
 *   · 并发硬约束：`redteam_agent_slot` 用 `ctx.subagents.listChildren` 的真实运行数
 *     卡住"同一靶标最多 3 个执行智能体"，超了直接拒绝，不靠提示词自觉。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { ROLE_TITLES, PLANNER_ROLE, ROLE_ORDER, scoreStageOf } from './store-core.js'
import { maxAgentsOf, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT } from './settings.js'
/* 技能可用性判定只有一份实现：面板的「技能库」页签与这里共用（见该文件头注释） */
import { checkSkill, summarizeSkills, expandSkillPath } from './skill-availability.js'

/** Cordis 插件名。 */
export const name = 'redteam-tools'

/** 硬依赖：资产库服务 + 工具注册表（subagents / skills 走 ctx.get 可选获取）。 */
export const inject = ['redteam', 'tools']

/** 根会话 id → engagementId 绑定（一次会话内稳定；进程重启后由 agent 重新绑定）。 */
const bindings = new Map()

/** 并发闸门：根会话 id → Map(子智能体键 → 预留时间戳)。子智能体结束时自动释放。 */
const reservations = new Map()

/**
 * 并发上限：同一靶标（根会话）同时最多几个执行智能体。
 *
 * **每次调用现读**（不在模块加载时定死）：用户在控制台「智能体」页改完立即生效，
 * 不必重启 dsh web。生效顺序见 `settings.js`：settings.json → `REDTEAM_MAX_AGENTS` → 默认 3。
 * @returns 当前生效的整数上限。
 */
function maxAgentsNow() {
  const root = (() => {
    try { return ctx.redteam.root } catch { return undefined }
  })()
  return maxAgentsOf(root, process.env)
}

/** 一次调用的会话解析结果。 */
function sessionInfoOf(exec) {
  const agent = exec && exec.agent
  const session = agent && agent.session
  if (session === undefined || session === null) return {}
  const id = session.id === undefined ? undefined : String(session.id)
  let parentId
  try {
    const header = session.header
    parentId = header && header.parentSession !== undefined && header.parentSession !== null
      ? String(header.parentSession)
      : undefined
  } catch { parentId = undefined }
  return { id: id, parentId: parentId, session: session }
}

/** 会话 id（兼容旧调用点）。 */
function sessionOf(exec) {
  return sessionInfoOf(exec).id
}

/**
 * 解析"根会话"：一路沿 parentSession 走到最顶层的会话 id。
 * 主会话派出的子智能体因此共享同一个绑定键，而**不同主会话之间天然隔离**。
 * 顺手把沿途会话 id 都返回，便于把绑定缓存到子会话上。
 */
function resolveRootSession(session) {
  const chain = []
  let cur = session
  let guard = 0
  while (cur !== undefined && cur !== null && guard < 64) {
    const info = sessionInfoOf({ agent: { session: cur } })
    if (info.id === undefined) break
    chain.push(info.id)
    if (info.parentId === undefined || info.parentId === '') break
    let parent
    try {
      const store = cur.store
      parent = store && typeof store.get === 'function' ? store.get(info.parentId) : undefined
    } catch { parent = undefined }
    if (parent === undefined || parent === null) {
      /* 父会话不在内存里（被回收 / 冷启动）：父 id 本身就是稳定的根键 */
      return { rootId: info.parentId, chain: chain.concat([info.parentId]) }
    }
    cur = parent
    guard += 1
  }
  return { rootId: chain.length > 0 ? chain[chain.length - 1] : undefined, chain: chain }
}

/** 绑定键 + 会话链。 */
function bindingKeyOf(exec) {
  const info = sessionInfoOf(exec)
  if (info.id === undefined) return { rootId: undefined, sessionId: undefined, chain: [] }
  const resolved = resolveRootSession(info.session)
  const rootId = resolved.rootId === undefined ? info.id : resolved.rootId
  return { rootId, sessionId: info.id, chain: resolved.chain }
}

/**
 * 解析本次调用应作用在哪个靶标上（会话隔离版）。
 *
 * 顺序：① 显式传入 → ② 本会话/父链上的绑定 → ③ 全局「当前靶标」指针
 * （仅当没有被别的会话占用；被占用时报错并提示显式绑定，**绝不静默串写**）。
 *
 * 抛错而不是"随便挑一个"是刻意的：多会话并行时挑错靶标 = 把 A 单位的成果写进
 * B 单位的库、A 的报告里出现 B 的数据（这正是要多会话隔离的原因）。
 */
function resolveEngagement(store, exec, explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  const keys = Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
  for (const key of keys) {
    const bound = bindings.get(key)
    if (typeof bound === 'string' && bound.length > 0) return bound
  }
  if (typeof store.activeEngagementId === 'function') {
    const active = store.activeEngagementId()
    if (active !== undefined) {
      const holder = Array.from(bindings.entries()).find(([k, v]) => v === active && !keys.includes(k))
      if (holder !== undefined) {
        throw new Error(
          '本会话尚未绑定靶标，而全局「当前靶标」' + active + ' 已被另一个会话占用；'
          + '为避免多会话串写同一个靶标库，请显式绑定：redteam_engagement_open（新建/打开）'
          + ' 或 redteam_session_bind（绑定到已有靶标）。',
        )
      }
      for (const key of keys) bindings.set(key, active)
      recordSessionBinding(store, exec, active)
      return active
    }
  }
  const list = store.listEngagements()
  if (list.length === 1) {
    for (const key of keys) bindings.set(key, list[0].id)
    recordSessionBinding(store, exec, list[0].id, list[0].name)
    return list[0].id
  }
  throw new Error('尚未绑定靶标：请先调用 redteam_engagement_open 传入靶标单位名称')
}

/**
 * 当前会话的绑定关系（redteam_session_info 与面板展示用）。
 * @param exec - 工具执行上下文（取会话链）。
 * @param store - 资产库实例（读面板「跟随会话」用的落盘绑定）。
 */
function bindingViewOf(exec, store) {
  const info = sessionInfoOf(exec)
  const { rootId, chain } = bindingKeyOf(exec)
  return {
    session_id: info.id ?? null,
    parent_session: info.parentId ?? null,
    root_session: rootId ?? null,
    session_chain: chain,
    is_subagent: info.parentId !== undefined,
    bound_engagement: rootId !== undefined ? (bindings.get(rootId) ?? null) : null,
    /* 面板「跟随会话」读的落盘绑定：写的是根会话键，重启后仍在 */
    panel_follow_engagement: rootId !== undefined && store && typeof store.sessionBinding === 'function'
      ? (store.sessionBinding(rootId) ?? null)
      : null,
  }
}

/** 子智能体的继承说明（写进返回值，让模型知道为什么它不用再绑定一次）。 */
function inheritedHint(exec, id) {
  const info = sessionInfoOf(exec)
  if (info.parentId === undefined) return undefined
  return '本会话是子智能体：靶标 ' + id + ' 继承自父会话（会话隔离生效，不会写到别的靶标库里）。'
}

/** 逗号/空白分隔的清单 → 去重数组。 */
function splitList(value) {
  return String(value || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
}

/** 把一行资产压成模型可读的紧凑结构（避免把整库原始数据塞进上下文）。 */
function compactAsset(a) {
  return {
    id: a.id,
    ip: a.ip,
    segment: a.segment_cidr,
    state: a.state,
    name: a.primary_name,
    names: a.names.map((n) => n.name),
    ports: a.ports.filter((p) => p.state === 'open')
      .map((p) => p.port + '/' + p.proto + (p.service ? ' ' + [p.service, p.product, p.version].filter(Boolean).join(' ') : '') + ' [' + p.provenance + ']'),
    fingerprints: a.fingerprints.map((f) => [f.category, f.vendor, f.product, f.version].filter(Boolean).join(' ') + ' [' + f.provenance + ']'),
    passive: a.passive,
    active: a.active,
    /* 发现时间：这条资产第一次进入本库的时刻（面板与报告都按它排时间线） */
    discovered_at: a.discovered_at,
    first_seen: a.first_seen,
    last_seen: a.last_seen,
    test_status: a.test_status,
    priority: a.priority,
  }
}

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/** 角色 code 的合法值说明（写进工具 description，模型不用猜）。 */
const ROLE_HINT = '角色 code：' + ROLE_ORDER.map((r) => '`' + r + '`（' + ROLE_TITLES[r] + '）').join('、')

/** 当前会话的绑定键（根会话 + 本会话 + 父链），用于把绑定写全。 */
function bindKeysOf(exec) {
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  return Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
}

/**
 * 把「根会话 → 靶标」记进 store 的持久绑定表（`$DSH_HOME/redteam/sessions.json`）。
 *
 * 工具侧的 {@link bindings} 是进程内 Map，只服务模型调用；控制台面板在**浏览器**里，
 * 拿不到它。于是"用户切到某个会话，面板就该显示那个会话的靶标"需要一份双方都读得到的账：
 * 这里写，面板经 `sessionBinding` op 读（见 UI 的半侧跟随逻辑）。
 *
 * 只写**根会话**键：子智能体沿父链继承，面板解析到根会话后落到同一个键上。
 * 写失败不影响工具本身的返回值（面板大不了回落到"最后一次绑定的靶标"）。
 */
function recordSessionBinding(store, exec, engagementId, name) {
  if (typeof store.setSessionBinding !== 'function') return
  const { rootId, sessionId } = bindingKeyOf(exec)
  const key = rootId || sessionId
  if (key === undefined || key === null || key === '') return
  try {
    store.setSessionBinding(String(key), String(engagementId), name === undefined ? undefined : String(name))
  } catch { /* 面板回落，不阻断智能体 */ }
}

/** 实时并发占用：读 subagents 注册表里"真正在跑"的直接子会话数。 */
async function liveRunningChildren(ctx, rootSessionId) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined || subagents === null || typeof subagents.listChildren !== 'function') {
    return { available: false, running: 0, error: 'subagents 注册表不可用（无法核对实际并发数，只能按预留计数）' }
  }
  try {
    const entries = await subagents.listChildren(rootSessionId)
    const rows = Array.isArray(entries) ? entries : []
    const running = rows.filter((e) => e && e.kind === 'child' && e.activity === 'running')
    return {
      available: true,
      running: running.length,
      running_labels: running.map((e) => e.label || e.id).slice(0, 20),
      total_children: rows.filter((e) => e && e.kind === 'child').length,
    }
  } catch (error) {
    return { available: false, running: 0, error: '列子会话失败：' + (error && error.message ? error.message : String(error)) }
  }
}

/** 预留（未被 subagents 注册表覆盖的那部分，例如刚 acquire 还没起来的）。 */
function reservationList(rootId) {
  const map = reservations.get(rootId)
  if (map === undefined) return []
  return Array.from(map, ([key, at]) => ({ key, at }))
}

function addReservation(rootId, key) {
  if (!reservations.has(rootId)) reservations.set(rootId, new Map())
  reservations.get(rootId).set(key, Date.now())
}

function dropReservation(rootId, key) {
  const map = reservations.get(rootId)
  if (map === undefined) return false
  if (key === undefined) {
    const n = map.size
    reservations.delete(rootId)
    return n > 0
  }
  return map.delete(key)
}

/**
 * 产出这条记录的智能体角色：显式传的优先，否则默认按主会话记账。
 * 这个值会写进库里的 `agent` 列，报告里"这一步是谁做的"就靠它。
 */
function agentOf(args) {
  const raw = typeof args.agent === 'string' ? args.agent.trim() : ''
  return raw !== '' ? raw : PLANNER_ROLE
}


/** 解析 IPv4 为整数；不是 IPv4 返回 null。 */
function ipv4Int(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim())
  if (m === null) return null
  const n = m.slice(1).map(Number)
  if (n.some((x) => x > 255)) return null
  return ((n[0] * 256 + n[1]) * 256 + n[2]) * 256 + n[3]
}

/** target 字符串里能认出的 IPv4（URL / host:port / 裸 IP 都行）；认不出返回 null。 */
function targetIpv4(target) {
  const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(String(target || ''))
  return m === null ? null : m[1]
}

function ipInCidr(ip, cidr) {
  const [base, bitsText] = String(cidr || '').split('/')
  const a = ipv4Int(ip)
  const b = ipv4Int(base)
  const bits = Number(bitsText)
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  if (bits === 0) return true
  const mask = (0xFFFFFFFF << (32 - bits)) >>> 0
  return (a & mask) >>> 0 === (b & mask) >>> 0
}

function scopeOfEngagement(store, id) {
  const row = store.listEngagements().find((e) => e.id === id)
  return Array.isArray(row && row.scope) ? row.scope : []
}

/** 范围判定：无 scope → 'unscoped'；有 scope 且 IP 命中 → in；IP 不在 → out；域名/解析不出 → unresolved。 */
function scopeCheck(store, id, target) {
  const scope = scopeOfEngagement(store, id)
  if (scope.length === 0) return { status: 'unscoped', scope, ip: null }
  const ip = targetIpv4(target)
  if (ip === null) return { status: 'unresolved', scope, ip: null }
  const hit = scope.find((cidr) => ipInCidr(ip, cidr))
  return { status: hit === undefined ? 'out' : 'in', scope, ip, cidr: hit || null }
}

/** 通过 SOCKS5 代理做一次 CONNECT 探测（suo5/chisel 的本地监听都支持）。 */
function socks5Probe(listen, target, timeoutMs = 6000) {
  const proxy = String(listen || '').replace(/^socks5:\/\//, '').replace(/^https?:\/\//, '')
  const pi = proxy.lastIndexOf(':')
  const ph = pi > 0 ? proxy.slice(0, pi) : '127.0.0.1'
  const pp = Number(pi > 0 ? proxy.slice(pi + 1) : proxy)
  const ti = target.lastIndexOf(':')
  const th = ti > 0 ? target.slice(0, ti) : target
  const tp = Number(ti > 0 ? target.slice(ti + 1) : 0)
  if (!Number.isFinite(pp) || pp <= 0 || !Number.isFinite(tp) || tp <= 0) {
    return Promise.resolve({ ok: false, target, error: 'listen/target 端口无法解析' })
  }
  return new Promise((resolve) => {
    const started = Date.now()
    let done = false
    let stage = 'greeting'
    const socket = createConnection({ host: ph, port: pp })
    const finish = (ok, error) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve({ ok, target, listen, latency_ms: Date.now() - started, error: error || undefined })
    }
    socket.setTimeout(Math.min(Math.max(Number(timeoutMs) || 6000, 1000), 20000))
    socket.on('timeout', () => finish(false, 'timeout'))
    socket.on('error', (e) => finish(false, String((e && e.code) || (e && e.message) || e)))
    socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])))
    socket.on('data', (buf) => {
      if (stage === 'greeting') {
        if (buf.length < 2 || buf[0] !== 5 || buf[1] !== 0) return finish(false, 'SOCKS5 greeting failed')
        stage = 'connect'
        const ip = ipv4Int(th)
        let req
        if (ip !== null) {
          const b = Buffer.alloc(10); b[0] = 5; b[1] = 1; b[2] = 0; b[3] = 1
          b.writeUInt32BE(ip >>> 0, 4); b.writeUInt16BE(tp, 8); req = b
        } else {
          const hb = Buffer.from(th, 'utf8')
          const b = Buffer.alloc(7 + hb.length); b[0] = 5; b[1] = 1; b[2] = 0; b[3] = 3; b[4] = hb.length
          hb.copy(b, 5); b.writeUInt16BE(tp, 5 + hb.length); req = b
        }
        socket.write(req)
        return
      }
      if (buf.length >= 2 && buf[0] === 5 && buf[1] === 0) finish(true)
      else finish(false, 'SOCKS5 connect rejected')
    })
  })
}

/**
 * boundary-* 的工具级硬门槛：必须有结构化 boundary 对象，且入口区 ≠ 落点区；
 * boundary-supply 还要求 scope_confirmed=true。store 层只警告（兼容历史/迁移脚本），
 * 但所有模型调用都走工具层，因此这里拒绝后智能体无法把同区隧道记成边界突破。
 */
function assertBoundaryGate(args, code) {
  const c = String(code || '')
  if (!c.startsWith('boundary-')) return
  const b = args && args.boundary
  if (b === null || b === undefined || typeof b !== 'object') {
    throw new Error('边界突破必须提供 boundary 对象（entry_zone / target_zone / isolation / target_asset）；只有边界四问齐全才能记 boundary-*，同区隧道只能记 internal。')
  }
  const entry = String(b.entry_zone || '').trim()
  const target = String(b.target_zone || '').trim()
  const isolation = String(b.isolation || '').trim()
  const asset = String(b.target_asset || '').trim()
  if (entry === '' || target === '' || isolation === '' || asset === '') {
    throw new Error('boundary 不完整：entry_zone / target_zone / isolation / target_asset 都必须填写。')
  }
  if (entry.toLowerCase() === target.toLowerCase()) {
    throw new Error('入口区与落点区相同（' + entry + '）：同区隧道不是边界突破，请改记 internal。')
  }
  if (c === 'boundary-supply' && b.scope_confirmed !== true) {
    throw new Error('boundary-supply 需要 scope_confirmed=true：先让用户确认供应商/云服务在授权范围内，再记分。')
  }
}

/** 账号类得分必须绑定真实登录会话；未授权接口/只有凭据不能记账号分。 */
const ACCOUNT_SCORE_CODES = new Set(['web-app', 'central-system'])

function hostOfTarget(value) {
  return String(value || '')
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')[0]
    .split('?')[0]
    .toLowerCase()
}

function assertAccountAccess(store, id, args, code) {
  if (!ACCOUNT_SCORE_CODES.has(String(code || ''))) return
  if (args.self_created === true) return
  const accessId = Number(args.access_id)
  if (!Number.isFinite(accessId) || accessId <= 0) {
    throw new Error('账号类得分必须绑定有效登录：先 redteam_access_add 记录实际登录（host/username/method），再把返回 id 传到 access_id；未授权接口、只有凭据都不算账号权限。')
  }
  const access = (store.listAccess(id, { limit: 1000 }) || []).find((a) => Number(a.id) === accessId)
  if (access === undefined) throw new Error('access_id 不存在：先 redteam_access_add 记录实际登录，再记分。')
  if (!String(access.username || '').trim()) {
    throw new Error('access_id 对应的登录没有 username：账号类得分必须能说清登录的是哪个账号。')
  }
  if (/webshell|rce|reverse|shell/i.test(String(access.method || ''))) {
    throw new Error('access_id 对应的是 WebShell/RCE 会话，不是账号登录：账号类得分请记录实际登录（method=web/ssh/rdp/db 等）。')
  }
  const targetHost = hostOfTarget(args.target)
  const accessHost = hostOfTarget(access.host)
  if (targetHost !== '' && accessHost !== '' && targetHost !== accessHost) {
    throw new Error('access_id 的登录目标与 target 不一致：access.host=' + access.host + '，target=' + args.target + '。')
  }
}

/** 写库工具共用的 agent 参数（角色 code 白名单提示写进 description）。 */
const AGENT_PARAM = {
  type: 'string',
  description: '【建议填】产出这条记录的角色 —— ' + ROLE_HINT
    + '。报告里会按它标注"这一步是谁做的"，不填按主会话记账。',
}

/**
 * 把 store 层抛出的异常统一收敛成结构化的失败返回。
 *
 * 为什么需要：同一类错误（对象不存在 / 参数非法）此前有两种形态 ——
 * 有的工具 `return { ok:false, error }`，有的直接抛。模型拿到前者能换参数重试，
 * 拿到后者往往直接放弃这一次调用，行为不可预测。统一成前者，且**不吞原始信息**。
 * @param tool - defineTool 的返回值。
 * @returns 包了一层 try/catch 的同一个工具定义。
 */
function withStructuredErrors(tool) {
  const inner = tool.execute
  if (typeof inner !== 'function') return tool
  return Object.assign({}, tool, {
    async execute(args, exec) {
      try {
        return await inner(args, exec)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        /* 参数类错误（非法值/缺必填）与"找不到对象"分开提示，模型据此决定重试还是放弃 */
        const kind = /非法|invalid|required|不能为空|not found|不存在/i.test(message) ? 'bad_input' : 'failed'
        return JSON.stringify({
          ok: false,
          error: message,
          error_kind: kind,
          hint: kind === 'bad_input'
            ? '这是参数或对象标识的问题：核对参数名与取值（可用对应的 *_list / *_query 工具先看实际 id），修正后重试。'
            : '工具执行失败，错误原文见 error 字段；不要静默跳过，先向用户或指挥者说明卡点。',
        }, null, 2)
      }
    },
  })
}


/**
 * 角色工具白名单（按预设 `config.profile` 生效；缺省 all = 不裁剪）。
 *
 * 为什么用"排除集"而不是"允许集"：工具会持续增加，允许集每加一个工具都要改 5 份；
 * 排除集只列"这个角色真不该看到的写操作/管理操作"，新增工具默认对所有角色可见，
 * 漏配的后果是"多看见一个工具"，而不是"关键工具被裁掉"。
 *
 * 只裁真正的越界写操作与管理操作；读工具、score_list、asset_query 等尽量保留，
 * 避免角色因为缺一个查询工具而卡住。profile 参数没被宿主传进来时回退 all。
 */
const PROFILE_EXCLUDES = {
  recon: new Set([
    'redteam_asset_assess', 'redteam_vuln_add', 'redteam_vuln_update',
    'redteam_credential_add', 'redteam_access_add', 'redteam_webshell_add', 'redteam_webshell_update',
    'redteam_tunnel_add', 'redteam_tunnel_update', 'redteam_score_hit', 'redteam_score_point_save',
    'redteam_score_report', 'redteam_report', 'redteam_report_targets', 'redteam_role_prompt_reset',
    'redteam_poc_add', 'redteam_poc_update', 'redteam_poc_use', 'redteam_attack_file_add',
    'redteam_shot_delete', 'redteam_http_evidence_add',
  ]),
  assess: new Set([
    'redteam_vuln_add', 'redteam_vuln_update', 'redteam_credential_add', 'redteam_access_add',
    'redteam_webshell_add', 'redteam_webshell_update', 'redteam_tunnel_add', 'redteam_tunnel_update',
    'redteam_score_hit', 'redteam_score_point_save', 'redteam_score_report', 'redteam_report',
    'redteam_report_targets', 'redteam_role_prompt_reset', 'redteam_poc_add', 'redteam_poc_update',
    'redteam_poc_use', 'redteam_attack_file_add', 'redteam_shot_delete',
  ]),
  'vuln-scan': new Set([
    'redteam_asset_assess', 'redteam_access_add', 'redteam_webshell_add', 'redteam_webshell_update',
    'redteam_tunnel_add', 'redteam_tunnel_update', 'redteam_session_check', 'redteam_score_point_save',
    'redteam_report', 'redteam_report_targets', 'redteam_role_prompt_reset', 'redteam_shot_delete',
  ]),
  exploit: new Set([
    'redteam_asset_assess', 'redteam_score_point_save', 'redteam_report', 'redteam_report_targets',
    'redteam_role_prompt_reset', 'redteam_shot_delete',
  ]),
  internal: new Set([
    'redteam_score_point_save', 'redteam_report', 'redteam_report_targets', 'redteam_role_prompt_reset',
    'redteam_shot_delete',
  ]),
}

export function apply(ctx, config = {}) {
  const profile = String((config && config.profile) || 'all').trim()
  const excluded = PROFILE_EXCLUDES[profile]
  const registerTool = (tool) => {
    if (excluded !== undefined && excluded.has(tool.name)) return
    ctx.tools.register(tool)
  }
  const store = ctx.redteam

  /* ── 子智能体结束时自动释放并发名额（不依赖模型记得调 release）──────────── */
  try {
    ctx.on('subagent/end', (info, parent) => {
      const parentSession = parent && parent.session
      const { rootId } = bindingKeyOf({ agent: { session: parentSession } })
      const childId = info && info.id !== undefined ? String(info.id) : undefined
      if (rootId === undefined) return
      if (childId !== undefined && dropReservation(rootId, childId)) return
      /* 注册表里的键可能与 runId 不同：按时间兜底清掉最早的一个预留 */
      const map = reservations.get(rootId)
      if (map === undefined || map.size === 0) return
      let oldestKey
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, at] of map) { if (at < oldestAt) { oldestAt = at; oldestKey = key } }
      if (oldestKey !== undefined) map.delete(oldestKey)
    })
  } catch { /* 事件不可用时只影响自动释放，手动 release 仍然可用 */ }

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_engagement_open',
    description: '打开或创建一次攻防演练靶标（按单位名称），并把**当前会话**绑定到该靶标（子智能体会自动继承）。后续所有资产工具默认作用于它。若靶标已存在则复用其资产库。写入的是本会话的绑定，不会改动其它会话正在用的靶标。',
    parameters: {
      target: { type: 'string', required: true, description: '靶标单位名称，例如「示例科技有限公司」' },
      scope: {
        type: 'array',
        description: '授权范围 CIDR 列表（可选：用户没给就不用问，按公开可见资产面自主推进）',
        items: { type: 'string' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      /* bindCurrent: false —— 不动全局「当前靶标」指针：多会话并行时那个指针是串写的根源 */
      const engagement = store.openEngagement(args.target, args.scope, { bindCurrent: false })
      const keys = bindKeysOf(exec)
      for (const key of keys) bindings.set(key, engagement.id)
      recordSessionBinding(store, exec, engagement.id, engagement.name)
      const view = bindingViewOf(exec, store)
      return JSON.stringify({
        ok: true,
        engagement,
        stats: store.stats(engagement.id),
        session: view,
        note: '已绑定到本会话（会话隔离：其它会话的绑定不受影响）；子智能体会继承本靶标。'
          + (view.is_subagent ? ' 注意：本会话是子智能体，通常不需要再 open，直接继承父会话靶标即可。' : ''),
      }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_session_bind',
    description: '把一个**已经存在**的靶标绑定到当前会话（多会话并行时用：每个会话绑自己的靶标，互不串写）。可用靶标 id 或单位名称，省略则列出可绑定的靶标。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id 或单位名称；省略只列出候选' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const list = store.listEngagements()
      const wanted = typeof args.engagement === 'string' ? args.engagement.trim() : ''
      if (wanted === '') {
        return JSON.stringify({
          ok: false,
          candidates: list.map((e) => ({ id: e.id, name: e.name, created_at: e.created_at, stats: e.stats })),
          note: '请传 engagement（靶标 id 或单位名称）完成绑定。',
        }, null, 2)
      }
      const hit = list.find((e) => e.id === wanted)
        || list.find((e) => String(e.name) === wanted)
        || list.find((e) => String(e.name).includes(wanted))
      if (hit === undefined) {
        return JSON.stringify({ ok: false, error: '靶标不存在：' + wanted, candidates: list.map((e) => e.id) }, null, 2)
      }
      const keys = bindKeysOf(exec)
      for (const key of keys) bindings.set(key, hit.id)
      recordSessionBinding(store, exec, hit.id, hit.name)
      return JSON.stringify({
        ok: true, engagement: { id: hit.id, name: hit.name },
        session: bindingViewOf(exec, store),
        note: '本会话已绑定到「' + hit.name + '」；后续工具与报告都只作用于它。',
      }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_scope_check',
    description: '检查一个 IP/URL/域名是否在当前靶标的授权 scope 内（scope 来自 redteam_engagement_open）。域名无法解析时返回 unresolved；scope 为空时返回 unscoped（不阻断，但提示用户补范围）。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', required: true, description: '要检查的 IP / URL / 域名' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const check = scopeCheck(store, id, args.target)
      const ok = check.status === 'in' || check.status === 'unscoped' || check.status === 'unresolved'
      return JSON.stringify({ ok, engagement: id, target: args.target, ...check }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_session_info',
    description: '查看**当前会话绑定的是哪个靶标**（会话 id、父会话、根会话、绑定链）。多会话同时开工时，先跑它确认自己没串到别人的靶标上。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(_args, exec) {
      const view = bindingViewOf(exec, store)
      const changed = view.bound_engagement !== null ? store.stats(view.bound_engagement) : null
      return JSON.stringify({
        ok: true, session: view, stats: changed,
        bindings_now: Array.from(bindings, ([k, v]) => ({ session: k, engagement: v })),
        note: '绑定是进程内状态：dsh 重启后各会话需要重新绑定一次（redteam_engagement_open / redteam_session_bind）。'
          + '面板的"跟随会话"读的是落盘绑定表，重启后仍能对上（见 redteam_engagement_open 的写入）。',
      }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_preflight',
    description: '【开工前必须跑一次】平台技能与资源自检：逐个检查红队技能的必需环境变量（如 FOFA 测绘的 FOFA_KEY）、本机工具与二进制（suo5 / fscan / gogo / frp / 冰蝎 / 哥斯拉 / nmap / nuclei…）、外部基础设施（反弹 Shell 用的 VPS）。返回 available/broken 清单与每个坏掉的技能"缺什么、怎么补"。**缺 key / 缺 VPS 时直接向用户要，或改用替代方案，不要假装能跑。** 同时返回当前绑定靶标的提示词新鲜度（`prompts.stale_count`：旧版/自写提示词数量），避免源码已更新但老靶标仍跑旧规则。',
    parameters: {
      include: { type: 'string', description: '只检查这些技能（逗号分隔）；省略则检查全部红队技能' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const skills = ctx.get('skills')
      if (skills === undefined || skills === null || typeof skills.list !== 'function') {
        return JSON.stringify({
          ok: false,
          error: '技能注册表不可用：无法做技能自检。请改用系统注入的 <available_skills> 清单人工核对，并向用户索要缺失的 key/资源。',
        }, null, 2)
      }
      let summaries = []
      try {
        summaries = await skills.list()
      } catch (error) {
        return JSON.stringify({ ok: false, error: '读取技能目录失败：' + (error && error.message ? error.message : String(error)) }, null, 2)
      }
      const only = splitList(args.include)
      const wanted = summaries.filter((s) => only.length === 0 || only.includes(s.name))
      /* 环境变量的真实来源有两处：进程环境 + $DSH_HOME/.env（dsh web 启动时加载的那份）。
         只看 process.env 会误判——用户明明把 FOFA_KEY 写进了 .env，面板却报"缺 key"。
         这里合并成一份：进程环境优先，.env 兜底（不覆盖已存在的值）。 */
      const envFile = expandSkillPath('$DSH_HOME/.env')
      const effectiveEnv = { ...process.env }
      let envFileKeys = []
      try {
        if (existsSync(envFile)) {
          const { readFileSync } = await import('node:fs')
          for (const line of readFileSync(envFile, 'utf8').split('\n')) {
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
            if (m === null) continue
            const key = m[1]
            const value = m[2].trim().replace(/^["']|["']$/g, '')
            if (value === '') continue
            envFileKeys.push(key)
            if (effectiveEnv[key] === undefined || effectiveEnv[key] === '') effectiveEnv[key] = value
          }
        }
      } catch { /* .env 读不到不影响主流程 */ }
      /* 同名技能可能存在于多个技能根：判定时带上"其它根"，才能识别被随包占位符盖住的误报 */
      const rootsWith = new Map()
      for (const x of summaries) {
        const dir = x.resourceBase && x.resourceBase.kind === 'directory' ? x.resourceBase.path : null
        if (dir === null) continue
        if (!rootsWith.has(x.name)) rootsWith.set(x.name, [])
        if (!rootsWith.get(x.name).includes(dir)) rootsWith.get(x.name).push(dir)
      }
      /* checked = **全量**结论（每个技能都判一次）：ok / onboarding.complete 必须基于它，
         否则带上 include 调用时，一台技能大面积坏掉的机器也会被判成"环境就绪"。
         wanted 只用于后面的展示过滤，不再决定判定范围。 */
      const checked = []
      for (const summary of summaries) {
        let def
        try { def = await skills.get(summary.name) } catch { def = undefined }
        const path = def && typeof def.path === 'string'
          ? def.path
          : (summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null)
        const root = summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null
        /* 判定逻辑（环境变量 / 本机路径 / 占位符 / 同名技能被盖住）全部来自共享模块，与面板显示的是同一份结论 */
        const verdict = checkSkill({ name: summary.name, content: def && def.content, path, root },
          { env: effectiveEnv, sameNameIn: rootsWith.get(summary.name) || [] })
        checked.push(Object.assign({}, verdict, {
          title: summary.description,
          path,
          /* 面板上要能看出"这条是给哪个角色用的" */
          when_to_use: summary.whenToUse || '',
          /* 需要用户补的东西：说得具体一点，方便一次性列给他 */
          needs_user: verdict.needs_user.map((n) => (n.startsWith('环境变量')
            ? n + '（拿到后 export 并重启 dsh web）'
            : n === 'VPS 地址' || n === 'VPS 主机名'
              ? '反弹 Shell / 载荷投递用的 ' + n + '（技能里还是占位符）'
              : n)),
        }))
      }
      /* 全量结论（判定用） */
      const allBroken = checked.filter((s) => s.status === 'broken')
      const allAvailable = checked.filter((s) => s.status === 'available')
      /* 展示子集（include 过滤后；不影响上面的判定） */
      const shown = (x) => only.length === 0 || only.includes(x.name)
      const broken = allBroken.filter(shown)
      const available = allAvailable.filter(shown)
      /* 工具箱现状：让用户一眼看到"本机到底有什么" */
      const toolkit = expandSkillPath('$DSH_HOME/redteam/toolkit')
      let toolkitEntries = []
      try {
        if (existsSync(toolkit)) {
          const { readdirSync } = await import('node:fs')
          toolkitEntries = readdirSync(toolkit).slice(0, 60)
        }
      } catch { /* 忽略 */ }

      /* ── 首次使用引导状态 ──────────────────────────────────────────────
         判定"环境是否配齐"看两项客观依据：
           ① FOFA_KEY 有值（测绘能力）
           ② VPS 私钥存在（反弹 Shell 落地能力）
         再加技能体检里的缺口；完成标记只用于提示"首次使用"。
         目标是让指挥智能体**在用户第一次进来时就主动把话说完、一次要齐**，
         而不是等真正动手时才发现缺 key 缺 VPS。 */
      const redteamDir = expandSkillPath('$DSH_HOME/redteam')
      const markerFile = redteamDir + '/.setup-complete'
      const hasMarker = existsSync(markerFile)
      /* npm 包不提供工具下载、安装脚本或安装链接/教程；工具由用户自行准备。 */
      const toolkitHint = '工具由用户自行准备；本插件不提供下载、安装脚本或教程，preflight 只报告缺口。'
      let fofaKey = effectiveEnv.FOFA_KEY || ''
      const vpsKey = effectiveEnv.REDTEAM_VPS_KEY || (toolkit + '/vps/id_rsa')
      const vpsHost = effectiveEnv.REDTEAM_VPS_HOST || ''   /* 不写死真实主机：公开包里不能夹带 */
      const hasVps = existsSync(vpsKey)
      const needsUser = Array.from(new Set(broken.flatMap((s) => s.needs_user)))
      const missing = []
      if (fofaKey === '') missing.push('FOFA_KEY（资产测绘：没有就只能用 crt.sh + 子域枚举，边缘/未备案资产会大量漏掉）')
      if (!hasVps) missing.push('VPS 登录方式（反弹 Shell 落地与载荷投递：没有就拿不到服务器权限、进不了内网）—— 私钥放到 ' + vpsKey + '，并设 REDTEAM_VPS_HOST=用户@主机')
      /* 掩码显示已配置的 key，避免把密钥写进会话记录 */
      const fofaShown = fofaKey.length > 8 ? fofaKey.slice(0, 4) + '…' + fofaKey.slice(-4) : '(已配置)'
      /* 运行环境提醒：让智能体在首次预检时就能提醒用户"该在 Kali 虚拟机里跑"。
         是提示不是门槛 —— 用户确认在宿主机上也照常放行（不阻断开工）。 */
      const runtimeHint = '本模式必须在**专供演练的 Kali 虚拟机**里运行，不要跑在日常办公电脑/宿主机上'
        + '（本机落 VPS 私钥与 WebShell 马，扫描流量也从常用出口 IP 出去；演练完虚拟机可直接丢弃）。'
        + '首次开工时提醒用户一次即可。'
      const onboarding = {
        /* 用**全量** broken 判定：带 include 调用时不能因为"我只看了这个技能"
           就宣布环境已就绪（那正是引导闭环要防的"假装能跑"）。 */
        complete: missing.length === 0 && allBroken.length === 0,
        runtime_hint: runtimeHint,
        first_run: !hasMarker,
        marker: { path: markerFile, exists: hasMarker },
        /* 工具由用户自行准备；没有下载/安装脚本或教程，这里只放提示 */
        toolkit: toolkitHint,
        configured: {
          fofa_key: fofaKey === '' ? 'missing' : 'configured(' + fofaShown + ')',
          vps_key: hasVps ? 'configured(' + vpsKey + ')' : 'missing',
          vps_host: vpsHost,
          env_file: { path: envFile, exists: existsSync(envFile), keys: envFileKeys },
        },
        missing,
      }
      let next
      if (!hasMarker || missing.length > 0) {
        next = '首次使用/有缺口：加载技能 `redteam-setup`，把 onboarding.missing 的每一项**一次性列给用户**（要什么、为什么、给到哪）。'
          + '工具由用户自行准备，本插件不提供下载、安装脚本、安装链接或教程。'
          + toolkitHint + ' '
          + '补不齐时按替代方案降级并说明限制：FOFA 不可用 → crt.sh / 被动 DNS / subfinder（资产收集不完整）；'
          + '没有 VPS → 只做不需要落地的成果（账号、数据、未授权），放弃 boundary/internal/central-system 类得分点。'
      } else if (allBroken.length > 0) {
        next = '把 broken 里 needs_user 的每一项**一次性列给用户**（要什么、为什么、给到哪），补齐后再开工；'
          + '补不齐就对用户说明哪部分能力降级、并给替代方案（例如 FOFA 不可用 → crt.sh / 被动 DNS / subfinder；没有 VPS → 先做不需要落地的成果）。'
      } else {
        next = '全部可用，可以开工。'
      }

      const summary = summarizeSkills(checked)
      /* 当前会话绑定靶标的提示词新鲜度：老靶标里残留的旧版/用户自写提示词
         不会自动跟着新版走；预检时明确报出来，避免“源码是新的、实际跑的是旧的”。 */
      let prompts = null
      try {
        const view = bindingViewOf(exec, store)
        const eng = view.bound_engagement ?? view.panel_follow_engagement
        if (eng !== null && eng !== undefined) {
          const roles = store.listPrompts(eng)
          const stale = roles.filter((r) => r.injected === true && r.stale === true)
            .map((r) => ({ role: r.role, title: r.title }))
          prompts = {
            engagement: eng, total: roles.length, stale_count: stale.length, stale,
            hint: stale.length === 0
              ? '执行角色提示词均为当前版。'
              : '有 ' + stale.length + ' 个执行角色的提示词仍是旧版/自写：先用面板「恢复默认」或 scripts/refresh-all-prompts.mjs 刷新，再开工；否则新版计分/边界规则不会生效。',
          }
        }
      } catch (error) {
        prompts = { error: error && error.message ? error.message : String(error) }
      }
      return JSON.stringify({
        /* ok 同样按全量判定；include 只影响下面 broken/available 两个展示列表 */
        ok: allBroken.length === 0 && missing.length === 0,
        /* include 里写了不存在的技能名：明确报出来，避免"查了个空气还 ok=true" */
        include: only.length > 0 ? { requested: only, unknown: unknownIncludes } : undefined,
        all_checked: { total: checked.length, broken: allBroken.length, available: allAvailable.length },
        onboarding,
        prompts,
        summary,
        checked: checked.length,
        available: available.map((s) => s.name),
        broken: broken.map((s) => ({ name: s.name, problems: s.problems, needs_user: s.needs_user })),
        unknown: checked.filter((s) => s.status === 'unknown').map((s) => s.name),
        toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries },
        skills_root_hint: '技能来自 DSH 原生注册表：本插件自带 + $DSH_HOME/skills + 项目根 + 各插件注册的根。',
        next,
      }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_agent_slot',
    description: '【主会话派活前后用】执行智能体的并发闸门：同一靶标**最多同时 N 个**在跑（N 是用户当前配置的并发数量，默认 3；控制台「智能体」页可改，随时生效）。action=status 看还剩几个名额与谁在跑；action=acquire 占一个名额（满了会直接拒绝，**不要重试硬塞**）；action=release 释放（子智能体结束时服务端也会自动释放）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'acquire', 'release'], description: 'status 查看 / acquire 占用 / release 释放' },
      label: { type: 'string', description: 'acquire 时的任务标签，例如「信息收集：主域与 C 段」' },
      key: { type: 'string', description: 'release 时指定要释放的键（省略则释放最早的一个预留）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const { rootId, sessionId } = bindingKeyOf(exec)
      const owner = rootId ?? sessionId
      if (owner === undefined) {
        return JSON.stringify({ ok: false, error: '取不到会话 id：无法统计并发（请确认工具调用带着 agent 上下文）。' }, null, 2)
      }
      const live = await liveRunningChildren(ctx, owner)
      const reserved = reservationList(owner)
      /* 注册表里 running 的子会话已经包含正在跑的；预留是"刚占位还没出现在注册表"的那部分，
         两者取较大值，避免重复计数又不会漏计 */
      const used = Math.max(live.running, reserved.length)
      const max = maxAgentsNow()
      const free = Math.max(max - used, 0)
      const base = {
        ok: true, max, used, free,
        running_from_registry: live.running,
        running_labels: live.running_labels ?? [],
        reservations: reserved,
        registry_available: live.available,
        registry_note: live.available ? undefined : live.error,
      }
      if (args.action === 'status') {
        return JSON.stringify(Object.assign(base, {
          hint: free === 0
            ? '名额已满：等现有智能体回报后再派（每次只派一个、按顺序推进是最稳的节奏）。'
            : '还有 ' + free + ' 个名额。默认一个一个派；只有确实互不依赖的活才并行。',
        }), null, 2)
      }
      if (args.action === 'acquire') {
        if (free <= 0) {
          return JSON.stringify(Object.assign(base, {
            ok: false,
            error: '并发已满（最多 ' + max + ' 个）：现在不能派新智能体。先等当前的在跑智能体回报，或先 release 掉已经结束的。',
          }), null, 2)
        }
        const key = (typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : 'slot') + '#' + Date.now()
        addReservation(owner, key)
        return JSON.stringify(Object.assign(base, { slot: key, used: used + 1, free: Math.max(max - used - 1, 0) }, {
          hint: '已占位（' + key + '）。**派完之后要记得**：子智能体结束会自动释放；若你派活失败（比如工具报错），手动 redteam_agent_slot action=release key=' + key + ' 把它放掉。',
        }), null, 2)
      }
      const dropped = dropReservation(owner, typeof args.key === 'string' && args.key.trim() !== '' ? args.key.trim() : undefined)
      return JSON.stringify(Object.assign(base, { ok: true, released: dropped, used: Math.max(used - (dropped ? 1 : 0), 0) }), null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_asset_add',
    description: '把一个资产及其端口/服务/指纹写入资产库（幂等 upsert）。每条发现必须标注 provenance：被动收集填 passive，主动探测填 active，并填写 tool（数据源或工具名）。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id；省略则用当前会话绑定的靶标' },
      ip: { type: 'string', required: true, description: '资产 IP（IPv4）' },
      state: { type: 'string', description: 'live | dead | unknown，默认 unknown' },
      primary_name: { type: 'string', description: '主域名/主机名' },
      provenance: { type: 'string', required: true, enum: ['passive', 'active'], description: '本条发现的来源：被动或主动' },
      tool: { type: 'string', description: '数据源或工具名，例如 crt.sh / nmap / nuclei / curl' },
      discovered_at: { type: 'string', description: '【可选】这条资产的发现时间（ISO，如 2026-09-17T09:30:00Z）。不填则按"第一次入库的时刻"自动记录；数据源给出历史首次出现时间时传进来更准。**重复采集不会覆盖它**。' },
      first_seen: { type: 'string', description: '【可选】数据源/工具报告的首次出现时间（与发现时间分开记）' },
      names: {
        type: 'array',
        description: '该资产关联的域名/证书名',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            kind: { type: 'string', description: 'domain | hostname | cert_cn，默认 domain' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
          },
        },
      },
      ports: {
        type: 'array',
        description: '开放端口及其服务/指纹',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            port: { type: 'number', required: true },
            proto: { type: 'string', description: 'tcp（默认）| udp' },
            service: { type: 'string', description: '服务名，例如 http / mysql' },
            product: { type: 'string', description: '产品名，例如 nginx' },
            version: { type: 'string', description: '版本，例如 1.24.0' },
            banner: { type: 'string', description: '原始 banner 片段' },
            url: { type: 'string', description: 'Web 服务可直接访问的完整 URL，例如 https://oa.example.com:8443/portal' },
            title: { type: 'string', description: 'Web 页面标题（HTTP 探测获取），例如「致远OA 登录」' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
            tool: { type: 'string' },
            fingerprints: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  category: { type: 'string', description: 'Web服务器 | 中间件 | 框架 | CMS | 数据库 | VPN网关 …' },
                  vendor: { type: 'string' },
                  product: { type: 'string' },
                  version: { type: 'string' },
                  evidence: { type: 'string', description: '判定依据，例如响应头 / 路径 / banner' },
                  confidence: { type: 'number', description: '0–1' },
                },
              },
            },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = {
        ip: args.ip, state: args.state, primary_name: args.primary_name,
        provenance: args.provenance, tool: args.tool,
        names: args.names, ports: args.ports,
        /* 发现时间：不传则由服务端按"第一次入库的时刻"自动记录；
           数据源能给历史时间（FOFA 的 first_seen 等）就传进来，报告时间线更准 */
        discovered_at: args.discovered_at,
        first_seen: args.first_seen,
      }
      const result = store.importBundle(id, { scan: { tool: args.tool, argv: ['redteam_asset_add'] }, assets: [asset] })
      const written = store.listAssets(id, { ip: args.ip, limit: 1 }).items[0]
      return JSON.stringify({
        ok: true, engagement: id, counts: result.counts,
        asset: written ? compactAsset(written) : null,
        discovered_at: written ? written.discovered_at : null,
        hint: '本条资产的发现时间已记为 ' + (written && written.discovered_at ? written.discovered_at : '(未知)')
          + '；重复采集只刷新 last_seen，不会改动发现时间。',
      }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_batch',
    description: '批量落库，减少逐条调用：kind=assets 批量资产（最多 500，复用 asset_add 的字段与去重）；kind=assess 批量评估（最多 200）；kind=vulns 批量漏洞（最多 200，带 request/response 自动存 HTTP 证据）。超出 scope 的条目会跳过并在 rejected 里说明。',
    parameters: {
      engagement: { type: 'string' },
      kind: { type: 'string', required: true, enum: ['assets', 'assess', 'vulns'] },
      items: {
        type: 'array', required: true,
        description: 'assets: [{ip, provenance, tool, state, primary_name, names, ports, discovered_at}]；assess: [{asset_id|ip, priority, potential, reason}]；vulns: [{title, severity, asset_id, cve, target, evidence, status, gained, request, response, method}]',
        items: { type: 'object', additionalProperties: true },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const kind = String(args.kind || '')
      const items = Array.isArray(args.items) ? args.items : []
      const limit = kind === 'assets' ? 500 : 200
      if (items.length === 0 || items.length > limit) throw new Error('redteam_batch: items 数量必须在 1..' + limit)
      const rejected = []
      const results = []
      if (kind === 'assets') {
        const accepted = []
        for (const it of items) {
          const check = scopeCheck(store, id, it && it.ip)
          if (check.status === 'out') { rejected.push({ ip: it && it.ip, reason: 'out_of_scope', scope: check.scope }); continue }
          if (!it || typeof it.ip !== 'string' || it.ip.trim() === '') { rejected.push({ item: it, reason: 'ip required' }); continue }
          accepted.push(it)
        }
        const out = accepted.length > 0
          ? store.importBundle(id, { scan: { tool: 'redteam_batch', argv: ['assets'] }, assets: accepted })
          : { counts: { assets: 0 } }
        return JSON.stringify({ ok: true, engagement: id, kind, accepted: accepted.length, rejected: rejected.length, counts: out.counts, rejected }, null, 2)
      }
      if (kind === 'assess') {
        for (const it of items) {
          try { results.push(store.assessAsset(id, it || {})) }
          catch (error) { rejected.push({ item: it, reason: error && error.message ? error.message : String(error) }) }
        }
        return JSON.stringify({ ok: true, engagement: id, kind, assessed: results.length, rejected: rejected.length, results, rejected }, null, 2)
      }
      if (kind === 'vulns') {
        for (const it of items) {
          const check = scopeCheck(store, id, it && it.target)
          if (check.status === 'out') { rejected.push({ target: it && it.target, reason: 'out_of_scope', scope: check.scope }); continue }
          try {
            const v = store.addVuln(id, { ...it, engagement: undefined, agent: agentOf(args), found_by_agent: it.found_by_agent || it.agent || 'vuln-scan' })
            let httpEvidenceId = null
            const request = typeof it.request === 'string' ? it.request.trim() : ''
            if (request !== '') {
              try {
                const ev = store.addHttpEvidence(id, { vuln_id: v.id, asset_id: it.asset_id, label: it.title, method: it.method || 'GET', url: it.target, request, response: it.response, captured_by: agentOf(args) })
                httpEvidenceId = ev.id
              } catch { /* 漏洞已落库 */ }
            }
            results.push({ id: v.id, updated: v.updated === true, http_evidence_id: httpEvidenceId })
          } catch (error) { rejected.push({ item: it, reason: error && error.message ? error.message : String(error) }) }
        }
        return JSON.stringify({ ok: true, engagement: id, kind, inserted: results.length, rejected: rejected.length, results, rejected }, null, 2)
      }
      throw new Error('redteam_batch.kind 只接受 assets / assess / vulns')
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_asset_link',
    description: '在资产库中写入一条关系边（图谱与后续横向分析共用）。relation 例如 resolves / exposes / contains / trusts / shares_cert。',
    parameters: {
      engagement: { type: 'string' },
      src_kind: { type: 'string', required: true, description: 'segment | asset | domain | port …' },
      src_id: { type: 'string', required: true },
      dst_kind: { type: 'string', required: true },
      dst_id: { type: 'string', required: true },
      relation: { type: 'string', required: true },
      confidence: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.importBundle(id, {
        edges: [{
          src_kind: args.src_kind, src_id: args.src_id,
          dst_kind: args.dst_kind, dst_id: args.dst_id,
          relation: args.relation, confidence: args.confidence,
        }],
      })
      return JSON.stringify({ ok: true, edges: result.counts.edges }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_asset_query',
    description: '检索资产库。支持按 C 段、端口、服务、指纹、来源、内外网维度（scope）、易打性评估状态（assessed=yes/no）、排序（sort）、关键词（全文，覆盖 IP/域名/banner/服务/指纹）过滤；limit+offset 翻页。返回紧凑结果，含每个资产的开放端口与指纹及内外网归属。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string', description: 'C 段，例如 203.0.113.0/24' },
      port: { type: 'number', description: '开放端口' },
      service: { type: 'string', description: '服务/产品名关键词，例如 nginx' },
      fingerprint: { type: 'string', description: '指纹关键词，例如 Tomcat / Spring' },
      provenance: { type: 'string', enum: ['passive', 'active'], description: '只看被动或主动来源' },
      q: { type: 'string', description: '全文检索词（空格分隔多词为 AND）' },
      state: { type: 'string', enum: ['live', 'dead', 'unknown'] },
      scope: { type: 'string', enum: ['internal', 'external'], description: '内外网维度：internal=内网/私网地址，external=互联网可达' },
      sort: { type: 'string', enum: ['priority', 'todo', 'unassessed', 'ports', 'ip'], description: '排序：priority=易打性优先（默认），todo=待测优先，unassessed=未评估优先，ports=端口多优先，ip=按 IP' },
      assessed: { type: 'string', enum: ['yes', 'no'], description: '易打性评估过滤：yes=已评估（assessed_at 有值），no=未评估' },
      limit: { type: 'number', description: '返回条数上限，默认 50，最大 200' },
      offset: { type: 'number', description: '分页偏移，默认 0；配合 limit 翻页（评估大靶标时用）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const limit = Math.min(Number(args.limit) || 50, 200)
      const result = store.listAssets(id, {
        cidr: args.cidr, port: args.port, service: args.service,
        fingerprint: args.fingerprint, provenance: args.provenance,
        q: args.q, state: args.state, scope: args.scope, sort: args.sort, assessed: args.assessed,
        limit, offset: Math.max(Number(args.offset) || 0, 0),
      })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total, returned: result.items.length,
        items: result.items.map(compactAsset),
      }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_asset_get',
    description: '取单个资产的完整详情：全部端口与服务、指纹、采集溯源时间线、关系边。用于深入分析某个目标。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: '资产 id（来自 redteam_asset_query 结果）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = store.getAsset(id, args.id)
      if (asset === undefined) return JSON.stringify({ ok: false, error: 'asset not found' })
      return JSON.stringify({ ok: true, asset }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_asset_stats',
    description: '资产测绘概览：C 段数、资产数（存活）、开放端口、服务、指纹、被动/主动溯源条数，以及各 C 段的明细。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, stats: store.stats(id), segments: store.listSegments(id) }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_asset_graph',
    description: '导出资产图谱（C 段 → 资产 → 开放端口，含域名解析边），用于拓扑推理与横向移动路径规划。节点数超过上限时按 C 段缩小范围。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string', description: '只取某个 C 段的子图' },
      maxNodes: { type: 'number', description: '节点上限，默认 300' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 300, 1000)
      const graph = store.graph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: '图谱节点过多（' + graph.nodes.length + ' > ' + maxNodes + '），请指定 cidr 缩小范围',
          segments: store.listSegments(id).map((s) => ({ cidr: s.cidr, assets: s.assets })),
        }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, nodes: graph.nodes, edges: graph.edges }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_role_prompt',
    description: '取出某个执行角色（信息收集/资产梳理/漏洞发现/漏洞利用/内网渗透）当前生效的系统提示词。委派子智能体时，把该提示词作为角色约束放进任务描述。',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', required: true, /* 角色白名单**从 ROLE_ORDER 派生**：写死 4 个值曾漏掉 assess，
          而预设明确要求主会话用本工具取资产梳理角色的提示词 —— 结果 enum 直接拒绝，
          资产梳理子智能体永远拿不到角色约束。派生后新增角色不会再漏。 */
      enum: ROLE_ORDER },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const found = store.listPrompts(id).find((p) => p.role === args.role)
      if (found === undefined) return JSON.stringify({ ok: false, error: 'unknown role' })
      return JSON.stringify({
        ok: true, role: found.role, title: found.title,
        updated_at: found.updated_at, prompt: found.content,
      }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_roles',
    description: '列出红队角色及其职责标题（主会话 / 信息收集 / 资产梳理 / 漏洞发现 / 漏洞利用 / 内网渗透）。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return JSON.stringify({
        ok: true,
        roles: Object.entries(ROLE_TITLES).map(([role, title]) => ({ role, title })),
      }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_asset_test',
    description: '记录对某个资产的测试情况：本次做了什么测试（`test`，追加式）、还剩什么攻击面（`surface`，覆盖式）、当前测试状态、是否被 WAF 封禁。**每个资产开始测之前先调一次（status=testing），测完/放弃再调一次**——资产测绘页面据此显示「未测试 / 测试中 / 已测试 / 被封禁 / 已放弃 / 无攻击面」。排除结论、登录失败原因、重测理由都写在 `test` 里。',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number', description: '资产 id（与 ip 二选一，优先 asset_id）' },
      ip: { type: 'string', description: '资产 IP' },
      status: { type: 'string', enum: ['untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'], description: '测试状态：未测试/测试中/已测试/被封禁/已放弃/无攻击面' },
      test: { type: 'string', description: '本次做了什么测试（**追加**到测试记录，例如「nmap 全端口 + nuclei cve 模板 + 接口越权」）。排除结论、登录失败原因、重测理由都写这里。' },
      notes: { type: 'string', description: 'test 的兼容别名（老提示词里的写法），效果与 test 相同，会一并追加到测试记录。' },
      surface: { type: 'string', description: '还剩什么攻击面可测（覆盖式，例如「SMB 445 未测；Web /api 未做越权」）' },
      blocked: { type: 'boolean', description: '本次是否被 WAF/防护封禁（true 时封禁计数 +1）' },
      updated_by: { type: 'string', description: '记录角色，例如 recon / vuln-scan' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateAssetTest(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ================================================================== 漏洞检测 */

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_vuln_add',
    description: '记录一条漏洞发现（漏洞检测角色）。带 cve 时按 (asset_id, cve, target) 幂等更新。severity：critical|high|medium|low|info；status：candidate（待验证）|confirmed（已验证）|false-positive|exploited|fixed。必须附证据（请求/响应片段、复现命令、证据文件路径）。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      asset_id: { type: 'number', description: '资产 id（来自 redteam_asset_query）' },
      cve: { type: 'string', description: 'CVE / CNVD 编号（无编号可省略）' },
      title: { type: 'string', required: true, description: '漏洞标题' },
      severity: { type: 'string', required: true, enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      target: { type: 'string', description: '受影响的目标，如 https://host:443/path 或 ip:port' },
      source: { type: 'string', description: '发现方式：nuclei / sqlmap / curl / manual …' },
      confidence: { type: 'number', description: '0–1' },
      evidence: { type: 'string', description: '证据：请求/响应摘要、命令、证据文件路径' },
      found_by_agent: { type: 'string', description: '发现角色，默认 vuln-scan' },
      gained: { type: 'string', description: '【重要】通过这个漏洞拿到了什么权限/成果，写得分口径的短标签，多项用顿号或逗号分隔，例如「服务器权限、内网隧道」「后台管理员账号」「数据库权限」' },
      method: { type: 'string', description: '【可选】HTTP 方法；填 request 时用' },
      request: { type: 'string', description: '【可选，建议填】完整原始请求（Burp/Yakit 可重放）；带上会自动保存 HTTP 证据，不需要再单独调 redteam_http_evidence_add。' },
      response: { type: 'string', description: '【可选】响应全文或关键片段' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addVuln(id, { ...args, engagement: undefined, agent: agentOf(args), found_by_agent: args.found_by_agent || args.agent || 'vuln-scan' })
      let httpEvidenceId = null
      const request = typeof args.request === 'string' ? args.request.trim() : ''
      if (request !== '') {
        try {
          const evidence = store.addHttpEvidence(id, {
            vuln_id: result.id, asset_id: args.asset_id, label: args.title,
            method: args.method || 'GET', url: args.target, request,
            response: args.response, captured_by: agentOf(args),
          })
          httpEvidenceId = evidence.id
        } catch { /* 漏洞已落库；证据失败不阻断 */ }
      }
      return JSON.stringify({ ok: true, engagement: id, ...result, http_evidence_id: httpEvidenceId, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_vuln_query',
    description: '检索漏洞库：按严重级、状态、CVE、资产、C 段或关键词过滤。用于挑选待利用目标或核对误报。',
    parameters: {
      engagement: { type: 'string' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      cve: { type: 'string' },
      asset_id: { type: 'number' },
      cidr: { type: 'string' },
      q: { type: 'string', description: '标题/CVE/目标/证据关键词' },
      limit: { type: 'number', description: '默认 50，最大 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listVulns(id, { ...args, engagement: undefined, limit: Math.min(Number(args.limit) || 50, 200) })
      return JSON.stringify({ ok: true, engagement: id, total: result.total, items: result.items, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_vuln_update',
    description: '更新漏洞状态/严重级/证据（例如验证后置为 confirmed、利用成功后置为 exploited、误报置为 false-positive）。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: '漏洞 id' },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      evidence: { type: 'string' },
      confidence: { type: 'number' },
      gained: { type: 'string', description: '通过这个漏洞拿到了什么权限/成果（得分口径短标签，多项用顿号分隔）' },
      title: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateVuln(id, args.id, { status: args.status, severity: args.severity, evidence: args.evidence, confidence: args.confidence, gained: args.gained, title: args.title })
      return JSON.stringify({ ok: result.updated, engagement: id, ...result, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  /* ================================================================== 漏洞利用 / 内网渗透 */

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_credential_add',
    description: '记录一条凭据（漏洞利用/内网渗透角色）。**必须把口令/密钥明文写进 secret_value**——面板要直接显示明文供随时复用；同时用 secret_ref 指向 runs/ 下的证据文件。注意：本库只在本机，禁止把库文件或导出内容提交到任何仓库。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      host: { type: 'string', required: true, description: '所属主机（IP 或域名）' },
      username: { type: 'string' },
      secret_type: { type: 'string', description: 'password | hash | key | token | connection-string，默认 password' },
      secret_value: { type: 'string', description: '【必填】凭据明文：口令 / Hash / 私钥 / Token / 连接串' },
      secret_ref: { type: 'string', description: '证据引用路径，例如 runs/cred-vnc-10.0.0.5.txt' },
      privilege: { type: 'string', description: '该凭据的权限级别，如 admin / user / db-read' },
      asset_id: { type: 'number' },
      source: { type: 'string', description: '来源：exploit / dump / config-leak …' },
      tool: { type: 'string' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addCredential(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ── 证据截图 ──────────────────────────────────────────────────────────────
     得分成果最有说服力的材料是"当时那张图"。工具面只做三件事：登记、查看、删除；
     图片落盘在 <靶标目录>/shots，库里只存元数据（图片不进 SQLite，否则库没法拷）。
     ⚠️ kind 必须如实填：现场截的图才写 screenshot；由记录生成的证据摘录卡写 card ——
     报告与面板会按它标不同文案，把生成的卡当现场证据是这条链上最不能出的事。 */
  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_shot_add',
    description: '登记一张证据截图：把图片拷进靶标目录并关联到得分点/命中（面板展开得分点即可看图，报告里也会嵌入）。批量得分点（如终端权限）每个得分点最多展示 3 张代表图，不必逐台截图。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      path: { type: 'string', description: '图片在本机的路径（相对靶标目录或绝对路径）；与 data_base64 二选一' },
      data_base64: { type: 'string', description: '图片内容（base64，可带 data: 前缀）；截图工具没落盘时用这个' },
      label: { type: 'string', description: '图片说明，例如「域控 WEB-SHDC1 atexec 回显 nt authority\\system」' },
      kind: { type: 'string', description: 'screenshot（现场截图，默认）| card（由记录生成的证据摘录卡，报告里会标注）' },
      point_code: { type: 'string', description: '关联的得分点 code，如 terminal-access / central-system' },
      hit_id: { type: 'number', description: '关联到具体某条得分命中（score_hit id）；给了它这张图就只挂在那一条上' },
      asset_id: { type: 'number' },
      target: { type: 'string', description: '这张图对应的目标（IP / URL）' },
      note: { type: 'string', description: '补充说明：这张图证明了什么' },
      source_ref: { type: 'string', description: '原始来源：截图的落盘路径或 runs/ 下的证据文件' },
      captured_at: { type: 'string', description: '截图时间（ISO），缺省用当前时间' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addShot(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_shot_list',
    description: '列出已登记的证据截图（含所属得分点、目标、类型、落盘文件）。',
    parameters: {
      engagement: { type: 'string' },
      point_code: { type: 'string' },
      hit_id: { type: 'number' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, ...store.listShots(id, {
        point_code: args.point_code, hit_id: args.hit_id, asset_id: args.asset_id,
      }) }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_shot_delete',
    description: '删除一张证据截图（连同磁盘文件）。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'shot id（redteam_shot_list 里返回的 id）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: eng, ...store.deleteShot(eng, args.id) }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_credential_list',
    description: '列出已收集的凭据（含明文 secret_value），用于凭据复用与横向移动。',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
      username: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listCredentials(id, { host: args.host, username: args.username }) }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_access_add',
    description: '记录一次成功获得的访问会话（横向移动起点）。method 例如 vnc/rdp/ssh/web-login/db/webshell；privilege 例如 admin/user/system。账号类得分必须把返回的 id 作为 access_id 传给 redteam_score_hit。',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string', required: true },
      username: { type: 'string' },
      method: { type: 'string', required: true, description: '获得访问的方式' },
      privilege: { type: 'string' },
      asset_id: { type: 'number' },
      session_ref: { type: 'string', description: '会话/证据引用，例如 runs/session-vnc-10.0.0.5.md' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAccess(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_access_list',
    description: '列出已获得的访问会话。',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listAccess(id, { host: args.host }) }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_role_prompt_reset',
    description: '把角色系统提示词恢复为内置默认（新版模板）。老靶标想用上最新版角色提示词时用它；省略 role 则全部角色（含主会话/资产梳理）重置。',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', /* 角色白名单**从 ROLE_ORDER 派生**：写死 4 个值曾漏掉 assess，
          而预设明确要求主会话用本工具取资产梳理角色的提示词 —— 结果 enum 直接拒绝，
          资产梳理子智能体永远拿不到角色约束。派生后新增角色不会再漏。 */
      enum: ROLE_ORDER },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.resetPrompts(id, args.role)
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ---------- WebShell 与内网隧道：打的过程中随时复用，避免"打到后面忘了还有入口" ---------- */

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_sessions',
    description: '【每次决策前后都要看】一屏总览当前所有可复用入口：已上线的 WebShell、可用的内网隧道（含监听地址与可达网段）、凭据、访问会话，并给出在线/离线统计。打内网前先看这里，不要重复造轮子，也不要忘记已有的隧道。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const summary = store.sessionSummary(id)
      return JSON.stringify({
        ok: true, engagement: id, totals: summary.totals,
        webshells: summary.webshells.map((w) => ({
          id: w.id, url: w.url, type: w.shell_type, pass_key: w.pass_key, privilege: w.privilege,
          status: w.status, asset_ip: w.asset_ip, last_check: w.last_check, note: w.note,
        })),
        tunnels: summary.tunnels.map((t) => ({
          id: t.id, kind: t.kind, listen: t.listen, entry: t.entry, reach: t.reach,
          entry_kind: t.entry_kind, legit: t.legit,
          status: t.status, asset_ip: t.asset_ip, command: t.command, last_check: t.last_check, note: t.note,
        })),
        hint: '隧道 status=active 时可直接给扫描器用：-socks5 <listen> 或 --proxy socks5://<listen>；webshell status=online 时用对应客户端连接。'
          + ' 注意 legit=false（entry_kind=self-only，只在自己的 VPS/自建服务器上）**不算跨越靶标边界、不算突破**；legit=null 表示未声明 entry_kind，用 redteam_tunnel_update 补上目标侧那一端。',
      }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_webshell_add',
    description: '登记一个已上线的 WebShell。**必须上传冰蝎马（behinder）或哥斯拉马（godzilla）的加密马**——用户在控制台要用对应客户端直连，一句话马/自研马/MemShell 用户连不上，不算可交付的入口。shell_type 只能填 godzilla | behinder；确实只能用其它形式时填 other 并在 note 里写清为什么。同一 url+pass_key 重复登记会合并刷新。登记后所有角色智能体都能复用它，不要重复打点。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      url: { type: 'string', required: true, description: 'WebShell 完整 URL' },
      shell_type: { type: 'string', description: 'godzilla（哥斯拉）| behinder（冰蝎）；其它形式才用 antsword/other 并说明原因' },
      pass_key: { type: 'string', description: '连接密码 / 密钥（冰蝎马写 pass，哥斯拉写 key）' },
      privilege: { type: 'string', description: '当前权限，例如 www-data / root / iis' },
      secret_ref: { type: 'string', description: '凭据/证据引用，例如 runs/ws-10.0.0.5.txt（不要把明文口令写进库）' },
      asset_id: { type: 'number' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addWebshell(id, { ...args, engagement: undefined, status: 'online', agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_webshell_list',
    description: '列出已登记的 WebShell（含在线状态与最后检查时间）。',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'online | offline | unknown' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listWebshells(id, args) }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_webshell_update',
    description: '更新 WebShell 状态（被删/掉线/权限变化）或补充说明。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'WebShell 记录 id' },
      status: { type: 'string', description: 'online | offline | dead | unknown' },
      privilege: { type: 'string' },
      note: { type: 'string' },
      check_note: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateWebshell(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_add',
    description: '登记一条内网隧道。**打进内网必须先用技能 suo5-tunnel 通过 WebShell/HTTP 建 socks5（kind=suo5）**；没有隧道就不要手搓内网探测脚本。listen 写本机可用地址（如 127.0.0.1:1080），reach 写它能到达的网段。登记后扫描器可直接 -socks5 <listen>。\n\n**红线：自己的 VPS / 自己配置的服务器不算隧道。** 只在你自己服务器上开的 socks5、frp 服务端、代理，没有碰到目标，**不算跨越靶标边界、不算边界突破或内网突破**（这类填 entry_kind=self-only，会被标成"不算突破"）。**必须说清目标侧的那一端**：\n· target-outbound — 目标主动连出到我方（**自己服务器收目标反弹 shell**、目标上跑 frp/Stowaway 客户端）；\n· target-http — 经目标 WebShell/HTTP 通道（suo5、Neo-ReGeorg、reGeorg）；\n· target-agent — 经目标已控进程/会话转发（SSH -R 由目标发起等）。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      kind: { type: 'string', required: true, description: 'suo5（首选，走 WebShell/HTTP）| socks5 | ssh-r | frp | chisel | other' },
      listen: { type: 'string', required: true, description: '本地监听地址 host:port' },
      entry: { type: 'string', description: '入口：WebShell URL / 跳板机 / 命令' },
      reach: { type: 'string', description: '可达网段，例如 10.0.0.0/8' },
      entry_kind: { type: 'string', description: '【重要】通道的目标侧那一端是什么：target-outbound（目标反弹 shell 到我方/目标上跑 frp 客户端）| target-http（经目标 WebShell 的 suo5/Neo-ReGeorg）| target-agent（经目标已控进程转发）| self-only（只在自己 VPS/自建服务器上，**不算突破**）' },
      webshell_id: { type: 'number', description: '由哪个 WebShell 建立' },
      asset_id: { type: 'number' },
      command: { type: 'string', description: '建立命令，便于重建' },
      pid: { type: 'string' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addTunnel(id, { ...args, engagement: undefined, status: 'active', agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_list',
    description: '列出已登记的内网隧道（含状态、监听地址、可达网段、entry_kind 与 legit 判定）。**legit=false 表示只在自己 VPS/自建服务器上开的通道，不算跨越靶标边界、不算突破**；legit=null 表示未声明 entry_kind。',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'active | down | unknown' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listTunnels(id, args) }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_update',
    description: '更新隧道状态（关闭/失效/更换监听地址）或补 entry_kind 判定。用完隧道务必标为 down 并说明，避免后续误用。**老记录没声明入口归属的（legit=null，界面显示"待确认"），用 entry_kind 补上目标侧那一端**，补完才算突破凭证。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true },
      status: { type: 'string', description: 'active | down | closed | unknown' },
      listen: { type: 'string' },
      reach: { type: 'string' },
      entry: { type: 'string', description: '入口：WebShell URL / 跳板机 / 命令' },
      entry_kind: { type: 'string', description: '补声明目标侧那一端：target-outbound | target-http | target-agent | self-only（只在自己服务器上，不算突破）' },
      note: { type: 'string' },
      check_note: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateTunnel(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_session_check',
    description: '实测所有 WebShell 与隧道的连通性（由 host 侧真实发起 HTTP / TCP 连接），并把在线/离线状态回写数据库。开工前和长时间任务后各跑一次。',
    parameters: {
      engagement: { type: 'string' },
      timeoutMs: { type: 'number', description: '单次探测超时，默认 6000ms' },
      probe_targets: { type: 'array', items: { type: 'string' }, description: '【可选，强烈建议】通过每条 active 隧道的 SOCKS5 实测的内网目标（host:port），例如 ["10.0.0.5:80"]；不填只测本地 listen 端口。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = await store.probeSessions(id, { timeoutMs: args.timeoutMs })
      const online = result.webshells.filter((w) => w.status === 'online').length
      const active = result.tunnels.filter((t) => t.status === 'active').length
      const targets = Array.isArray(args.probe_targets) ? args.probe_targets.filter((x) => typeof x === 'string' && x.trim() !== '').slice(0, 20) : []
      if (targets.length > 0) {
        for (const t of result.tunnels) {
          if (t.status !== 'active' || !t.listen) continue
          t.reachable = []
          for (const target of targets) t.reachable.push(await socks5Probe(t.listen, target, args.timeoutMs))
        }
      }
      const reachable = result.tunnels.reduce((n, t) => n + ((t.reachable || []).filter((x) => x.ok).length), 0)
      const probed = result.tunnels.reduce((n, t) => n + ((t.reachable || []).length), 0)
      return JSON.stringify({
        ok: true, engagement: id, checked_at: result.checkedAt,
        summary: `WebShell 在线 ${online}/${result.webshells.length}，隧道可用 ${active}/${result.tunnels.length}`
          + (targets.length > 0 ? `，内网目标可达 ${reachable}/${probed}` : '（未做目标侧探测）'),
        webshells: result.webshells, tunnels: result.tunnels,
      }, null, 2)
    }
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_pivot_probe',
    description: '通过一个本地 SOCKS5 隧道实测多个内网目标（host:port），返回可达矩阵。用于判断“隧道进程活着”是否真的能到内网。',
    parameters: {
      engagement: { type: 'string' },
      listen: { type: 'string', required: true, description: '隧道本地 SOCKS5 监听，如 127.0.0.1:1080' },
      targets: { type: 'array', required: true, items: { type: 'string' }, description: '内网目标 host:port 列表，最多 50 个' },
      timeoutMs: { type: 'number', description: '单目标超时，默认 6000ms' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const targets = (Array.isArray(args.targets) ? args.targets : []).filter((x) => typeof x === 'string' && x.trim() !== '').slice(0, 50)
      if (targets.length === 0) throw new Error('redteam_pivot_probe.targets required')
      const probes = []
      for (const target of targets) probes.push(await socks5Probe(args.listen, target, args.timeoutMs))
      return JSON.stringify({ ok: true, engagement: id, listen: args.listen, reachable: probes.filter((x) => x.ok).length, total: probes.length, probes }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_attack_path',
    description: '导出攻击图谱：资产拓扑 + 漏洞节点 + 已控制资产（meta.owned）。用于横向移动路径规划与战果汇报。节点过多时用 cidr 缩小范围。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      maxNodes: { type: 'number', description: '默认 400' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 400, 1500)
      const graph = store.attackGraph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: '图谱节点过多（' + graph.nodes.length + ' > ' + maxNodes + '），请指定 cidr 缩小范围',
          summary: graph.summary,
        }, null, 2)
      }
      return JSON.stringify({
        ok: true, engagement: id, summary: graph.summary,
        owned: graph.nodes.filter((n) => n.meta && n.meta.owned).map((n) => n.label),
        nodes: graph.nodes, edges: graph.edges,
      }, null, 2)
    },
  })))

  /* ================================================================== 域名 / Web 资产 */

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_web_list',
    description: '列出 Web 资产（含可直接访问的 URL 与页面标题）。做 Web 渗透前先看这里，优先从接口入手。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listWeb(id, { cidr: args.cidr, limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total,
        items: result.items.map((w) => ({
          url: w.url || ('http' + (w.port === 443 || w.port === 8443 || w.port === 9443 ? 's' : '') + '://' + w.ip + (w.port === 80 || w.port === 443 ? '' : ':' + w.port)),
          title: w.title, ip: w.ip, segment: w.segment_cidr, port: w.port,
          service: [w.service, w.product, w.version].filter(Boolean).join(' '),
          provenance: w.provenance, asset_id: w.asset_id,
        })),
      }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_domain_index',
    description: '按域名维度聚合资产：每个域名关联了哪些 IP/资产。用于梳理主域名、子域与 C 段的关系。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.domainIndex(id) }, null, 2)
    },
  })))

  /* ================================================================== 得分目标 */

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_score_list',
    description: '查看得分目标面板：所有得分点（名称/分类/分值/是否已拿下/命中证据）与总分进度，并返回每条的 evidence_need（判定标准）与 evidence_proof（自证材料）。**每次规划下一步之前先看这里**，按分值高低决定先打什么。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listScorePoints(id, {})
      /* 按合并版的 8 个类别分组返回：智能体一眼看到"哪些类别还没打、每项上限用了多少" */
      const groups = (result.ruleGroups || []).map((g) => ({
        category: g.name,
        items: g.tiers.length,
        points: g.points,
        cap_sum: g.capSum,
      }))
      return JSON.stringify({
        ok: true, engagement: id, summary: result.summary,
        groups,
        items: result.items.map((p) => ({
          id: p.id, code: p.code, name: p.name, category: p.category, points: p.points,
          /* 合并版的档位说明（一条含多档时，记分要用 points 参数指定本档分值） */
          tier: p.tier, cap: p.cap, cap_used: p.cap_used, dedup_scope: p.dedup_scope,
          scope_label: p.scope_label,
          enabled: p.enabled, achieved: p.hits.length > 0, hits: p.hits.length,
          counted: p.counted, earned: p.earned,
          /* 该条因计分口径 / 已达上限而不计分的条数（把它当停止信号，别在同一条上刷） */
          capped: p.capped,
          /* 两个字段各司其职：service_summary 是"这条为什么有命中不计分"的整段说明；
             capped_reason 留给**逐条命中**的具体原因（在 hits[] 里），不要拿摘要冒充它。 */
          capped_summary: p.service_summary,
          evidence_need: p.evidence_need,
          evidence_proof: p.evidence_proof,
          evidence: p.hits.map((h) => (h.target ? h.target + '：' : '') + h.evidence).slice(0, 3),
        })),
      }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_score_hit',
    description: '记录一次得分。规则是 25 项合并版；**记分前先用 `redteam_score_list` 读实际 code、上限与口径**，不要凭记忆。\n\n'
      + '**evidence 只写结果**：目标资产 + 拿到什么（账号/权限/数据量），不要写过程；能指向漏洞就带 vuln_id。\n\n'
      + '**多档条目用 `points` 指定本档**（普通/管理员等）；**同一系统只按最高权限计一次**（G1），提权后补高档，系统会顶掉低档。\n\n'
      + '**红线**：账号类必须实际登录成功，并把 `redteam_access_add` 返回的 `access_id` 传进来——**只有未授权接口/响应数据/凭据不算账号权限**；自己注册的账号不算得分权限，用 self_created=true 只留痕。\n\n'
      + '**口径/上限**：每条自带去重口径与上限，warning 是停止信号；数据成果单独计分（G2），evidence 写实际数据量。\n\n'
      + '**边界**：boundary-* 必须传 `boundary` 对象（entry_zone/target_zone/isolation/target_asset；supply 加 scope_confirmed=true）；同区/不全拒绝。',
    parameters: {
      engagement: { type: 'string' },
      code: { type: 'string', description: '得分点 code（或 point_id / point_name 任选其一）；先用 redteam_score_list 核对实际 code' },
      point_id: { type: 'number' },
      point_name: { type: 'string' },
      points: { type: 'number', description: '【多档条目必填】本次命中按哪一档计分（如服务器主机权限：普通权限填 10、管理员填 50；域名控制：一级 50、二级 20）。不填则用该条主档默认值。' },
      target: { type: 'string', description: '目标资产：URL / ip:port / 主机名（**带上端口**，服务/系统口径按它判定）' },
      asset_id: { type: 'number', description: '目标资产在库里的 id' },
      port: { type: 'number', description: '【建议填】这条得分落在哪个端口（口径判定按「资产 + 端口」；target 里已带端口时可不填）' },
      vuln_id: { type: 'number', description: '【建议填】用哪个漏洞拿到的分（报告据此附原始请求）' },
      step_id: { type: 'number', description: '对应的攻击链步骤 id（可选）' },
      access_id: { type: 'number', description: '【账号类必填】实际登录成功后在 redteam_access_add 返回的 id；未授权接口不能代替账号登录。' },
      evidence: { type: 'string', required: true, description: '【必填】结果：拿到的东西，例如「后台管理员 tomcat/Tomcat@2024（已实测浏览器可登录）」「数据库账号 root/xxx」「导出 132 万条用户数据」。多档条目请写明档位（如"管理员权限"）。' },
      command: { type: 'string', description: '【可选，建议填】实际命令/请求原文；带上会自动生成动作记录供报告复现。' },
      result: { type: 'string', description: '【可选】实际回显/结果摘要；不填用 evidence。' },
      data_scale: { type: 'string', enum: ['large', 'knowledge-base'], description: 'G5 数据规模：large=超 1 亿条或 10TB（×2）；knowledge-base=知识库系统（×2）。不填不翻倍。' },
      ip_version: { type: 'string', enum: ['4', '6'], description: 'G6：IPv6 成果 ×3（填 "6"）。target 已是 IPv6 字面量时可省略。' },
      boundary_evidence: { type: 'string', description: '兼容字段：边界四问的文字摘要。新调用请用 boundary 对象（结构化校验）。' },
      boundary: {
        type: 'object', additionalProperties: false,
        description: '仅 boundary-* 必填；同区/不全拒绝',
        properties: {
          entry_zone: { type: 'string', required: true, description: '入口区：互联网/DMZ/办公/生产/隔离' },
          target_zone: { type: 'string', required: true, description: '落点区' },
          isolation: { type: 'string', enum: ['firewall', 'airgap', 'physical', 'multi-homed', 'supply', 'other'], required: true, description: '跨过的隔离' },
          target_asset: { type: 'string', required: true, description: '实际访问到的靶标内网资产（IP:端口 + 回显）' },
          scope_confirmed: { type: 'boolean', description: 'boundary-supply 必填 true：用户已确认授权范围' },
          note: { type: 'string' },
        },
      },
      self_created: { type: 'boolean', description: '【重要】这个账号/权限是不是**自己注册、自己创建**的？是则填 true —— 只作过程记录，不计分、不进报告。拿到别人已有的账号/权限不要填（默认 false）。' },
      note: { type: 'string' },
      recorded_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      assertBoundaryGate(args, args.code)
      const pointRows = store.listScorePoints(id).items || []
      const point = pointRows.find((p) => (args.point_id !== undefined && args.point_id !== null && Number(p.id) === Number(args.point_id))
        || (args.point_name && String(p.name) === String(args.point_name))
        || (args.code && String(p.code) === String(args.code)))
      assertAccountAccess(store, id, args, point ? point.code : args.code)
      const result = store.addScoreHit(id, { ...args, engagement: undefined })
      let stepId = null
      let stepHint = null
      const command = typeof args.command === 'string' ? args.command.trim() : ''
      if (command !== '') {
        try {
          const point = (store.listScorePoints(id).items || []).find((p) => Number(p.id) === Number(result.point_id))
          let scope
          if (args.asset_id !== undefined && args.asset_id !== null) {
            try { scope = store.getAsset(id, args.asset_id).scope } catch { /* 资产读不到就按 target 推 */ }
          }
          const stageCode = scoreStageOf({ code: point && point.code, target: args.target }, scope)
          const step = store.addChainStep(id, {
            stage: 'exploit', stage_code: stageCode,
            title: (point && point.name) || '得分动作',
            tool: command,
            result: args.result || args.evidence,
            asset_id: args.asset_id, vuln_id: args.vuln_id,
            agent: agentOf(args), recorded_by: args.recorded_by || args.agent,
          })
          stepId = step.id
          store.linkScoreHitStep(id, result.id, stepId)
        } catch (error) {
          stepHint = '得分已记录，但自动动作记录失败：' + (error && error.message ? error.message : String(error))
        }
      }
      return JSON.stringify({ ok: true, engagement: id, ...result, step_id: stepId, step_hint: stepHint || undefined }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_score_point_save',
    description: '新增或修改得分点（分值/名称/分类/说明/启用）。用户也会在界面上编辑；智能体只在必要时用（例如发现规则里还有未被记录的得分项）。带 id 为修改，不带 id 为新增。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', description: '已有得分点 id（修改时传）' },
      name: { type: 'string', required: true },
      code: { type: 'string', description: '短代码（新增时建议给，便于记录得分）' },
      category: { type: 'string', description: '分类，如 账号权限 / 服务器权限 / 数据库 / 网络突破 / 数据 / 核心业务系统' },
      points: { type: 'number', description: '分值' },
      description: { type: 'string', description: '得分条件说明' },
      enabled: { type: 'boolean' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.saveScorePoint(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_asset_assess',
    description: '给资产做「易打性评估」：预期能拿下哪些成果（账号权限/RCE/服务器权限/数据库权限/敏感数据/边界突破）、优先级多高、判断理由。信息收集收口时对每个资产调用一次，供指挥者按性价比排序。',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number' },
      ip: { type: 'string' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high 容易出成果 / medium 一般 / low 难打或价值低' },
      potential: { type: 'string', description: '预期成果，如「账号权限+RCE」「数据库权限」「大量敏感信息」' },
      reason: { type: 'string', description: '判断理由：指纹版本命中 Nday、接口未鉴权、口令弱、暴露数据库、WAF 强弱等' },
      assessed_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.assessAsset(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ================================================================== 证据 / 攻击链 / 报告 */

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_http_evidence_add',
    description: '保存一条 HTTP 证据：原始请求与响应。报告会把它渲染成可粘贴进 Burp Suite / Yakit 的原始报文，因此 request 必须是完整可重放的原始请求（含请求行、Host 等头部、必要时 body）。',
    parameters: {
      engagement: { type: 'string' },
      vuln_id: { type: 'number', description: '关联的漏洞 id（建议填）' },
      asset_id: { type: 'number' },
      label: { type: 'string', description: '这条证据的用途，例如「越权读取用户列表」' },
      method: { type: 'string', description: 'GET/POST/…' },
      url: { type: 'string' },
      status: { type: 'number', description: '响应状态码' },
      request: { type: 'string', required: true, description: '原始请求全文（Burp 可直接粘贴）' },
      response: { type: 'string', description: '响应全文或关键片段' },
      note: { type: 'string' },
      captured_by: { type: 'string', description: '采集角色' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addHttpEvidence(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_data_proof',
    description: 'P1 敏感数据的结构化证明：op=add 记录字段/条数/样本/来源（row_count>=10000 标 meets_threshold）；op=list 查询。比自由文本 evidence 更可核对，报告/复核用它。',
    parameters: {
      engagement: { type: 'string' },
      op: { type: 'string', enum: ['add', 'list'], required: true },
      target: { type: 'string', description: '数据所在目标（IP/URL/系统名）' },
      source: { type: 'string', description: 'api / db / file / backup' },
      interface: { type: 'string', description: '接口路径 / 库表 / 文件路径' },
      fields: { type: 'array', items: { type: 'string' }, description: '泄露字段，例如 姓名 / 身份证号 / 手机号' },
      row_count: { type: 'number', description: '实际条数（P1 门槛 10000）' },
      sample: { type: 'string', description: '脱敏样本（1–3 条）' },
      query: { type: 'string', description: '可复现的查询/请求' },
      evidence_ref: { type: 'string', description: '证据文件路径' },
      pii_type: { type: 'string', description: 'pii / 三要素 / 其他' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      note: { type: 'string' },
      limit: { type: 'number', description: 'op=list 返回条数，默认 100' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.op === 'list') return JSON.stringify({ ok: true, engagement: id, ...store.listDataProofs(id, args) }, null, 2)
      return JSON.stringify({ ok: true, engagement: id, proof: store.addDataProof(id, { ...args, created_by: agentOf(args) }) }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_cleanup',
    description: '清理台账：op=add 记录上传的马/临时账号/隧道/文件/计划任务；op=list 查未清理项；op=update 标记 done。交付前用它确认没有遗留入口。',
    parameters: {
      engagement: { type: 'string' },
      op: { type: 'string', enum: ['add', 'list', 'update'], required: true },
      id: { type: 'number', description: 'op=update 的台账 id' },
      kind: { type: 'string', description: 'webshell / account / tunnel / file / task / other' },
      target: { type: 'string' },
      location: { type: 'string', description: 'URL / 路径 / 主机:端口' },
      detail: { type: 'string' },
      status: { type: 'string', enum: ['open', 'done', 'kept'], description: '默认 open' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.op === 'list') return JSON.stringify({ ok: true, engagement: id, ...store.listCleanup(id, args) }, null, 2)
      if (args.op === 'update') return JSON.stringify({ ok: true, engagement: id, item: store.updateCleanup(id, args) }, null, 2)
      return JSON.stringify({ ok: true, engagement: id, item: store.addCleanup(id, { ...args, created_by: agentOf(args) }) }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_add',
    description: '保存一个**实际生效**的攻击文件（脚本/POC/EXP/字典）到目标文件夹，供复用与交付。目录结构：attack-files/<IP|URL主机|C段>/<文件名>。evidence 必填且必须写清验证效果（例如"回显 uid=0"、"未授权返回 200 并含数据"）——**没打通的、只是尝试过的脚本不要放进来**。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', required: true, description: '目标：IP、URL 或 C 段（同一 IP 的多个端口会归到该 IP 文件夹）' },
      name: { type: 'string', required: true, description: '文件名，例如 cve-2021-22893.sh / vnc_brute.py' },
      kind: { type: 'string', enum: ['poc', 'exp', 'script', 'wordlist', 'other'], description: '类型：poc 验证 / exp 利用 / script 脚本 / wordlist 字典' },
      description: { type: 'string', description: '这个文件做什么（一句话）' },
      evidence: { type: 'string', required: true, description: '有效性证据：实际打通的输出/回显/影响，或对应漏洞/证据 id' },
      content: { type: 'string', description: '文件内容（与 path 二选一）' },
      path: { type: 'string', description: '已存在的文件路径（相对靶标目录或绝对路径），会复制进目标文件夹（与 content 二选一）' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      created_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAttackFile(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_list',
    description: '列出已保存的攻击文件（按目标文件夹分组）。开始打某个目标前先看这里，避免重复造轮子。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: '只看某个目标' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.target) return JSON.stringify({ ok: true, engagement: id, items: store.listAttackFiles(id, { target: args.target }) }, null, 2)
      return JSON.stringify({ ok: true, engagement: id, folders: store.attackFileTree(id) }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_report_targets',
    description: '【已弃用，改用 redteam_score_report】按目标查看成果报告（每个 IP / URL / C 段一份）：成果漏洞（含可粘贴进 Burp/Yakit 的原始请求）、已获权限、凭据、攻击文件、攻击链。用于按目标汇报或检查某个目标还缺什么。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: '只看某个目标的报告' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.reportTargets(id, {})
      const picked = args.target ? result.targets.filter((t) => t.key === args.target || t.label === args.target) : result.targets
      return JSON.stringify({
        ok: true, engagement: id, generated_at: result.generated_at, totals: result.totals,
        targets: picked.map((t) => ({ key: t.key, label: t.label, segment: t.segment, stats: t.stats })),
      }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_attack_chain',
    description: '攻击链：按攻击面位置串起来的四个阶段 —— ① 信息收集（互联网侧）→ ② 互联网资产权限 → ③ 边界突破（搭隧道）→ ④ 内网资产权限。靶标系统不再单独计分。返回每阶段的阶段目标、**实际拿到多少分与累计分**、涉及资产、以及边界突破阶段的真实隧道。开工时看它明确"现在在第几阶段、下一步该打哪一阶段"，汇报时按阶段给结论。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const chain = store.scoreChain(id)
      return JSON.stringify({
        ok: true, engagement: id,
        totals: { points: chain.summary.points, totalPoints: chain.summary.totalPoints, hits: chain.summary.hits,
          /* 按服务封顶（同资产同端口只算一次）而没计分的条数：账号类/数据库权限 */
          serviceCappedHits: chain.summary.serviceCappedHits || 0 },
        stages: (chain.stages || []).map((st) => ({
          code: st.code, name: st.name, goal: st.goal,
          points: st.points, cumulative: st.cumulative, counted: st.counted, hits: st.hits,
          steps: st.steps, tools: st.tools,
          methods: (st.sections || []).map((x) => x.label + '：' + (x.items || []).join('、')),
          scored: st.items.map((x) => ({ point: x.point_name, points: x.points, counted: x.counted, target: x.target,
            service: x.service || null, capped: x.capped === true, capped_reason: x.capped_reason || null })),
          assets: (st.assets || []).map((a) => a.ip + (a.scope === 'internal' ? '(内网)' : '(外网)') + ' 贡献' + a.points + '分'),
          tunnels: (st.tunnels || []).map((t) => t.kind + ' ' + t.listen + ' [' + t.status + '] 可达 ' + (t.reach || '—')),
        })),
        hint: '得分阶段是自动推导的（boundary-*→边界突破，其余按资产内外网归属；靶标系统不再单独计分）；写攻击链步骤时带 stage_code（只接受 recon/internet/boundary/internal）步骤计数才会落到正确阶段，写别的值会被忽略。账号权限与数据库权限按「同资产同端口」封顶：一个服务拿到最高权限即拿满，同服务重复命中标 capped=true 且不计分。',
      }, null, 2)
    },
  })))


  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_score_report',
    description: '红队得分报告（四段式）：一、靶标单位资产证明（只列得分资产，附域名/标题/主机名/隧道/同段等归属证据与强弱）；二、得分汇总表（互联网资产权限 / 边界突破 / 内网资产权限）；三、账号密码凭据权限汇总表（同一顺序，凭据默认脱敏）；四、得分点复现（同一顺序，每条给最短报文/命令与缺口）。只收录"拿到了分"的成果，没得分的漏洞不进报告。需要交付报告时用这个，而不是 redteam_report。',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: '最多多少项，默认 500' },
      markdown: { type: 'boolean', description: 'true=返回 markdown 全文（默认 true）；false=只返回条目摘要' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const r = store.scoreReport(id, { limit: args.limit })
      if (args.markdown === false) {
        return JSON.stringify({ ok: true, engagement: id, summary: r.summary,
          items: r.items.map((x) => ({ seq: x.seq, point: x.point_name, points: x.points, counted: x.counted,
            target: x.target, gained: x.gained, requests: x.requests.length, missing_evidence: x.missing_evidence })) }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, summary: r.summary, markdown: r.markdown }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_report',
    description: '【已弃用，改用 redteam_score_report】生成成果报告（Markdown）：只收录**已验证/已利用且中危以上**的成果漏洞（每条附可粘贴进 Burp/Yakit 的原始请求）、攻击链、已获权限与凭据、修复建议。信息收集的资产清单、待验证/误报、低危与信息级水洞都不会出现在报告里。想让发现进报告：先 redteam_vuln_update 置为 confirmed（验证通过）或 exploited（利用成功），再 redteam_http_evidence_add 补原始请求。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.report(id)
      return JSON.stringify({ ok: true, engagement: id, generated_at: result.generated_at, stats: result.stats, markdown: result.markdown }, null, 2)
    },
  })))

  /* ── 知识库（POC/EXP）：全局共享，跨靶标复用 ───────────────────────────────
     为什么单列一组工具：通用 POC/EXP 是一次性投入、长期复用的资产。打 Nday/1day
     之前先查这里，能省掉整轮"去互联网找 + 手搓 + 调试"的时间；验证有效的通用
     POC/EXP 必须回填，后面的靶标和智能体直接就能用。 */

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_poc_search',
    description: '【打 Nday/1day 前的第一步】先查"现成的"两层：① **知识库**（本机沉淀的通用 POC/EXP，跨靶标共享，按"已验证 → 复用次数"排序）② **本机 nuclei 模板库**（上万条模板，CVE/组件名直接命中）。命中就取用：知识库用 redteam_poc_get 拿全文，模板直接 `nuclei -t <相对路径>`。**不要重复去互联网找或重新手搓**。两层都没有，再去互联网搜索或自己手搓，验证有效后用 redteam_poc_add 回填知识库。',
    parameters: {
      q: { type: 'string', description: '关键字：组件+版本、漏洞名、路径片段、正文里的特征串都行' },
      cve: { type: 'string', description: 'CVE / CNVD 编号，例如 CVE-2023-21839' },
      component: { type: 'string', description: '组件/产品名，例如 Weblogic、Shiro、泛微 OA、Nacos' },
      kind: { type: 'string', description: 'poc | exp | script | template | payload' },
      category: { type: 'string', description: '按**归类**筛（可多值，逗号分隔）：rce | deserialization | file-upload | sqli | unauthorized | auth-bypass | weak-password | ssrf | xxe | path-traversal | info-leak | privesc | tunnel | other' },
      engagement: { type: 'string', description: '按**来源靶标**筛（靶标 id 或名称关键词）：只看"在某个单位上验证过的"经验' },
      asset_target: { type: 'string', description: '按**发现资产**筛（IP / 域名 / URL 片段）' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web（互联网）| self（手搓）| manual（人工）| nuclei-template' },
      verified: { type: 'boolean', description: 'true 只看实测验证过的（优先用这些）' },
      templateLimit: { type: 'number', description: '本机 nuclei 模板最多返回几条，默认 20' },
      limit: { type: 'number', description: '知识库条目上限，默认 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      const q = args.q || args.cve || args.component || ''
      /* templateStats() / nucleiTemplatesDir() 都要扫模板目录：**一次调用只算一次**。
         原来这一小段里 templateStats() 被连着算了三遍（13k 模板的目录每次都要走一遍）。 */
      const tplStats = store.templateStats()
      const tpl = q
        ? store.searchTemplates(q, Math.min(Number(args.templateLimit) || 20, 100))
        : { dir: tplStats.dir || store.nucleiTemplatesDir() || null, total: tplStats.total, items: [] }
      const hit = items.length > 0 || (tpl.items || []).length > 0
      return JSON.stringify({
        ok: true,
        knowledge_base: {
          total: stats.total, verified: stats.verified, reused: stats.reused,
          /* 归类概览：让智能体知道"哪类武器已经攒了多少"，缺哪类心里有数 */
          by_category: (stats.byCategory || []).filter((c) => c.n > 0).map((c) => c.name + ' ' + c.n + '（已验证 ' + c.verified + '）'),
          by_engagement: (stats.byEngagement || []).slice(0, 10).map((e) => e.engagement + ' ' + e.n),
        },
        local_templates: { dir: tplStats.dir, total: tplStats.total, cve_templates: tplStats.cve, matched: (tpl.items || []).length },
        count: items.length,
        hint: hit
          ? '命中现成的：知识库条目用 redteam_poc_get 取全文；nuclei 模板直接用 `nuclei -t <模板相对路径>`。用完 redteam_poc_use 记一次复用。'
          : '知识库与本机模板库都没有：去互联网搜索（web_search / GitHub / ExploitDB / 厂商公告）或自己手搓，验证有效后务必 redteam_poc_add 回填知识库（带 category + engagement + asset_target + verified_note）。',
        templates: (tpl.items || []).map((t) => ({ path: t.path, name: t.name, severity: t.severity, tags: t.tags })),
        items: items.map((x) => ({
          id: x.id, code: x.code, title: x.title, kind: x.kind, category: x.category, cve: x.cve, component: x.component,
          versions: x.versions, language: x.language, source: x.source, source_url: x.source_url,
          verified: x.verified === 1, verified_note: x.verified_note, hit_count: x.hit_count,
          /* 来源溯源：哪条经验、哪个靶标、哪台资产、什么时候建的 */
          engagement: x.engagement_name || x.engagement_id || null, asset_target: x.asset_target || null,
          found_by_agent: x.found_by_agent || null, created_at: x.created_at,
          tags: x.tags, usage: x.usage, path: x.path, has_content: x.has_content === 1,
        })),
      }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_poc_get',
    description: '取一条知识库 POC/EXP 的**完整内容**（正文 + 用法 + 验证记录 + 落盘路径），可直接照用或改造成目标专用脚本。不传 id 时可用 code（redteam_poc_search 返回里的 code 字段）。',
    parameters: {
      id: { type: 'number', description: '知识库条目 id' },
      code: { type: 'string', description: '知识库条目的稳定标识（search 结果里的 code）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const row = store.getPoc(args.id !== undefined ? args.id : args.code)
      if (row === undefined) return JSON.stringify({ ok: false, error: '知识库没有这一条（先用 redteam_poc_search 检索）' }, null, 2)
      return JSON.stringify({ ok: true, ...row }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_poc_add',
    description: '把**通用可复用**的 POC/EXP 落进知识库（跨靶标共享）。从互联网拿到的、自己手搓的、或已经调通验证过的都往这里放——只收录真正有效的，并写清来源与验证证据。判断标准：**换个目标还能用**的进知识库；只对本次靶标有效的脚本走 redteam_attack_file_add（攻击文件页）。同名（同一 code）会合并刷新，可用于更新版本。\n\n**回填三件套（缺了面板里就没有归类、追溯不到来源）**：① `category` 归类；② `engagement` + `asset_target` —— 这条知识是在哪个靶标、哪台资产上发现并验证的；③ `verified` + `verified_note` 验证证据。',
    parameters: {
      title: { type: 'string', required: true, description: '标题：组件 + 漏洞名/编号，例如「Weblogic T3 反序列化 CVE-2023-21839」' },
      kind: { type: 'string', description: 'poc（验证）| exp（利用）| script | template | payload' },
      category: { type: 'string', description: '【归类，建议必填】rce 远程命令执行 | deserialization 反序列化 | file-upload 文件上传 getshell | sqli SQL 注入 | unauthorized 未授权访问 | auth-bypass 认证绕过/越权 | weak-password 弱口令 | ssrf | xxe | path-traversal 目录穿越/任意文件读 | info-leak 信息泄露 | privesc 提权/横向 | tunnel 隧道/代理 | other 其它' },
      cve: { type: 'string', description: 'CVE / CNVD 编号' },
      component: { type: 'string', description: '组件/产品名（便于按组件检索）' },
      versions: { type: 'string', description: '影响版本范围' },
      severity: { type: 'string', description: 'critical | high | medium | low' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web（互联网扒的）| self（自己手搓）| manual（人工）| nuclei-template' },
      source_url: { type: 'string', description: '来源链接（互联网来源必填，便于复核）' },
      description: { type: 'string', description: '这个 POC 干什么、原理要点、前提条件' },
      usage: { type: 'string', description: '用法：完整命令行示例 + 需要替换的参数' },
      content: { type: 'string', description: '正文：脚本/POC 源码、原始请求包、nuclei 模板、调用步骤' },
      path: { type: 'string', description: '也可以给本机已有文件路径（相对 pocs/ 或绝对路径），由知识库读取正文' },
      filename: { type: 'string', description: '正文落盘文件名，默认按语言给（poc.py / poc.sh / poc.yaml…）' },
      verified: { type: 'boolean', description: '是否已实测验证（**只有在真实目标上验证过的才填 true**）' },
      verified_note: { type: 'string', description: '验证证据：在哪台目标、什么回显/结果、是否需要认证' },
      engagement: { type: 'string', description: '【来源靶标】这条知识是在哪个靶标上发现/验证的（填靶标 id 或单位名称）' },
      asset_target: { type: 'string', description: '【发现资产】具体是在哪台资产/哪个目标上验证成功的，例如 10.1.2.3:8080 或 http://oa.demo.com' },
      found_by_agent: { type: 'string', description: '发现它的角色 code（recon / assess / vuln-scan / exploit / internal）' },
      tags: { type: 'string', description: '逗号分隔标签，例如「java,反序列化,rce」' },
      created_by: { type: 'string', description: '哪个角色/智能体沉淀的' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      /* engagement 这个参数名在本工具里表示"来源靶标"，不是"作用在哪个靶标"，
         所以不能走 resolveEngagement；只做名称补全，把 id 与中文名都记下来便于面板归类。 */
      const payload = Object.assign({}, args)
      if (typeof args.engagement === 'string' && args.engagement.trim() !== '') {
        const wanted = args.engagement.trim()
        const hit = store.listEngagements().find((e) => e.id === wanted || String(e.name) === wanted || String(e.name).includes(wanted))
        payload.engagement_id = hit ? hit.id : wanted
        payload.engagement_name = hit ? hit.name : wanted
      }
      const r = store.savePoc(payload)
      const stats = store.pocStats()
      return JSON.stringify({
        ok: true, created: r.created, code: r.poc.code, path: r.path,
        category: r.poc.category, engagement: r.poc.engagement_name || r.poc.engagement_id || null,
        asset_target: r.poc.asset_target || null, created_at: r.poc.created_at,
        verified: r.poc.verified === 1,
        hint: '已进知识库（归类：' + (r.poc.category || 'other') + '，建立时间：' + r.poc.created_at + '），'
          + '后续任何靶标的智能体 redteam_poc_search 都能直接命中；知识库共 ' + stats.total + ' 条。',
      }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_poc_list',
    description: '列出知识库里的 POC/EXP（可按 kind/source/component/verified 过滤，不带条件就是全部）。用于盘点"我们手上已经有哪些现成武器"，避免重复搜集。',
    parameters: {
      kind: { type: 'string' }, source: { type: 'string' }, component: { type: 'string' },
      verified: { type: 'boolean' }, limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      return JSON.stringify({ ok: true, stats: { total: stats.total, verified: stats.verified, by_kind: stats.byKind, by_source: stats.bySource },
        count: items.length,
        items: items.map((x) => ({ id: x.id, code: x.code, title: x.title, kind: x.kind, cve: x.cve, component: x.component,
          language: x.language, source: x.source, verified: x.verified === 1, hit_count: x.hit_count, tags: x.tags })) }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_poc_update',
    description: '更新知识库条目：补验证结论（verified + verified_note）、修正影响版本、补用法或正文、改标签。**在真实目标上验证通过后，一定要回来把 verified 置 true 并写清证据**——后续智能体会优先用已验证的。',
    parameters: {
      id: { type: 'number', description: '知识库条目 id' },
      code: { type: 'string', description: '或用 code 指定条目' },
      patch: {
        type: 'object', additionalProperties: true,
        description: '{ verified, verified_note, versions, usage, description, content, tags, severity, component, cve, source, source_url, language }',
      },
      verified: { type: 'boolean', description: '便捷写法：直接传 verified' },
      verified_note: { type: 'string', description: '便捷写法：直接传验证证据' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const patch = Object.assign({}, args.patch || {})
      if (args.verified !== undefined) patch.verified = args.verified
      if (args.verified_note !== undefined) patch.verified_note = args.verified_note
      const row = store.updatePoc(args.id !== undefined ? args.id : args.code, patch)
      return JSON.stringify({ ok: true, id: row.id, code: row.code, verified: row.verified === 1, verified_note: row.verified_note, updated_at: row.updated_at }, null, 2)
    },
  })))

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_poc_use',
    description: '记一次知识库 POC/EXP 的复用（用在哪个靶标/目标）。复用次数高的条目会排前面，方便后来者优先选经过实战的武器。',
    parameters: {
      id: { type: 'number' },
      code: { type: 'string' },
      used_on: { type: 'string', description: '用在哪：靶标名 / 目标 IP / URL' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const r = store.markPocUsed(args.id !== undefined ? args.id : args.code, args.used_on)
      return JSON.stringify(r, null, 2)
    },
  })))

  /* ================================================================== 资产发现时间线 */

  registerTool(withStructuredErrors(defineTool({
    name: 'redteam_asset_timeline',
    description: '资产「发现时间」视图：按天聚合"哪天收了多少资产"（区分内网/外网），并列出最近发现的资产。用于回答"这个资产是什么时候发现的"、检查信息收集有没有断层，也用于本轮收集的收口核对。',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: '最近资产条数，默认 50' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const data = store.discoveryTimeline(id, { limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id,
        span: data.span,
        days: data.days,
        recent: data.recent.map((a) => ({
          id: a.id, ip: a.ip, scope: a.scope, state: a.state, name: a.primary_name,
          discovered_at: a.discovered_at, last_seen: a.last_seen, open_ports: a.open_ports, priority: a.priority,
        })),
        hint: '发现时间 = 这条资产**第一次进入本库**的时刻；重复采集只刷新 last_seen。'
          + '报告附录与资产测绘页都按它排序。',
      }, null, 2)
    },
  })))
}
