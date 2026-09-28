/**
 * 直连 registry 的发布/暂存流程（绕开 npm CLI 的 TTY 限制）。
 *
 * 为什么要绕：npm CLI 的 `otplease()` 要求 stdin/stdout 都是 TTY，而人工证明要在浏览器里
 * 按安全密钥完成 —— 本机（QEMU VM）没有任何 WebAuthn 认证器（无平台认证器、无 USB 密钥、
 * 无蓝牙），所以必须把流程拆成「链接在能验证的设备上打开，凭据在这里领取」。
 * 协议本身支持这种拆分：registry 在缺 OTP 时返回 401 + authUrl/doneUrl，
 * 完成验证后 GET doneUrl 就能领到一次性凭据。
 *
 * 用法：
 *   node scripts/npm-direct.mjs auth  <authUrl> <doneUrl>     # 轮询领取凭据并打印（脱敏）
 */
const [, , cmd, authUrl, doneUrl] = process.argv
const token = (await import('node:fs')).readFileSync('/tmp/probe.npmrc', 'utf8').match(/npm_[A-Za-z0-9]+/)?.[0]

if (cmd !== 'auth' || !authUrl || !doneUrl) {
  console.error('用法：node scripts/npm-direct.mjs auth <authUrl> <doneUrl>')
  process.exit(2)
}

console.log(`\n请在**能完成验证的设备**（手机 / 带指纹的电脑）上打开：\n\n    ${authUrl}\n`)
console.log('等待验证完成（最多 15 分钟）…')
const deadline = Date.now() + 15 * 60 * 1000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000))
  const r = await fetch(doneUrl, { headers: { authorization: `Bearer ${token}` } })
  if (r.status === 200) {
    const c = await r.json().catch(() => ({}))
    if (!c.token) { console.error('返回里没有 token:', JSON.stringify(c).slice(0, 200)); process.exit(1) }
    const otp = c.token
    // 只在本地落盘，不打印明文；只显示形态特征，便于判断是 6 位验签码还是恢复码
    ;(await import('node:fs')).writeFileSync('/tmp/npm-otp.txt', otp, { mode: 0o600 })
    const shape = /^\d{6}$/.test(otp) ? '6 位数字（TOTP 形态）' : `${otp.length} 位非纯数字（恢复码/其它形态）`
    console.log(`\n✓ 已领取一次性凭据：${shape} → 写入 /tmp/npm-otp.txt（600）`)
    process.exit(0)
  }
  if (r.status !== 202) { console.error(`\n轮询返回 ${r.status}`); process.exit(1) }
  process.stdout.write('.')
}
console.error('\n等待超时')
process.exit(1)
