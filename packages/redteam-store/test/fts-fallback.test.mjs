/**
 * 无 FTS5 构建下的检索降级回归。
 *
 * 为什么单独一个文件：FTS5 是**编译期**选项，官方 Node 构建并不一致
 * （22.14 没有、22.23 有）。CI 的 Node 一旦换成带 FTS5 的版本，
 * 降级分支就再没有任何测试执行它了 —— 于是"降级路径烂掉"这种事
 * 要等用户在无 FTS5 的机器上踩到才会发现。
 *
 * 做法：用 `REDTEAM_NO_FTS5=1` 强制降级，在**子进程**里跑（HAS_FTS5 是模块加载时
 * 求值的常量，同进程改环境变量无效），再把结论回传。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const store = join(here, '..', 'lib', 'core.js')

let pass = 0; let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log('  ✓ ' + msg) } else { fail += 1; console.log('  ✗ ' + msg) } }

/* 子进程脚本：强制无 FTS5，建库 → 灌数据 → 检索 → 打印 JSON 结论 */
const CHILD = `
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore, HAS_FTS5 } from ${JSON.stringify(store)}

const root = mkdtempSync(join(tmpdir(), 'rt-nofts-'))
const out = { HAS_FTS5, errors: [] }
try {
  const s = new RedteamStore(root)
  const eng = s.openEngagement('无FTS检索验证', '10.20.30.0/24')
  s.importBundle(eng.id, {
    segments: [{ cidr: '10.20.30.0/24', scope: 'internal' }],
    assets: [{
      ip: '10.20.30.40', state: 'live', primary_name: 'portal.example.test',
      names: [{ name: 'vpn.example.test', kind: 'domain' }],
      ports: [{
        port: 7001, proto: 'tcp', service: 'http', product: 'Weblogic', version: '12.2.1.3',
        banner: 'Welcome to Weblogic Server', title: 'OA 办公系统',
        fingerprints: [{ category: 'middleware', vendor: 'Oracle', product: 'Weblogic', version: '12.2.1.3' }],
      }],
    }],
  })
  const hit = (q) => { try { return s.listAssets(eng.id, { q }).total } catch (e) { out.errors.push(q + ': ' + e.message); return -1 } }
  out.hits = {
    ip: hit('10.20.30.40'),
    primary: hit('portal.example.test'),
    alias: hit('vpn.example.test'),
    banner: hit('Welcome to Weblogic'),
    title: hit('OA 办公系统'),
    component: hit('Weblogic'),
    vendor: hit('Oracle'),
    none: hit('zzz-不存在-zzz'),
  }
  /* 知识库也必须能在无 FTS5 下落库与检索（走 LIKE 兜底） */
  const add = s.savePoc({
    title: 'Weblogic T3 反序列化', kind: 'exp', cve: 'CVE-2023-21839', component: 'Weblogic',
    description: 'T3 协议反序列化', content: 'import socket  # payload', verified: true,
  })
  out.pocAdded = !!(add && add.poc && add.poc.id)
  out.pocFound = s.searchPocs({ q: 'weblogic' }).length
  s.close()
} catch (e) {
  out.fatal = e.message
}
rmSync(root, { recursive: true, force: true })
console.log('__RESULT__' + JSON.stringify(out))
`

const dir = mkdtempSync(join(tmpdir(), 'rt-nofts-run-'))
const script = join(dir, 'child.mjs')
try {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(script, CHILD, 'utf8')
  const raw = execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { REDTEAM_NO_FTS5: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const line = (raw.split('\n').find((l) => l.startsWith('__RESULT__')) || '').slice('__RESULT__'.length)
  const r = JSON.parse(line || '{}')
  ok(r.fatal === undefined, '无 FTS5 下建库与整体流程不抛异常' + (r.fatal ? '（' + r.fatal + '）' : ''))
  ok(r.HAS_FTS5 === false, 'REDTEAM_NO_FTS5=1 确实把能力开关压成 false')
  const h = r.hits || {}
  const cases = [['ip', '资产 IP'], ['primary', '主域名'], ['alias', '别名域名'], ['banner', '端口 banner'],
    ['title', '页面标题'], ['component', '服务组件'], ['vendor', '指纹厂商']]
  for (const [k, label] of cases) ok(h[k] >= 1, '降级检索命中 ' + label + '（' + h[k] + ' 条）')
  ok(h.none === 0, '无关词不误命中')
  ok((r.errors || []).length === 0, '检索过程零报错' + ((r.errors || []).length ? '：' + r.errors.join('；') : ''))
  ok(r.pocAdded === true, '知识库在无 FTS5 下落库成功')
  ok(r.pocFound >= 1, '知识库在无 FTS5 下可检索（LIKE 兜底，命中 ' + r.pocFound + ' 条）')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('')
if (fail > 0) { console.error('✗ ' + fail + '/' + (pass + fail) + ' 项失败'); process.exit(1) }
console.log('通过 ' + pass + '/' + (pass + fail))
