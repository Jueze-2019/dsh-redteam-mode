/**
 * 提示词—工具契约回归测试
 *
 * 跑法：node packages/redteam-store/test/prompt-contract.test.mjs
 *
 * 为什么要有这个测试：提示词里教会智能体用的每个参数，必须在工具里真实存在，
 * 否则调用会被静默丢弃，指令等于没写（v0.7.7 之前 `redteam_asset_test` 的 `notes`
 * 就是这样：四个角色提示词都让写 notes，而该参数根本不存在 → 排除结论与登录
 * 失败原因全部没落库）。这里锁三条契约：
 *   ① `notes` 是 `redteam_asset_test` 的兼容别名，会与 `test` 一起追加进 test_notes；
 *   ② `stage_code` 只接受 5 个合法值，非法值退回老 stage 兜底并给出可见告警；
 *   ③ `redteam_chain_add` 带 point_code 却不给 evidence 时，必须明确告知"没有记分"，
 *      不能静默（旧实现用 try/catch 吞掉，模型以为记上了）。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedteamStore, DEFAULT_PROMPTS, VALID_STAGE_CODES, LEGACY_PROMPT_HASHES } from '../lib/core.js'

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

  console.log('— 契约四：提示词里不再出现不存在的参数名')
  for (const [role, text] of Object.entries(DEFAULT_PROMPTS)) {
    const bad = /redteam_asset_test[^）)]{0,24}notes/.test(text)
    ok(!bad, `${role} 提示词不再教智能体传 asset_test 的 notes 字段（或用 test）`)
  }
  const recon = DEFAULT_PROMPTS.recon
  ok(recon.includes('一次记分必填两样'), '记分纪律写明 code + evidence 必填')
  ok(DEFAULT_PROMPTS.internal.includes('一次记分必填两样'), 'internal 也有同一条 code 必填纪律（四角色一致）')
  ok(recon.split('## 记分纪律').length - 1 === 1, 'recon 里记分纪律只出现一次（不再整节重复）')
  ok(readFileSync(new URL('../lib/core.js', import.meta.url), 'utf8').includes("'untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'"),
    'updateAssetTest 的 status 白名单是完整 6 值')

  console.log('— 契约五：历史默认指纹表兜住"manifest 丢失"的靶标')
  /* v0.7.6 的四个默认指纹：只写在各靶标 manifest 里。manifest 一丢（靶标被拷走、目录被清），
     这批默认就会被判成"用户自写"而永不升级 —— 所以必须同时登记在 LEGACY_PROMPT_HASHES。 */
  const v076 = { recon: '7d56354b1674', 'vuln-scan': '2729503e8e0c', exploit: '676de29dcef6', internal: '4b777d35a742' }
  for (const [role, fingerprint] of Object.entries(v076)) {
    ok((LEGACY_PROMPT_HASHES[role] || []).includes(fingerprint),
      `${role} 的 v0.7.6 默认指纹已登记（manifest 丢失也能识别为默认）`)
  }
  ok(LEGACY_PROMPT_HASHES.internal.length >= 3, 'internal 的历史指纹表不少于 3 条')

  console.log('— 契约六：公共段落机制（v0.7.9 重构后）')
  /* 记分纪律 / 查库这两段原本在四个角色里逐字重复（记分纪律 4 份、查库 3 份），改一处要改多处、
     极易漂移。现在只写一份由代码拼接注入 —— 这里锁住"注入到位 + 不再有第二份副本 + 总量不膨胀"。 */
  const ROLES_ALL = ['recon', 'vuln-scan', 'exploit', 'internal']
  for (const role of ROLES_ALL) {
    const text = DEFAULT_PROMPTS[role]
    ok((text.match(/## 记分纪律/g) || []).length === 1, `${role} 的记分纪律块有且只有 1 份`)
    ok(text.includes('一次记分必填两样'), `${role} 正文含记分契约（证明公共块已注入）`)
  }
  ok((DEFAULT_PROMPTS.recon.match(/## 打之前先查库/g) || []).length === 1, 'recon 的查库块只有 1 份')
  ok((DEFAULT_PROMPTS['vuln-scan'].match(/## 打之前先查库/g) || []).length === 1, 'vuln-scan 的查库块只有 1 份')
  ok((DEFAULT_PROMPTS.exploit.match(/## 打之前先查库/g) || []).length === 1, 'exploit 的查库块只有 1 份')
  ok((DEFAULT_PROMPTS.internal.match(/## 打之前先查库/g) || []).length === 0,
    'internal 不注入完整查库块（它有专属的"先看已有入口"工作流）')

  const coreSrc = readFileSync(new URL('../lib/core.js', import.meta.url), 'utf8')
  ok(coreSrc.includes('const COMMON_SCORE_RULES'), '公共块的唯一副本以常量形式定义在源码里')
  ok((coreSrc.match(/## 记分纪律（所有角色都遵守）/g) || []).length === 1,
    '记分纪律正文在源码里只出现 1 次（不再逐角色重复）')
  ok((coreSrc.match(/## 打之前先查库（禁止重复打）/g) || []).length === 1,
    '查库正文在源码里只出现 1 次')

  const total = ROLES_ALL.reduce((sum, role) => sum + DEFAULT_PROMPTS[role].length, 0)
  ok(total < 21000, `四角色提示词总量 ${total} 字 < 21000（防膨胀栅栏）`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n通过 ${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
