#!/usr/bin/env node
/**
 * RedTeam 资产库命令行壳：JSON in（stdin）→ JSON out（stdout）。
 *
 * 两个用途：
 *   1. 原型期的动态 Host 半侧不能 require/import，只能通过 ctx.shell 调本脚本；
 *   2. 调试与验收：不启动界面就能直接查库、灌数据。
 *
 * 数据核心与正式 host 插件共用 packages/redteam-store/lib/core.js，
 * 操作分发共用 core.dispatch，因此三种入口行为一致。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { RedteamStore, dispatch } from '../lib/core.js'

const ROOT = process.env.REDTEAM_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'redteam')

function main() {
  const store = new RedteamStore(ROOT)
  let raw = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { raw += chunk })
  process.stdin.on('end', () => {
    let out
    try {
      const req = raw.trim() ? JSON.parse(raw) : { op: 'bootstrap' }
      out = dispatch(store, req)
    } catch (error) {
      out = { ok: false, error: error && error.message ? error.message : String(error) }
    }
    store.close()
    process.stdout.write(JSON.stringify(out))
  })
}

main()
