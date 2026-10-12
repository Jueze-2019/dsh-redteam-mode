/**
 * 「面板跟随会话」的 host 侧解析测试（零依赖）
 *
 * 跑法：node packages/redteam-ui/test/session-root.test.mjs
 *
 * 为什么单独测这一块：绑定表只记**根会话**键，而用户在界面里点开的可能是子智能体的
 * 会话。解析错了不会报错，只会让面板"回落到最后绑定的靶标"——表现成"跟着跟着不跟了"，
 * 是最难从界面上看出来的一类缺陷。所以把 resolveRootSessionId 的边界钉死在这里：
 * 正常父链、深层嵌套、会话不在注册表里（冷启动）、自环（防死循环）、注册表不可用。
 */
import { resolveRootSessionId } from '../lib/index.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }

/** 造一个会话注册表替身：`{ id: parentId | undefined }`。 */
const ctxOf = (map) => ({
  get: (name) => (name === 'sessions'
    ? { list: () => Object.entries(map).map(([id, parent]) => ({ id, header: parent === undefined ? { id } : { id, parentSession: parent } })) }
    : undefined),
})

console.log('— 根会话解析（面板跟随会话的入口）')
{
  const ctx = ctxOf({ main: undefined, child: 'main', grand: 'child' })
  ok(resolveRootSessionId(ctx, 'main') === 'main', '主会话：自己就是根')
  ok(resolveRootSessionId(ctx, 'child') === 'main', '一层子会话：解析到父会话')
  ok(resolveRootSessionId(ctx, 'grand') === 'main', '两层嵌套：一路走到顶')
  ok(resolveRootSessionId(ctx, '') === '', '空 id：原样返回（不炸）')
}
{
  /* 冷启动 / 会话被回收：注册表里没有它 —— 必须原样返回，好让面板回落到"最后绑定的靶标" */
  const ctx = ctxOf({ main: undefined })
  ok(resolveRootSessionId(ctx, 'ghost') === 'ghost', '会话不在注册表里：原样返回（面板据此回落）')
  ok(resolveRootSessionId(ctx, 'ghost-child') === 'ghost-child', '未知会话当作根，不抛异常')
}
{
  /* 自环：parentSession 指向自己。没有 64 层保护会死循环把进程卡死 */
  const ctx = ctxOf({ loop: 'loop' })
  ok(resolveRootSessionId(ctx, 'loop') === 'loop', '自环（parentSession = 自己）：直接返回，不死循环')
}
{
  /* 父 id 指向一个不存在的会话：停在能找到的最后一层 */
  const ctx = ctxOf({ a: 'missing' })
  ok(resolveRootSessionId(ctx, 'a') === 'a', '父会话不存在：停在最后一层已存在的会话上')
}
{
  const noSessions = { get: () => undefined }
  ok(resolveRootSessionId(noSessions, 'x') === 'x', 'sessions 注册表不可用：原样返回（不影响其它功能）')
  const broken = { get: () => ({ list: () => { throw new Error('boom') } }) }
  ok(resolveRootSessionId(broken, 'x') === 'x', '注册表抛异常：原样返回（不把请求带崩）')
}

console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
