/**
 * hermes-dsh-redteam-mode —— 插件自举（host 半侧）
 *
 * 这个包是**自包含**的：资产库、工具、控制台、预设、技能全在包内，
 * 装一个包就齐活。本文件负责三件事：
 *
 *   1. 首次启动时把包内自带的 `redteam` 预设装到用户的 preset 根
 *      （`$DSH_HOME/.agent-presets/redteam/`），并把预设里的
 *      `{{REDTEAM_SKILLS_DIR}}` 占位符替换成包内 skills/ 的**真实绝对路径**。
 *      为什么走"落地到用户根"而不是配置一个 preset roots：YAML 补丁里拿不到
 *      本包安装路径（`ctx.baseUrl` 是 profile 目录），而 JS 里
 *      `import.meta.url` 永远正确。落地还有一个好处：用户可以就地改预设。
 *   2. 已经存在同名预设时**不动它**（用户自己的改动优先），只提示。
 *   3. 把包内路径挂到 ctx 上，方便排障与其它行复用。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名。 */
export const name = 'redteam-mode'

/** 无硬依赖：即使 skills 服务缺失也不该阻断挂载。 */
export const inject = []

/** 本包根目录（从模块位置解析，装到哪个 profile / 哪个路径都对）。 */
export function packagePaths() {
  const root = fileURLToPath(new URL('..', import.meta.url))
  return {
    root,
    presets: join(root, 'presets'),
    presetDir: join(root, 'presets', 'redteam'),
    skills: join(root, 'skills'),
  }
}

/** 用户 preset 根（与 dsh-agent-presets 的 USER_PRESET_DIR 保持一致）。 */
export function userPresetRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.agent-presets')
}

/**
 * 把包内预设落地到用户 preset 根（已存在则跳过）。
 * @param options - `{ force?: boolean, log?: (msg: string) => void }`
 * @returns `{ action: 'installed'|'kept', dir, skillsDir }`
 */
export function installPreset(options = {}) {
  const paths = packagePaths()
  const target = join(userPresetRoot(), 'redteam')
  const log = options.log ?? (() => {})
  const skillCount = existsSync(paths.skills)
    ? readdirSync(paths.skills).filter((f) => f.endsWith('.md')).length
    : 0

  if (existsSync(join(target, 'agent.cordis.yml')) && options.force !== true) {
    log(`已存在用户自己的预设 ${target}，保留不动（要覆盖：REDTEAM_PRESET_REFRESH=1 启动一次）`)
    return { action: 'kept', dir: target, skillsDir: paths.skills, skills: skillCount }
  }

  mkdirSync(target, { recursive: true })
  for (const file of readdirSync(paths.presetDir)) {
    const text = readFileSync(join(paths.presetDir, file), 'utf8')
      .replace(/\{\{REDTEAM_SKILLS_DIR\}\}/g, paths.skills)
    writeFileSync(join(target, file), text, 'utf8')
  }
  log(`预设已安装到 ${target}（打包技能 ${skillCount} 个：${paths.skills}）`)
  return { action: 'installed', dir: target, skillsDir: paths.skills, skills: skillCount }
}

/**
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  const paths = packagePaths()
  let result
  try {
    result = installPreset({
      force: process.env.REDTEAM_PRESET_REFRESH === '1',
      log: (msg) => ctx.logger?.info?.('redteam-mode: ' + msg),
    })
  } catch (error) {
    /* 装不上不该拖垮整个 harness：把原因说清楚，面板与资产库照常可用 */
    ctx.logger?.error?.('redteam-mode: 预设安装失败：%s', error && error.message ? error.message : String(error))
    result = { action: 'failed', dir: join(userPresetRoot(), 'redteam'), skillsDir: paths.skills, skills: 0 }
  }
  /* Cordis 要求服务走 provide（直接赋值会报 "cannot set property without provide"） */
  ctx.provide('redteamMode', Object.freeze({ paths, preset: result }))
  ctx.logger?.info?.(
    'redteam-mode: 就绪（数据目录默认 $DSH_HOME/redteam；预设 %s；技能目录 %s）',
    result.dir, result.skillsDir,
  )
}

export default { name, inject, apply }
