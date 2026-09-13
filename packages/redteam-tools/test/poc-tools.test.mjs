/**
 * 知识库工具回归测试（零依赖）
 *
 * 跑法：node packages/redteam-tools/test/poc-tools.test.mjs
 *
 * 用桩替身替换 `@deepseek-ai/dsh-tools`（只保留 defineTool 恒等函数），
 * 于是可以在普通 Node 里把工具集注册一遍、真正跑 execute，验证：
 *   · 六个知识库工具都注册上了、能跑通；
 *   · "先查知识库 → 没有再去互联网/手搓 → 验证有效回填"这条链路的工具行为正确；
 *   · 知识库跨靶标共享（换一个靶标仍然能检索到）。
 */
import { register } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

register(new URL(
  'data:text/javascript,export function resolve(s,c,n){if(s==="@deepseek-ai/dsh-tools")return{shortCircuit:true,url:"data:text/javascript,export const defineTool=(t)=>t"};return n(s,c)}',
), import.meta.url)

const { apply } = await import('../lib/index.js')
const { RedteamStore } = await import('../../redteam-store/lib/core.js')

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }

const root = mkdtempSync(join(tmpdir(), 'rt-poctools-'))
try {
  const store = new RedteamStore(root)
  store.openEngagement('工具测试靶标')
  const tools = new Map()
  apply({ redteam: store, tools: { register: (t) => tools.set(t.name, t) } })
  const exec = (name, args) => tools.get(name).execute(args, { agent: { session: { id: 's1' } } })
  const call = async (name, args) => JSON.parse(await exec(name, args || {}))

  /* 1) 工具齐全 */
  const names = ['redteam_poc_search', 'redteam_poc_get', 'redteam_poc_add', 'redteam_poc_list', 'redteam_poc_update', 'redteam_poc_use']
  ok(names.every((n) => tools.has(n)), '六个知识库工具都注册了：' + names.length + ' 个')
  ok(tools.size >= 48, `工具总数 ${tools.size}（含原有工具）`)

  /* 2) 两层都没有 → 要给出"去互联网/手搓，然后回填"的指引（用一个谁都匹配不到的词） */
  const empty = await call('redteam_poc_search', { q: 'zzz-这个组件不存在-zzz' })
  ok(empty.count === 0 && (empty.templates || []).length === 0 && /互联网|手搓/.test(empty.hint),
    '两层都没命中时，给出「去互联网搜索或手搓，然后回填」的指引')

  /* 2b) 本机 nuclei 模板库也算"现成的"：CVE 一搜即中 */
  const tpl = await call('redteam_poc_search', { q: 'CVE-2023-21839' })
  if (tpl.local_templates && tpl.local_templates.total > 0) {
    ok(tpl.local_templates.dir && (tpl.templates || []).length > 0, '本机 nuclei 模板库被纳入检索（' + tpl.local_templates.total + ' 条模板 / ' + tpl.local_templates.cve_templates + ' 条 CVE）')
    ok((tpl.templates || []).some((t) => /CVE-2023-21839/i.test(t.path)), '按 CVE 能命中模板文件路径')
    ok(/命中现成的/.test(tpl.hint), '模板命中时提示直接用 nuclei -t，不要重复搜集')
  } else {
    console.log('  · 本机没有 nuclei 模板目录，跳过模板库断言')
  }

  /* 3) 落库：互联网来源 + 已验证 */
  const added = await call('redteam_poc_add', {
    title: 'Weblogic T3 反序列化 CVE-2023-21839', kind: 'exp', cve: 'CVE-2023-21839', component: 'Weblogic',
    versions: '12.2.1.3 / 12.2.1.4 / 14.1.1', language: 'python', source: 'web',
    source_url: 'https://example.com/cve-2023-21839', description: 'T3 协议反序列化',
    usage: 'python3 poc.py -t https://TARGET:7001', content: 'import socket\n# payload', verified: true,
    verified_note: '10.1.2.3:7001 返回命令回显', tags: 'java,反序列化,rce', created_by: 'vuln-scan',
  })
  ok(added.ok === true && added.created === true, '新增 POC 成功（' + added.code + '）')
  ok(added.verified === true, '验证状态被记录')
  ok(/\.py$/.test(added.path || ''), '正文按语言落盘为 .py 文件')

  /* 4) 检索：关键字 / CVE / 正文 / 只查已验证 */
  const byKeyword = await call('redteam_poc_search', { q: 'weblogic' })
  ok(byKeyword.count === 1 && byKeyword.items[0].code === added.code, '按组件关键字能检索到')
  ok(byKeyword.hint.startsWith('命中现成的'), '知识库命中时提示直接取用，不要再重复搜集')
  const byCve = await call('redteam_poc_search', { cve: '2023-21839' })
  ok(byCve.count === 1, '按 CVE 编号能检索到')
  const byBody = await call('redteam_poc_search', { q: 'socket' })
  ok(byBody.count === 1, '正文关键词也能检索到（FTS 覆盖 content）')
  const onlyVerified = await call('redteam_poc_search', { verified: true })
  ok(onlyVerified.count === 1, '可按"已验证"过滤')

  /* 5) 取全文 + 复用计数 + 补验证结论 */
  const got = await call('redteam_poc_get', { code: added.code })
  ok(got.content.includes('import socket'), 'redteam_poc_get 能取到完整正文')
  const used = await call('redteam_poc_use', { code: added.code, used_on: '工具测试靶标' })
  ok(used.hit_count === 1, '复用计数 +1')
  const updated = await call('redteam_poc_update', { code: added.code, verified_note: '复核通过' })
  ok(updated.verified === true && updated.verified_note === '复核通过', '可补验证结论')

  /* 6) 只有"通用可复用"的才进知识库：手搓未验证的也允许，但 verified 必须是 false */
  const selfMade = await call('redteam_poc_add', { title: '泛微 OA 前台 SQL 注入', kind: 'poc', component: '泛微 OA', source: 'self', content: 'sqlmap -u ...' })
  const selfRow = await call('redteam_poc_get', { code: selfMade.code })
  ok(selfRow.verified === 0, '手搓未验证的条目 verified=0（不会被误当可直接用）')

  /* 7) 跨靶标共享：换一个靶标（另一个会话）仍能检索到 */
  const other = new RedteamStore(root)
  other.openEngagement('另一个靶标')
  const tools2 = new Map()
  apply({ redteam: other, tools: { register: (t) => tools2.set(t.name, t) } })
  const shared = JSON.parse(await tools2.get('redteam_poc_search').execute({ q: 'weblogic' }, { agent: { session: { id: 's2' } } }))
  ok(shared.count === 1, '知识库跨靶标共享（新靶标/新会话也能命中）')

  /* 8) 同名合并刷新（同一漏洞的新版本 POC 覆盖旧版，不产生重复条目） */
  const again = await call('redteam_poc_add', { title: 'Weblogic T3 反序列化 CVE-2023-21839', code: added.code, content: '# v2', kind: 'exp' })
  const all = await call('redteam_poc_list', {})
  ok(again.created === false && all.count === 2, '同 code 再存是合并刷新，不产生重复条目')
  ok((await call('redteam_poc_get', { code: added.code })).content === '# v2', '合并时正文被更新')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
