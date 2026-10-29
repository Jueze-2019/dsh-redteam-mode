/** GitHub Release 更新检查的零依赖单测（不发真实网络请求）。 */
import { githubAssetUrl, releaseAssetOf, checkLatest } from '../lib/ui.js'

let pass = 0
let fail = 0
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) } }

const asset = { name: 'dsh-redteam-mode-0.15.3.tgz', size: 123, browser_download_url: 'https://github.com/Jueze-2019/dsh-redteam-mode/releases/download/v0.15.3/dsh-redteam-mode-0.15.3.tgz' }
const release = { tag_name: 'v0.15.3', html_url: 'https://github.com/Jueze-2019/dsh-redteam-mode/releases/tag/v0.15.3', assets: [asset] }

ok(githubAssetUrl(asset) === asset.browser_download_url, 'GitHub Release 资产地址通过校验')
ok(githubAssetUrl({ browser_download_url: 'https://evil.example/x.tgz' }) === null, '非 GitHub 资产地址被拒绝')
ok(githubAssetUrl({ browser_download_url: 'http://github.com/x.tgz' }) === null, '非 HTTPS 资产地址被拒绝')
ok(releaseAssetOf(release, '0.15.3')?.name === asset.name, '按版本选择 .tgz 资产')

const oldFetch = globalThis.fetch
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => release })
const check = await checkLatest()
globalThis.fetch = oldFetch
ok(check.ok === true && check.latest === '0.15.3' && check.source === 'github', '检查更新读取 GitHub Release 最新 tag')
ok(check.asset && check.asset.url === asset.browser_download_url, '检查结果带可安装的 GitHub 资产 URL')

console.log(`\n通过 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
