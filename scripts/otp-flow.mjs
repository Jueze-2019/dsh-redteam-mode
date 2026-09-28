/**
 * 需要人工存在性证明的 npm 操作（发布 / 批准）：把 web-OTP 流程拆开，链接交给人、凭据自己领。
 *
 * 为什么要自己实现：npm CLI 的 `otplease()` 要求 stdin/stdout 都是 TTY，且人工证明要在
 * **浏览器里按安全密钥**。本机（QEMU VM）没有任何 WebAuthn 认证器（无平台认证器、无 USB 密钥、
 * 无蓝牙），所以流程必须是「链接在能验证的设备上打开，凭据在这里领取」——
 * 好消息是 npm 的协议本来就支持这种拆分（浏览器出 OTP，客户端轮询 doneUrl 领）。
 *
 * 用法：
 *   node scripts/otp-flow.mjs publish [--otp-log /tmp/publish.log]
 *   # 也可以直接给一个已有的 done/auth 对（比如 CLI 打印过的）：
 *   node scripts/otp-flow.mjs resume <authUrl> <doneUrl>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const OFFLINE_HEADERS = {
  'npm-command': 'publish',
  'npm-auth-type': 'web',
  'user-agent': 'npm/12.1.0 node/v22.23.2 linux x64 workspaces/false',
}

const args = process.argv.slice(2)
const mode = args[0] || 'publish'

/** 从 ~/.npmrc 取 token（不打印）。 */
function readToken (rcPath = join(homedir(), '.npmrc')) {
  const rc = readFileSync(rcPath, 'utf8')
  const m = rc.match(/npm_[A-Za-z0-9]+/)
  if (!m) throw new Error(`${rcPath} 里没找到 npm token`)
  return m[0]
}

async function resume (authUrl, doneUrl, token) {
  /* 链接与状态写文件：后台跑时 stdout 可能被缓冲，写文件才能立刻被读到 */
  writeFileSync('/tmp/npm-auth-url.txt', authUrl + '\n' + doneUrl + '\n', { mode: 0o600 })
  console.log(`\n请在**能完成验证的设备**（手机/带指纹的电脑）上打开这个链接：\n\n    ${authUrl}\n`)
  console.log('（链接与 doneUrl 也已写入 /tmp/npm-auth-url.txt）')
  console.log('等待验证完成（最多 15 分钟）…')
  const deadline = Date.now() + 15 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const r = await fetch(doneUrl, { headers: { authorization: `Bearer ${token}` } })
    if (r.status === 200) {
      const c = await r.json().catch(() => ({}))
      if (!c.token) throw new Error('doneUrl 返回里没有 token')
      return c.token
    }
    if (r.status !== 202) throw new Error(`轮询 doneUrl 返回 ${r.status}`)
    process.stdout.write('.')
  }
  throw new Error('等待超时')
}

if (mode === 'resume') {
  const [, , authUrl, doneUrl] = args
  const token = readToken()
  const otp = await resume(authUrl, doneUrl, token)
  console.log('\n✓ 拿到一次性凭据')
  writeFileSync('/tmp/npm-otp.txt', otp, { mode: 0o600 })
  console.log('已写入 /tmp/npm-otp.txt（600）')
} else if (mode === 'publish') {
  const userconfig = args.includes('--userconfig')
    ? args[args.indexOf('--userconfig') + 1]
    : join(homedir(), '.npmrc')
  const cwd = args.includes('--cwd') ? args[args.indexOf('--cwd') + 1] : process.cwd()
  const token = readToken(userconfig)

  console.log(`[1/4] 在 ${cwd} 发起发布（不带 OTP，预期拿到 EOTP 的鉴权链接）…`)
  /* 必须用伪终端（script -qec）跑：npm CLI 在非 TTY 下会把 authUrl/doneUrl **打码成 \*\*\***，
     只有 TTY 才打印完整链接（实测：raw 请求能拿到，CLI 非 TTY 拿不到）。 */
  const cmd = `npx -y npm@12 publish --access public --userconfig ${JSON.stringify(userconfig)}`
  const proc = spawn('script', ['-qec', cmd, '/dev/null'], {
    cwd,
    env: { ...process.env, npm_config_otp: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  const collect = (buf) => { out += String(buf) }
  proc.stdout.on('data', collect)
  proc.stderr.on('data', collect)

  const authMatch = await new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const m = out.match(/https:\/\/www\.npmjs\.com\/auth\/cli\/[a-f0-9-]+/)
      const done = out.match(/https:\/\/registry\.npmjs\.org\/-\/v1\/done\?authId=[a-z0-9-]+/)
      if (m && done) { clearInterval(timer); resolve({ authUrl: m[0], doneUrl: done[0] }) }
      else if (Date.now() - started > 300000) { clearInterval(timer); reject(new Error('等 authUrl 超时:\n' + out.slice(-800))) }
      else if (/npm error (?!code EOTP)/.test(out) && !/EOTP/.test(out)) { /* 继续等 */ }
    }, 500)
  })

  proc.kill()  // CLI 只会干等，凭据我们自己领；留着它没意义
  console.log(`    ✓ 拿到 authUrl / doneUrl`)
  const otp = await resume(authMatch.authUrl, authMatch.doneUrl, token)
  console.log('\n✓ 拿到一次性凭据')
  writeFileSync('/tmp/npm-otp.txt', otp, { mode: 0o600 })

  console.log('[4/4] 带凭据重新发布 …')
  const res = await new Promise((resolve) => {
    const p = spawn('npx', ['-y', 'npm@12', 'publish', '--access', 'public', '--userconfig', userconfig, '--otp', otp], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let o = ''
    p.stdout.on('data', (b) => { o += String(b) })
    p.stderr.on('data', (b) => { o += String(b) })
    p.on('close', (code) => resolve({ code, o }))
  })
  const tail = res.o.split('\n').filter((l) => !/^npm notice [\d.]+k?B/.test(l)).slice(-12).join('\n')
  console.log(tail)
  process.exit(res.code === 0 ? 0 : 1)
} else {
  console.error('用法：node scripts/otp-flow.mjs publish [--cwd <包目录>] [--userconfig <npmrc>]\n' +
    '      node scripts/otp-flow.mjs resume <authUrl> <doneUrl>')
  process.exit(2)
}
