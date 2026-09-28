/**
 * 直连 registry 发布（等价于 `npm publish`，但不依赖 CLI 的 TTY 行为）。
 *
 * 为什么不用 CLI：npm 的 OTP 流程要 stdin/stdout 都是 TTY，非 TTY 时它把鉴权链接**打码**；
 * 而本机（QEMU VM）没有任何 WebAuthn 认证器，必须把"链接给人在别的设备上点"这一步拆出来。
 * registry 的协议本身支持：缺 OTP 时返回 401 + authUrl/doneUrl，人在浏览器验证完，
 * GET doneUrl 即可领到一次性凭据，再带着它重发同一个请求。
 *
 * 用法：
 *   node scripts/publish-direct.mjs <包目录> [--userconfig <npmrc>] [--probe-only]
 *
 * 流程：
 *   ① 读 package.json + npm pack 出 tarball → 组装 publish 用的 packument（带 _attachments）
 *   ② PUT /<name>            → 401 EOTP，拿 authUrl / doneUrl（--probe-only 到此为止）
 *   ③ 打印 authUrl，轮询 doneUrl 领凭据
 *   ④ 带 npm-otp 重发同一个 PUT → 发布完成
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const pkgDir = args[0]
if (!pkgDir) {
  console.error('用法：node scripts/publish-direct.mjs <包目录> [--userconfig <npmrc>] [--probe-only]')
  process.exit(2)
}
const userconfig = args.includes('--userconfig') ? args[args.indexOf('--userconfig') + 1] : join(homedir(), '.npmrc')
const probeOnly = args.includes('--probe-only')

const registry = 'https://registry.npmjs.org'
const { createHash } = await import('node:crypto')
const sha1 = (buf) => createHash('sha1').update(buf).digest('hex')
const sha512 = (buf) => 'sha512-' + createHash('sha512').update(buf).digest('base64')
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const token = readFileSync(userconfig, 'utf8').match(/npm_[A-Za-z0-9]+/)?.[0]
if (!token) throw new Error(`${userconfig} 里没有 token`)

const HEADERS = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  /* 这三行是"能不能拿到 web-OTP 链接"的关键：registry 只对 npm CLI 形态的请求返回 authUrl/doneUrl */
  'npm-command': 'publish',
  'npm-auth-type': 'web',
  'user-agent': 'npm/12.1.0 node/v22.23.2 linux x64 workspaces/false',
}

/** 用 npm pack 产出 tarball（与 CLI 发布完全同一份产物，prepublishOnly 也会跑）。 */
function packTarball () {
  const out = execFileSync('npm', ['pack', '--pack-destination', '/tmp', '--json'], {
    cwd: pkgDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  const info = JSON.parse(out)[0]
  const path = join('/tmp', info.filename)
  if (!existsSync(path)) throw new Error('npm pack 没有产出 ' + path)
  return { path, info }
}

/** 组装 registry 需要的 packument（含 tarball 附件）。 */
function buildBody (name, version, tarballPath) {
  const data = readFileSync(tarballPath)
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const versionManifest = {
    ...manifest,
    _id: `${name}@${version}`,
    dist: { shasum: sha1(data), integrity: sha512(data), tarball: `${registry}/${name}/-/${name}-${version}.tgz` },
  }
  return {
    _id: name,
    name,
    'dist-tags': { latest: version },
    versions: { [version]: versionManifest },
    readme: manifest.readme || '',
    _attachments: {
      [`${name}-${version}.tgz`]: {
        content_type: 'application/octet-stream',
        data: data.toString('base64'),
        length: data.length,
      },
    },
  }
}
const put = (body, otp) => fetch(`${registry}/${manifest.name}`, {
  method: 'PUT',
  headers: otp ? { ...HEADERS, 'npm-otp': otp } : HEADERS,
  body: JSON.stringify(body),
})

/* --otp 分支：直接用已领到的一次性凭据发布，不做 401/轮询那一段。
   为什么需要：鉴权会话与"领取凭据"可以分开 —— 人可能在**另一条**会话链接上完成验证
   （实测踩过：探测用的链接验证了，正式流程那条还没），凭据拿到就得立刻用掉。 */
if (args.includes('--otp')) {
  const otp = args[args.indexOf('--otp') + 1]
  const packed = packTarball()
  console.log(`[otp] 直接发布 ${packed.info.filename}（${packed.info.size} 字节）…`)
  const r = await put(buildBody(manifest.name, manifest.version, packed.path), otp)
  const tx = await r.text()
  if (r.status === 200 || r.status === 201) {
    console.log(`\u2713 发布成功：${manifest.name}@${manifest.version}`)
    process.exit(0)
  }
  console.error(`\u2717 状态 ${r.status}：${tx.slice(0, 500)}`)
  process.exit(1)
}

const { path: tarball, info } = packTarball()
console.log(`[1/4] 打包完成：${info.filename}（${info.size} 字节，${info.entryCount ?? info.files?.length ?? '?'} 个文件）`)
const body = buildBody(manifest.name, manifest.version, tarball)

console.log('[2/4] PUT（不带 OTP），预期 401 EOTP …')
let res = await put(body)
let text = await res.text()
if (res.status === 200 || res.status === 201) {
  console.log('✓ 直接发布成功（这次没要求人工验证）')
  process.exit(0)
}
let parsed = {}
try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }

if (!parsed.authUrl || !parsed.doneUrl) {
  console.error(`✗ 状态 ${res.status}，响应里没有 authUrl/doneUrl：`)
  console.error(text.slice(0, 600))
  process.exit(1)
}
console.log(`    拿到鉴权链接（也可能是内容审查拒绝，若下面验证后仍失败请看返回）`)
writeFileSync('/tmp/npm-auth-url.txt', parsed.authUrl + '\n' + parsed.doneUrl + '\n', { mode: 0o600 })
console.log(`\n[3/4] 请在**能完成验证的设备**上打开这个链接：\n\n    ${parsed.authUrl}\n`)
console.log('       （同时写入 /tmp/npm-auth-url.txt）')
if (probeOnly) { console.log('--probe-only：到此为止'); process.exit(0) }

const deadline = Date.now() + 15 * 60 * 1000
let otp
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000))
  const r = await fetch(parsed.doneUrl, { headers: { authorization: `Bearer ${token}` } })
  if (r.status === 200) {
    const c = await r.json().catch(() => ({}))
    if (!c.token) { console.error('doneUrl 没有返回 token：', JSON.stringify(c).slice(0, 200)); process.exit(1) }
    otp = c.token
    break
  }
  if (r.status !== 202) { console.error(`\n✗ 轮询 doneUrl 返回 ${r.status}`); process.exit(1) }
  process.stdout.write('.')
}
if (!otp) { console.error('\n✗ 等待验证超时'); process.exit(1) }
writeFileSync('/tmp/npm-otp.txt', otp, { mode: 0o600 })
console.log(`\n    ✓ 已领取一次性凭据（${/^\d{6}$/.test(otp) ? '6 位数字' : otp.length + ' 位'}形态）`)

console.log('[4/4] 带凭据重发同一个 PUT …')
res = await put(body, otp)
text = await res.text()
if (res.status === 200 || res.status === 201) {
  console.log(`✓ 发布成功：${manifest.name}@${manifest.version}`)
  process.exit(0)
}
console.error(`✗ 提交失败 ${res.status}：${text.slice(0, 500)}`)
process.exit(1)
