/**
 * RedTeam 资产库 —— Cordis Host 插件壳
 *
 * 职责：把 {@link RedteamStore} 发布为进程级服务 `ctx.redteam`，供
 *   · 客户端界面（经 dsh-redteam-ui 的 HTTP 桥接）
 *   · 各角色智能体的工具行（preset 平面，注入 ctx.redteam）
 * 共同读取同一份 SQLite 事实库。
 *
 * 平面归属：host。资产数据要跨会话被后续漏洞检测/利用/内网智能体共享，
 * 因此服务实例必须进程级唯一，不能放进 preset。
 *
 * 零外部依赖：只用 node: 内置模块，避免 profile 下解析不到 node_modules。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { RedteamStore } from './core.js'

/** Cordis 插件名。 */
export const name = 'redteam-store'

/** 无硬依赖：数据层不依赖其它服务即可激活。 */
export const inject = []

/**
 * 解析数据根目录：显式配置 > REDTEAM_HOME > $DSH_HOME/redteam。
 * 组合层通常用 `!!js dshHomePath('redteam')` 直接给出绝对路径。
 */
function resolveRoot(config) {
  if (config && typeof config.root === 'string' && config.root.length > 0) return config.root
  if (process.env.REDTEAM_HOME) return process.env.REDTEAM_HOME
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'redteam')
}

/**
 * @param ctx - 插件上下文。
 * @param config - `{ root?: string }`。
 */
export function apply(ctx, config = {}) {
  const root = resolveRoot(config)
  const store = new RedteamStore(root)

  // 服务随 fiber 卸载而关闭：所有 SQLite 句柄在同一处释放。
  ctx.effect(() => () => store.close())

  ctx.provide('redteam', store)
}

export { RedteamStore }
