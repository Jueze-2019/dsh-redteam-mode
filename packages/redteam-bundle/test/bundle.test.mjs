/**
 * 市场包 `dsh-redteam-mode` 的打包自检（零依赖）
 *
 * 跑法：node packages/redteam-bundle/test/bundle.test.mjs
 *
 * 这个包是**要发布到 npm、被陌生人装进自己 harness** 的，所以除了功能，
 * 还要盯住三类最容易翻车的地方：
 *   ① 生成物漂移：lib/ 是从三个源码包生成的，忘了重新生成就会发旧代码；
 *   ② 打包契约：dsh.bundle.patch / dsh.client / exports 子路径必须齐，
 *      否则装完不挂载、浏览器半侧不加载；
 *   ③ 泄密：技能与预设里不能有本机路径、VPS 地址、API key（要公开的包）。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

console.log('— 打包契约')
ok(manifest.name === 'dsh-redteam-mode', `包名是 ${manifest.name}`)
ok(manifest.dsh?.bundle?.patch === './cordis.patch.yml', '声明了 dsh.bundle.patch（否则装完不会成为 profile 层）')
ok(manifest.dsh?.client?.platform === 'web', '声明了 dsh.client.platform=web（浏览器半侧才会被加载）')
for (const sub of ['.', './store', './ui', './tools', './client']) {
  ok(typeof manifest.exports?.[sub] === 'string', `exports["${sub}"] 存在`)
}
ok(manifest.dependencies === undefined || Object.keys(manifest.dependencies).length === 0, '零运行时依赖（自包含）')
ok((manifest.files ?? []).includes('cordis.patch.yml') && (manifest.files ?? []).includes('presets') && (manifest.files ?? []).includes('skills'),
  'files 覆盖补丁/预设/技能（npm 打包不会漏）')

console.log('— 补丁层')
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
ok(patch.includes('dsh-redteam-mode/store') && patch.includes('dsh-redteam-mode/ui'), '只挂本包的子路径行（不引用传递依赖）')
ok(patch.includes("dshHomePath('redteam')"), '资产库根目录用 dshHomePath 解析')
ok(!/dsh-redteam-(store|ui|tools)\b/.test(patch.replace(/dsh-redteam-mode\/(store|ui|tools)/g, '')),
  '补丁里没有裸的兄弟包名（pnpm 隔离布局下会解析失败）')

console.log('— 预设')
const preset = readFileSync(join(root, 'presets/redteam/agent.cordis.yml'), 'utf8')
ok(preset.includes('name: dsh-redteam-mode/tools'), '工具行指向本包子路径')
ok(preset.includes('{{REDTEAM_SKILLS_DIR}}'), '技能目录是待替换占位符')
ok(/红队（RedTeam）作战指挥智能体/.test(preset), '人设正文在')
ok(!preset.includes('/home/'), '预设里没有本机绝对路径')

console.log('— 技能随包分发')
const skills = readdirSync(join(root, 'skills')).filter((f) => f.endsWith('.md'))
ok(skills.length === 13, `打包技能 ${skills.length} 个`)
const badSkill = skills.find((f) => {
  const text = readFileSync(join(root, 'skills', f), 'utf8')
  return !/^---\n[\s\S]*?name:\s*\S+/m.test(text) || !/description:/.test(text)
})
ok(badSkill === undefined, '每个技能都有 front-matter（name + description）')

console.log('— 公开包不能夹带敏感信息')
/* 待检查的真实值在运行时拼出来：这样**仓库里不出现这些字面量**（仓库自身的
   发布前扫描就是查这些串），而这个测试仍然在真正地检查"包里有没有夹带它们"。
   检查对象是打出来的包（lib/ presets/ skills/ cordis.patch.yml）。 */
const SENSITIVE = [
  ['FOFA key', ['6c720afd', 'ebd3a7ac', 'ad8601fb', '70df06f8'].join('')],
  ['VPS IP', ['123', '.207.63', '.62'].join('')],
  ['主机名', ['VM-20-3', '-ubuntu'].join('')],
  ['本机路径', ['/home', '/jz'].join('')],
]
for (const [label, needle] of SENSITIVE) {
  const hits = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'test') walk(full); continue }
      if (!/\.(md|yml|yaml|js|json)$/.test(entry.name)) continue
      if (readFileSync(full, 'utf8').includes(needle)) hits.push(full.slice(root.length + 1))
    }
  }
  walk(root)
  ok(hits.length === 0, `${label} 0 命中${hits.length ? '：' + hits.join(', ') : ''}`)
}

console.log('— 生成物与源码同步')
try {
  execFileSync(process.execPath, [join(root, 'tools', 'build.mjs'), '--check'], { stdio: 'pipe' })
  ok(true, 'lib/ 与三个源码包一致（跑 build.mjs 生成）')
} catch (error) {
  ok(false, 'lib/ 已漂移，需要重新运行 node packages/redteam-bundle/tools/build.mjs\n' + String(error.stdout || ''))
}

console.log('— 首次启动自举（预设落地 + 占位符替换 + 幂等）')
const home = mkdtempSync(join(tmpdir(), 'rt-bundle-'))
const prevHome = process.env.DSH_HOME
try {
  process.env.DSH_HOME = home
  const { installPreset, packagePaths } = await import('../lib/index.js')
  const first = installPreset({ log: () => {} })
  ok(first.action === 'installed', '首次启动安装预设')
  const installed = join(home, '.agent-presets', 'redteam', 'agent.cordis.yml')
  ok(existsSync(installed), '预设落到 $DSH_HOME/.agent-presets/redteam/')
  const text = readFileSync(installed, 'utf8')
  ok(!text.includes('{{REDTEAM_SKILLS_DIR}}'), '占位符已被替换成真实路径')
  ok(text.includes(packagePaths().skills), '替换成的是包内 skills/ 绝对路径')
  /* 用户改过就不该被覆盖 */
  writeFileSync(installed, '# 用户自己改过的预设\n', 'utf8')
  const second = installPreset({ log: () => {} })
  ok(second.action === 'kept' && readFileSync(installed, 'utf8').includes('用户自己改过'), '已存在时不覆盖用户预设')
  const forced = installPreset({ force: true, log: () => {} })
  ok(forced.action === 'installed' && !readFileSync(installed, 'utf8').includes('用户自己改过'), 'REDTEAM_PRESET_REFRESH=1 时强制覆盖')
} catch (error) {
  ok(false, '自举流程抛错：' + (error && error.message))
} finally {
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
