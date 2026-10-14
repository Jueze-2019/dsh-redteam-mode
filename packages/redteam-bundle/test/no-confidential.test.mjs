/**
 * 敏感内容闸门的回归测试（零依赖）
 *
 * 跑法：node packages/redteam-bundle/test/no-confidential.test.mjs
 *
 * 为什么要测"一个检查脚本"：
 *   ① **规则会被改瞎**：以后有人为了让自己的提交过闸而放宽正则，测试必须炸 ——
 *      所以这里跑闸门自带的 `--selftest`（12 个"该拦"样例 + 5 个"该放"样例）；
 *   ② **闸门必须真的接上**：`.githooks/pre-commit` 存在且可执行、`core.hooksPath`
 *      指向它，否则规则再严也只是摆设；
 *   ③ **仓库本身要干净**：全量扫描必须 0 命中（真实事故是 2026-10-12 把战绩统计
 *      写进了仓库根 README 与 docs/，只能靠改写 git 历史清除）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')
const gate = join(repo, 'scripts', 'check-no-confidential.mjs')

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }

/** 跑一个命令，返回 `{ code, out }`（不抛异常，失败也是一种结果）。 */
function run(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status === undefined ? 1 : error.status, out: String(error.stdout || '') + String(error.stderr || '') }
  }
}

console.log('— 闸门脚本存在且可跑')
ok(existsSync(gate), 'scripts/check-no-confidential.mjs 存在')

console.log('— 规则自检（该拦的要拦、该放的要放）')
{
  const r = run(process.execPath, [gate, '--selftest'])
  ok(r.code === 0, '闸门自检通过（12 拦 / 5 放）' + (r.code === 0 ? '' : '\n' + r.out.slice(0, 600)))
  /* 反向确认自检**真的在跑样例**，而不是空转通过 */
  ok(/拦下/.test(r.out) && /放行/.test(r.out), '自检同时报了"拦下"与"放行"两组结果（不是空转）')
}

console.log('— 仓库全量扫描必须干净')
{
  const r = run(process.execPath, [gate, '--all'])
  ok(r.code === 0, '仓库（含未跟踪文件）0 命中' + (r.code === 0 ? '' : '\n' + r.out.slice(0, 800)))
}

console.log('— 闸门确实接在提交路径上')
ok(existsSync(join(repo, '.githooks', 'pre-commit')), '.githooks/pre-commit 存在（随仓库版本化）')
{
  const mode = statSync(join(repo, '.githooks', 'pre-commit')).mode
  ok((mode & 0o111) !== 0, 'pre-commit 可执行')
  /* `core.hooksPath` 是**每台机器的本地配置**，不会随仓库分发：
     CI 的全新 checkout 上必然没配，所以那里只验"钩子文件本身可用"。
     本机（开发机）则要求真的启用了 —— 否则规则写了也没人执行。 */
  const inCI = process.env.CI === 'true' || process.env.CI === '1' || process.env.GITHUB_ACTIONS === 'true'
  const cfg = run('git', ['config', '--get', 'core.hooksPath']).out.trim()
  if (inCI) {
    console.log(`  · CI 环境（${cfg || '未配置'}）：core.hooksPath 是本地配置，此处不要求已启用；服务端口径由本 workflow 的闸门步骤保证`)
  } else {
    ok(cfg === '.githooks', 'core.hooksPath 指向 .githooks（本机已启用：' + (cfg || '未配置') + '）')
    if (cfg !== '.githooks') {
      console.log('    修法：git config core.hooksPath .githooks（scripts/deploy-local.mjs 也会自动配）')
    }
  }
}

console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
