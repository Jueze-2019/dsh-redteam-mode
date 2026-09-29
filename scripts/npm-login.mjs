/**
 * npm 网页登录（web login）：把「链接给人在能验证的设备上打开」与「本机领取 token」拆开。
 *
 * 为什么要自己实现：`npm login --auth-type=web` 会先 `opener(loginUrl)` 打开浏览器，
 * 本机（QEMU VM）没有浏览器/桌面环境，`opener` 抛 `code: 'ENYI'`，而 npm 的
 * `lib/utils/auth.js` 一旦收到 ENYI 就**直接退化到 Username/Password 交互登录** ——
 * 而 npm 的 2FA 只有 WebAuthn，没有密码这条路可走（表现：打印完 Login at 链接后
 * 又问 Username:）。协议本身支持拆分：`POST /-/v1/login`（body `{}`）返回
 * `loginUrl` / `doneUrl`，人在浏览器里完成证明，本机轮询 `doneUrl` 就能领到 token。
 *
 * 用法：
 *   node scripts/npm-login.mjs                 # 打印登录链接，轮询领取 token 并写入 ~/.npmrc
 *   node scripts/npm-login.mjs --timeout 1800  # 改轮询上限（秒，默认 1200）
 *   node scripts/npm-login.mjs --userconfig <npmrc 路径>
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const userconfig = args.includes('--userconfig') ? args[args.indexOf('--userconfig') + 1] : join(homedir(), '.npmrc')
const timeoutArg = args.includes('--timeout') ? Number(args[args.indexOf('--timeout') + 1]) : 1200
if (!Number.isFinite(timeoutArg) || timeoutArg <= 0) { console.error('--timeout 需要一个正数（秒）'); process.exit(2) }

const registry = 'https://registry.npmjs.org'
const registryHost = new URL(registry).host

/* registry 只对"看起来像 npm CLI"的请求返回网页登录链接，这四个头少一个都会被拒。 */
const HEADERS = {
  'content-type': 'application/json',
  'npm-command': 'login',
  'npm-auth-type': 'web',
  'user-agent': 'npm/12.1.0 node/v22.23.2 linux x64 workspaces/false',
}

console.log('[1/3] 向 registry 申请网页登录会话 …')
const res = await fetch(`${registry}/-/v1/login`, { method: 'POST', headers: HEADERS, body: '{}' })
const text = await res.text()
let content = {}
try { content = JSON.parse(text) } catch { /* 非 JSON */ }
if (!res.ok || !content.loginUrl || !content.doneUrl) {
  console.error(`✗ 申请失败 ${res.status}：${text.slice(0, 300)}`)
  process.exit(1)
}

/* 链接写文件：后台跑时 stdout 会被缓冲，写文件才能立刻读到 */
writeFileSync('/tmp/npm-login-url.txt', content.loginUrl + '\n' + content.doneUrl + '\n', { mode: 0o600 })
console.log(`\n>>> 请在**能完成验证的设备**（手机 / 带指纹或安全密钥的电脑）上打开：\n\n    ${content.loginUrl}\n`)
console.log(`>>> 链接与 doneUrl 也写入了 /tmp/npm-login-url.txt`)
console.log(`[2/3] 等待验证完成（最多 ${Math.round(timeoutArg / 60)} 分钟，期间可以离开）…`)

/* 轮询 doneUrl：202 = 还没完成（按 retry-after 的秒数再试），200 = 拿到 token。 */
const deadline = Date.now() + timeoutArg * 1000
let token = null
let lastStatus = 0
while (Date.now() < deadline) {
  const r = await fetch(content.doneUrl, { headers: HEADERS })
  lastStatus = r.status
  if (r.status === 200) {
    const body = await r.json().catch(() => ({}))
    if (!body.token) { console.error(`\n✗ doneUrl 返回里没有 token：${JSON.stringify(body).slice(0, 200)}`); process.exit(1) }
    token = body.token
    break
  }
  if (r.status !== 202) {
    console.error(`\n✗ 轮询返回 ${r.status}（登录会话可能已过期，重跑本脚本即可）`)
    process.exit(1)
  }
  const retry = Number(r.headers.get('retry-after'))
  await new Promise((resolve) => setTimeout(resolve, (Number.isFinite(retry) && retry > 0 ? retry : 5) * 1000))
  process.stdout.write('.')
}
if (token === null) { console.error(`\n✗ 等待超时（最后一次状态 ${lastStatus}）—— 重跑本脚本会拿到新链接`); process.exit(1) }
console.log('\n    ✓ 已领到 token')

/* 写入 ~/.npmrc：替换 registry.npmjs.org 的 _authToken 那一行，其它行原样保留。 */
const line = `//${registryHost}/:_authToken=${token}`
let rc = existsSync(userconfig) ? readFileSync(userconfig, 'utf8') : ''
const hadToken = new RegExp(`^//${registryHost.replace(/\./g, '\\.')}/:_authToken=.*$`, 'm').test(rc)
if (existsSync(userconfig)) {
  const backup = `${userconfig}.bak-${Date.now()}`
  copyFileSync(userconfig, backup)
  console.log(`    旧 npmrc 已备份：${backup}${hadToken ? '' : '（里面原本没有本 registry 的 token）'}`)
}
rc = hadToken
  ? rc.replace(new RegExp(`^//${registryHost.replace(/\./g, '\\.')}/:_authToken=.*$`, 'm'), line)
  : rc.replace(/\s*$/, '\n') + line + '\n'
writeFileSync(userconfig, rc, { mode: 0o600 })

console.log('[3/3] 验证新 token …')
const who = await fetch(`${registry}/-/whoami`, { headers: { authorization: `Bearer ${token}` } })
const whoText = await who.text()
if (!who.ok) {
  console.error(`✗ token 写入 ${userconfig} 了，但 whoami 返回 ${who.status}：${whoText.slice(0, 200)}`)
  process.exit(1)
}
console.log(`\n✓✓ 登录成功：${whoText.trim()}（token 已写入 ${userconfig}，只显示前 9 位 ${token.slice(0, 9)}…）`)
