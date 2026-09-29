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
/* 发行组成契约（哪些技能/脚本进 npm 包）—— 见该文件的说明 */
const { isSkillShipped, isScriptShipped } = await import('./distribution.mjs')
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

/* 5) 预设：同一份源码生成**两个**产物。
       a) `presets/redteam/agent.cordis.yml` —— 老式「目录预设」，只有 DSH < 0.1.7
          的 `$DSH_HOME/.agent-presets/` 扫描机制会读它，留着给老版本用户。
       b) `cordis.patch.yml` 生成区里的 `preset-redteam` 声明行 —— DSH 0.1.7-alpha.1
          起 agent preset **只认 `@deepseek-ai/dsh-agent-preset` 声明行**（注册表既不
          扫目录也不接受预设路径），由它把「红队模式」注册进新会话的模式列表。
          不单开补丁文件的原因见 cordis.patch.yml 里的说明（数组形式旧版会崩）。
   工具行都改成本包子路径；skill-filesystem 行注入技能目录。 */
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

/* 5b) 声明行（产物 b 的内容，写回 cordis.patch.yml 的生成区）。
     技能目录不能再靠"安装时替换占位符"——声明行是静态 YAML，插件启动时不会去改
     profile 的补丁层。改成**运行时**解析，两级：
       ① 本包 host 半侧 `dsh-redteam-mode` 提供的 `redteamMode` 服务，它用
          `import.meta.url` 解析包内路径，包被搬到哪（npx 缓存换 hash、profile 重装、
          软链开发态）都对；
       ② 兜底按 profile base 解析本包（`baseUrl` 即 profile 目录）。
     两者都拿不到时宁可让 skill-filesystem 配置校验报错（预设激活失败、模式列表里
     带诊断），也不要写死一个会静默失效的绝对路径 —— v0.9.0 的事故就是这么来的。 */
const SKILLS_EXPR = "ctx.get('redteamMode')?.paths?.skills ?? process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('dsh-redteam-mode/package.json')), 'skills')"
const declaredPlugins = preset.replace('      - {{REDTEAM_SKILLS_DIR}}', '      - !!js ' + SKILLS_EXPR)
if (declaredPlugins === preset) throw new Error('声明行里技能目录占位符替换失败')
const metaName = /^name:[ \t]*(.*)$/m.exec(presetMeta)
const metaDescription = /^description:[ \t]*(.*)$/m.exec(presetMeta)
if (metaName === null || metaDescription === null) throw new Error('preset/preset.yml 缺少 name 或 description')
/* 生成区从起始标记整段替换：标记之前的内容（迁移补丁 + 三个挂载行）是手写的，
   这里原样保留，所以 patches 文件平时仍然可以手工编辑。 */
const DECL_START = '# >>> preset-redteam declaration'
const DECL_END = '# <<< preset-redteam declaration <<<'
const declBody = `- insert:
    - id: preset-redteam
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: redteam
        name: ${JSON.stringify(metaName[1].trim())}
        description: ${JSON.stringify(metaDescription[1].trim())}
        order: 10
        plugins:
${declaredPlugins.split('\n').map((line) => (line.trim() === '' ? '' : '          ' + line)).join('\n')}
`
const patchPath = join(pkgRoot, 'cordis.patch.yml')
const patchText = readFileSync(patchPath, 'utf8')
const startAt = patchText.indexOf(DECL_START)
const endAt = patchText.indexOf(DECL_END)
if (startAt < 0 || endAt < 0 || endAt < startAt) {
  throw new Error('cordis.patch.yml 里找不到生成区标记（' + DECL_START + ' / ' + DECL_END + '）')
}
write('cordis.patch.yml', patchText.slice(0, startAt) + DECL_START + ' (generated by tools/build.mjs) >>>\n' + declBody + DECL_END + '\n')

/* 技能：从仓库已脱敏的 skills/ 拷一份 —— 但按 tools/distribution.mjs 的发行契约，
   攻击操作手册型技能**不进 npm 包**（它们与"下载渗透工具"一起构成自动审查眼中的恶意特征）。
   留在仓库的那 9 份随 Release 附件分发，用户显式获取。

   ⚠️ 拷贝前先清空目标目录：本脚本只"写"不"删"，历史上一次手工放进
   packages/redteam-bundle/skills/ 的文件会永远留在包里 —— 表现是"本机看着 23 个技能、
   干净检出只有 13 个"（README 承诺 23 个，发布产物却只有 13 个）。
   清空后 `skills/` 与"仓库根 skills/ ∩ 发行白名单"严格对应，包内容可复现。 */
const skillsSrc = join(packagesDir, '../skills')
const skillsDst = join(pkgRoot, 'skills')
const allSkillNames = readdirSync(skillsSrc).filter((f) => f.endsWith('.md'))
const omittedSkills = allSkillNames.filter((f) => !isSkillShipped(f))
const skillNames = allSkillNames.filter((f) => isSkillShipped(f))
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

/* 环境安装脚本：**不再随 npm 包分发**（0.12.0 起）。
   它会在用户机器上自动下载 11 个渗透二进制并 chmod +x —— 这正是发布期自动审查判定
   "恶意"的行为特征。改为：包内不带；需要的人从 Release 附件取工具箱后**自己执行**。
   启动逻辑（lib/index.js 的 installSetupScript）本就处理"包内没有脚本"的情况：
   返回 action=missing，预检据此提示用户去哪拿，绝不代下载。 */
const setupSrc = join(packagesDir, '..', 'scripts', 'redteam-setup.sh')
const setupDst = join(pkgRoot, 'scripts', 'redteam-setup.sh')
let setupCopied = false
if (!isScriptShipped('redteam-setup.sh')) {
  if (CHECK) {
    if (existsSync(setupDst)) drift.push('scripts/redteam-setup.sh（发行契约要求删除）')
  } else {
    rmSync(join(pkgRoot, 'scripts'), { recursive: true, force: true })
  }
} else {
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
  console.error('✗ 预设未生成（目录预设给 DSH < 0.1.7，声明行写在 cordis.patch.yml 里）')
  process.exit(1)
}
if (!readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8').includes('id: preset-redteam')) {
  console.error('✗ cordis.patch.yml 里没有生成出 preset-redteam 声明行')
  process.exit(1)
}
if (CHECK) {
  if (drift.length > 0) {
    console.error('✗ 生成物与源码不同步（跑 node packages/redteam-bundle/tools/build.mjs 重新生成）：')
    for (const d of drift) console.error('   ' + d)
    process.exit(1)
  }
  console.log(`✓ 生成物与源码同步（lib/ ${generated.length} 个文件、预设 2 个、cordis.patch.yml 声明行、技能 ${skills} 个）`)
  process.exit(0)
}
console.log(`✓ dsh-redteam-mode 已生成：lib/ ${generated.length} 个文件（含 core 与报告拆出的模块）、预设 2 个 + cordis.patch.yml 声明行、技能 ${skills} 个、安装脚本 ${setupCopied ? '1 个' : '缺失'}`)
