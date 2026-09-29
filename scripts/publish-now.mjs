/**
 * 一条命令跑完：拿鉴权链接 → 人验证 → 领凭据 → 立刻发布（不留人手空档）。
 *
 * 为什么要"自动收尾"：registry 的一次性凭据（web-OTP 返回 16 位 token）与鉴权会话都只有
 * 几分钟有效期 —— 实测两分钟内没用掉就变成 404。人手在中间敲命令的延迟足以让它失效。
 * 所以这里把「轮询到凭据」与「带凭据重发 PUT」串在同一个进程里，领到即发。
 *
 * 用法：
 *   node scripts/publish-now.mjs <包目录> [--userconfig <npmrc>]
 *
 * 人只需要做一件事：在能验证的设备上打开打印出来的链接、按一次安全密钥。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const pkgDir = args[0]
if (!pkgDir) { console.error('用法：node scripts/publish-now.mjs <包目录> [--userconfig <npmrc>]'); process.exit(2) }
const userconfig = args.includes('--userconfig') ? args[args.indexOf('--userconfig') + 1] : join(homedir(), '.npmrc')
const registry = 'https://registry.npmjs.org'
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const token = readFileSync(userconfig, 'utf8').match(/npm_[A-Za-z0-9]+/)?.[0]
if (!token) throw new Error(`${userconfig} 里没有 token`)

const HEADERS = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'npm-command': 'publish',
  'npm-auth-type': 'web',
  'user-agent': 'npm/12.1.0 node/v22.23.2 linux x64 workspaces/false',
}

const sha1 = (b) => createHash('sha1').update(b).digest('hex')
const sha512 = (b) => 'sha512-' + createHash('sha512').update(b).digest('base64')

function packTarball () {
  const out = execFileSync('npm', ['pack', '--pack-destination', '/tmp', '--json'],
    { cwd: pkgDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const info = JSON.parse(out)[0]
  return { path: join('/tmp', info.filename), info }
}

function buildBody (tarballPath) {
  const data = readFileSync(tarballPath)
  const m = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const { name, version } = m
  const versionManifest = {
    ...m,
    _id: `${name}@${version}`,
    dist: { shasum: sha1(data), integrity: sha512(data), tarball: `${registry}/${name}/-/${name}-${version}.tgz` },
  }
  return {
    _id: name,
    name,
    'dist-tags': { latest: version },
    versions: { [version]: versionManifest },
    readme: m.readme || '',
    _attachments: {
      [`${name}-${version}.tgz`]: { content_type: 'application/octet-stream', data: data.toString('base64'), length: data.length },
    },
  }
}

const put = (body, otp) => fetch(`${registry}/${manifest.name}`, {
  method: 'PUT', headers: otp ? { ...HEADERS, 'npm-otp': otp } : HEADERS, body: JSON.stringify(body),
})

/* 先打包（prepublishOnly 会跑自检），再取鉴权链接 —— 顺序重要：链接必须最后生成，
   否则人还没验证，会话就先过期了。 */
console.log('[1/3] 打包（含 prepublishOnly 自检）…')
const packed = packTarball()
console.log(`      ${packed.info.filename}（${packed.info.size} 字节）`)
const body = buildBody(packed.path)

console.log('[2/3] 取鉴权链接 …')
let res = await put(body)
let text = await res.text()
let parsed = {}
try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }

/* 200/201 = 直接落库；**202 = 成功**，表示进入发布期审查（npm 对双用途包的正常响应，
   正文 `{"success":true}`）。把 202 当失败会让每次成功发布都白报一次错 —— 0.12.1 就踩了。 */
const PUBLISHED = new Set([200, 201, 202])
const describe = (status) => status === 202 ? '202（进入发布期审查，属正常成功）' : String(status)
if (PUBLISHED.has(res.status)) { console.log(`✓ 无需人工验证，已直接发布成功（${describe(res.status)}）`); process.exit(0) }
if (!parsed.authUrl || !parsed.doneUrl) {
  console.error(`✗ 状态 ${res.status}：${text.slice(0, 500)}`); process.exit(1)
}

writeFileSync('/tmp/npm-auth-url.txt', parsed.authUrl + '\n' + parsed.doneUrl + '\n', { mode: 0o600 })
console.log(`\n>>> 请在能验证的设备上打开（4-5 分钟内有效）：\n\n    ${parsed.authUrl}\n`)
console.log('>>> 验证完成后我会自动领凭据并立刻发布，你不需要再做别的。\n')

console.log('[3/3] 等待验证 → 领凭据 → 立即发布 …')
const deadline = Date.now() + 12 * 60 * 1000
let otp
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000))
  const r = await fetch(parsed.doneUrl, { headers: { authorization: `Bearer ${token}` } })
  if (r.status === 200) {
    const c = await r.json().catch(() => ({}))
    if (!c.token) { console.error('doneUrl 未返回 token：', JSON.stringify(c).slice(0, 200)); process.exit(1) }
    otp = c.token
    break
  }
  if (r.status !== 202) { console.error(`\n✗ 轮询返回 ${r.status}（会话可能已过期，重跑本脚本即可）`); process.exit(1) }
  process.stdout.write('.')
}
if (!otp) { console.error('\n✗ 等待超时'); process.exit(1) }
console.log(`\n    ✓ 领到凭据（${otp.length} 位），立刻发布 …`)

res = await put(body, otp)
text = await res.text()
/* 同上：202 也是成功（进入发布期审查）。版本要在 packument 上可见还需要一小会儿，
   别因为"查不到版本"就重发 —— 重发同版本会撞 409。 */
if (PUBLISHED.has(res.status)) {
  console.log(`✓✓ 发布成功：${manifest.name}@${manifest.version}（${describe(res.status)}）`)
  if (res.status === 202) {
    console.log('   版本需要过发布期审查，packument 上稍后才可见（0.12.0 实测约 1 分钟）。')
    console.log('   验证：curl -s https://registry.npmjs.org/' + manifest.name + ' | grep -o \'"latest":"[^"]*"\'')
  }
  process.exit(0)
}
console.error(`✗ 发布失败 ${res.status}：${text.slice(0, 500)}`)
process.exit(1)
