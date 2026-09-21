/**
 * 技能可用性判定回归测试（零依赖）
 *
 * 跑法：node packages/redteam-store/test/skill-availability.test.mjs
 *
 * 为什么要有它：技能的"能不能用"最容易骗人 —— 技能能列出来、正文也读得到，但里面写的
 * `FOFA_KEY`、本机二进制路径、VPS 地址可能一个都没配。判定逻辑是**一份实现两处用**
 * （`redteam_preflight` 工具 + 面板「技能库」页签），所以这里锁住四个维度 + 边界情况，
 * 免得哪天改判定把"缺 key"误判成可用，又回到"开工才发现跑不起来"。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSkill, summarizeSkills, requiredEnvOf, referencedPathsOf, expandSkillPath } from '../lib/skill-availability.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }

const root = mkdtempSync(join(tmpdir(), 'rt-skill-avail-'))
process.env.DSH_HOME = root
/* 造一个"本机工具箱"：有的文件存在、有的不存在 */
const toolkit = join(root, 'redteam', 'toolkit')
mkdirSync(join(toolkit, 'suo5'), { recursive: true })
mkdirSync(join(toolkit, 'gogo'), { recursive: true })
writeFileSync(join(toolkit, 'suo5', 'suo5-linux-amd64'), 'x', 'utf8')
writeFileSync(join(toolkit, 'gogo', 'gogo'), 'x', 'utf8')
const realSkill = join(toolkit, 'demo.md')
writeFileSync(realSkill, '# demo\n', 'utf8')

console.log('— 环境变量抽取')
ok(requiredEnvOf('KEY = os.environ["FOFA_KEY"]').join(',') === 'FOFA_KEY', 'os.environ["X"] 算必需')
ok(requiredEnvOf('process.env.MY_TOKEN').join(',') === 'MY_TOKEN', 'process.env.X 算必需')
ok(requiredEnvOf('KEY = os.environ.get("FOFA_KEY", "默认")').length === 0,
  'os.environ.get("X", "默认") 有兜底 → 不算必需（否则会把能用的技能误判成坏）')
ok(requiredEnvOf('${VPS_HOST:?必须给}').join(',') === 'VPS_HOST', 'shell 的 ${X:?} 算必需')
ok(requiredEnvOf('$TARGET 只是占位符').length === 0, '裸 $TARGET 不判定（技能里到处都是目标占位）')

console.log('— 本机路径抽取与展开')
ok(referencedPathsOf('SUO5=$DSH_HOME/redteam/toolkit/suo5/suo5-linux-amd64').length === 1,
  '抽出 $DSH_HOME 下的 toolkit 路径')
ok(referencedPathsOf('见 README 的 /etc/passwd 与 http://x/toolkit/').length === 0,
  '只认 toolkit/bin/local 下的本机路径（正文里的 URL 与系统路径不误伤）')
ok(expandSkillPath('$DSH_HOME/redteam/toolkit') === join(root, 'redteam', 'toolkit'), '$DSH_HOME 展开正确')
ok(expandSkillPath('~/x').startsWith('/'), '~/ 展开成绝对路径')

console.log('— 四个判定维度')
const good = checkSkill({
  name: 'good', path: realSkill,
  content: '# 好技能\nSUO5=$DSH_HOME/redteam/toolkit/suo5/suo5-linux-amd64\nGOGO=$DSH_HOME/redteam/toolkit/gogo/gogo\n',
}, { env: process.env })
ok(good.status === 'available' && good.problems.length === 0, '路径都在 + 无必需 key → 可用')

const missingEnv = checkSkill({ name: 'fofa', content: 'KEY = os.environ["RT_FAKE_KEY"]' }, { env: process.env })
ok(missingEnv.status === 'broken' && missingEnv.checked.missing_env.includes('RT_FAKE_KEY'),
  '缺环境变量 → 判为 broken 并列出变量名')
ok(missingEnv.needs_user.some((x) => x.includes('RT_FAKE_KEY')), 'needs_user 明确写出"要向用户要什么"')

const missingPath = checkSkill({
  name: 'tunnel', content: 'X=$DSH_HOME/redteam/toolkit/does-not-exist-xyz/bin\n',
}, { env: process.env })
ok(missingPath.status === 'broken' && missingPath.checked.missing_paths.length === 1,
  '正文引用的本机路径不存在 → broken')

/* 用**干净的 env**：占位符判定依赖 REDTEAM_VPS_HOST 是否已配，
   直接传 process.env 会让本机已配 VPS 的开发机把这条断言测成假阴性。 */
const placeholder = checkSkill({ name: 'vps', content: 'ssh root@<你的VPS_IP> -p 9000\n' }, { env: {} })
ok(checkSkill({ name: 'vps', content: 'ssh root@<你的VPS_IP> -p 9000\n' },
  { env: { REDTEAM_VPS_HOST: '1.2.3.4' } }).status === 'available',
  '已配置 REDTEAM_VPS_HOST 时，正文里的占位符不再算缺口（技能即可用）')
ok(placeholder.status === 'broken' && placeholder.needs_user.includes('VPS 地址'),
  '基础设施还是占位符 → broken，并标出"要 VPS 地址"')

const envSet = checkSkill({ name: 'fofa', content: 'KEY = os.environ["RT_FAKE_KEY"]' }, { env: Object.assign({}, process.env, { RT_FAKE_KEY: 'x' }) })
ok(envSet.status === 'available', '把 key 设上之后同一个技能变成可用（判定看的是进程环境）')

console.log('— 边界情况')
const noContent = checkSkill({ name: 'remote', content: '' })
ok(noContent.status === 'unknown' && /正文读不到/.test(noContent.problems[0]),
  '正文读不到 → unknown（不武断说它坏了，也不假装可用）')
const missingFile = checkSkill({ name: 'x', path: join(root, 'nope.md'), content: '# x\n' })
ok(missingFile.status === 'broken' && /技能文件不存在/.test(missingFile.problems.join('')), '技能文件不存在 → broken')

/* 同名技能被"随包占位符版本"盖住：真实事故 —— 用户自己那份配好了 VPS，但包内那份
   （含 <你的VPS_IP>）排在技能根前面，面板于是报"VPS 地址还是占位符"，看着像环境没配。 */
console.log('— 同名技能被前面的技能根盖住（误报兜底）')
{
  const mineRoot = join(root, 'skills-mine')
  const bundleRoot = join(root, 'skills-bundled')
  mkdirSync(mineRoot, { recursive: true })
  mkdirSync(bundleRoot, { recursive: true })
  writeFileSync(join(mineRoot, 'vps-demo.md'), '# vps-demo\nssh root@10.9.9.9 -p 9000\n', 'utf8')
  const shadowed = checkSkill(
    { name: 'vps-demo', content: 'ssh root@<你的VPS_IP> -p 9000\n', root: bundleRoot },
    { env: process.env, sameNameIn: [bundleRoot, mineRoot] },
  )
  ok(shadowed.status === 'broken' && shadowed.shadowed_by === mineRoot,
    '真实加载的是占位符版本 → 仍然 broken，但指出"另一份可用、被盖住了"')
  ok(shadowed.problems.some((p) => /还有一份同名技能/.test(p)), 'problem 里写明是哪份、以及怎么让它生效')

  /* 反过来：当前这份本来就是好的，就不该报"被盖住"，也不该多出任何问题 */
  const fine = checkSkill(
    { name: 'vps-demo', content: 'ssh root@10.9.9.9 -p 9000\n', root: mineRoot },
    { env: process.env, sameNameIn: [bundleRoot, mineRoot] },
  )
  ok(fine.status === 'available' && fine.shadowed_by === undefined, '当前这份可用时不产生多余告警')

  /* 同名但两份一样（都缺 key）：不该因为"别处也有"就改变结论 */
  const sameEnv = checkSkill(
    { name: 'vps-demo', content: 'KEY = os.environ["RT_FAKE_KEY2"]', root: mineRoot },
    { env: process.env, sameNameIn: [mineRoot] },
  )
  ok(sameEnv.status === 'broken' && sameEnv.shadowed_by === undefined, '同一份根不参与"被盖住"判定（跳过自己）')
}
const summary = summarizeSkills([good, missingEnv, missingPath, noContent])
ok(summary.total === 4 && summary.available === 1 && summary.broken === 2 && summary.unknown === 1,
  `汇总正确：${JSON.stringify(summary)}`)

console.log('— 与工具/面板共用同一份实现')
{
  /* tools 与 UI 都必须 import 这个模块，而不是各自内联一份判定 */
  const { readFileSync } = await import('node:fs')
  const tools = readFileSync(new URL('../../redteam-tools/lib/index.js', import.meta.url), 'utf8')
  const ui = readFileSync(new URL('../../redteam-ui/lib/index.js', import.meta.url), 'utf8')
  ok(/from '\.\.\/\.\.\/redteam-store\/lib\/skill-availability\.js'/.test(tools),
    'redteam_preflight 用共享判定模块')
  ok(/from '\.\.\/\.\.\/redteam-store\/lib\/skill-availability\.js'/.test(ui),
    '面板技能库用同一份共享判定模块')
  const bundleTools = readFileSync(new URL('../../redteam-bundle/lib/tools.js', import.meta.url), 'utf8')
  const bundleUi = readFileSync(new URL('../../redteam-bundle/lib/ui.js', import.meta.url), 'utf8')
  ok(/from '\.\/skill-availability\.js'/.test(bundleTools) && /from '\.\/skill-availability\.js'/.test(bundleUi),
    '打包后两个半侧都指向包内 ./skill-availability.js（自包含）')
}

rmSync(root, { recursive: true, force: true })
console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
