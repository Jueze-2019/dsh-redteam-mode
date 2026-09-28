# Mac 发布指引：dsh-redteam-mode 0.12.0

本目录是给"在能做二次验证的 Mac 上发布 npm 包"用的一站式材料。按顺序做完即可，
预计 10 分钟，其中 3 分钟是真在等命令跑。

- 目标版本：**0.12.0**（0.11.5 / 0.11.6 / 0.11.7 三个号已被 npm 侧烧掉，**不要复用**）
- 目标仓库：<https://github.com/Jueze-2019/dsh-redteam-mode>
- npm 包名：`dsh-redteam-mode`（公开包，双用途已申报）

---

## 0. 出发前：Mac 上的前提

| 前提 | 怎么确认 |
| --- | --- |
| Node ≥ 22.14（建议 22 LTS 或 24） | `node -v` |
| npm ≥ 11.5.1（**关键**，npm 10 无法完成受信发布的 OIDC 交换） | `npm -v`，低了就 `npm i -g npm@12`（注意 npm@12 要求 Node ≥ 22.22.2） |
| git | `git --version` |
| **能过 WebAuthn**：那台 Mac 上已注册的安全密钥（Touch ID / iCloud 钥匙串 passkey / USB 密钥） | 先随便走一次 npm 网页验证看看能不能弹出来 |
| npm 已登录 | `npm whoami` 应返回 `jueze`；不是的话跑 `npm login --auth-type=web` |

> 如果这台 Mac 上**没有**注册过认证器：先在 Safari/Chrome 里登录 npm →
> `Account → Two-Factor Authentication → Modify 2FA → Add Security Key`，按提示把
> iCloud 钥匙串 / Touch ID 注册为一条新安全密钥（旧的 `15728875568` 保留作备份）。
> 详细步骤见 `docs/npm-2fa-passkey-setup.md`。

## 1. 拿代码

```sh
git clone git@github.com:Jueze-2019/dsh-redteam-mode.git
cd dsh-redteam-mode
git log --oneline -1        # 应为 "chore(release): 版本定稿 0.12.0 …"
node -p "require('./packages/redteam-bundle/package.json').version"   # 应为 0.12.0
```

> 也可以直接用随包分发的 `dsh-redteam-mode-0.12.0-src.tar.gz`（由 `git archive` 从
> 发布提交生成，**不含**工作区里的临时开发文件）。但它没有 `.git`，所以第 5 步的
> `git tag` 要用 `git clone` 那份来做 —— 推荐还是直接 clone。

## 2. 发布前自检（零依赖，不需要 npm install）

```sh
cd packages/redteam-bundle
node tools/build.mjs --check      # 生成物与源码是否同步
node tools/test-all.mjs           # 全量回归，应输出「14 个文件、531 条断言」通过
```

两个都绿再往下走。`npm publish` 时这两个还会作为 `prepublishOnly` 自动再跑一遍，失败不会发出去。

## 3. 发布（关键一步）

```sh
npm publish --access public
```

会发生什么：

1. 先跑 `prepublishOnly`（上面的自检）；
2. **自动打开浏览器**让你做一次人工验证 —— 选你那台 Mac 上的安全密钥/passkey，按 Touch ID；
3. 成功后终端会出现 `+ dsh-redteam-mode@0.12.0`。

⏱️ **要快**：这类鉴权会话有约 **4–5 分钟**空闲上限（实测 264 秒后失效）。浏览器弹出来就立刻按。

### 如果出现 `403 ... dual-use`

npm 对双用途包可能只允许"暂存 + 人工批准"。看到这条就改走暂存（**同一条命、同一个密钥**）：

```sh
npx npm@12 stage publish --access public    # 暂存，会要一次验证
npx npm@12 stage list                       # 拿 stage-id
npx npm@12 stage approve <stage-id>         # 立刻批准，别等！
```

⚠️ **别在 `validating` 阶段等**：实测 0.11.5/0.11.6/0.11.7 三次暂存都在 `validating` 停留
15–18 分钟后被 npm 自行丢弃，版本号永久占用且 public 端查不到。所以暂存完立刻 `stage list`
+ `stage approve`，一次做完。

## 4. 验证发布成功（命令返回成功不算数）

```sh
npm view dsh-redteam-mode version                                   # 应输出 0.12.0
curl -s https://registry.npmjs.org/dsh-redteam-mode | grep -o '"latest":"[^"]*"'   # "latest":"0.12.0"
```

装一个试试（可选，最真实的验收）：

```sh
cd /tmp && dsh plugin --profile web add dsh-redteam-mode
```

## 5. 收尾

```sh
git tag v0.12.0 && git push origin main --tags
```

> CI 的自动发布已经**关掉**了（`.github/workflows/publish.yml` 不再监听 tag 推送，仓库变量
> `NPM_TRUSTED_PUBLISHING_ENABLED` 也置为 `false`），所以你推 tag 不会触发一次注定失败的
> 发布 job，也不会留下红色记录。想恢复 CI 发布时，把变量设回 `true`：
>
> ```sh
> gh variable set NPM_TRUSTED_PUBLISHING_ENABLED --body "true" --repo Jueze-2019/dsh-redteam-mode
> ```
>
> （它的能力上限是"暂存"，最终仍需人工批准 —— 这是 npm 对双用途包的政策。）

推完 tag 后，**剩下三步交给我**（告诉我一声即可）：

1. 建 GitHub Release（`bash scripts/release-notes.sh v0.12.0`）；
2. 打 tarball 并作为 Release 附件上传（给"装不上 npm"的人的备用安装路径）；
3. 更新并提交市场条目 PR（#5034）—— 草稿在 `docs/marketplace-pr/`。

---

## 已知报错对照表

| 报错 | 含义 | 怎么办 |
| --- | --- | --- |
| `403 ... bypasses two-factor authentication cannot publish a dual-use security package` | 用的是长期 token 直发，政策不允许 | 改用交互式 `npm publish`（走第 3 步），或走暂存 |
| `403 Direct trusted publishing cannot publish a dual-use security package` | CI/OIDC 直发也不允许 | 同上 |
| `404 Not Found - PUT https://registry.npmjs.org/dsh-redteam-mode` | **不是"包没绑定"**：要么发布用的 npm 太老（npm 10 没有 OIDC 逻辑），要么受信发布没绑 | 确认 `npm -v ≥ 11.5.1` |
| `409 Cannot stage previously published version "0.11.x"` | 该版本号被占用（暂存条目被丢弃后号也回不来） | 换下一个号（本次是 0.12.0） |
| `EOTP` / `This operation requires a one-time password` | 正常流程：需要人工验证 | 在浏览器里完成，别关终端 |
| `ENEEDAUTH` | 未登录 / token 无效 | `npm login --auth-type=web` |
| 浏览器没弹出来 | 终端与浏览器不在同一台机器，或没有 GUI | 必须在同一台 Mac 的终端里跑 |

## 发布之后（发给用户的话术）

- 安装：`dsh plugin --profile web add dsh-redteam-mode`，装完重启一次 `dsh web`
- 本版改了什么：见 `docs/releases/v0.12.0.md`
- 合规声明：仅限**已获书面授权**的攻防演练/渗透测试使用
