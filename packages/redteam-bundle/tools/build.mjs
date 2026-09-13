/**
 * 把三个包「生」成单包插件 `dsh-redteam-mode` 的 lib/。
 *
 * 为什么要生成而不是直接依赖：
 *   pnpm 默认是隔离布局——`dsh-redteam-store` 这类**传递依赖**不会被链到
 *   `<profile>/node_modules/` 下。而 agent preset 里的行是按**宿主 base**解析裸包名的
 *   （`loader.internal.import(name, profileDir)`），所以预设行一旦引用传递依赖就直接
 *   解析失败。让市场用户只装一个包、包内自带全部实现，是唯一稳的做法。
 *
 * 于是：`packages/redteam-{store,ui,tools}` 仍是**唯一源码**，本脚本把它们拷成
 * 自包含的 lib/（改写包内相对 import），生成物随包提交。改完源码跑：
 *
 *   node packages/redteam-bundle/tools/build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const packagesDir = join(pkgRoot, '..')
const libDir = join(pkgRoot, 'lib')

const read = (rel) => readFileSync(join(packagesDir, rel), 'utf8')
/** `--check`：只比对生成结果与仓库现状，不写盘（CI / 回归测试用）。 */
const CHECK = process.argv.includes('--check')
const drift = []
const write = (rel, text) => {
  const target = join(pkgRoot, rel)
  if (CHECK) {
    let current
    try { current = readFileSync(target, 'utf8') } catch { current = undefined }
    if (current !== text) drift.push(rel)
    return rel
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text, 'utf8')
  return rel
}

/* 1) 资产库核心：零依赖，原样拷过来；插件壳里的 './core.js' 改成 './store-core.js' */
const core = read('redteam-store/lib/core.js')
write('lib/store-core.js', core)
const storeIndex = read('redteam-store/lib/index.js').replace("from './core.js'", "from './store-core.js'")
write('lib/store.js', storeIndex)

/* 2) 控制台 host 半侧：把跨包的 core 引用改成本地 store-core */
const uiIndex = read('redteam-ui/lib/index.js')
  .replace("from '../../redteam-store/lib/core.js'", "from './store-core.js'")
write('lib/ui.js', uiIndex)

/* 3) 浏览器半侧：原样拷（client 入口由本包的 exports['./client'] 提供） */
write('lib/client.js', read('redteam-ui/lib/client.js'))

/* 4) 工具集：跨包引用 ROLE_TITLES，改成本地 store-core */
const tools = read('redteam-tools/lib/index.js')
  .replace("from '../../redteam-store/lib/core.js'", "from './store-core.js'")
write('lib/tools.js', tools)

/* 5) 预设：工具行指向本包子路径；技能目录用占位符，由插件在首次启动时
      替换成真实绝对路径（YAML 里没法知道包装在哪）。 */
/* 预设：工具行改成本包子路径；skill-filesystem 行注入包内技能目录占位符。
   占位符由这里注入（而不是写在源码预设里），这样 redteam-sync-repo 从线上
   覆盖仓库预设时不会把 build 弄坏。 */
const SKILL_ROW = "- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'"
const presetSource = read('../preset/agent.cordis.yml')
if (!presetSource.includes(SKILL_ROW)) throw new Error('预设里找不到 skill-filesystem 行')
const preset = presetSource
  .replace('  name: dsh-redteam-tools', '  name: dsh-redteam-mode/tools')
  .replace(SKILL_ROW, SKILL_ROW + `
  # 红队技能随包分发：__REDTEAM_SKILLS_DIR__ 由插件首次启动时替换成包内 skills/ 的绝对路径。
  # $DSH_HOME/skills 等默认根仍然生效（includeDefaultRoots 默认 true），用户自己的技能照旧优先。
  config:
    customSkillDirs:
      - {{REDTEAM_SKILLS_DIR}}`)
if (!preset.includes('{{REDTEAM_SKILLS_DIR}}')) throw new Error('技能目录占位符注入失败')
write('presets/redteam/agent.cordis.yml', preset)
const presetMeta = readFileSync(join(packagesDir, '../preset/preset.yml'), 'utf8')
const presetMetaPath = join(pkgRoot, 'presets/redteam/preset.yml')
if (CHECK) {
  let current
  try { current = readFileSync(presetMetaPath, 'utf8') } catch { current = undefined }
  if (current !== presetMeta) drift.push('presets/redteam/preset.yml')
} else {
  mkdirSync(dirname(presetMetaPath), { recursive: true })
  writeFileSync(presetMetaPath, presetMeta, 'utf8')
}

/* 技能：从仓库已脱敏的 skills/ 拷一份 */
const skillsSrc = join(packagesDir, '../skills')
const skillsDst = join(pkgRoot, 'skills')
mkdirSync(skillsDst, { recursive: true })
let skills = 0
for (const f of readdirSync(skillsSrc)) {
  if (!f.endsWith('.md')) continue
  const text = readFileSync(join(skillsSrc, f), 'utf8')
  if (CHECK) {
    let current
    try { current = readFileSync(join(skillsDst, f), 'utf8') } catch { current = undefined }
    if (current !== text) drift.push('skills/' + f)
  } else {
    mkdirSync(skillsDst, { recursive: true })
    writeFileSync(join(skillsDst, f), text, 'utf8')
  }
  skills += 1
}

/* 校验：生成的 lib 里不允许再出现跨包的相对路径 */
const generated = ['lib/store-core.js', 'lib/store.js', 'lib/ui.js', 'lib/tools.js', 'lib/client.js']
const offenders = []
for (const rel of generated) {
  const text = readFileSync(join(pkgRoot, rel), 'utf8')
  for (const m of text.matchAll(/from\s+'([^']*\.\.\/[^']*)'/g)) offenders.push(`${rel}: ${m[1]}`)
  for (const m of text.matchAll(/from\s+'([^']*redteam-(store|ui|tools)[^']*)'/g)) offenders.push(`${rel}: ${m[1]}`)
}
if (offenders.length > 0) {
  console.error('✗ 生成结果仍含跨包引用：')
  for (const o of offenders) console.error('   ' + o)
  process.exit(1)
}
if (!existsSync(join(pkgRoot, 'presets/redteam/agent.cordis.yml'))) {
  console.error('✗ 预设未生成')
  process.exit(1)
}
if (CHECK) {
  if (drift.length > 0) {
    console.error('✗ 生成物与源码不同步（跑 node packages/redteam-bundle/tools/build.mjs 重新生成）：')
    for (const d of drift) console.error('   ' + d)
    process.exit(1)
  }
  console.log(`✓ 生成物与源码同步（lib/ 5 个文件、预设 2 个、技能 ${skills} 个）`)
  process.exit(0)
}
console.log(`✓ dsh-redteam-mode 已生成：lib/ 5 个文件、预设 2 个、技能 ${skills} 个`)
