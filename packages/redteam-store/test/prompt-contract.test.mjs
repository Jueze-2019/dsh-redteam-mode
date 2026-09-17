/**
 * 提示词—工具契约回归测试
 *
 * 跑法：node packages/redteam-store/test/prompt-contract.test.mjs
 *
 * 为什么要有这个测试：提示词里教会智能体用的每个参数，必须在工具里真实存在，
 * 否则调用会被静默丢弃，指令等于没写（v0.7.7 之前 `redteam_asset_test` 的 `notes`
 * 就是这样：四个角色提示词都让写 notes，而该参数根本不存在 → 排除结论与登录
 * 失败原因全部没落库）。这里锁住几条契约：
 *   ① `notes` 是 `redteam_asset_test` 的兼容别名，会与 `test` 一起追加进 test_notes；
 *   ② `stage_code` 只接受 5 个合法值，非法值退回老 stage 兜底并给出可见告警；
 *   ③ `redteam_chain_add` 带 point_code 却不给 evidence 时，必须明确告知"没有记分"；
 *   ④ 提示词里不出现不存在的参数名；
 *   ⑤ 公共段落（授权 / 记分 / 查库 / 落库溯源 / 交付）只写一份、由代码拼接注入 ——
 *      v0.9.0 六个角色共用同一套副本。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore, DEFAULT_PROMPTS, VALID_STAGE_CODES, LEGACY_PROMPT_HASHES, ROLE_TITLES, PLANNER_ROLE } from '../lib/core.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }

const root = mkdtempSync(join(tmpdir(), 'rt-prompt-contract-'))
try {
  const store = new RedteamStore(root)
  const { id } = store.openEngagement('提示词契约测试靶标')
  /* 直接用最小 insert 造一台资产：本测试只关心资产测试记录与攻击链的契约，不关心测绘链路。 */
  const assetId = (() => {
    const now = new Date().toISOString()
    const r = store.db(id).prepare(`INSERT INTO asset(segment_cidr, ip, ip_int, state, confidence, first_seen, last_seen, scope)
      VALUES(?,?,?,?,?,?,?,?)`).run('10.0.0.0/24', '10.0.0.9', 167772169, 'live', 0.9, now, now, 'internal')
    return Number(r.lastInsertRowid)
  })()

  console.log('— 契约一：notes 与 test 都落进测试记录')
  store.updateAssetTest(id, { asset_id: assetId, status: 'testing', test: 'nmap 全端口' })
  store.updateAssetTest(id, { asset_id: assetId, notes: '登不进去：账号已禁用', status: 'tested' })
  const asset = store.getAsset(id, assetId)
  ok(/nmap 全端口/.test(asset.test_notes), 'test 参数写进了 test_notes')
  ok(/登不进去/.test(asset.test_notes), 'notes 参数（兼容别名）也写进了 test_notes')
  ok(asset.test_status === 'tested', '状态被正确更新为 tested')
  const onlyNotes = store.updateAssetTest(id, { asset_id: assetId, notes: '第二次排除结论' })
  ok(/第二次排除结论/.test(onlyNotes.test_notes), '返回值里带 test_notes，模型能确认写成功')

  console.log('— 契约二：stage_code 白名单 + 非法值告警')
  ok(VALID_STAGE_CODES.length === 5 && VALID_STAGE_CODES.includes('boundary'),
    '只暴露 5 个合法阶段 code')
  const good = store.addChainStep(id, { stage: 'pivot', stage_code: 'boundary', title: 'suo5 隧道打通' })
  ok(good.stage_code === 'boundary' && good.stage_hint === null, '合法 stage_code 原样保留、无告警')
  const bad = store.addChainStep(id, { stage: 'vuln', stage_code: 'foothold', title: '撕破口子' })
  ok(bad.stage_code === 'internet' && /无效的 stage_code/.test(bad.stage_hint || ''),
    '废弃值 foothold 被拦下、退回按 stage 兜底，并返回可见告警')

  console.log('— 契约三：chain_add 带分不带证据必须说清楚')
  const noEvidence = store.addChainStep(id, { stage: 'exploit', stage_code: 'internet', title: '上传 getshell', point_code: 'webshell', asset_id: assetId })
  ok(noEvidence.hit === null && /没有记分/.test(noEvidence.score_hint || ''),
    '带 point_code 但没给 evidence：明确回报没有记分')
  const scored = store.addChainStep(id, {
    stage: 'exploit', stage_code: 'internet', title: '上传 getshell',
    point_code: 'webshell', target: '10.0.0.9', evidence: '10.0.0.9｜/upload/x.jsp 冰蝎马，已连接',
  })
  ok(scored.hit !== null && scored.hit.counted === true, '同时给 point_code + evidence 时照常记分')
  ok(scored.score_hint === null, '记分成功时不给多余告警')

  console.log('— 契约四：步骤要能回答"怎么做的"（tool / result 落库）')
  const step = store.addChainStep(id, {
    stage: 'exploit', stage_code: 'internet', title: 'suo5 建隧道',
    tool: 'suo5-linux-amd64 -t http://t/shell.jsp -l 1080', result: 'socks5 ok', agent: 'exploit',
  })
  const stepRow = store.listChain(id).find((x) => x.id === step.id)
  ok(stepRow.tool === 'suo5-linux-amd64 -t http://t/shell.jsp -l 1080', 'chain_add 的 tool 原样落库（报告复现靠它）')
  ok(stepRow.result === 'socks5 ok', 'chain_add 的 result 原样落库')
  ok(stepRow.agent === 'exploit', 'chain_add 的 agent 原样落库（报告标"谁做的"）')

  console.log('— 契约五：提示词里不再出现不存在的参数名')
  for (const [role, text] of Object.entries(DEFAULT_PROMPTS)) {
    const bad = /redteam_asset_test[^）)]{0,24}notes/.test(text)
    ok(!bad, `${role} 提示词不再教智能体传 asset_test 的 notes 字段（或用 test）`)
  }
  ok(readFileSync(new URL('../lib/core.js', import.meta.url), 'utf8').includes("'untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'"),
    'updateAssetTest 的 status 白名单是完整 6 值')

  console.log('— 契约六：六个角色与公共段落注入')
  const roles = Object.keys(ROLE_TITLES)
  ok(roles.length === 6 && roles.includes('assess') && roles.includes(PLANNER_ROLE),
    '角色表是六个（含资产梳理 assess 与主会话 plan）：' + roles.join('/'))
  ok(roles.every((r) => typeof DEFAULT_PROMPTS[r] === 'string' && DEFAULT_PROMPTS[r].trim() !== ''),
    '每个角色都有默认提示词')
  /* 记分 / 查库 / 落库溯源：只写一份、由代码拼接，这里同时验"注入到位"与"只有一份" */
  const WITH_SCORE = ['vuln-scan', 'exploit', 'internal']
  const WITH_DB = ['recon', 'assess', 'vuln-scan', 'exploit', 'internal']
  for (const role of roles) {
    const text = DEFAULT_PROMPTS[role]
    const scoreBlocks = (text.match(/## 记分纪律/g) || []).length
    const dbBlocks = (text.match(/## 打之前先查库/g) || []).length
    const evBlocks = (text.match(/## 落库与溯源/g) || []).length
    if (WITH_SCORE.includes(role)) {
      ok(scoreBlocks === 1 && text.includes('一次记分必填两样'), `${role}：记分纪律有且只有 1 份且内容到位`)
    } else {
      ok(scoreBlocks === 0, `${role}：不注入记分纪律（由专门的记分角色负责）`)
    }
    ok(dbBlocks === (WITH_DB.includes(role) ? 1 : 0), `${role}：查库块的注入符合角色分工（${dbBlocks} 份）`)
    if (role === PLANNER_ROLE) ok(evBlocks === 0, '主会话：不注入落库块（它不动手）')
    else ok(evBlocks === 1, `${role}：落库与溯源块注入 1 份`)
  }
  ok(['recon', 'assess', 'vuln-scan', 'exploit', 'internal'].every((r) => DEFAULT_PROMPTS[r].includes('不要询问授权范围')),
    '五个执行角色都写明"用户给出靶标单位名称即已授权、不要问授权范围"')

  const coreSrc = readFileSync(new URL('../lib/core.js', import.meta.url), 'utf8')
  ok(coreSrc.includes('const COMMON_SCORE_RULES') && coreSrc.includes('const COMMON_AUTH') && coreSrc.includes('const COMMON_EVIDENCE'),
    '公共块以常量形式定义在源码里（授权 / 记分 / 查库 / 落库 / 交付）')
  ok((coreSrc.match(/## 记分纪律（所有角色都遵守）/g) || []).length === 1, '记分纪律正文在源码里只出现 1 次')
  ok((coreSrc.match(/## 打之前先查库（禁止重复打）/g) || []).length === 1, '查库正文在源码里只出现 1 次')
  ok((coreSrc.match(/## 落库与溯源（强制：没落库的发现 = 没发生）/g) || []).length === 1, '落库溯源正文只出现 1 次')
  /* 生成器与源文件都在：改提示词必须走 prompts.src.js / prompts.roles.md */
  ok(coreSrc.includes('gen-prompts.mjs'), 'core.js 里注明提示词由生成器维护')

  const total = roles.reduce((sum, role) => sum + DEFAULT_PROMPTS[role].length, 0)
  ok(total < 32000, `六角色提示词总量 ${total} 字 < 32000（防膨胀栅栏）`)

  console.log('— 契约七：历史默认指纹表（v0.9.0 重写后按设计清空）')
  /* v0.9.0 把六个角色提示词整体重写：旧默认一律不再登记为"可自动升级"，
     残留的旧提示词判为"用户自写"而保留（面板可恢复默认，脚本可 --force）。 */
  ok(Object.keys(LEGACY_PROMPT_HASHES).length === 0,
    '历史指纹表已清空（旧提示词不沿用，符合"原本的工作逻辑提示词全部不要"）')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n通过 ${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
