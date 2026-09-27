/**
 * 暂存批准（npm stage approve 的等价实现，走 npm 的 web-OTP 流程）。
 *
 * 为什么不用 CLI：npm 的 approve 用 `otplease()`，要求 stdin/stdout 都是 TTY，
 * 而审批要在浏览器里按一次安全密钥 —— 在这台机器上 CLI 与浏览器不在同一个交互会话里，
 * 它只会打印链接然后干等回车。这个脚本把同一套协议拆开：
 *
 *   1) POST /-/stage/<id>/approve            → 401 EOTP，响应体里给 authUrl / doneUrl
 *   2) 打印 authUrl 让用户在自己的浏览器里完成证明（人类存在性证明，脚本不代替）
 *   3) 轮询 doneUrl（202 = 还没按，200 = 拿到一次性凭据）
 *   4) 带一次性凭据重新 POST → 发布
 *
 * 用法：node scripts/stage-approve.mjs <stage-id>
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STAGE_ID = process.argv[2]
if (!STAGE_ID) {
  console.error('用法：node scripts/stage-approve.mjs <stage-id>')
  process.exit(2)
}

const APPROVE_URL = `https://registry.npmjs.org/-/stage/${STAGE_ID}/approve`

/** 从 ~/.npmrc 取发布 token（不打印、不外传）。 */
function readToken () {
  const rc = readFileSync(join(homedir(), '.npmrc'), 'utf8')
  const m = rc.match(/npm_[A-Za-z0-9]+/)
  if (!m) throw new Error('~/.npmrc 里没找到 npm token')
  return m[0]
}
const TOKEN = readToken()

const post = (headers) => fetch(APPROVE_URL, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${TOKEN}`,
    /* 这三行是能不能拿到 web-OTP 链接的关键：registry 只对 npm CLI 的请求
       返回带 authUrl / doneUrl 的 EOTP，裸请求只回一句 "provide a one-time pass"。 */
    'npm-command': 'stage',
    'npm-auth-type': 'web',
    'user-agent': 'npm/12.1.0 node/v22.23.2 linux x64 workspaces/false',
    ...headers,
  },
})

console.log(`[1/4] 请求批准 ${STAGE_ID} …`)
let res = await post({})
let body = await res.json().catch(() => ({}))

if (res.status === 200) {
  console.log('✓ 已批准并发布（这次不需要二次验证）')
  console.log(JSON.stringify(body).slice(0, 400))
  process.exit(0)
}

console.log(`    状态 ${res.status}：${body.error || res.statusText}`)

/* 401 EOTP：响应体里带 authUrl / doneUrl（npm CLI 的 otplease 也是读这两个字段） */
const authUrl = body.authUrl
const doneUrl = body.doneUrl
if (!authUrl || !doneUrl) {
  console.error('✗ 响应里没有 authUrl / doneUrl，无法完成证明：')
  console.error(JSON.stringify(body, null, 2).slice(0, 800))
  process.exit(1)
}

console.log('\n[2/4] 请在已登录 npm 的浏览器里打开下面这个链接，按一次安全密钥/指纹完成验证：\n')
console.log(`      ${authUrl}\n`)
console.log('[3/4] 等待验证完成（最多等 10 分钟，验证完这里会自动继续）…')

const deadline = Date.now() + 10 * 60 * 1000
let otp
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000))
  const r = await fetch(doneUrl, { headers: { authorization: `Bearer ${TOKEN}` } })
  if (r.status === 200) {
    const c = await r.json().catch(() => ({}))
    otp = c.token
    if (!otp) {
      console.error('✗ 验证返回里没有 token：', JSON.stringify(c).slice(0, 300))
      process.exit(1)
    }
    break
  }
  if (r.status !== 202) {
    const c = await r.text().catch(() => '')
    console.error(`✗ 轮询返回 ${r.status}：${c.slice(0, 300)}`)
    process.exit(1)
  }
  process.stdout.write('.')
}
if (!otp) {
  console.error('\n✗ 等待超时：浏览器里那次验证没有完成')
  process.exit(1)
}
console.log('\n    ✓ 已拿到一次性凭据')

console.log('[4/4] 带凭据提交批准 …')
/* 提交这一步只发一次请求，但要走公网：连接超时是瞬时的（实测撞过一次），
   而一次性凭据还在有效期内，所以重试是安全的、也是必要的。 */
for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    res = await post({ 'npm-otp': otp })
    body = await res.json().catch(() => ({}))
    break
  } catch (err) {
    console.log(`    第 ${attempt} 次提交失败（${err.cause?.code || err.message}），重试 …`)
    if (attempt === 5) {
      console.error('✗ 提交阶段连续失败，放弃（凭据可能已过期，重跑本脚本即可）')
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, 3000 * attempt))
  }
}
if (res.status === 200) {
  console.log('✓ 暂存包已批准并发布：', JSON.stringify(body).slice(0, 300))
  process.exit(0)
}
console.error(`✗ 提交失败 ${res.status}：${JSON.stringify(body).slice(0, 400)}`)
process.exit(1)
