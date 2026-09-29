#!/usr/bin/env node
/**
 * 把仓库里的新构建部署到**本机正在运行的那套 dsh web**（开发态：源码即运行代码）。
 *
 * 跑法：
 *   node scripts/deploy-local.mjs            # 构建 + 同步 + 自愈预设 + 提示重启
 *   node scripts/deploy-local.mjs --restart   # 同步后自动重启 dsh web（会中断当前会话，谨慎）
 *
 * 它做四件事：
 *   ① `build.mjs` 从三个源码包重新生成市场包 `lib/` 与预设/技能（保证产物与源码一致）；
 *   ② 把包内 `lib/` 同步到 profile 的 `node_modules/dsh-redteam-mode/lib/`（运行中加载的就是这份）；
 *   ③ 调 `installPreset({ force: true })` **用官方安装路径**刷新用户预设 ——
 *      这一步只对 **DSH < 0.1.7** 有意义（那时模式来自 `$DSH_HOME/.agent-presets/` 目录）。
 *      0.1.7-rc.2 起注册表既不扫目录也不接受预设路径，模式改由随包补丁
 *      `cordis.patch.yml` 生成区里的 `@deepseek-ai/dsh-agent-preset` 声明行注册；
 *      这里保留刷新是为了老版本机器，新版本机器上它只是写一份没人读的文件。
 *      注：**直接把打包模板 cp 进 `$DSH_HOME/.agent-presets/redteam/` 会留下
 *      `{{REDTEAM_SKILLS_DIR}}` 占位符**，YAML 把它解析成对象 → skill-filesystem 配置校验失败
 *      → 整个预设挂载失败 → 建不了会话、发不出消息（v0.9.0 真实事故，别再用 cp）。
 *      注：`installPreset` 现在也会自愈已存在的坏预设（占位符残留 / 旧包路径失效），
 *      所以即使以前踩过坑，正常启动一次 dsh web 也会自动修好。
 *   ④ 把 package.json（含 `dsh.bundle.patch` 补丁层清单）整份对齐到仓库那份 ——
 *      补丁层从 0.12.1 起是两个文件，只同步 lib/ 会让声明行挂不上、模式列表里没红队模式。
 *
 * 之后 host 侧改动仍需重启 dsh web 才生效（客户端 UI 会自动热重载）。
 */
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPreset, packagePaths } from '../packages/redteam-bundle/lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const bundle = join(repo, 'packages', 'redteam-bundle')

/* ① 重新生成市场包 */
console.log('— ① 生成市场包（build.mjs）')
execFileSync(process.execPath, [join(bundle, 'tools', 'build.mjs')], { cwd: repo, stdio: 'inherit' })

/* ② 同步到 profile 的 node_modules */
const profilesRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles')
const profiles = existsSync(profilesRoot)
  ? readdirSync(profilesRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : []
let synced = 0
for (const profile of profiles) {
  const libDir = join(profilesRoot, profile, 'node_modules', 'dsh-redteam-mode', 'lib')
  if (!existsSync(libDir)) continue
  console.log(`— ② 同步到 profile "${profile}"`)
  const files = readdirSync(join(bundle, 'lib'))
  for (const file of files) {
    copyFileSync(join(bundle, 'lib', file), join(libDir, file))
  }
  /* ⚠️ **presets/ 必须一起同步**：installPreset 是从**已安装包**的 presets/ 读模板再落地的，
     只同步 lib/ 的话它会用上一次部署留下的旧预设覆盖用户预设 —— 表现是"代码更新了、人设还是旧的"，
     更糟的是会把带占位符的坏预设重新写回去（v0.9.0 踩过）。技能目录同理（随包分发）。 */
  const installedRoot = join(profilesRoot, profile, 'node_modules', 'dsh-redteam-mode')
  for (const sub of ['presets', 'skills', 'scripts']) {
    const srcDir = join(bundle, sub)
    if (!existsSync(srcDir)) continue
    for (const file of readdirSync(srcDir, { withFileTypes: true })) {
      const from = join(srcDir, file.name)
      const to = join(installedRoot, sub, file.name)
      if (file.isDirectory()) {
        mkdirSync(to, { recursive: true })
        for (const inner of readdirSync(from)) copyFileSync(join(from, inner), join(to, inner))
      } else {
        mkdirSync(join(installedRoot, sub), { recursive: true })
        copyFileSync(from, to)
      }
    }
    console.log(`   ${sub}/ 已同步`)
  }
  /* ⚠️ **cordis.patch.yml 本身也必须同步**：新会话模式列表的唯一入口
     （`preset-redteam` 声明行）就写在这个补丁层里。只同步 lib/ 会变成
     "代码是新的、补丁层是旧的"——表现是插件一切正常，就是模式列表里没有红队模式。
     它由 build.mjs 从 preset/ 重新生成，所以这里必须从仓库那份拷过去。 */
  const patchSrc = join(bundle, 'cordis.patch.yml')
  if (existsSync(patchSrc)) {
    copyFileSync(patchSrc, join(installedRoot, 'cordis.patch.yml'))
    console.log('   cordis.patch.yml 已同步（含 preset-redteam 声明行）')
  }
  /* package.json 整份对齐 —— **不只是版本号**：`dsh.bundle.patch`、`exports`、
     `dsh.client` 都写在这份清单里。只同步 lib/ 会出现"文件到位了、补丁层没声明"，
     表现同样是模式列表里没有红队模式。仓库那份是唯一事实来源。
     注意 `dsh.bundle.patch` 必须保持**字符串**：数组形式只有 DSH ≥0.1.7 才认，
     0.1.6 及更早会直接抛错、harness 起不来（详见 cordis.patch.yml 里的说明）。 */
  const installedPkgPath = join(profilesRoot, profile, 'node_modules', 'dsh-redteam-mode', 'package.json')
  const sourcePkgText = readFileSync(join(bundle, 'package.json'), 'utf8')
  if (existsSync(installedPkgPath)) {
    let current = ''
    try { current = readFileSync(installedPkgPath, 'utf8') } catch { current = '' }
    if (current !== sourcePkgText) {
      let before = {}
      try { before = JSON.parse(current) } catch { before = {} }
      const after = JSON.parse(sourcePkgText)
      writeFileSync(installedPkgPath, sourcePkgText, 'utf8')
      console.log('   package.json 已对齐'
        + (before.version !== after.version ? `（版本 ${before.version} ← ${after.version}）` : '（补丁层/exports 等）'))
    }
  }
  synced += files.length
}
if (synced === 0) console.log('— ② 没找到任何装过 dsh-redteam-mode 的 profile（只更新了仓库产物）')

/* ③ 用官方路径刷新用户预设（占位符替换 + 坏预设自愈）
   关键：必须用 **profile 里那份已安装的包** 去调 installPreset —— 它写进预设的是
   `profile/node_modules/dsh-redteam-mode/skills`（运行时真正在用的技能目录）。
   若用仓库里那份调用，写进去的是仓库路径：仓库被移动/删除后技能就静默消失。
   选哪个 profile：优先 DSH_PROFILE / 正在运行的 dsh 进程的 --profile，其次 web。 */
console.log('— ③ 刷新用户预设（installPreset force，用 profile 里的包）')
const explicitProfile = process.env.DSH_PROFILE || process.env.REDTEAM_PROFILE || null
const ordered = explicitProfile !== null && profiles.includes(explicitProfile)
  ? [explicitProfile, ...profiles.filter((p) => p !== explicitProfile)]
  : [...profiles.filter((p) => p === 'web'), ...profiles.filter((p) => p !== 'web')]
let presetResult = null
for (const profile of ordered) {
  const installedRoot = join(profilesRoot, profile, 'node_modules', 'dsh-redteam-mode')
  const entry = join(installedRoot, 'lib', 'index.js')
  if (!existsSync(entry)) continue
  /* 软链到仓库的安装（开发态）用仓库路径反而更好（改源码即时生效）；真实拷贝的安装用包内路径 */
  const mod = await import(entry)
  presetResult = mod.installPreset({ force: true, log: (msg) => console.log('   [' + profile + '] ' + msg) })
  console.log(`   [${profile}] 技能目录将写成：${presetResult.skillsDir}`)
  break
}
if (presetResult === null) {
  /* 本机没装过市场包（纯仓库开发）：退化成用仓库那份，路径就是仓库的 skills/ */
  presetResult = installPreset({ force: true, log: (msg) => console.log('   ' + msg) })
}
const result = presetResult
const presetFile = join(result.dir, 'agent.cordis.yml')
const text = existsSync(presetFile) ? readFileSync(presetFile, 'utf8') : ''
if (text.includes('{{REDTEAM_SKILLS_DIR}}')) {
  console.error('✗ 预设里仍有占位符，落盘前请检查 installPreset —— 带着它启动会导致预设挂载失败、会话建不起来')
  process.exit(1)
}
console.log(`   预设：${presetFile}`)
console.log(`   技能目录：${result.skillsDir}`)

/* ④ 提示重启 */
console.log('\n✓ 部署完成。host 侧改动需要重启 dsh web 才生效：')
console.log('  node scripts/deploy-local.mjs --restart        # 自动重启（会中断当前会话）')
console.log('  setsid nohup bash scripts/restart-dsh-web.sh >> runs/restart-dsh-web.log 2>&1 &')
if (process.argv.includes('--restart')) {
  console.log('\n— ④ 自动重启（按 --restart）：交给脱离进程的脚本执行')
  /* 不传 PID：脚本自己从端口反查正在跑的 dsh —— 传错/不传都会导致"新起一个端口冲突的
     实例、旧进程继续跑"，日志看着成功其实代码没换。 */
  const child = spawn('setsid', ['nohup', 'bash', join(repo, 'scripts', 'restart-dsh-web.sh')], {
    cwd: repo, detached: true, stdio: 'ignore',
  })
  child.unref()
  console.log('   重启脚本已在后台运行，日志：$DSH_HOME/restart-dsh-web.log')
}
