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
import { resolve, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dispatch, dispatchAsync } from '../../redteam-store/lib/core.js'
/* 技能可用性判定与 redteam_preflight 共用同一份实现（环境变量 / 本机路径 / 占位符） */
import { checkSkill, summarizeSkills } from '../../redteam-store/lib/skill-availability.js'

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

/* ------------------------------------------------------------------ 版本与更新 */

/** 运行 shell 命令，带超时；返回 `{ code, stdout, stderr, timedOut }`。 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    let child
    try {
      /* ⚠️ 两个都踩过：
         · env 必须显式传 process.env —— spawn 默认给的是空环境，空 PATH 下
           npm/pnpm 会直接 `spawn npm ENOENT`（版本检查永远失败）；
         · cwd 必须是**真实存在**的目录 —— 传一个不存在的路径同样是 ENOENT
           （报错长得像"命令找不到"，很容易误判）。 */
      const cwd = typeof options.cwd === 'string' && options.cwd !== '' && existsSync(options.cwd) ? options.cwd : undefined
      child = spawn(command, args, {
        cwd,
        env: options.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: error && error.message ? error.message : String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolvePromise(value) } }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 忽略 */ }
      done({ code: -1, stdout: stdout, stderr: stderr, timedOut: true })
    }, Math.max(Number(options.timeoutMs) || 30000, 1000))
    child.stdout.on('data', (c) => { stdout += c.toString('utf8') })
    child.stderr.on('data', (c) => { stderr += c.toString('utf8') })
    child.on('error', (error) => { clearTimeout(timer); done({ code: -1, stdout: stdout, stderr: String((error && error.message) || error) }) })
    child.on('close', (code) => { clearTimeout(timer); done({ code: code === null ? -1 : code, stdout: stdout, stderr: stderr }) })
  })
}

/** 本插件包身份（由 store 壳读取 package.json 后挂上；读不到则报"未知版本"）。 */
function pluginIdentity(ctx) {
  const store = ctx.redteam
  const info = store && store.plugin ? store.plugin : null
  return {
    name: (info && info.name) || 'dsh-redteam-mode',
    version: (info && info.version) || null,
    description: (info && info.description) || '',
    homepage: (info && info.homepage) || null,
  }
}

/** profile 目录：DSH 的 `ctx.baseUrl` 就是它（loader.internal.import(name, profileDir) 的 base）。 */
function profileDirOf(ctx) {
  try {
    if (typeof ctx.baseUrl === 'string' && ctx.baseUrl.length > 0) return ctx.baseUrl
  } catch { /* 忽略 */ }
  const home = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
  return join(home, 'profiles', 'web')
}

/** 读 profile 的 package.json（依赖声明 + dsh.profile.bundles）。 */
function readProfilePackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch { return null }
}

/** 包管理器：profile 里有 pnpm-lock / pnpm-workspace 就用 pnpm，否则 npm。 */
function packageManagerOf(dir) {
  if (existsSync(join(dir, 'pnpm-lock.yaml')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) return 'pnpm'
  return 'npm'
}

/**
 * 更新前置检查：装的是不是发布版（profile 里能不能解析到这个包名）、
 * 有没有智能体正在跑（更新要重启 dsh web，会把它们打断）。
 */
async function updatePreflight(ctx) {
  const dir = profileDirOf(ctx)
  const pkg = pluginIdentity(ctx)
  const profilePkg = readProfilePackage(dir)
  const deps = (profilePkg && profilePkg.dependencies) || {}
  const declared = typeof deps[pkg.name] === 'string' ? deps[pkg.name] : null
  const installedDir = join(dir, 'node_modules', pkg.name)
  const blockers = []
  const notes = []

  /* ① 开发态（源码软链）：profile 里没有这个包名 → 不能用包管理器更新 */
  const devLinked = declared === null && !existsSync(join(installedDir, 'package.json'))
  if (devLinked) {
    blockers.push('当前是**开发态安装**（profile 依赖里没有 ' + pkg.name + '，是源码软链/手动挂载的），包管理器更新不适用。')
    notes.push('开发态请用仓库流程升级：`git pull && node packages/redteam-bundle/tools/build.mjs`，再重启 dsh web。')
  }

  /* ② 有智能体在跑：重启会打断它们 */
  let running = []
  try {
    const subagents = ctx.get('subagents')
    const sessions = ctx.get('sessions')
    if (subagents !== undefined && subagents !== null && sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {
      const roots = sessions.list().filter((s) => {
        const header = s && s.header
        return header && (header.parentSession === undefined || header.parentSession === null)
      })
      for (const root of roots) {
        try {
          const kids = await subagents.listChildren(root.id)
          for (const k of Array.isArray(kids) ? kids : []) {
            if (k && k.kind === 'child' && k.activity === 'running') running.push({ session: String(root.id), label: k.label || String(k.id) })
          }
        } catch { /* 单个会话读不到不影响其它 */ }
      }
    }
  } catch { /* 注册表不可用就不挡（只是少了一层保护） */ }
  if (running.length > 0) {
    blockers.push('有 ' + running.length + ' 个智能体正在跑（' + running.map((r) => r.label).join('、') + '）：更新要重启 dsh web，会打断它们。请等它们结束。')
  }
  return { dir, declared, packageManager: packageManagerOf(dir), devLinked, running, blockers, notes }
}

/** 到 npm registry 查最新版本（走包管理器，避免自带网络栈）。 */
async function checkLatest(ctx, dir, name) {
  const pm = packageManagerOf(dir)
  const args = pm === 'pnpm' ? ['view', name, 'version', '--json'] : ['view', name, 'version', '--json']
  const r = await run(pm, args, { cwd: dir, timeoutMs: 60000 })
  if (r.code !== 0) {
    return { ok: false, error: '查询最新版本失败（' + pm + ' view）：' + String(r.stderr || r.stdout || '').trim().slice(0, 400) }
  }
  const raw = String(r.stdout || '').trim().replace(/^"|"$/g, '')
  const latest = raw.split('\n').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean).pop() || null
  return { ok: latest !== null, latest, registry: pm }
}

/** `a < b`（只比较数字段，够用；预发布后缀按"更旧"处理）。 */
function versionLess(a, b) {
  const parse = (v) => String(v || '').split('-')[0].split('.').map((x) => Number(x) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] || 0) < (y[i] || 0)) return true
    if ((x[i] || 0) > (y[i] || 0)) return false
  }
  return false
}

/**
 * 重启脚本：等旧进程退出 + 端口释放，再按同样的参数把 dsh web 拉起来。
 * 写成独立 shell 脚本（不依赖 node 在 PATH 里），日志追加到 $DSH_HOME/redteam/update.log。
 */
function restartScript(pid, port, command, args, logPath) {
  const quoted = args.map((a) => "'" + String(a).replace(/'/g, "'\\''") + "'").join(' ')
  return [
    '#!/bin/bash',
    '# 由 RedTeam 控制台的「自动更新」生成：等旧 dsh web 退出后原样重启它。',
    'set -u',
    'OLD_PID=' + pid,
    'PORT=' + port,
    'LOG=' + JSON.stringify(logPath),
    'echo "[$(date \'+%F %T\')] 等待旧进程 $OLD_PID 退出…" >> "$LOG"',
    'for i in $(seq 1 60); do',
    '  kill -0 "$OLD_PID" 2>/dev/null || break',
    '  sleep 1',
    'done',
    'for i in $(seq 1 30); do',
    '  ss -ltn 2>/dev/null | grep -q ":$PORT " || break',
    '  sleep 1',
    'done',
    'echo "[$(date \'+%F %T\')] 启动：' + command + ' ' + quoted.replace(/"/g, '\\"') + '" >> "$LOG"',
    'cd ' + JSON.stringify(process.cwd()) + ' >> "$LOG" 2>&1',
    'nohup ' + command + ' ' + quoted + ' >> "$LOG" 2>&1 &',
    'echo "[$(date \'+%F %T\')] 已拉起新进程 pid=$!" >> "$LOG"',
    '',
  ].join('\n')
}

/** 应用更新：装新版本 + 生成重启脚本 + 让当前进程退出。 */
async function applyUpdate(ctx, dir, name, targetVersion) {
  const pm = packageManagerOf(dir)
  const spec = targetVersion ? name + '@' + targetVersion : name
  const args = pm === 'pnpm' ? ['add', spec] : ['install', spec, '--save']
  const r = await run(pm, args, { cwd: dir, timeoutMs: 300000 })
  if (r.code !== 0) {
    return { ok: false, error: '安装失败（' + pm + ' ' + args.join(' ') + '）：' + String(r.stderr || r.stdout || '').trim().slice(0, 1200) }
  }
  /* 重启：拿当前进程的启动命令原样再来一遍 */
  const argv = process.argv.slice()
  const command = argv[0]
  const rest = argv.slice(1)
  const port = (() => {
    try { return String(ctx.webServer.port) } catch { return '3080' }
  })()
  const root = (() => {
    try { return ctx.redteam.root } catch { return join(process.env.DSH_HOME || '.', 'redteam') }
  })()
  mkdirSync(root, { recursive: true })
  const logPath = join(root, 'update.log')
  const scriptPath = join(root, 'restart-dsh-web.sh')
  writeFileSync(scriptPath, restartScript(process.pid, port, command, rest, logPath), { encoding: 'utf8', mode: 0o755 })
  const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' })
  child.unref()
  /* 给浏览器留出收到响应的窗口，然后退出 —— 新进程由脚本按原命令行拉起 */
  setTimeout(() => { process.exit(0) }, 1200).unref()
  return {
    ok: true, installed: spec, packageManager: pm,
    restart: { script: scriptPath, log: logPath, port, command: [command].concat(rest).join(' '), pid: process.pid },
  }
}


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

/** 技能可用性缓存：`{ at, scope, byName: Map }`；30 秒内复用。 */
let skillAvailabilityCache = null
const SKILL_AVAILABILITY_TTL_MS = 30000

/**
 * 逐个技能的可用性（读正文 → 共享判定模块）。
 * @param ctx - 插件上下文。
 * @param list - `ctx.skills.list()` 的返回（SkillSummary[]）。
 * @param scope - 当前作用域。
 * @param force - true 时跳过快取缓存。
 */
async function skillAvailabilityOf(ctx, list, scope, force) {
  const now = Date.now()
  if (!force && skillAvailabilityCache !== null
    && now - skillAvailabilityCache.at < SKILL_AVAILABILITY_TTL_MS
    && skillAvailabilityCache.size === list.length) {
    return { at: skillAvailabilityCache.at, cached: true, byName: skillAvailabilityCache.byName }
  }
  const byName = new Map()
  for (const summary of list) {
    let def
    try { def = await ctx.skills.get(summary.name, { scope }) } catch { def = undefined }
    const path = def && typeof def.path === 'string'
      ? def.path
      : (summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null)
    const verdict = checkSkill({ name: summary.name, content: def && def.content, path }, { env: process.env })
    byName.set(summary.name, verdict)
  }
  skillAvailabilityCache = { at: now, size: list.length, byName }
  return { at: now, cached: false, byName }
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
    /* 可用性检查要读每个技能的正文（可能几百个），做 30 秒缓存：
       面板反复打开、切页签都不会重复打注册表；技能是磁盘文件，半分钟粒度足够。
       `refresh: true` 跳过缓存（面板上的「重新检查可用性」按钮用）。 */
    const availability = await skillAvailabilityOf(ctx, list, scope, request.refresh === true)
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
      const avail = availability.byName.get(s.name)
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
        /* 可用性：available 能直接跑 / broken 有明确缺口 / unknown 正文读不到判不了 */
        availability: avail ? avail.status : 'unknown',
        problems: avail ? avail.problems : ['未检查'],
        needs_user: avail ? avail.needs_user : [],
      }
    })
    const availSummary = summarizeSkills(Array.from(availability.byName.values()))
    return {
      ok: true,
      total: items.length,
      fromPlugin: items.filter((x) => x.fromPlugin).length,
      availability: {
        summary: availSummary,
        checked_at: availability.at,
        cached: availability.cached,
        broken: Array.from(availability.byName.values()).filter((x) => x.status === 'broken')
          .map((x) => ({ name: x.name, problems: x.problems, needs_user: x.needs_user })),
        note: '可用性 = 技能文件存在 + 正文能加载 + 必需环境变量已设置 + 正文引用的本机路径存在 + 没有未填的基础设施占位符；'
          + '判定用的是运行 dsh 的这个进程的环境变量（不是 shell 里 export 的）。未列出的技能正文读不到，状态为未知。',
      },
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
 * 智能体并发状态（「智能体」页签用）：直接读 subagents 注册表里"真正在跑"的子会话。
 * 与工具层的 `redteam_agent_slot` 同一套口径，但这里只读不占位。
 * @param ctx - 插件上下文。
 * @param request - `{ op: 'agentsStatus' }`。
 * @returns JSON 结果，或 undefined 表示不是这个 op。
 */
async function handleAgentsOp(ctx, request) {
  if (request.op !== 'agentsStatus') return undefined
  const max = (() => {
    const raw = Number(process.env.REDTEAM_MAX_AGENTS)
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3
  })()
  const subagents = ctx.get('subagents')
  const sessions = ctx.get('sessions')
  if (subagents === undefined || subagents === null || sessions === undefined || sessions === null || typeof sessions.list !== 'function') {
    return { ok: false, error: 'subagents / sessions 注册表不可用：读不到并发占用。', max }
  }
  const children = []
  try {
    const roots = sessions.list().filter((s) => {
      const header = s && s.header
      return header && (header.parentSession === undefined || header.parentSession === null)
    })
    for (const root of roots) {
      try {
        const kids = await subagents.listChildren(root.id)
        for (const k of Array.isArray(kids) ? kids : []) {
          if (k && k.kind === 'child') children.push({ parent: String(root.id), label: k.label || String(k.id), activity: k.activity, mode: k.mode })
        }
      } catch { /* 单个会话读不到就跳过 */ }
    }
  } catch (error) {
    return { ok: false, error: '列子会话失败：' + (error && error.message ? error.message : String(error)), max }
  }
  const running = children.filter((c) => c.activity === 'running')
  return {
    ok: true, max, used: running.length, free: Math.max(max - running.length, 0),
    running: running.slice(0, 20), total_children: children.length,
    note: '同一会话（靶标）同时最多 ' + max + ' 个执行智能体；默认顺序派活。',
  }
}

/**
 * 版本与更新类 op（面板右上角的「版本 + 自动更新」用）。
 * 不碰资产库，直接操作 profile 与 npm/pnpm；全部在 host 侧执行。
 * @param ctx - 插件上下文。
 * @param request - `{ op: 'version' | 'updateCheck' | 'updateApply', target? }`。
 * @returns JSON 结果，或 undefined 表示不是更新类 op。
 */
async function handleUpdateOp(ctx, request) {
  if (!['version', 'updateCheck', 'updateApply'].includes(request.op)) return undefined
  const pkg = pluginIdentity(ctx)
  const pre = await updatePreflight(ctx)
  if (request.op === 'version') {
    const check = pre.devLinked ? null : await checkLatest(ctx, pre.dir, pkg.name)
    return {
      ok: true,
      plugin: pkg,
      install: {
        mode: pre.devLinked ? 'dev' : 'package',
        dir: pre.dir,
        declared: pre.declared,
        packageManager: pre.packageManager,
      },
      latest: check && check.ok ? check.latest : null,
      updateAvailable: check && check.ok && pkg.version ? versionLess(pkg.version, check.latest) : false,
      check_error: check && check.ok === false ? check.error : undefined,
      blockers: pre.blockers,
      notes: pre.notes,
      running_agents: pre.running,
    }
  }
  if (request.op === 'updateCheck') {
    const check = await checkLatest(ctx, pre.dir, pkg.name)
    if (check.ok !== true) return { ok: false, error: check.error, current: pkg.version, install: { mode: pre.devLinked ? 'dev' : 'package' } }
    return {
      ok: true, current: pkg.version, latest: check.latest,
      updateAvailable: pkg.version ? versionLess(pkg.version, check.latest) : true,
      install: { mode: pre.devLinked ? 'dev' : 'package', dir: pre.dir, packageManager: pre.packageManager },
      blockers: pre.blockers, notes: pre.notes, running_agents: pre.running,
    }
  }
  /* updateApply */
  if (pre.blockers.length > 0) {
    return { ok: false, error: '现在不能更新：' + pre.blockers.join(' '), blockers: pre.blockers, notes: pre.notes }
  }
  const result = await applyUpdate(ctx, pre.dir, pkg.name, typeof request.target === 'string' && request.target ? request.target : null)
  if (result.ok !== true) return Object.assign({ current: pkg.version }, result)
  return Object.assign({ current: pkg.version, latest: request.target || null }, result, {
    note: '已安装，正在重启 dsh web（页面会在几秒内断开，重启完成后刷新即可看到新版本）。重启日志：' + result.restart.log,
  })
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
        const agentsResult = await handleAgentsOp(ctx, request)
        if (agentsResult !== undefined) {
          sendJson(res, 200, agentsResult)
          return
        }
        const updateResult = await handleUpdateOp(ctx, request)
        if (updateResult !== undefined) {
          sendJson(res, 200, updateResult)
          return
        }
        const skillResult = await handleSkillOp(ctx, request)
        /* dispatchAsync 只多处理 probeSessions（连通性探测需要真实发起连接） */
        sendJson(res, 200, skillResult === undefined ? await dispatchAsync(store, request) : skillResult)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error && error.message ? error.message : String(error) })
      }
    },
  }))
}
