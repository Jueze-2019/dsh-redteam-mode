/**
 * 角色提示词版本管理回归测试
 *
 * 跑法：node packages/redteam-store/test/prompts.test.mjs
 *
 * 规则：**是内置默认就跟着新版走，用户自己改过的永不覆盖。**
 * 判断依据是内容指纹（manifest 记下"上次写入默认时的指纹" + 历史默认指纹表）。
 *
 * v0.9.0 起角色从 4 个变成 6 个（主会话 plan + 五个执行角色），并整体重写了正文；
 * 这里同步覆盖"新角色自动补种"这条新行为。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { RedteamStore, DEFAULT_PROMPTS, ROLE_TITLES, LEGACY_PROMPT_HASHES } from '../lib/core.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }
const hash = (t) => createHash('sha1').update(String(t).trim()).digest('hex').slice(0, 12)

const root = mkdtempSync(join(tmpdir(), 'rt-prompts-test-'))
try {
  const store = new RedteamStore(root)
  const { id } = store.openEngagement('提示词测试靶标')
  const dir = store.promptsDirOf(id)
  const manifestPath = store.promptManifestPathOf(id)
  const roles = Object.keys(ROLE_TITLES)

  /* 1) 新靶标：六个角色都是当前内置默认 */
  const fresh = store.listPrompts(id)
  ok(fresh.length === 6 && fresh.every((p) => p.content.trim() === DEFAULT_PROMPTS[p.role].trim()),
    '新靶标播种的六个角色提示词 = 当前内置默认')
  ok(fresh.filter((p) => p.planner === true).length === 1 && fresh.find((p) => p.planner)?.role === 'plan',
    '六个角色里只有一个主会话（plan），它不参与派活')
  ok(roles.every((r) => typeof DEFAULT_PROMPTS[r] === 'string' && DEFAULT_PROMPTS[r].trim() !== ''),
    '每个角色都有内置默认提示词（不会出现空角色）')

  /* 2) manifest 记录了"这是默认"，所以能被识别为可升级 */
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  ok(roles.every((r) => manifest[r] === hash(DEFAULT_PROMPTS[r])), 'manifest 记下了每个角色的默认指纹')

  /* 3) 用户自己改过的：再次读取时不能被覆盖 */
  store.savePrompt(id, 'exploit', '# 我自己写的漏洞利用提示词\n只打这一个点。')
  const kept = store.listPrompts(id).find((p) => p.role === 'exploit')
  ok(kept.content.includes('我自己写的'), '用户自写的提示词不被自动覆盖')
  const manifest2 = JSON.parse(readFileSync(manifestPath, 'utf8'))
  ok(manifest2.exploit === undefined, '用户自写后 manifest 里不再标记为默认')
  /* 3b) 用户手写的内容恰好等于内置默认时，应重新被认定为默认（可升级） */
  store.savePrompt(id, 'exploit', DEFAULT_PROMPTS.exploit)
  ok(JSON.parse(readFileSync(manifestPath, 'utf8')).exploit === hash(DEFAULT_PROMPTS.exploit),
    '内容等于内置默认时重新记为默认')

  /* 4) 旧版默认 → 自动升级：manifest 里记着"上次写下的默认"，内容变了（模拟新版默认）就替换 */
  const fakeOld = '# 老版本的信息收集提示词（没有任何新纪律）\n扫就完了。'
  writeFileSync(join(dir, 'recon.md'), fakeOld, 'utf8')
  const m3 = JSON.parse(readFileSync(manifestPath, 'utf8'))
  m3.recon = hash(fakeOld)                     // 模拟"上一版默认就是它"
  writeFileSync(manifestPath, JSON.stringify(m3), 'utf8')
  const res = store.refreshDefaultPrompts(id)
  const recon = readFileSync(join(dir, 'recon.md'), 'utf8')
  ok(res.changed === 1 && recon.trim() === DEFAULT_PROMPTS.recon.trim(), '旧版默认被自动换成当前版本')
  ok(existsSync(join(dir, 'recon.md')) && readFileSync(join(dir, 'recon.md'), 'utf8').includes('收集完整'),
    '升级后带上了新纪律（资产要收集完整）')
  ok(readFileSync(manifestPath, 'utf8').includes(hash(DEFAULT_PROMPTS.recon)), 'manifest 同步更新为新指纹')
  ok(res.kept.length === 0, '没有误判为用户自写')

  /* 4b) 老靶标缺新角色文件（没有 assess / plan）：读取时按当前默认补种，不报错 */
  const legacyDir = store.promptsDirOf(id)
  rmSync(join(legacyDir, 'assess.md'), { force: true })
  rmSync(join(legacyDir, 'plan.md'), { force: true })
  const created = store.refreshDefaultPrompts(id)
  ok(created.created === 2 && readFileSync(join(legacyDir, 'assess.md'), 'utf8').trim() === DEFAULT_PROMPTS.assess.trim(),
    '缺失的新角色（资产梳理 / 主会话）按当前默认自动补种')

  /* 5) 无 manifest 的老靶标：历史默认指纹表兜底 */
  const old = new RedteamStore(join(root, 'legacy'))
  const { id: legId } = old.openEngagement('老靶标')
  const legDir = old.promptsDirOf(legId)
  rmSync(old.promptManifestPathOf(legId), { force: true })
  /* 历史上的默认值之一（v0.1.0 的漏洞检测提示词开头） */
  const legacyText = '# 漏洞检测智能体（Vulnerability）\n\n## 角色\n你是漏洞检测智能体。'
  writeFileSync(join(legDir, 'vuln-scan.md'), legacyText, 'utf8')
  /* v0.9.0 整体重写提示词后，历史指纹表按设计清空：旧版本一律不再登记为"可自动升级"，
     残留的旧提示词会被判为用户自写而保留（面板点「恢复默认」或脚本 --force 可换新版） */
  ok(Object.keys(LEGACY_PROMPT_HASHES).length === 0,
    '提示词整体重写后历史指纹表已清空（旧默认不再被当作可升级对象）')
  /* 注意：上面这段文本只是形似，不是真正的历史默认，因此不该被覆盖 */
  old.refreshDefaultPrompts(legId)
  ok(readFileSync(join(legDir, 'vuln-scan.md'), 'utf8').includes('你是漏洞检测智能体。') === true,
    '形似但指纹不符的内容不被动（避免误伤用户自写）')
  /* 6) 缺文件的角色不炸 */
  mkdirSync(legDir, { recursive: true })
  ok(store.listPrompts(legId).length === 6, '角色文件缺失时读取不报错')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
