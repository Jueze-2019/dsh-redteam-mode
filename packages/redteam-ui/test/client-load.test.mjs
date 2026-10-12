/**
 * 客户端 bundle 的"能不能加载"自检（零依赖，纯 Node）
 *
 * 跑法：node packages/redteam-ui/test/client-load.test.mjs
 *
 * 为什么需要它：浏览器半侧是**手写 bundle**，没有任何构建期校验 —— 语法错、
 * 引用了不存在的注入键、注册 id 写错，都要等用户打开页面才发现（host 侧改了
 * 还要重启 dsh web，反馈环很长）。这里用最小 DOM/加载器替身把它加载一遍，
 * 至少挡住"一打开就白屏"这一类问题；组件渲染行为仍靠人工/浏览器验证。
 *
 * 覆盖：
 *   ① 文件能被 `window.__ModuleLoader__.load({ id })` 注册；
 *   ② 工厂函数能执行完（没有未定义变量、没有语法错）；
 *   ③ 导出 apply / inject，且 inject 只声明平台种子确实提供的服务（slots/react）；
 *   ④ apply(ctx) 能在替身 ctx 上跑完：注册 4 个槽位、注入样式、卸载时清理干净。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }

/* ── 最小替身：React（用真实 react 不现实，这里只要 createElement 语义）────── */
const nodeRequire = createRequire(import.meta.url)
let reactStub
try {
  /* 平台种子提供 react；本机若装不到就用极简替身（只保证 createElement 返回结构对象） */
  reactStub = nodeRequire('react')
} catch {
  reactStub = {
    createElement: (type, props, ...children) => ({ $$typeof: 'stub', type, props: Object.assign({}, props, children.length ? { children } : {}) }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useReducer: (r, i) => [i, () => {}],
    useMemo: (f) => f(),
    useCallback: (f) => f(),
    Component: class Component { constructor(props) { this.props = props || {} } setState() {} forceUpdate() {} render() { return null } },
    Fragment: 'Fragment',
  }
}

/* ── 最小 DOM 替身：只记下 head.append 放了什么，便于断言样式注入/清理 ────── */
const appended = []
const removed = []
const makeEl = (tag) => ({
  tagName: tag, textContent: '', attributes: {},
  setAttribute(k, v) { this.attributes[k] = v },
  append() {},
  remove() { removed.push(this) },
})
const documentStub = {
  head: { append: (el) => appended.push(el) },
  createElement: (tag) => makeEl(tag),
}

/* ── 加载 ────────────────────────────────────────────────────────────────── */
let registered = null
const windowStub = {
  __ModuleLoader__: { load: (def) => { registered = def } },
  location: { hash: '', href: 'http://127.0.0.1:3080/' },
  addEventListener: () => {}, removeEventListener: () => {},
  open: () => null,
  setTimeout: (f, t) => setTimeout(f, t),
}
const source = readFileSync(clientPath, 'utf8')

console.log('— 加载与注册')
ok(/__ModuleLoader__\.load\(/.test(source), 'client.js 通过 __ModuleLoader__.load 注册')
{
  const fn = new Function('window', 'document', 'require', 'navigator', 'setTimeout', 'clearInterval', 'setInterval', 'URL', 'Blob', source)
  let threw = null
  try {
    fn(windowStub, documentStub, (name) => {
      if (name === 'react') return reactStub
      throw new Error('unexpected require: ' + name)
    }, { clipboard: { writeText: () => {} } }, setTimeout, clearInterval, setInterval, URL, Blob)
  } catch (error) {
    threw = error
  }
  ok(threw === null, '工厂函数执行完不报错' + (threw ? '：' + threw.message : ''))
}
ok(registered !== null && typeof registered.factory === 'function', '拿到了 factory')
ok(registered !== null && registered.id === 'dsh-redteam-ui', `注册 id 是 UI 包名（${registered && registered.id}）`)

const moduleExports = registered.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error('unexpected require: ' + name)
})
console.log('— 导出契约')
ok(typeof moduleExports.apply === 'function', '导出 apply')
ok(Array.isArray(moduleExports.inject), '导出 inject 数组')
ok(moduleExports.inject.every((k) => ['slots', 'react'].includes(k)),
  `inject 只声明平台种子提供的服务（${moduleExports.inject.join(', ')}）`)

console.log('— apply(ctx) 挂载与卸载')
const registeredSlots = []
const cleanups = []
const ctx = {
  slots: {
    inject: (name, fn) => fn(),
    register: (meta, render) => { registeredSlots.push({ meta, render }) },
  },
  effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') cleanups.push(dispose) },
}
let applyThrew = null
try { moduleExports.apply(ctx) } catch (error) { applyThrew = error }
ok(applyThrew === null, 'apply 不报错' + (applyThrew ? '：' + applyThrew.message : ''))
ok(registeredSlots.length === 4, `注册了 4 个槽位（实际 ${registeredSlots.length}）`)
ok(registeredSlots.every((s) => typeof s.render === 'function' && s.meta && s.meta.name && s.meta.id),
  '每个槽位都带 name/id 与渲染函数')
ok(appended.length >= 2, `注入了样式标签（${appended.length} 个）`)
for (const dispose of cleanups) { try { dispose() } catch { /* 忽略 */ } }
ok(removed.length >= 2, `卸载时把样式标签移除了（${removed.length} 个）`)

console.log('— 会话标题 → 靶标 反查（落盘绑定缺失时的兜底）')
{
  const list = [
    { id: '潮州三环-集团-股份有限公司', name: '潮州三环（集团）股份有限公司' },
    { id: '国家税务总局西藏自治区税务局', name: '国家税务总局西藏自治区税务局' },
    { id: '某电力公司', name: '某电力公司' },
    { id: '国家电力投资集团有限公司', name: '国家电力投资集团有限公司' },
  ]
  const byTitle = moduleExports.engagementByTitle
  ok(typeof byTitle === 'function', '导出了 engagementByTitle（纯函数，可单测）')
  ok(byTitle('国家税务总局西藏自治区税务局', list) === '国家税务总局西藏自治区税务局',
    '标题就是单位名：直接命中')
  ok(byTitle('潮州三环(集团)股份有限公司', list) === '潮州三环-集团-股份有限公司',
    '括号/连字符差异不影响命中（全角半角、（）、- 都压掉）')
  ok(byTitle('某电力公司', list) === '某电力公司',
    '短名与长名同现时命中自己（不是"国家电力投资集团…"）')
  ok(byTitle('-home-jz-~6587~6863-~897F~85CF-~56FD~5BB6~7A0E~52A1~603B~5C40~897F~85CF~81EA~6CBB~533A~7A0E~52A1~5C40--', list)
    === '国家税务总局西藏自治区税务局',
    '标题是转义后的路径（~6587 = 文 等）：解码后照样命中')
  ok(byTitle('西藏宁算信息科技有限公司 红队演练', list) === null,
    '名册里没有的单位：不硬凑（返回 null，交给下一级兜底）')
  ok(byTitle('web', list) === null, '目录基名认不出单位：老实返回 null（不猜）')
  ok(byTitle('', list) === null && byTitle(undefined, list) === null, '空标题不炸')
}

console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
