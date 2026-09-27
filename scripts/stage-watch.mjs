/**
 * 盯住暂存状态，一旦自动审查完成就立刻提交批准。
 *
 * 背景：暂存中的包要等 npm 的发布期自动审查跑完（状态 validating → 允许批准），
 * 期间 approve 会返回 `409 ... automated review hasn't finished`。
 * 这次审查跑完之前，人工批准那一步的凭据会过期 —— 所以脚本会：
 *   1) 先试着用旧凭据直接提交（可能还没过期）；
 *   2) 不行就轮询 stage 状态，审查一结束再提示重新做一次证明。
 *
 * 用法：node scripts/stage-watch.mjs <stage-id>
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STAGE_ID = process.argv[2] || '09f8dc01-a92a-40d2-8b52-4b9027b7bfe1'
const VIEW_URL = `https://registry.npmjs.org/-/stage/${STAGE_ID}`

const token = readFileSync(join(homedir(), '.npmrc'), 'utf8').match(/npm_[A-Za-z0-9]+/)?.[0]
if (!token) throw new Error('~/.npmrc 里没找到 npm token')

const headers = { authorization: `Bearer ${token}` }
const npmHeaders = { ...headers, 'npm-command': 'stage', 'npm-auth-type': 'web', 'user-agent': 'npm/12.1.0 node/v22.23.2 linux x64' }

const deadline = Date.now() + 25 * 60 * 1000
let last = ''
while (Date.now() < deadline) {
  let status = 'unknown'
  try {
    const r = await fetch(VIEW_URL, { headers: npmHeaders })
    if (r.ok) {
      const d = await r.json()
      status = d.status || d.state || 'unknown'
    } else {
      status = `http-${r.status}`
    }
  } catch (err) {
    status = `net-${err.cause?.code || 'error'}`
  }
  if (status !== last) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] 暂存状态: ${status}`)
    last = status
  }
  /* 审查跑完（或状态字段消失）后仍要看 registry 上是否已经落地 */
  const pub = await fetch(`https://registry.npmjs.org/dsh-redteam-mode?t=${Date.now()}`)
    .then((r) => r.json()).catch(() => ({}))
  if (pub.versions?.['0.11.5']) {
    console.log('✓ 0.11.5 已出现在 registry 上')
    process.exit(0)
  }
  if (status !== 'validating' && status !== 'unknown' && !status.startsWith('net-')) {
    console.log(`审查阶段结束（${status}）：需要再批准一次 → node scripts/stage-approve.mjs ${STAGE_ID}`)
    process.exit(10)
  }
  await new Promise((r) => setTimeout(r, 20000))
}
console.log('✗ 等待超时')
process.exit(2)
