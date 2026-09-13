/**
 * 工具 schema 结构自检（零依赖）
 *
 * 跑法：node packages/redteam-tools/test/tool-schema.test.mjs
 *
 * 为什么要有这个测试：DSH 在**挂载预设**时校验每个工具的参数 schema，
 * 一旦有不合法的地方（例如 object 没有显式 additionalProperties），
 * 整个预设 mount 失败 → 该会话任何 resume 都失败 → 客户端命令菜单不停重试
 * → 每次重试都要整份解码会话日志，把 dsh 进程 CPU 打满、界面卡死（v0.6.1 真实事故）。
 *
 * 所以这里把"schema 合法性"做成回归测试：新增工具时只要犯同类错误，测试立刻红。
 */
import { register } from 'node:module'

register(new URL(
  'data:text/javascript,export function resolve(s,c,n){if(s==="@deepseek-ai/dsh-tools")return{shortCircuit:true,url:"data:text/javascript,export const defineTool=(t)=>t"};return n(s,c)}',
), import.meta.url)

const { apply } = await import('../lib/index.js')
const { existsSync, readdirSync } = await import('node:fs')
const { join } = await import('node:path')
const { pathToFileURL } = await import('node:url')

/**
 * 找 DSH 自己的 schema 校验器（有就用它做权威校验，没有就只跑上面的结构自检）。
 * 为什么值得：挂载预设时用的就是它，能 100% 复现"预设 mount 失败"的条件。
 */
async function loadOfficialValidator() {
  const candidates = []
  if (process.env.DSH_TOOLS_PATH) candidates.push(process.env.DSH_TOOLS_PATH)
  const npxRoot = join(process.env.HOME || '', '.npm', '_npx')
  if (existsSync(npxRoot)) {
    for (const dir of readdirSync(npxRoot)) {
      candidates.push(join(npxRoot, dir, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js'))
    }
  }
  candidates.push(join(process.cwd(), 'node_modules/@deepseek-ai/dsh-tools/lib/index.js'))
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        const mod = await import(pathToFileURL(c).href)
        if (typeof mod.assertSupportedJsonSchema === 'function') return mod
      } catch { /* 换下一个候选 */ }
    }
  }
  return undefined
}

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }

const tools = new Map()
apply({ redteam: {}, tools: { register: (t) => tools.set(t.name, t) } })

const problems = []
const seenObjects = { count: 0 }

/** 递归检查一个 schema 节点。path 用于报错定位。 */
function checkSchema(node, path) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((x, i) => checkSchema(x, `${path}[${i}]`)); return }

  if (node.type === 'object') {
    seenObjects.count += 1
    if (node.additionalProperties !== true && node.additionalProperties !== false) {
      problems.push(`${path}: type=object 必须显式 additionalProperties: true|false（缺失会导致预设挂载失败）`)
    }
    if (node.properties !== undefined) {
      if (typeof node.properties !== 'object' || Array.isArray(node.properties)) problems.push(`${path}.properties 必须是对象`)
      else for (const [k, v] of Object.entries(node.properties)) checkSchema(v, `${path}.properties.${k}`)
    }
  }
  if (node.type === 'array') {
    if (node.items === undefined) problems.push(`${path}: type=array 必须给 items`)
    else checkSchema(node.items, `${path}.items`)
  }
  if (node.type !== undefined && !['object', 'array', 'string', 'number', 'boolean', 'integer', 'null'].includes(node.type)) {
    problems.push(`${path}: 不支持的 type=${JSON.stringify(node.type)}`)
  }
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) problems.push(`${path}.enum 必须是非空数组`)
    else if (node.enum.some((v) => typeof v !== 'string')) problems.push(`${path}.enum 只允许字符串枚举`)
  }
  /* 递归 items/properties 之外的常见包裹 */
  for (const key of ['items', 'additionalProperties']) {
    if (key === 'items' && node.type === 'array') continue
    if (node[key] !== undefined && typeof node[key] === 'object') checkSchema(node[key], `${path}.${key}`)
  }
}

for (const [name, tool] of tools) {
  if (!tool.name || !tool.description || typeof tool.execute !== 'function') {
    problems.push(`${name}: 缺少 name/description/execute`)
    continue
  }
  if (tool.parameters === undefined) continue
  for (const [pname, schema] of Object.entries(tool.parameters)) {
    checkSchema(schema, `${name}.parameters.${pname}`)
  }
}

ok(tools.size > 0, `工具集可加载（${tools.size} 个）`)
ok(seenObjects.count > 0, `检查到 ${seenObjects.count} 个 object 类型 schema 节点`)
ok(problems.length === 0, problems.length === 0 ? '所有工具 schema 合法（object 均显式声明 additionalProperties、array 均有 items）' : `发现 ${problems.length} 处 schema 问题`)
for (const p of problems.slice(0, 20)) console.log('      · ' + p)

/* 权威校验：用 DSH 挂载预设时用的同一套校验器跑一遍（找得到才跑） */
const official = await loadOfficialValidator()
if (official === undefined) {
  console.log('  · 未找到 DSH 的 schema 校验器（跳过权威校验，只跑了结构自检）')
} else {
  const bad = []
  for (const [name, tool] of tools) {
    const spec = Object.assign({}, tool.parameters || {})
    try {
      const js = typeof official.parameterSchemaSpecToJsonSchema === 'function'
        ? official.parameterSchemaSpecToJsonSchema(spec)
        : spec
      official.assertSupportedJsonSchema(js)
    } catch (error) {
      bad.push(`${name}: ${error && error.message ? error.message : String(error)}`)
    }
  }
  ok(bad.length === 0, bad.length === 0
    ? `全部 ${tools.size} 个工具通过 DSH 官方 schema 校验器（预设挂载不会再失败）`
    : `${bad.length} 个工具未通过官方校验`)
  for (const b of bad.slice(0, 10)) console.log('      · ' + b)
}

/* 关键工具的 schema 必须真的带上规则说明（避免以后被静默改掉） */
const byName = tools
ok(!/patch: \{ type: 'object' \}/.test(String(byName.get('redteam_poc_update'))), 'redteam_poc_update.patch 不再缺少 additionalProperties')
const scoreHit = byName.get('redteam_score_hit')
ok(String(scoreHit.description).includes('自己注册的账号不算得分权限'), 'redteam_score_hit 仍带"自建账号不计分"红线')
ok(scoreHit.parameters.self_created !== undefined, 'redteam_score_hit 提供 self_created 参数')
const tunnelAdd = byName.get('redteam_tunnel_add')
ok(tunnelAdd.parameters.entry_kind !== undefined, 'redteam_tunnel_add 提供 entry_kind 参数')
ok(String(tunnelAdd.description).includes('不算隧道'), 'redteam_tunnel_add 仍带"自己的服务器不算隧道"红线')

console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
