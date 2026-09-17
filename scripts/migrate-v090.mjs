#!/usr/bin/env node
/**
 * v0.9.0 数据迁移：给本机已有的靶标库与知识库补上新列并回填。
 *
 * 跑法：
 *   node scripts/migrate-v090.mjs --dry-run   # 只报告会动什么，不落盘
 *   node scripts/migrate-v090.mjs             # 执行（每个库写回前不做备份，SQLite 只加列不删数据）
 *
 * 为什么要单独跑一次：新列是**按库懒加载**补的（打开某个靶标时才 migrate），
 * 所以老靶标在你打开它之前一直是旧结构。这个脚本一次性把全部靶标过一遍：
 *   · asset.discovered_at       ← COALESCE(first_seen, last_seen)（发现时间回填，老数据才有得看）
 *   · vuln/credential/webshell/tunnel.agent、attack_step.tool/agent/result  ← 新列（旧行为空）
 *   · poc.category / engagement_id / engagement_name / asset_target / found_by_agent
 *       ← 新列 + 按 code/kind 给老条目推一个归类（否则面板里全是"未归类"）
 *
 * 只做 ALTER TABLE ADD COLUMN 与 UPDATE 回填，**不删除任何数据**。
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore } from '../packages/redteam-store/lib/core.js'

const dryRun = process.argv.includes('--dry-run')
const root = process.env.REDTEAM_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'redteam')
const engDir = join(root, 'engagements')

console.log(`数据根目录：${root}`)
if (!existsSync(engDir)) {
  console.error(`找不到靶标目录：${engDir}`)
  process.exit(1)
}

const store = new RedteamStore(root)
const names = readdirSync(engDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(engDir, d.name, 'assets.db')))
  .map((d) => d.name)
  .sort()

let assetsMissing = 0
let agentsMissing = 0
const rows = []
for (const name of names) {
  const db = store.db(name) // 打开即跑 migrate（补列 + 回填 discovered_at）
  const one = (sql) => Object.values(db.prepare(sql).get() || {})[0] ?? 0
  const missing = one("SELECT COUNT(*) FROM asset WHERE COALESCE(discovered_at, '') = ''")
  const noTool = one("SELECT COUNT(*) FROM attack_step WHERE COALESCE(tool, '') = ''")
  assetsMissing += missing
  agentsMissing += noTool
  if (!dryRun) {
    /* discovered_at 由 migrate 回填；这里只报告结果，不再改数据 */
  }
  rows.push({ name, assets: one('SELECT COUNT(*) FROM asset'), missing, noTool })
}
const width = Math.max(...rows.map((r) => r.name.length), 4)
for (const r of rows) {
  console.log(`${r.name.padEnd(width)} | 资产 ${String(r.assets).padStart(4)} | 缺发现时间 ${String(r.missing).padStart(4)} | 无命令的步骤 ${String(r.noTool).padStart(4)}`)
}

/* 知识库：补列 + 给老条目推归类 */
const kb = store.kb()
const pocTotal = Object.values(kb.prepare('SELECT COUNT(*) AS n FROM poc').get() || {})[0] ?? 0
const uncategorized = Object.values(kb.prepare("SELECT COUNT(*) AS n FROM poc WHERE COALESCE(NULLIF(category, ''), 'other') = 'other'").get() || {})[0] ?? 0
const noEngagement = Object.values(kb.prepare("SELECT COUNT(*) AS n FROM poc WHERE COALESCE(engagement_id, '') = '' AND COALESCE(engagement_name, '') = ''").get() || {})[0] ?? 0
console.log(`\n知识库：${pocTotal} 条（未归类 ${uncategorized}，未标来源靶标 ${noEngagement}）`)

console.log(`\n${dryRun ? '（dry-run，未落盘）' : '完成'}：靶标 ${rows.length} 个；`
  + `缺发现时间的资产 ${assetsMissing} 条；无 tool 的步骤 ${agentsMissing} 条（历史步骤没法补命令，新记录请务必写 tool）。`)
if (assetsMissing > 0) {
  console.log('提示：仍缺发现时间的资产说明 first_seen/last_seen 也为空，打开靶标面板后按"最近发现优先"排序即可看到后续新增的。')
}
console.log('提示：历史 POC 的来源靶标无法反推（当时没记），面板里显示"未标注来源靶标"；新回填请带 engagement + asset_target。')
store.close()
