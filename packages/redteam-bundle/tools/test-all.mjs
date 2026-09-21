/**
 * 全量回归测试入口（零依赖）。
 *
 * 跑法：node packages/redteam-bundle/tools/test-all.mjs
 *
 * 为什么需要它：发布脚本原先只跑 `bundle.test.mjs`，于是
 * `rules.test.mjs` 与 `session-isolation.test.mjs` 红着也能发版
 * （那两个文件当时正好因为得分点重构而崩溃，谁都没发现）。
 * 这里把**所有**测试文件跑一遍，任何一个红就整体失败 —— 发布前必须先过这关。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')

/** 测试文件的发现顺序：store → tools → ui → bundle（后面的依赖前面的产物）。 */
const ORDER = ['redteam-store', 'redteam-tools', 'redteam-ui', 'redteam-bundle']

const files = []
for (const pkg of ORDER) {
  const dir = join(repo, 'packages', pkg, 'test')
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()) {
    files.push({ pkg, path: join(dir, name) })
  }
}

let failed = 0
const summary = []
for (const { pkg, path } of files) {
  const label = pkg.replace('redteam-', '') + '/' + path.split('/').pop()
  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    code = error.status === undefined || error.status === null ? 1 : error.status
    out = String(error.stdout || '') + String(error.stderr || '')
  }
  /* 只认最后一行"通过 N/M"，红的时候把 ✗ 行也带出来，便于直接定位 */
  const passLine = (out.match(/^通过 \d+\/\d+$/m) || ['（没有输出通过行）'])[0]
  const fails = (out.match(/^\s*✗ .*$/gm) || []).slice(0, 5)
  /* 测试文件是直接抛异常死的（没跑到打印"通过"）时，✗ 行根本不存在 ——
     上面那两种情况都拿不到线索。这里必须把 stdout+stderr 的尾部带出来，
     否则 CI 上只会看到"没有输出通过行"，无从下手（2026-09 真踩过：
     GitHub Actions 上 8 个文件红、本地全绿，日志里却一个字都没有）。 */
  let tail = []
  if (code !== 0 && fails.length === 0) {
    tail = out.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()).filter(Boolean).slice(-14)
  }
  summary.push({ label, code, passLine, fails, tail })
  if (code !== 0) failed += 1
}

const width = Math.max(...summary.map((x) => x.label.length), 10)
for (const x of summary) {
  console.log((x.code === 0 ? '  ✓ ' : '  ✗ ') + x.label.padEnd(width + 2) + x.passLine)
  for (const f of x.fails) console.log('        ' + f.trim())
  for (const line of x.tail) console.log('        | ' + line)
}
console.log('')
if (failed > 0) {
  console.error('✗ ' + failed + '/' + summary.length + ' 个测试文件未通过 —— 修完再发版（不要让红的测试进入发布流程）')
  process.exit(1)
}
console.log('✓ 全部 ' + summary.length + ' 个测试文件通过（' + files.length + ' 个文件、'
  + summary.reduce((n, x) => n + Number((x.passLine.match(/(\d+)\/(\d+)/) || [0, 0])[2] || 0), 0) + ' 条断言）')
