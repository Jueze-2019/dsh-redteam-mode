/**
 * 判定规则的"工具层"回归测试（零依赖）
 *
 * 跑法：node packages/redteam-tools/test/rule-tools.test.mjs
 *
 * store 层的规则（packages/redteam-store/test/rules.test.mjs）之外，这里确认
 * **智能体真正调用的那几个工具**会把规则带到输出里：
 *   · redteam_score_hit 自己注册的账号 → counted=false + warning（不计分）
 *   · redteam_tunnel_add 自己 VPS 上的通道 → legit=false + warning（不算突破）
 *   · redteam_sessions / redteam_tunnel_list 明确暴露 entry_kind 与 legit
 *   · redteam_chain_add 带分时同样遵守自建不计分
 */
import { register } from 'node:module'
register(new URL('data:text/javascript,export function resolve(s,c,n){if(s==="@deepseek-ai/dsh-tools")return{shortCircuit:true,url:"data:text/javascript,export const defineTool=(t)=>t"};return n(s,c)}'), import.meta.url)
const { apply } = await import('../lib/index.js')
const { RedteamStore } = await import('../../redteam-store/lib/core.js')
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'rt-rule-tools-'))
const store = new RedteamStore(root)
store.openEngagement('工具规则测试')
const tools = new Map()
apply({ redteam: store, tools: { register: (t) => tools.set(t.name, t) } })
const call = async (n, a) => JSON.parse(await tools.get(n).execute(a || {}, { agent: { session: { id: 's1' } } }))
let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }

/* 自己注册的账号：记录但明确不计分 */
const self = await call('redteam_score_hit', { code: 'web-account-user', target: 'http://t/register', evidence: '自建 ztest/1', self_created: true })
ok(self.counted === false && /自己注册|不计分/.test(self.warning || ''), 'score_hit：自建账号 counted=false 且给出原因')
ok(self.summary.achievedPoints === 0 && self.summary.selfCreatedHits === 1, 'score_hit：自建账号不加分，summary 单独计数')

/* 拿到别人已有的账号：照常计分 */
const real = await call('redteam_score_hit', { code: 'web-account-user', target: 'http://t/admin', evidence: 'tomcat/Tomcat@2024' })
ok(real.counted === true && real.summary.achievedPoints === 10, 'score_hit：拿到已有账号照常计分（10 分）')

/* 隧道：自己 VPS 上的不算突破 */
const t1 = await call('redteam_tunnel_add', { kind: 'socks5', listen: '127.0.0.1:1080', entry: 'my vps', entry_kind: 'self-only' })
ok(t1.legit === false && /self-only/.test(t1.warning || ''), 'tunnel_add：self-only 标注不算突破并给出原因')
const t2 = await call('redteam_tunnel_add', { kind: 'frp', listen: '127.0.0.1:1081', entry: '目标反弹到我的VPS', entry_kind: 'target-outbound' })
ok(t2.legit === true, 'tunnel_add：目标反弹 shell 到我的服务器 → 算真隧道')
const t3 = await call('redteam_tunnel_add', { kind: 'socks5', listen: '127.0.0.1:1082' })
ok(t3.legit === null && /entry_kind/.test(t3.warning || ''), 'tunnel_add：未声明 entry_kind → 待确认并提示补上')

/* 会话总览与隧道列表都要暴露判定 */
const sess = await call('redteam_sessions', {})
ok(sess.totals.tunnelsLegit === 1 && sess.totals.tunnelsSelfOnly === 1, 'sessions：分开统计目标侧通道与自建通道')
ok(sess.tunnels.every((t) => 'legit' in t && 'entry_kind' in t), 'sessions：每条隧道都带 entry_kind / legit')
ok(/不算突破/.test(sess.hint || ''), 'sessions：提示里写清 legit=false 不算突破')
const list = await call('redteam_tunnel_list', {})
/* 注意 Array.join 会把 null 变成空串，所以显式 String() 一下 */
ok(list.items.map((t) => String(t.legit)).join(',') === 'null,true,false',
  'tunnel_list：逐条给出 legit 判定（实际 ' + list.items.map((t) => String(t.legit)).join(',') + '）')

/* 攻击链带分时同样遵守规则 */
const stepSelf = await call('redteam_chain_add', { stage: 'vuln', title: '注册进后台', point_code: 'web-account-admin', evidence: '自建 ztest20 授权管理员', self_created: true })
ok(stepSelf.hit && stepSelf.hit.counted === false, 'chain_add：自建账号带分也计 0 分')
const stepReal = await call('redteam_chain_add', { stage: 'vuln', title: '拿下后台', point_code: 'web-account-admin', evidence: '厂商账号 svc-demo/Demo@2024' })
ok(stepReal.hit && stepReal.hit.counted === true, 'chain_add：真实账号带分照常计分')

rmSync(root, { recursive: true, force: true })
console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
