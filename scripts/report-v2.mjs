#!/usr/bin/env node
/**
 * 四段式得分报告 · 本地预览入口（兼容旧命令）
 *
 * 渲染逻辑已经并入 `packages/redteam-store/lib/core.js` 的 `scoreReport`：
 *   · 工具 `redteam_score_report`、控制台「报告」页、`scripts/export-engagement-report.mjs`
 *     都走同一份实现；
 *   · 本脚本只负责把结果落盘到 `$DSH_HOME/redteam/reports/<靶标>/`，方便本机预览。
 *
 * 跑法：
 *   node scripts/report-v2.mjs --engagement '<靶标 id 或名称>'
 *   node scripts/report-v2.mjs --engagement '<id>' --secrets          # 本机预览明文凭据
 *   node scripts/report-v2.mjs --engagement '<id>' --layout legacy    # 旧版长报告（回退用）
 */
import { existsSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { RedteamStore } from '../packages/redteam-store/lib/core.js'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1]
}
const has = (name) => argv.includes('--' + name)
const safeName = (s) => String(s || 'engagement').replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'engagement'

const root = process.env.REDTEAM_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'redteam')
const store = new RedteamStore(root)
const engagement = argOf('engagement', store.activeEngagementId())
if (!engagement) {
  console.error('没有可用靶标：用 --engagement <id> 指定')
  process.exit(1)
}
const layout = argOf('layout', 'simple')
const report = store.scoreReport(engagement, {
  limit: Number(argOf('limit', 2000)),
  shotRef: 'relative',
  layout,
  secrets: has('secrets'),
})
const outDir = resolve(argOf('out', join(root, 'reports', safeName(engagement))))
mkdirSync(outDir, { recursive: true })
const file = join(outDir, 'report-preview.md')
writeFileSync(file, report.markdown, 'utf8')
writeFileSync(join(outDir, 'report-preview.json'), JSON.stringify({
  engagement,
  target: report.target,
  layout: report.layout || layout,
  items: report.items.length,
  points: report.summary.points,
  lines: report.markdown.split('\n').length,
  bytes: Buffer.byteLength(report.markdown),
}, null, 2), 'utf8')

const shotsSrc = join(root, 'engagements', engagement, 'shots')
const shotsDst = join(outDir, 'shots')
if (existsSync(shotsSrc)) {
  rmSync(shotsDst, { recursive: true, force: true })
  cpSync(shotsSrc, shotsDst, { recursive: true })
}
store.close()

console.log('✓ 预览：' + file)
console.log('  ' + report.items.length + ' 项 / ' + report.summary.points + ' 分 · '
  + report.markdown.split('\n').length + ' 行 / ' + Buffer.byteLength(report.markdown) + ' 字节 · layout=' + (report.layout || layout))
console.log('  指标：' + join(outDir, 'report-preview.json'))
