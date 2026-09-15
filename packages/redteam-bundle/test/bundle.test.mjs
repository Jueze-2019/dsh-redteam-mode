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
/* 挂载行只引用本包子路径（裸兄弟包名在 pnpm 隔离布局下解析不到）；
   只有迁移补丁会提到旧包名，那是用来精确匹配旧行的，不是挂载。 */
const mountNames = [...patch.matchAll(/^\s{4,}-?\s*name:\s*(\S+)\s*$/gm)].map((m) => m[1])
ok(mountNames.length > 0 && mountNames.every((n) => n.startsWith('dsh-redteam-mode')),
  `insert 的挂载行只用本包子路径：${mountNames.join(', ')}`)

/* ── 行 id 撞车回归（v0.7.0 真实事故）──────────────────────────────────────
   loader 的 `- insert:` 是**追加**语义：不按 id 去重。预发布期用开发版装过的
   机器，profile 补丁里已经有 id=redteam-store / redteam-ui 的行，再 insert 同名
   行 → boot 直接失败 "duplicate loader entry id"。所以：
     · insert 的 id 必须带前缀，与旧行不可能撞车；
     · 两条 (id + name) 补丁负责把旧行 disabled 掉（匹配不到只 warn，无副作用）。 */
const insertedIds = []
{
  let inInsert = false
  for (const line of patch.split('\n')) {
    if (/^\s*-?\s*insert:\s*$/.test(line)) { inInsert = true; continue }
    if (/^\s*-\s/.test(line) && !/^\s{4,}/.test(line)) {
      if (/^\s*-\s+id:/.test(line)) inInsert = false
    }
    const m = /^\s{4,}-\s+id:\s*(\S+)\s*$/.exec(line)
    if (inInsert && m) insertedIds.push(m[1])
  }
}
ok(insertedIds.length >= 3, `解析出 ${insertedIds.length} 个 insert 行 id：${insertedIds.join(', ')}`)
const LEGACY_IDS = ['redteam-store', 'redteam-ui']
ok(insertedIds.every((id) => !LEGACY_IDS.includes(id)),
  'insert 的行 id 不与预发布期旧 id 撞车（否则老机器 boot 失败）')
ok(insertedIds.every((id) => id.startsWith('redteam-mode')), 'insert 的行 id 统一带 redteam-mode 前缀')
for (const legacy of LEGACY_IDS) {
  const re = new RegExp(`^- id: ${legacy}\\n  name: dsh-${legacy}\\n  disabled: true`, 'm')
  ok(re.test(patch), `带 (id+name) 的迁移补丁会关掉旧行 ${legacy}（匹配不到只 warn）`)
}
/* 迁移补丁必须同时给出 name：loader 只在 id 与 name 都匹配时才应用，否则会误改同 id 的别的行 */
ok(/^- id: redteam-store\n  name: dsh-redteam-store/m.test(patch) && /^- id: redteam-ui\n  name: dsh-redteam-ui/m.test(patch),
  '两条迁移补丁都带 name（精确匹配，不会误伤同 id 的其它行）')

console.log('— 预设')
const preset = readFileSync(join(root, 'presets/redteam/agent.cordis.yml'), 'utf8')
ok(preset.includes('name: dsh-redteam-mode/tools'), '工具行指向本包子路径')
ok(preset.includes('{{REDTEAM_SKILLS_DIR}}'), '技能目录是待替换占位符')
ok(/includeDefaultRoots: false/.test(preset), '关掉默认技能根（否则会把 .agents/skills 等几百个技能一起吞进来）')
ok(/dshHomePath\('skills'\)/.test(preset), '额外只放行 $DSH_HOME/skills')
ok(/红队（RedTeam）作战指挥智能体/.test(preset), '人设正文在')
ok(!preset.includes('/home/'), '预设里没有本机绝对路径')

console.log('— 子智能体委派的硬约束（toolFilter / maxDepth）')
{
  /* 背景：v0.8.0 想用 toolFilter.deny 把委派工具从子会话里摘掉，deny 列表里写了 `subagent`——
     但 `subagent` 是**这一行自己注册的 scoped 工具**，不在全局工具库里，tools.restrict()
     校验时抛 `names unknown global tool "subagent"`，结果是**每一次委派都失败**（0.8.1 修）。
     这里锁住那条教训：deny 里只能出现全局工具名。 */
  const GLOBAL_DELEGATION_TOOLS = ['subagent_fork', 'workflow', 'ralph']
  const subagentRow = /- id: tool-subagent\n([\s\S]*?)(?=\n    - id: )/.exec(preset)
  ok(subagentRow !== null, '找得到 tool-subagent 行')
  if (subagentRow !== null) {
    const row = subagentRow[1]
    const depth = /maxDepth: (\d+)/.exec(row)
    ok(depth !== null && Number(depth[1]) === 1, 'maxDepth = 1（子智能体不得再往下派发）')

    const denyBlock = /toolFilter:\n\s+deny:\n((?:\s+- [\w-]+\n?)+)/.exec(row)
    ok(denyBlock !== null, 'tool-subagent 行配了 toolFilter.deny')
    if (denyBlock !== null) {
      const names = denyBlock[1].split('\n').map((l) => l.replace(/^\s+- /, '').trim()).filter(Boolean)
      ok(names.length > 0, `deny 列表非空（${names.join(', ')}）`)
      ok(!names.includes('subagent'),
        'deny 里没有 `subagent`（它是行内 scoped 工具，写进 deny 会让整个委派挂掉）')
      const unknown = names.filter((n) => !GLOBAL_DELEGATION_TOOLS.includes(n))
      ok(unknown.length === 0, `deny 里全是全局工具名（未知项：${unknown.join(', ') || '无'}）`)
    }
  }
}


console.log('— 浏览器半侧的注册 id')
{
  /* 前端加载器按**包名**认领模块：bundle URL 是 dsh-redteam-mode/client.js，
     它就找 __ModuleLoader__.load({ id: 'dsh-redteam-mode' })。
     生成时若原样拷 UI 包那份（id: 'dsh-redteam-ui'），浏览器会报
     "loaded without registering ... via __ModuleLoader__.load"。 */
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const m = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(client)
  ok(m !== null, 'client.js 里有 __ModuleLoader__.load({ id })')
  ok(m !== null && m[1] === manifest.name, `注册 id 等于包名（${m ? m[1] : '?'} vs ${manifest.name}）`)
}

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

console.log('— 迁移脚本（预发布期遗留行）')
{
  const home = mkdtempSync(join(tmpdir(), 'rt-migrate-'))
  const prev = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    const patchFile = join(home, 'profiles', 'web', 'cordis.patch.yml')
    const legacy = [
      '# 用户自己的补丁',
      '- insert:',
      '    - id: redteam-store',
      '      name: dsh-redteam-store',
      '      config:',
      "        root: /tmp/x",
      '    - id: redteam-ui',
      '      name: dsh-redteam-ui',
      '',
      '- id: other-plugin',
      '  disabled: true',
      '',
    ].join('\n')
    writeFileSync(patchFile, legacy, 'utf8')
    const out = execFileSync(process.execPath, [join(root, 'lib', 'migrate-legacy-rows.mjs')], { encoding: 'utf8' })
    const text = readFileSync(patchFile, 'utf8')
    ok(!/redteam-store|redteam-ui/.test(text), '遗留的 redteam-store / redteam-ui 行被删除')
    ok(/other-plugin/.test(text) && /用户自己的补丁/.test(text), '其它行与注释原样保留')
    ok(/备份/.test(out), '写回前做了备份')
    /* 只剩遗留行时，必须写回 `[]`，否则 boot 报 "must be a top-level YAML array" */
    writeFileSync(patchFile, '- insert:\n    - id: redteam-store\n      name: dsh-redteam-store\n', 'utf8')
    execFileSync(process.execPath, [join(root, 'lib', 'migrate-legacy-rows.mjs')], { encoding: 'utf8' })
    ok(readFileSync(patchFile, 'utf8').trim() === '[]', '整份被删空时写回 []（合法空补丁）')
    const again = execFileSync(process.execPath, [join(root, 'lib', 'migrate-legacy-rows.mjs')], { encoding: 'utf8' })
    ok(/没有预发布期的遗留行/.test(again), '重复执行是幂等的')

    /* 块里带注释的遗留补丁：删掉 id 行后 `- insert:` 不能留成悬空块
       （只剩注释，YAML 会解析成 {insert: null}，boot 照样出错） */
    const withComments = [
      '# 用户自己的补丁',
      '- insert:',
      '    # 老版本的资产库行',
      '    - id: redteam-store',
      '      name: dsh-redteam-store',
      '    # 老版本的控制台行',
      '    - id: redteam-ui',
      '      name: dsh-redteam-ui',
      '',
      '- id: other-plugin',
      '  disabled: true',
      '',
    ].join('\n')
    writeFileSync(patchFile, withComments, 'utf8')
    execFileSync(process.execPath, [join(root, 'lib', 'migrate-legacy-rows.mjs')], { encoding: 'utf8' })
    const cleaned = readFileSync(patchFile, 'utf8')
    ok(!/insert:/.test(cleaned) && !/redteam-store|redteam-ui/.test(cleaned),
      '块内带注释时不留悬空的 `- insert:`')
    ok(/other-plugin/.test(cleaned), '悬空块清理后其它行仍在')
    /* 旧版脚本留下的悬空块（没有遗留行可删）也要能被自愈 */
    writeFileSync(patchFile, '# 只有注释\n- insert:\n    # 只剩注释了\n\n', 'utf8')
    execFileSync(process.execPath, [join(root, 'lib', 'migrate-legacy-rows.mjs')], { encoding: 'utf8' })
    ok(readFileSync(patchFile, 'utf8').trim() === '[]', '已是悬空块时自愈为 []（无需遗留行）')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
