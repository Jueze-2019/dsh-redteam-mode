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
 *      这一步是关键：**直接把打包模板 cp 进 `$DSH_HOME/.agent-presets/redteam/` 会留下
 *      `{{REDTEAM_SKILLS_DIR}}` 占位符**，YAML 把它解析成对象 → skill-filesystem 配置校验失败
 *      → 整个预设挂载失败 → 建不了会话、发不出消息（v0.9.0 真实事故，别再用 cp）。
 *      注：`installPreset` 现在也会自愈已存在的坏预设（占位符残留 / 旧包路径失效），
 *      所以即使以前踩过坑，正常启动一次 dsh web 也会自动修好。
 *   ④ 顺手把已装包里的 package.json 版本号对齐（面板显示的版本来自它）。
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
  /* 版本号对齐（面板显示的是这份 package.json） */
  const installedPkgPath = join(profilesRoot, profile, 'node_modules', 'dsh-redteam-mode', 'package.json')
  const sourcePkg = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8'))
  if (existsSync(installedPkgPath)) {
    const installed = JSON.parse(readFileSync(installedPkgPath, 'utf8'))
    if (installed.version !== sourcePkg.version) {
      installed.version = sourcePkg.version
      writeFileSync(installedPkgPath, JSON.stringify(installed, null, 2) + '\n', 'utf8')
      console.log(`   版本号 ${installed.version} ← ${sourcePkg.version}`)
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
