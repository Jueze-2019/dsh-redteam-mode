/**
 * 暂存全生命周期诊断：把 stage 状态的每一次变化都记下来。
 *
 * 背景：0.11.5 / 0.11.6 两次暂存都在 `validating` 之后**直接消失**（stage view 变 404），
 * 版本号却被永久占用。要区分两种可能，必须看清状态机：
 *   · 若是"审查通过、进入可批准态" → 会看到 validating 之外的中间状态；
 *   · 若是"审查拒绝/超时丢弃" → 只会看到 validating → 404，且 registry 上始终不出现该版本。
 *
 * 用法：node scripts/stage-diag.mjs <stage-id> [轮询分钟数]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STAGE_ID = process.argv[2]
const MINUTES = Number(process.argv[3] || 25)
if (!STAGE_ID) {
  console.error('用法：node scripts/stage-diag.mjs <stage-id> [轮询分钟数]')
  process.exit(2)
}

const token = readFileSync(join(homedir(), '.npmrc'), 'utf8').match(/npm_[A-Za-z0-9]+/)?.[0]
const headers = {
  authorization: `Bearer ${token}`,
  'npm-command': 'stage',
  'npm-auth-type': 'web',
  'user-agent': 'npm/12.1.0 node/v22.23.2 linux x64',
}

const t0 = Date.now()
const stamp = () => `+${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s ${new Date().toISOString().slice(11, 19)}`
const log = (msg) => console.log(`${stamp()}  ${msg}`)

let lastStage = null
const deadline = Date.now() + MINUTES * 60 * 1000
while (Date.now() < deadline) {
  let stageLine = 'net-error'
  try {
    const r = await fetch(`https://registry.npmjs.org/-/stage/${STAGE_ID}`, { headers })
    if (r.ok) {
      const d = await r.json()
      stageLine = d.status || JSON.stringify(Object.keys(d))
    } else {
      stageLine = `http-${r.status}${r.status === 404 ? '（条目已消失）' : ''}`
    }
  } catch (err) {
    stageLine = `net-${err.cause?.code || 'error'}`
  }

  let pubLine = '?'
  try {
    const r = await fetch(`https://registry.npmjs.org/dsh-redteam-mode?t=${Date.now()}`)
    const d = await r.json()
    const vs = Object.keys(d.versions || {}).filter((v) => v.startsWith('0.11') && !v.includes('probe'))
    pubLine = `已发布 0.11.x=[${vs.join(',')}] latest=${(d['dist-tags'] || {}).latest}`
  } catch { /* 网络抖动忽略 */ }

  if (stageLine !== lastStage) {
    log(`stage=${stageLine} | ${pubLine}`)
    lastStage = stageLine
  }

  if (stageLine.startsWith('http-404')) {
    log('条目已从暂存队列消失 —— 判定：审查未通过（或超时丢弃），不是"等待批准"')
    process.exit(10)
  }
  await new Promise((r) => setTimeout(r, 15000))
}
log('轮询结束（未消失）')
process.exit(0)
