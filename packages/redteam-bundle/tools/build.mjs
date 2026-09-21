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
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
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

/* 1) 资产库核心：零依赖，原样拷过来；插件壳里的 './core.js' 改成 './store-core.js'。
   core.js 拆分成了 4 个模块（ip-utils / schema / validate / score-rules），
   它们用的是**同目录相对导入**（./ip-utils.js 等），拷贝时文件名不变，因此
   无需改写导入路径 —— 只要把这 5 个文件都放进 lib/ 即可。 */
const core = read('redteam-store/lib/core.js')
write('lib/store-core.js', core)
/* 1a) core.js 依赖的 4 个模块（纯函数，零外部依赖） */
for (const name of ['ip-utils', 'schema', 'validate', 'score-rules', 'report-replay']) {
  write('lib/' + name + '.js', read('redteam-store/lib/' + name + '.js'))
}

/* 1b) 技能可用性判定：tools 与面板共用的一份实现（零依赖，原样拷） */
const skillAvailability = read('redteam-store/lib/skill-availability.js')
write('lib/skill-availability.js', skillAvailability)
const storeIndex = read('redteam-store/lib/index.js').replace("from './core.js'", "from './store-core.js'")
write('lib/store.js', storeIndex)

/* 2) 控制台 host 半侧：把跨包的 core 引用改成本地 store-core */
const uiIndex = read('redteam-ui/lib/index.js')
  .replace("from '../../redteam-store/lib/core.js'", "from './store-core.js'")
  .replace("from '../../redteam-store/lib/skill-availability.js'", "from './skill-availability.js'")
write('lib/ui.js', uiIndex)

/* 3) 浏览器半侧：拷过来，并把注册 id 改成**本包的包名**。
   前端加载器按包名取模块：bundle URL 是 `dsh-redteam-mode/client.js`，它就用
   `__ModuleLoader__.load({ id: 'dsh-redteam-mode' })` 去认领；源码包里写的是
   `dsh-redteam-ui`（那份 bundle 属于 UI 包），不改就会报
   "loaded without registering ... via __ModuleLoader__.load"。 */
const clientSrc = read('redteam-ui/lib/client.js')

/* 3a) 把 CSS 占位符替换成 styles.js 的正文。
   浏览器半侧运行期不能 import（模块身份靠 __ModuleLoader__.load，基座外只能 require react），
   所以源码里 client.js 只留一行 `const CSS = '__RT_STYLES__'`，由这里内联 ——
   源码可读（CSS 单独一个文件、编辑器能高亮），产物仍是单文件自包含。 */
const stylesSrc = read('redteam-ui/lib/styles.js')
const styleMatch = /export const CSS = String\.raw`([\s\S]*?)`\n?$/.exec(stylesSrc)
if (styleMatch === null) throw new Error('styles.js 里找不到 export const CSS = String.raw`...`')
const cssText = styleMatch[1]
if (!clientSrc.includes("'__RT_STYLES__'")) throw new Error('client.js 里找不到 __RT_STYLES__ 占位符')
if (cssText.includes('`') || cssText.includes('${')) {
  throw new Error('CSS 里含反引号或 ${ —— 内联进模板串会截断，请改用其它引号写法')
}
const clientWithCss = clientSrc.replace("'__RT_STYLES__'", '`' + cssText + '`')
const clientId = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).name
const registered = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(clientWithCss)
if (registered === null) throw new Error('client.js 里找不到 __ModuleLoader__.load({ id })')
const clientOut = clientWithCss.replace(
  /(__ModuleLoader__\.load\(\{\s*id:\s*')[^']+(')/,
  `$1${clientId}$2`,
)
if (!new RegExp(`__ModuleLoader__\\.load\\(\\{\\s*id:\\s*'${clientId}'`).test(clientOut)) {
  throw new Error('client.js 的注册 id 改写失败')
}
write('lib/client.js', clientOut)

/* 4) 工具集：跨包引用 ROLE_TITLES，改成本地 store-core */
const tools = read('redteam-tools/lib/index.js')
  .replace("from '../../redteam-store/lib/core.js'", "from './store-core.js'")
  .replace("from '../../redteam-store/lib/skill-availability.js'", "from './skill-availability.js'")
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
  # 技能根**顺序即优先级**（同名技能取先出现的那份）：$DSH_HOME/skills 必须排在包内目录前面，
  # 否则用户在自己那份里配好的 VPS 地址 / 密钥会被随包模板（里面是 \`<你的VPS_IP>\` 这类占位符）盖住，
  # 连技能可用性判定都会误报成"技能坏了"。
  config:
    # 只扫描"$DSH_HOME/skills + 本插件自带的"两个根：
    # 关掉 includeDefaultRoots，避免把 .agents/skills、项目级的大技能包（动辄数百个）
    # 一起吞进红队会话——那既污染模型上下文，也让技能页看起来像被塞了几百个技能。
    includeDefaultRoots: false
    customSkillDirs:
      - !!js dshHomePath('skills')
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

/* 技能：从仓库已脱敏的 skills/ 拷一份。
   ⚠️ 拷贝前先清空目标目录：本脚本只"写"不"删"，历史上一次手工放进
   packages/redteam-bundle/skills/ 的文件会永远留在包里 —— 表现是"本机看着 23 个技能、
   干净检出只有 13 个"（README 承诺 23 个，发布产物却只有 13 个）。
   清空后 `skills/` 与仓库根 `skills/` 严格一一对应，包内容可复现。 */
const skillsSrc = join(packagesDir, '../skills')
const skillsDst = join(pkgRoot, 'skills')
const skillNames = readdirSync(skillsSrc).filter((f) => f.endsWith('.md'))
if (CHECK) {
  /* 只比对，不删盘：目标目录里多出来的文件同样是 drift */
  let current = []
  try { current = readdirSync(skillsDst).filter((f) => f.endsWith('.md')) } catch { current = [] }
  for (const f of current) if (!skillNames.includes(f)) drift.push('skills/' + f + '（多余，应删除）')
} else {
  rmSync(skillsDst, { recursive: true, force: true })
  mkdirSync(skillsDst, { recursive: true })
}
let skills = 0
for (const f of skillNames) {
  const text = readFileSync(join(skillsSrc, f), 'utf8')
  if (CHECK) {
    let current
    try { current = readFileSync(join(skillsDst, f), 'utf8') } catch { current = undefined }
    if (current !== text) drift.push('skills/' + f)
  } else {
    writeFileSync(join(skillsDst, f), text, 'utf8')
  }
  skills += 1
}

/* 环境安装脚本：随包分发一份。
   为什么必须随包：市场包用户装完只有 node_modules，仓库根本不在盘上——
   预检里如果只说"从仓库取 scripts/redteam-setup.sh"，用户拿不到脚本、引导就断了。
   随包分发后由 lib/index.js 在启动时落到 $DSH_HOME/redteam/setup.sh。 */
const setupSrc = join(packagesDir, '..', 'scripts', 'redteam-setup.sh')
const setupDst = join(pkgRoot, 'scripts', 'redteam-setup.sh')
let setupCopied = false
try {
  const text = readFileSync(setupSrc, 'utf8')
  if (CHECK) {
    let current
    try { current = readFileSync(setupDst, 'utf8') } catch { current = undefined }
    if (current !== text) drift.push('scripts/redteam-setup.sh')
  } else {
    mkdirSync(dirname(setupDst), { recursive: true })
    writeFileSync(setupDst, text, { encoding: 'utf8', mode: 0o755 })
  }
  setupCopied = true
} catch (error) {
  console.error('✗ 读取 scripts/redteam-setup.sh 失败：' + (error && error.message ? error.message : String(error)))
}

/* 校验：生成的 lib 里不允许再出现跨包的相对路径 */
const generated = [
  'lib/store-core.js', 'lib/ip-utils.js', 'lib/schema.js', 'lib/validate.js', 'lib/score-rules.js',
  'lib/report-replay.js',
  'lib/skill-availability.js', 'lib/store.js', 'lib/ui.js', 'lib/tools.js', 'lib/client.js',
]
const offenders = []
for (const rel of generated) {
  const text = readFileSync(join(pkgRoot, rel), 'utf8')
  for (const m of text.matchAll(/from\s+'([^']*\.\.\/[^']*)'/g)) offenders.push(`${rel}: ${m[1]}`)
  /* 同目录相对导入（./ip-utils.js 等）是允许的：它们随包一起分发。
     真正要拦的是"跳出本包"的引用（../ 或裸包名），上面两条已经覆盖。 */
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
  console.log(`✓ 生成物与源码同步（lib/ ${generated.length} 个文件、预设 2 个、技能 ${skills} 个）`)
  process.exit(0)
}
console.log(`✓ dsh-redteam-mode 已生成：lib/ ${generated.length} 个文件（含 core 与报告拆出的模块）、预设 2 个、技能 ${skills} 个、安装脚本 ${setupCopied ? '1 个' : '缺失'}`)
