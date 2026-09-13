/**
 * RedTeam 控制台 —— Host 半侧
 *
 * 职责：为浏览器半侧提供一条 Package 私有的 HTTP 桥接 `POST /redteam/api`：
 *   · 资产库相关 op 转交 `ctx.redteam`（dsh-redteam-store 发布的进程级服务）；
 *   · 会话连通性 op（probeSessions）在 host 侧真实发起 TCP/HTTP 探测；
 *   · 技能目录 op（skillCatalog / skillRead）直接读 `ctx.skills`，按红队 preset
 *     的 standing scope 取目录——技能由 DSH 原生 skill 体系管理（$DSH_HOME/skills、
 *     项目 .dsh/skills、.agents/skills），控制台只做浏览。
 *
 * 为什么走 webServer 而不是 typert/@Remote：本包与 store 包都刻意保持零外部依赖
 * （profile 下解析不到 node_modules），具名路由是最小且稳定的接缝。
 * 跨源请求由 Origin/Host 校验挡住（同源 POST 才放行）。
 */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { dispatch, dispatchAsync } from './store-core.js'

/** 本包自带技能目录（随包分发；dev 安装的 UI 包没有 skills/，此时恒为 false）。 */
const PLUGIN_SKILLS_DIR = (() => {
  try { return resolve(fileURLToPath(new URL('../skills/', import.meta.url))) } catch { return null }
})()
/** 目录比较要规范化：注册表给的是 `/a/b/skills`，URL 拼出来可能带结尾斜杠。 */
const sameDir = (a, b) => {
  if (a === null || b === null) return false
  try { return resolve(a) === resolve(b) } catch { return false }
}

/** Cordis 插件名。 */
export const name = 'redteam-ui'

/** 硬依赖：资产库服务 + 浏览器 HTTP 载体 + 技能注册表 + preset 名册（技能目录按红队 scope 读）。 */
export const inject = ['redteam', 'webServer', 'skills', 'agentPresets']

/** 请求体上限（资产导入可能较大）。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** 读取完整请求体；超过上限即中断。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 统一的 JSON 响应。 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 技能目录：按红队 preset 的 standing scope 读取原生 skill 注册表。
 * 技能由 DSH 管理（$DSH_HOME/skills、项目 .dsh/skills、.agents/skills、内置根），
 * 控制台只列出「红队会话实际能用到的技能」。
 * @param ctx - 插件上下文。
 * @param request - `{ op: 'skillCatalog' | 'skillRead', name? }`。
 * @returns JSON 结果，或 undefined 表示不是技能类 op。
 */
async function handleSkillOp(ctx, request) {
  if (request.op !== 'skillCatalog' && request.op !== 'skillRead') return undefined
  let scope = null
  try {
    scope = await ctx.agentPresets.standingKeyFor('redteam')
  } catch (error) {
    return { ok: false, error: '无法解析红队 preset 作用域：' + (error && error.message ? error.message : String(error)) }
  }
  if (request.op === 'skillCatalog') {
    const list = await ctx.skills.list({ scope })
    /* 技能目录来自 DSH 原生注册表：自带根 + $DSH_HOME/skills + 项目根 + **每个插件注册的根**
       （本插件只是其中之一）。所以这里把"每个技能来自哪个目录/哪个来源"如实给出来，
       否则用户看到几百个技能会以为是我们塞进去的。 */
    const bySource = new Map()
    const byDir = new Map()
    const items = list.map((s) => {
      const dir = s.resourceBase && s.resourceBase.kind === 'directory' ? s.resourceBase.path : null
      const name = dir === null ? '(非文件系统来源)' : dir
      byDir.set(name, (byDir.get(name) || 0) + 1)
      bySource.set(s.source, (bySource.get(s.source) || 0) + 1)
      return {
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse || '',
        provider: s.provider,
        source: s.source,
        dir: dir,
        modelInvocable: s.invocation ? s.invocation.modelInvocable !== false : true,
        userInvocable: s.invocation ? s.invocation.userInvocable !== false : true,
        fromPlugin: sameDir(dir, PLUGIN_SKILLS_DIR),
      }
    })
    return {
      ok: true,
      total: items.length,
      fromPlugin: items.filter((x) => x.fromPlugin).length,
      bySource: Array.from(bySource, ([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n),
      byDir: Array.from(byDir, ([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n),
      note: '技能由 DSH 原生注册表管理：DSH 自带根 + $DSH_HOME/skills + 项目根 .dsh/skills、.agents/skills + 各插件注册的根。本插件只自带 ' +
        '了 ' + items.filter((x) => x.fromPlugin).length + ' 个（随包分发），其余来自其它来源。',
      items,
    }
  }
  if (typeof request.name !== 'string' || request.name.length === 0) {
    return { ok: false, error: 'name required' }
  }
  const skill = await ctx.skills.get(request.name, { scope })
  if (skill === undefined) return { ok: false, error: 'skill not found: ' + request.name }
  return {
    ok: true,
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse || '',
    provider: skill.provider,
    source: skill.source,
    path: skill.path || null,
    content: skill.content || '',
  }
}

/**
 * @param ctx - 插件上下文（已保证 redteam / webServer / skills / agentPresets 可用）。
 */
export function apply(ctx) {
  const store = ctx.redteam

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/redteam/api',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      const origin = req.headers.origin
      const host = req.headers.host
      if (typeof origin === 'string' && typeof host === 'string') {
        let originHost = null
        try { originHost = new URL(origin).host } catch { originHost = null }
        if (originHost !== host) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
          return
        }
      }
      try {
        const raw = await readBody(req)
        const request = raw.trim() ? JSON.parse(raw) : {}
        const skillResult = await handleSkillOp(ctx, request)
        /* dispatchAsync 只多处理 probeSessions（连通性探测需要真实发起连接） */
        sendJson(res, 200, skillResult === undefined ? await dispatchAsync(store, request) : skillResult)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    },
  }))
}
